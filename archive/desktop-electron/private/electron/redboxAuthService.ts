import { app } from 'electron';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { normalizeApiBaseUrl, safeUrlJoin } from '../../electron/core/urlUtils';

const REDBOX_GATEWAY_BASE = 'https://api.ziz.hk';
const REDBOX_APP_SLUG = 'redbox';
const DEFAULT_TIMEOUT_MS = 20000;
const CURRENT_SESSION_FILE_PATH = path.join(app.getPath('userData'), 'redbox-auth-session.json');
const REFRESH_AHEAD_MS = 60 * 1000;
let sessionStoragePreparedPromise: Promise<string> | null = null;

export interface RedboxUserProfile {
  id?: string;
  phone?: string;
  nickname?: string;
  name?: string;
  avatar_url?: string;
  [key: string]: unknown;
}

export interface RedboxAuthSession {
  accessToken: string;
  refreshToken: string;
  tokenType: string;
  expiresAt: number | null;
  user: RedboxUserProfile | null;
  apiKey: string;
  createdAt: number;
  updatedAt: number;
}

export interface RedboxWechatLoginInfo {
  enabled: boolean;
  sessionId: string;
  qrContentUrl: string;
  url: string;
  expiresIn: number;
}

export interface RedboxWechatStatusResult {
  status: 'PENDING' | 'SCANNED' | 'CONFIRMED' | 'EXPIRED' | 'FAILED';
  sessionId: string;
  session?: RedboxAuthSession;
  raw: Record<string, unknown>;
}

export interface RedboxCallRecord {
  id: string;
  model: string;
  endpoint: string;
  tokens: number;
  points: number;
  createdAt: string;
  status: string;
  raw: Record<string, unknown>;
}

export interface RedboxModelInfo {
  id: string;
  capability?: string;
  apiType?: string;
  ownedBy?: string;
}

class RedboxApiError extends Error {
  status: number;
  bodyText: string;

  constructor(message: string, status: number, bodyText = '') {
    super(message);
    this.name = 'RedboxApiError';
    this.status = status;
    this.bodyText = bodyText;
  }
}

const withTimeoutSignal = (timeoutMs = DEFAULT_TIMEOUT_MS): { signal: AbortSignal; clear: () => void } => {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(new Error(`Request timeout after ${timeoutMs}ms`));
  }, timeoutMs);
  return {
    signal: controller.signal,
    clear: () => clearTimeout(timer),
  };
};

const decodeJwtExpiresAt = (token: string): number | null => {
  const raw = String(token || '').trim();
  if (!raw.includes('.')) return null;
  try {
    const payloadSegment = raw.split('.')[1] || '';
    const normalized = payloadSegment.replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
    const decoded = Buffer.from(padded, 'base64').toString('utf8');
    const payload = JSON.parse(decoded) as { exp?: number };
    if (!Number.isFinite(payload.exp)) return null;
    return Number(payload.exp) * 1000;
  } catch {
    return null;
  }
};

const unwrapPayload = <T>(value: unknown): T => {
  if (!value || typeof value !== 'object') return value as T;
  const record = value as Record<string, unknown>;
  if (
    Object.prototype.hasOwnProperty.call(record, 'data') &&
    (
      Object.prototype.hasOwnProperty.call(record, 'success') ||
      Object.prototype.hasOwnProperty.call(record, 'code') ||
      Object.prototype.hasOwnProperty.call(record, 'message')
    )
  ) {
    return record.data as T;
  }
  return value as T;
};

const formatErrorMessage = (status: number, bodyText: string, fallback: string): string => {
  if (!bodyText) return fallback;
  try {
    const parsed = JSON.parse(bodyText) as Record<string, unknown>;
    const topMessage = String(parsed.message || '').trim();
    const errorMessage = parsed.error && typeof parsed.error === 'object'
      ? String((parsed.error as Record<string, unknown>).message || '').trim()
      : '';
    const message = topMessage || errorMessage;
    if (message) return message;
  } catch {
    // ignore invalid JSON
  }
  return bodyText.length > 300 ? `${bodyText.slice(0, 300)}...` : bodyText;
};

const normalizeGatewayRoot = (baseUrl = REDBOX_GATEWAY_BASE): string => {
  const normalized = normalizeApiBaseUrl(baseUrl, REDBOX_GATEWAY_BASE);
  if (!normalized) return REDBOX_GATEWAY_BASE;
  try {
    const url = new URL(normalized);
    let pathname = String(url.pathname || '').replace(/\/+$/, '');
    pathname = pathname.replace(new RegExp(`/${REDBOX_APP_SLUG}/v1$`, 'i'), '');
    pathname = pathname.replace(new RegExp(`/${REDBOX_APP_SLUG}$`, 'i'), '');
    pathname = pathname.replace(/\/(api\/)?v1$/i, '');
    url.pathname = pathname || '/';
    url.search = '';
    url.hash = '';
    return url.toString().replace(/\/+$/, '');
  } catch {
    return normalized
      .replace(new RegExp(`/${REDBOX_APP_SLUG}/v1$`, 'i'), '')
      .replace(new RegExp(`/${REDBOX_APP_SLUG}$`, 'i'), '')
      .replace(/\/(api\/)?v1$/i, '')
      .replace(/\/+$/, '');
  }
};

const buildTenantBase = (baseUrl = REDBOX_GATEWAY_BASE): string => {
  return `${normalizeGatewayRoot(baseUrl)}/${REDBOX_APP_SLUG}/v1`;
};

const buildOpenAiBaseCandidates = (baseUrl = REDBOX_GATEWAY_BASE): string[] => {
  const root = normalizeGatewayRoot(baseUrl);
  return [
    `${root}/v1`,
    `${root}/${REDBOX_APP_SLUG}/v1`,
    `${root}/api/v1`,
  ];
};

const buildTenantUrl = (nextPath: string, baseUrl = REDBOX_GATEWAY_BASE): string => {
  return safeUrlJoin(buildTenantBase(baseUrl), nextPath);
};

const normalizeAuthSession = (raw: unknown, previous?: RedboxAuthSession | null): RedboxAuthSession => {
  const payload = (raw && typeof raw === 'object' && Object.prototype.hasOwnProperty.call(raw as Record<string, unknown>, 'auth_payload'))
    ? ((raw as Record<string, unknown>).auth_payload as Record<string, unknown>)
    : (raw as Record<string, unknown> || {});

  const accessToken = String(payload.access_token || payload.accessToken || '').trim();
  const refreshToken = String(payload.refresh_token || payload.refreshToken || previous?.refreshToken || '').trim();
  if (!accessToken) {
    throw new Error('登录结果缺少 access_token');
  }

  const now = Date.now();
  const expiresInSec = Number(payload.expires_in || payload.expiresIn || 0);
  const explicitExpiresAt = Number(payload.expires_at || payload.expiresAt || 0);
  const decodedExpiresAt = decodeJwtExpiresAt(accessToken);
  const expiresAt = Number.isFinite(explicitExpiresAt) && explicitExpiresAt > 0
    ? (explicitExpiresAt > 10_000_000_000 ? explicitExpiresAt : explicitExpiresAt * 1000)
    : (Number.isFinite(expiresInSec) && expiresInSec > 0 ? now + (expiresInSec * 1000) : decodedExpiresAt);

  return {
    accessToken,
    refreshToken,
    tokenType: String(payload.token_type || payload.tokenType || previous?.tokenType || 'Bearer').trim() || 'Bearer',
    expiresAt: Number.isFinite(expiresAt || 0) ? Number(expiresAt) : null,
    user: (payload.user && typeof payload.user === 'object')
      ? (payload.user as RedboxUserProfile)
      : (previous?.user || null),
    apiKey: String(payload.api_key || payload.apiKey || previous?.apiKey || '').trim(),
    createdAt: previous?.createdAt || now,
    updatedAt: now,
  };
};

const readSessionFile = async (): Promise<RedboxAuthSession | null> => {
  try {
    const sessionFilePath = await ensureSessionStoragePrepared();
    const raw = await fs.readFile(sessionFilePath, 'utf8');
    const parsed = JSON.parse(raw) as RedboxAuthSession;
    if (!parsed || typeof parsed !== 'object') return null;
    if (!parsed.accessToken) return null;
    return {
      ...parsed,
      refreshToken: String(parsed.refreshToken || '').trim(),
      tokenType: String(parsed.tokenType || 'Bearer').trim() || 'Bearer',
      expiresAt: Number.isFinite(Number(parsed.expiresAt)) ? Number(parsed.expiresAt) : null,
      apiKey: String(parsed.apiKey || '').trim(),
      user: parsed.user || null,
      createdAt: Number(parsed.createdAt || Date.now()),
      updatedAt: Number(parsed.updatedAt || Date.now()),
    };
  } catch {
    return null;
  }
};

const writeSessionFile = async (sessionData: RedboxAuthSession): Promise<void> => {
  const sessionFilePath = await ensureSessionStoragePrepared();
  await fs.mkdir(path.dirname(sessionFilePath), { recursive: true });
  await fs.writeFile(sessionFilePath, JSON.stringify(sessionData, null, 2), 'utf8');
};

const clearSessionFile = async (): Promise<void> => {
  for (const candidate of getSessionFileCandidates()) {
    try {
      await fs.unlink(candidate);
    } catch {
      // ignore
    }
  }
};

const normalizeHeadersForLog = (headers?: HeadersInit): Record<string, string> => {
  if (!headers) return {};
  if (headers instanceof Headers) {
    return Object.fromEntries(headers.entries());
  }
  if (Array.isArray(headers)) {
    return Object.fromEntries(
      headers.map(([key, value]) => [String(key), String(value)])
    );
  }
  return Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [key, String(value)])
  );
};

const normalizeBodyForLog = (body: BodyInit | null | undefined): string => {
  if (typeof body === 'string') return body;
  if (body == null) return '';
  if (body instanceof URLSearchParams) return body.toString();
  if (body instanceof FormData) {
    return JSON.stringify(
      Array.from(body.entries()).map(([key, value]) => [
        key,
        typeof value === 'string'
          ? value
          : {
              name: value.name,
              type: value.type,
              size: value.size,
            },
      ])
    );
  }
  return String(body);
};

const logRequestDebug = (tag: string, stage: string, payload: Record<string, unknown>): void => {
  try {
    console.log(`[redbox-auth][${tag}] ${stage} ${JSON.stringify(payload, null, 2)}`);
  } catch {
    console.log(`[redbox-auth][${tag}] ${stage}`, payload);
  }
};

const requestJson = async <T>(
  url: string,
  init: RequestInit,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  debugTag?: string,
): Promise<T> => {
  const { signal, clear } = withTimeoutSignal(timeoutMs);
  try {
    if (debugTag) {
      logRequestDebug(debugTag, 'request', {
        method: String(init.method || 'GET').toUpperCase(),
        url,
        timeoutMs,
        headers: normalizeHeadersForLog(init.headers),
        body: normalizeBodyForLog(init.body),
      });
    }

    const response = await fetch(url, {
      ...init,
      signal,
      headers: {
        Accept: 'application/json',
        ...(init.headers || {}),
      },
    });

    const bodyText = await response.text().catch(() => '');
    const parsed = bodyText ? (() => {
      try {
        return JSON.parse(bodyText);
      } catch {
        return bodyText;
      }
    })() : {};

    if (debugTag) {
      logRequestDebug(debugTag, 'response', {
        url,
        status: response.status,
        statusText: response.statusText,
        headers: Object.fromEntries(response.headers.entries()),
        body: bodyText,
      });
    }

    if (!response.ok) {
      const fallback = `${response.status} ${response.statusText}`.trim();
      const errorMessage = formatErrorMessage(response.status, typeof parsed === 'string' ? parsed : bodyText, fallback);
      throw new RedboxApiError(errorMessage, response.status, bodyText);
    }

    return unwrapPayload<T>(parsed);
  } catch (error) {
    if (debugTag) {
      logRequestDebug(debugTag, 'error', {
        url,
        name: error instanceof Error ? error.name : 'UnknownError',
        message: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : '',
      });
    }
    if (error instanceof RedboxApiError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(message);
  } finally {
    clear();
  }
};

const isSessionExpiringSoon = (sessionData: RedboxAuthSession): boolean => {
  if (!sessionData.expiresAt || !Number.isFinite(sessionData.expiresAt)) return false;
  return Date.now() >= (sessionData.expiresAt - REFRESH_AHEAD_MS);
};

const refreshAccessTokenInternal = async (
  sessionData: RedboxAuthSession,
  baseUrl = REDBOX_GATEWAY_BASE,
): Promise<RedboxAuthSession> => {
  if (!sessionData.refreshToken) {
    throw new Error('当前登录态缺少 refresh_token，请重新登录');
  }

  const endpointCandidates = [
    '/auth/refresh',
    '/auth/refresh-token',
    '/auth/token/refresh',
    '/auth/refresh_token',
  ];
  const errors: string[] = [];
  let lastAuthError: RedboxApiError | null = null;

  for (const endpoint of endpointCandidates) {
    const url = buildTenantUrl(endpoint, baseUrl);
    try {
      const data = await requestJson<Record<string, unknown>>(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${sessionData.accessToken}`,
        },
        body: JSON.stringify({
          refresh_token: sessionData.refreshToken,
          refreshToken: sessionData.refreshToken,
        }),
      });
      const nextSession = normalizeAuthSession(data, sessionData);
      await writeSessionFile(nextSession);
      return nextSession;
    } catch (error) {
      if (error instanceof RedboxApiError && [400, 401, 403].includes(error.status)) {
        lastAuthError = error;
      }
      const message = error instanceof Error ? error.message : String(error);
      errors.push(`${endpoint}: ${message}`);
      continue;
    }
  }

  if (lastAuthError) {
    throw new RedboxApiError(
      lastAuthError.message || '刷新令牌已失效，请重新登录',
      lastAuthError.status,
      lastAuthError.bodyText,
    );
  }

  throw new Error(`令牌刷新失败，请重新登录。${errors.slice(0, 2).join(' | ')}`);
};

const ensureFreshSession = async (baseUrl = REDBOX_GATEWAY_BASE): Promise<RedboxAuthSession> => {
  const sessionData = await readSessionFile();
  if (!sessionData || !sessionData.accessToken) {
    throw new Error('当前未登录，请先登录官方账号');
  }
  const decodedExpiresAt = decodeJwtExpiresAt(sessionData.accessToken);
  const effectiveExpiresAt = Number.isFinite(Number(sessionData.expiresAt))
    ? Number(sessionData.expiresAt)
    : decodedExpiresAt;

  if (effectiveExpiresAt && Number.isFinite(effectiveExpiresAt)) {
    const patchedExpiresAt = Number(sessionData.expiresAt || 0);
    if (!Number.isFinite(patchedExpiresAt) || patchedExpiresAt !== effectiveExpiresAt) {
      await writeSessionFile({
        ...sessionData,
        expiresAt: effectiveExpiresAt,
        updatedAt: Date.now(),
      });
    }
    if (Date.now() < (effectiveExpiresAt - REFRESH_AHEAD_MS)) {
      return sessionData;
    }
    return refreshAccessTokenInternal(sessionData, baseUrl);
  }

  // Missing exp claim: keep existing token first, and rely on 401-triggered refresh in authorizedRequest.
  return sessionData;
};

const authorizedRequest = async <T>(
  run: (accessToken: string, sessionData: RedboxAuthSession) => Promise<T>,
  baseUrl = REDBOX_GATEWAY_BASE,
): Promise<T> => {
  let sessionData = await ensureFreshSession(baseUrl);
  try {
    return await run(sessionData.accessToken, sessionData);
  } catch (error) {
    if (error instanceof RedboxApiError && error.status === 401 && sessionData.refreshToken) {
      sessionData = await refreshAccessTokenInternal(sessionData, baseUrl);
      return run(sessionData.accessToken, sessionData);
    }
    throw error;
  }
};

export const getRedboxGatewayBase = (): string => REDBOX_GATEWAY_BASE;

export const getRedboxAuthSession = async (): Promise<RedboxAuthSession | null> => {
  return readSessionFile();
};

export const hydrateRedboxAuthSessionOnStartup = async (
  baseUrl = REDBOX_GATEWAY_BASE,
): Promise<{ session: RedboxAuthSession | null; refreshed: boolean; cleared: boolean }> => {
  const sessionData = await readSessionFile();
  if (!sessionData || !sessionData.accessToken) {
    return { session: null, refreshed: false, cleared: false };
  }

  if (!isSessionExpiringSoon(sessionData)) {
    return { session: sessionData, refreshed: false, cleared: false };
  }

  try {
    const refreshed = await refreshAccessTokenInternal(sessionData, baseUrl);
    return { session: refreshed, refreshed: true, cleared: false };
  } catch (error) {
    if (error instanceof RedboxApiError && [400, 401, 403].includes(error.status)) {
      await clearSessionFile();
      return { session: null, refreshed: false, cleared: true };
    }
    console.warn('[redbox-auth] startup session refresh failed, keeping existing session:', error);
    return { session: sessionData, refreshed: false, cleared: false };
  }
};

export const logoutRedboxAuthSession = async (): Promise<void> => {
  await clearSessionFile();
};

export const sendRedboxSmsCode = async (phone: string, baseUrl = REDBOX_GATEWAY_BASE): Promise<void> => {
  const normalizedPhone = String(phone || '').trim();
  if (!normalizedPhone) {
    throw new Error('手机号不能为空');
  }
  await requestJson(buildTenantUrl('/auth/send-sms-code', baseUrl), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone: normalizedPhone }),
  });
};

export const loginRedboxBySms = async (
  payload: { phone: string; code: string; inviteCode?: string },
  baseUrl = REDBOX_GATEWAY_BASE,
): Promise<RedboxAuthSession> => {
  const data = await requestJson<Record<string, unknown>>(buildTenantUrl('/auth/login/sms', baseUrl), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      phone: String(payload.phone || '').trim(),
      code: String(payload.code || '').trim(),
      invite_code: String(payload.inviteCode || '').trim() || undefined,
    }),
  });
  const sessionData = normalizeAuthSession(data);
  await writeSessionFile(sessionData);
  return sessionData;
};

export const registerRedboxBySms = async (
  payload: { phone: string; code: string; inviteCode?: string },
  baseUrl = REDBOX_GATEWAY_BASE,
): Promise<RedboxAuthSession> => {
  const data = await requestJson<Record<string, unknown>>(buildTenantUrl('/auth/register/sms', baseUrl), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      phone: String(payload.phone || '').trim(),
      code: String(payload.code || '').trim(),
      invite_code: String(payload.inviteCode || '').trim() || undefined,
    }),
  });
  const sessionData = normalizeAuthSession(data);
  await writeSessionFile(sessionData);
  return sessionData;
};

export const getRedboxWechatLoginUrl = async (
  state = 'redconvert-desktop',
  baseUrl = REDBOX_GATEWAY_BASE,
): Promise<RedboxWechatLoginInfo> => {
  const url = `${buildTenantUrl('/auth/login/wechat/url', baseUrl)}?state=${encodeURIComponent(String(state || 'redconvert-desktop'))}`;
  const data = await requestJson<Record<string, unknown>>(url, { method: 'GET' });
  return {
    enabled: Boolean(data.enabled),
    sessionId: String(data.session_id || data.sessionId || '').trim(),
    qrContentUrl: String(data.qr_content_url || data.qrContentUrl || '').trim(),
    url: String(data.url || '').trim(),
    expiresIn: Number(data.expires_in || data.expiresIn || 0) || 0,
  };
};

export const pollRedboxWechatStatus = async (
  sessionId: string,
  baseUrl = REDBOX_GATEWAY_BASE,
): Promise<RedboxWechatStatusResult> => {
  const normalizedSessionId = String(sessionId || '').trim();
  if (!normalizedSessionId) {
    throw new Error('session_id 不能为空');
  }
  const url = `${buildTenantUrl('/auth/login/wechat/status', baseUrl)}?session_id=${encodeURIComponent(normalizedSessionId)}`;
  const data = await requestJson<Record<string, unknown>>(url, { method: 'GET' });
  const status = String(data.status || '').trim().toUpperCase() as RedboxWechatStatusResult['status'];
  let sessionData: RedboxAuthSession | undefined;
  if (status === 'CONFIRMED' && data.auth_payload) {
    sessionData = normalizeAuthSession(data.auth_payload as Record<string, unknown>);
    await writeSessionFile(sessionData);
  }
  return {
    status: status || 'PENDING',
    sessionId: normalizedSessionId,
    session: sessionData,
    raw: data,
  };
};

export const loginRedboxByWechatCode = async (
  code: string,
  baseUrl = REDBOX_GATEWAY_BASE,
): Promise<RedboxAuthSession> => {
  const normalizedCode = String(code || '').trim();
  if (!normalizedCode) {
    throw new Error('微信 code 不能为空');
  }
  const data = await requestJson<Record<string, unknown>>(buildTenantUrl('/auth/login/wechat', baseUrl), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: normalizedCode }),
  });
  const sessionData = normalizeAuthSession(data);
  await writeSessionFile(sessionData);
  return sessionData;
};

export const refreshRedboxAuthSession = async (baseUrl = REDBOX_GATEWAY_BASE): Promise<RedboxAuthSession> => {
  const sessionData = await readSessionFile();
  if (!sessionData) {
    throw new Error('当前未登录');
  }
  return refreshAccessTokenInternal(sessionData, baseUrl);
};

export const getRedboxCurrentUser = async (baseUrl = REDBOX_GATEWAY_BASE): Promise<Record<string, unknown>> => {
  return authorizedRequest(async (accessToken) => {
    return requestJson<Record<string, unknown>>(buildTenantUrl('/users/me', baseUrl), {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });
  }, baseUrl);
};

export const getRedboxPoints = async (baseUrl = REDBOX_GATEWAY_BASE): Promise<Record<string, unknown>> => {
  return authorizedRequest(async (accessToken) => {
    return requestJson<Record<string, unknown>>(buildTenantUrl('/users/me/points', baseUrl), {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    }, DEFAULT_TIMEOUT_MS, 'points');
  }, baseUrl);
};

export const listRedboxProducts = async (baseUrl = REDBOX_GATEWAY_BASE): Promise<Array<Record<string, unknown>>> => {
  const data = await authorizedRequest(async (accessToken) => {
    return requestJson<unknown>(buildTenantUrl('/payments/products', baseUrl), {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });
  }, baseUrl);

  if (Array.isArray(data)) {
    return data.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === 'object'));
  }
  if (data && typeof data === 'object') {
    const record = data as Record<string, unknown>;
    const products = Array.isArray(record.items) ? record.items : Array.isArray(record.products) ? record.products : [];
    return products.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === 'object'));
  }
  return [];
};

export const createRedboxPagePayOrder = async (
  payload: { productId?: string; amount?: string | number; subject?: string; pointsToDeduct?: number },
  baseUrl = REDBOX_GATEWAY_BASE,
): Promise<Record<string, unknown>> => {
  const productId = String(payload.productId || '').trim();
  const normalizedAmountRaw = typeof payload.amount === 'string'
    ? payload.amount.trim()
    : (Number.isFinite(Number(payload.amount)) ? String(payload.amount) : '');
  const amountNumber = Number(normalizedAmountRaw || 0);
  const amount = Number.isFinite(amountNumber) && amountNumber > 0
    ? amountNumber.toFixed(2)
    : '';

  if (!productId && !amount) {
    throw new Error('创建充值订单失败：product_id 与 amount 不能同时为空');
  }

  return authorizedRequest(async (accessToken) => {
    return requestJson<Record<string, unknown>>(buildTenantUrl('/payments/orders/page-pay', baseUrl), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        product_id: productId || undefined,
        amount: amount || undefined,
        subject: String(payload.subject || '').trim() || (amount ? '积分充值' : undefined),
        points_to_deduct: Number.isFinite(Number(payload.pointsToDeduct))
          ? Math.max(0, Math.floor(Number(payload.pointsToDeduct)))
          : 0,
      }),
    });
  }, baseUrl);
};

export const createRedboxWechatNativeOrder = async (
  payload: { productId?: string; amount?: string | number; description?: string },
  baseUrl = REDBOX_GATEWAY_BASE,
): Promise<Record<string, unknown>> => {
  const productId = String(payload.productId || '').trim();
  const normalizedAmountRaw = typeof payload.amount === 'string'
    ? payload.amount.trim()
    : (Number.isFinite(Number(payload.amount)) ? String(payload.amount) : '');
  const amountNumber = Number(normalizedAmountRaw || 0);
  const amount = Number.isFinite(amountNumber) && amountNumber > 0
    ? amountNumber.toFixed(2)
    : '';

  if (!productId && !amount) {
    throw new Error('创建微信支付订单失败：product_id 与 amount 不能同时为空');
  }

  return authorizedRequest(async (accessToken) => {
    return requestJson<Record<string, unknown>>(buildTenantUrl('/payments/orders/wechat/native', baseUrl), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        product_id: productId || undefined,
        amount: amount || undefined,
        description: String(payload.description || '').trim() || (amount ? '积分充值' : undefined),
      }),
    });
  }, baseUrl);
};

export const getRedboxOrderStatus = async (outTradeNo: string, baseUrl = REDBOX_GATEWAY_BASE): Promise<Record<string, unknown>> => {
  const normalizedTradeNo = String(outTradeNo || '').trim();
  if (!normalizedTradeNo) {
    throw new Error('out_trade_no 不能为空');
  }
  return authorizedRequest(async (accessToken) => {
    return requestJson<Record<string, unknown>>(buildTenantUrl(`/payments/orders/${encodeURIComponent(normalizedTradeNo)}`, baseUrl), {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });
  }, baseUrl);
};

export const listRedboxApiKeys = async (baseUrl = REDBOX_GATEWAY_BASE): Promise<Array<Record<string, unknown>>> => {
  const data = await authorizedRequest(async (accessToken) => {
    return requestJson<unknown>(buildTenantUrl('/users/me/api-keys', baseUrl), {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });
  }, baseUrl);

  if (Array.isArray(data)) {
    return data.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === 'object'));
  }
  if (data && typeof data === 'object') {
    const record = data as Record<string, unknown>;
    const keys = Array.isArray(record.items) ? record.items : Array.isArray(record.keys) ? record.keys : [];
    return keys.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === 'object'));
  }
  return [];
};

export const createRedboxApiKey = async (
  name: string,
  baseUrl = REDBOX_GATEWAY_BASE,
): Promise<{ keyId: string; key: string; name: string }> => {
  const normalizedName = String(name || '').trim() || `RedBox Desktop ${new Date().toISOString().slice(0, 10)}`;

  const data = await authorizedRequest(async (accessToken, sessionData) => {
    const created = await requestJson<Record<string, unknown>>(buildTenantUrl('/users/me/api-keys', baseUrl), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ name: normalizedName }),
    });

    const key = String(created.key || '').trim();
    if (key) {
      const nextSession: RedboxAuthSession = {
        ...sessionData,
        apiKey: key,
        updatedAt: Date.now(),
      };
      await writeSessionFile(nextSession);
    }

    return created;
  }, baseUrl);

  return {
    keyId: String(data.id || data.key_id || '').trim(),
    key: String(data.key || '').trim(),
    name: String(data.name || normalizedName).trim(),
  };
};

const extractRawApiKeyFromPayload = (payload: Record<string, unknown> | null | undefined): string => {
  if (!payload || typeof payload !== 'object') return '';
  const direct = String(payload.key || payload.api_key || payload.token || '').trim();
  if (direct) return direct;
  const nested = payload.api_key;
  if (nested && typeof nested === 'object') {
    return String((nested as Record<string, unknown>).key || (nested as Record<string, unknown>).token || '').trim();
  }
  return '';
};

export const ensureRedboxSessionApiKey = async (
  name = 'RedBox Desktop',
  baseUrl = REDBOX_GATEWAY_BASE,
): Promise<{ key: string; source: 'session' | 'ensure-default' | 'create' }> => {
  let sessionData = await ensureFreshSession(baseUrl);
  const existing = String(sessionData.apiKey || '').trim();
  if (existing.startsWith('rbx_')) {
    return { key: existing, source: 'session' };
  }

  try {
    const ensured = await authorizedRequest(async (accessToken, currentSession) => {
      return requestJson<Record<string, unknown>>(buildTenantUrl('/users/me/api-keys/ensure-default', baseUrl), {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ name: String(name || '').trim() || 'RedBox Desktop' }),
      });
    }, baseUrl);
    const ensuredKey = extractRawApiKeyFromPayload(ensured);
    if (ensuredKey.startsWith('rbx_')) {
      const nextSession: RedboxAuthSession = {
        ...sessionData,
        apiKey: ensuredKey,
        updatedAt: Date.now(),
      };
      await writeSessionFile(nextSession);
      return { key: ensuredKey, source: 'ensure-default' };
    }
  } catch {
    // fallback to explicit create
  }

  const created = await createRedboxApiKey(name, baseUrl);
  const createdKey = String(created.key || '').trim();
  if (!createdKey.startsWith('rbx_')) {
    throw new Error('自动创建 API Key 失败：返回值缺少 rbx_ 前缀 key');
  }
  return { key: createdKey, source: 'create' };
};

export const setRedboxSessionApiKey = async (apiKey: string): Promise<RedboxAuthSession> => {
  const sessionData = await readSessionFile();
  if (!sessionData) {
    throw new Error('当前未登录');
  }
  const nextSession: RedboxAuthSession = {
    ...sessionData,
    apiKey: String(apiKey || '').trim(),
    updatedAt: Date.now(),
  };
  await writeSessionFile(nextSession);
  return nextSession;
};

export const fetchRedboxModels = async (baseUrl = REDBOX_GATEWAY_BASE): Promise<RedboxModelInfo[]> => {
  const candidates = buildOpenAiBaseCandidates(baseUrl).map((base) => safeUrlJoin(base, '/models'));
  const errors: string[] = [];
  for (const endpoint of candidates) {
    try {
      const data = await authorizedRequest(async (accessToken, sessionData) => {
        const bearer = String(sessionData.apiKey || accessToken || '').trim();
        return requestJson<unknown>(endpoint, {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${bearer}`,
            'Content-Type': 'application/json',
          },
        });
      }, baseUrl);
      const root = (data && typeof data === 'object') ? (data as Record<string, unknown>) : {};
      const modelItems = Array.isArray(root.data) ? root.data : [];
      const models = modelItems.reduce<RedboxModelInfo[]>((acc, item) => {
        if (!item || typeof item !== 'object') return acc;
        const record = item as Record<string, unknown>;
        const id = String(record.id || record.name || '').trim();
        if (!id) return acc;
        acc.push({
          id,
          capability: String(record.capability || '').trim() || undefined,
          apiType: String(record.api_type || record.apiType || '').trim() || undefined,
          ownedBy: String(record.owned_by || record.ownedBy || '').trim() || undefined,
        });
        return acc;
      }, []);
      if (models.length > 0) {
        return models;
      }
      errors.push(`${endpoint}: empty`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(`${endpoint}: ${message}`);
    }
  }

  throw new Error(`拉取模型列表失败：${errors.slice(0, 2).join(' | ')}`);
};

export const parseRedboxApiError = (error: unknown): { message: string; status?: number; body?: string } => {
  if (error instanceof RedboxApiError) {
    return {
      message: error.message,
      status: error.status,
      body: error.bodyText,
    };
  }
  if (error instanceof Error) {
    return { message: error.message };
  }
  return { message: String(error) };
};

const toIsoTime = (value: unknown): string => {
  if (typeof value === 'string' && value.trim()) return value;
  const asNumber = Number(value || 0);
  if (Number.isFinite(asNumber) && asNumber > 0) {
    const timestampMs = asNumber > 10_000_000_000 ? asNumber : asNumber * 1000;
    return new Date(timestampMs).toISOString();
  }
  return new Date().toISOString();
};

const extractCallRecordsFromPayload = (payload: unknown): RedboxCallRecord[] => {
  if (!payload) return [];
  const candidates: unknown[][] = [];

  if (Array.isArray(payload)) {
    candidates.push(payload);
  } else if (typeof payload === 'object') {
    const record = payload as Record<string, unknown>;
    const arrKeys = [
      'items',
      'records',
      'usage_records',
      'call_records',
      'inference_records',
      'logs',
      'list',
      'data',
      'transactions',
      'recent_records',
    ];
    for (const key of arrKeys) {
      const value = record[key];
      if (Array.isArray(value)) {
        candidates.push(value);
      }
    }
  }

  const rows = candidates.flat().filter((item): item is Record<string, unknown> => Boolean(item && typeof item === 'object'));
  const normalized = rows.map((item, index) => {
    const id = String(item.id || item.record_id || item.log_id || item.request_id || `record_${index}`).trim();
    const model = String(item.model || item.model_name || item.modelId || '-').trim();
    const endpoint = String(item.endpoint || item.path || item.api || item.method || '-').trim();
    const tokens = Number(item.total_tokens || item.tokens || item.token || item.usage_tokens || 0);
    const points = Number(item.points || item.points_cost || item.cost_points || item.cost || 0);
    const status = String(item.status || item.state || 'success').trim();
    const createdAt = toIsoTime(item.created_at || item.createdAt || item.time || item.timestamp);
    return {
      id,
      model,
      endpoint,
      tokens: Number.isFinite(tokens) ? tokens : 0,
      points: Number.isFinite(points) ? points : 0,
      status: status || 'success',
      createdAt,
      raw: item,
    } satisfies RedboxCallRecord;
  });

  const deduped = new Map<string, RedboxCallRecord>();
  for (const item of normalized) {
    if (!deduped.has(item.id)) {
      deduped.set(item.id, item);
    }
  }
  return Array.from(deduped.values()).slice(0, 100);
};

export const listRedboxCallRecords = async (baseUrl = REDBOX_GATEWAY_BASE): Promise<RedboxCallRecord[]> => {
  const endpoints = [
    '/users/me/ai-usage-logs?page=1&limit=50',
    '/users/me/records',
    '/users/me/logs',
  ];
  const errors: string[] = [];

  for (const endpoint of endpoints) {
    try {
      const payload = await authorizedRequest(async (accessToken) => {
        return requestJson<unknown>(buildTenantUrl(endpoint, baseUrl), {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${accessToken}`,
          },
        });
      }, baseUrl);
      const records = extractCallRecordsFromPayload(payload);
      if (records.length > 0) {
        return records;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(`${endpoint}: ${message}`);
    }
  }

  try {
    const pointsPayload = await getRedboxPoints(baseUrl);
    const records = extractCallRecordsFromPayload(pointsPayload);
    if (records.length > 0) {
      return records;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    errors.push(`/users/me/points: ${message}`);
  }

  if (errors.length > 0) {
    const meaningful = errors.filter((entry) => !/cannot get\s+\/redbox\/v1\//i.test(entry));
    if (meaningful.length > 0) {
      console.warn('[redbox-auth] call records not available:', meaningful.slice(0, 3).join(' | '));
    }
  }
  return [];
};
const getLegacyUserDataDirs = (): string[] => {
  const currentUserData = path.resolve(app.getPath('userData'));
  const parentDir = path.dirname(currentUserData);
  const currentBaseName = path.basename(currentUserData);
  const candidates = [
    'RedBox',
    'red-convert-desktop',
    'RedConvert',
    'redconvert-desktop',
    'com.redbox.app',
    app.name,
  ];
  return Array.from(new Set(
    candidates
      .map((name) => String(name || '').trim())
      .filter(Boolean)
      .filter((name) => name !== currentBaseName)
      .map((name) => path.join(parentDir, name))
      .filter((candidate) => path.resolve(candidate) !== currentUserData),
  ));
};

const getSessionFileCandidates = (): string[] => {
  return [
    CURRENT_SESSION_FILE_PATH,
    ...getLegacyUserDataDirs().map((dir) => path.join(dir, 'redbox-auth-session.json')),
  ];
};

const ensureSessionStoragePrepared = async (): Promise<string> => {
  if (!sessionStoragePreparedPromise) {
    sessionStoragePreparedPromise = (async () => {
      try {
        if (fsSync.existsSync(CURRENT_SESSION_FILE_PATH) && fsSync.statSync(CURRENT_SESSION_FILE_PATH).size > 0) {
          return CURRENT_SESSION_FILE_PATH;
        }
      } catch {
        // fall through to legacy probe
      }

      for (const candidate of getSessionFileCandidates().slice(1)) {
        try {
          if (!fsSync.existsSync(candidate)) continue;
          if (fsSync.statSync(candidate).size <= 0) continue;
          await fs.mkdir(path.dirname(CURRENT_SESSION_FILE_PATH), { recursive: true });
          await fs.copyFile(candidate, CURRENT_SESSION_FILE_PATH);
          console.log(`[UserDataMigration] migrated redbox-auth-session.json from ${candidate} to ${CURRENT_SESSION_FILE_PATH}`);
          break;
        } catch (error) {
          console.warn(`[UserDataMigration] failed to migrate redbox-auth-session.json from ${candidate}:`, error);
        }
      }

      return CURRENT_SESSION_FILE_PATH;
    })();
  }

  return sessionStoragePreparedPromise;
};
