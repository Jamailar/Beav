import type {
  OfficialFeatureModule,
  OfficialFeatureRegisterContext,
  OfficialFeatureSettingsContext,
  OfficialTranscriptionAuthContext,
  OfficialTranscriptionAuthResult,
} from '../../electron/officialFeatureBridge';
import { app, BrowserWindow } from 'electron';
import fs from 'fs/promises';
import path from 'path';
import { normalizeApiBaseUrl } from '../../electron/core/urlUtils';
import {
  createRedboxApiKey,
  createRedboxPagePayOrder,
  createRedboxWechatNativeOrder,
  ensureRedboxSessionApiKey,
  fetchRedboxModels,
  hydrateRedboxAuthSessionOnStartup,
  type RedboxAuthSession,
  type RedboxModelInfo,
  getRedboxAuthSession,
  getRedboxCurrentUser,
  getRedboxGatewayBase,
  getRedboxOrderStatus,
  getRedboxPoints,
  getRedboxWechatLoginUrl,
  listRedboxApiKeys,
  listRedboxCallRecords,
  listRedboxProducts,
  loginRedboxBySms,
  loginRedboxByWechatCode,
  logoutRedboxAuthSession,
  parseRedboxApiError,
  pollRedboxWechatStatus,
  refreshRedboxAuthSession,
  registerRedboxBySms,
  sendRedboxSmsCode,
  setRedboxSessionApiKey,
} from './redboxAuthService';
import {
  REDBOX_OFFICIAL_VIDEO_BASE_URL,
  REDBOX_OFFICIAL_VIDEO_MODELS,
} from '../../shared/redboxVideo';

const REDBOX_OFFICIAL_SOURCE_ID = 'redbox_official_auto';
const REDBOX_OFFICIAL_SOURCE_NAME = 'RedBox Official';
const REDBOX_OFFICIAL_PRESET_ID = 'redbox-official';
const REDBOX_OFFICIAL_OPENAI_BASE_URL = normalizeApiBaseUrl(
  `${getRedboxGatewayBase()}/redbox/v1`,
  'https://api.ziz.hk/redbox/v1',
);
const REDBOX_OFFICIAL_DEFAULT_TEXT_MODEL = 'qwen3.5-plus';
const REDBOX_OFFICIAL_DEFAULT_ASR_MODEL = 'step-asr';
const REDBOX_OFFICIAL_DEFAULT_IMAGE_MODEL = 'qwen-image-2.0';
const REDBOX_OFFICIAL_DEFAULT_EMBEDDING_MODEL = 'text-embedding-3-small';
const OFFICIAL_AUTH_MONITOR_INTERVAL_MS = 5 * 60 * 1000;
const PAYMENT_FORM_TEMP_DIR = path.join(app.getPath('temp'), 'redbox-payment-pages');

interface MainAiSourceLike {
  id?: string;
  name?: string;
  presetId?: string;
  baseURL?: string;
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  models?: string[];
  protocol?: string;
  [key: string]: unknown;
}

let officialContext: OfficialFeatureSettingsContext | null = null;
let officialAuthMonitorTimer: ReturnType<typeof setInterval> | null = null;
let officialAuthMonitorRunning = false;

const parseMainAiSources = (raw: unknown): MainAiSourceLike[] => {
  if (Array.isArray(raw)) {
    return raw.filter((item): item is MainAiSourceLike => Boolean(item && typeof item === 'object'));
  }
  const text = String(raw || '').trim();
  if (!text) return [];
  try {
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is MainAiSourceLike => Boolean(item && typeof item === 'object'));
  } catch {
    return [];
  }
};

const isHtmlPaymentForm = (value: string): boolean => {
  const normalized = String(value || '').trim().toLowerCase();
  return normalized.startsWith('<!doctype html')
    || normalized.startsWith('<html')
    || normalized.startsWith('<form')
    || normalized.includes('<form ');
};

const buildPaymentFormHtmlDocument = (paymentForm: string): string => {
  const raw = String(paymentForm || '').trim();
  if (!raw) return '';
  if (/<html[\s>]/i.test(raw) || /<!doctype html/i.test(raw)) {
    return raw;
  }
  return [
    '<!doctype html>',
    '<html lang="zh-CN">',
    '<head>',
    '  <meta charset="utf-8" />',
    '  <meta name="viewport" content="width=device-width, initial-scale=1" />',
    '  <title>RedBox 支付跳转</title>',
    '  <style>body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;padding:24px;color:#222}button{padding:10px 16px;border-radius:10px;border:1px solid #ddd;background:#fff;cursor:pointer}</style>',
    '</head>',
    '<body>',
    '  <p>正在跳转支付页面，如未自动打开，请点击下方按钮继续。</p>',
    `  ${raw}`,
    '  <script>',
    '    (function(){',
    '      var form = document.forms[0];',
    '      if (form) {',
    '        try { form.submit(); } catch (_) {}',
    '      }',
    '    })();',
    '  </script>',
    '</body>',
    '</html>',
  ].join('\n');
};

const openPaymentFormInBrowser = async (
  shell: OfficialFeatureRegisterContext['shell'],
  paymentForm: string,
): Promise<'external-url' | 'external-html'> => {
  const normalized = String(paymentForm || '').trim();
  const preview = normalized.slice(0, 200).replace(/\s+/g, ' ');
  console.log('[redbox-auth] open-payment-form received', {
    length: normalized.length,
    preview,
    isHttpUrl: /^https?:\/\//i.test(normalized),
    isHtmlForm: isHtmlPaymentForm(normalized),
  });
  if (!normalized) {
    throw new Error('payment_form 不能为空');
  }
  if (/^https?:\/\//i.test(normalized)) {
    await shell.openExternal(normalized);
    return 'external-url';
  }
  if (!isHtmlPaymentForm(normalized)) {
    throw new Error('仅支持外部支付链接或 HTML 支付表单');
  }

  const html = buildPaymentFormHtmlDocument(normalized);
  const fileName = `payment_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.html`;
  const targetPath = path.join(PAYMENT_FORM_TEMP_DIR, fileName);
  await fs.mkdir(PAYMENT_FORM_TEMP_DIR, { recursive: true });
  await fs.writeFile(targetPath, html, 'utf8');

  const openError = await shell.openPath(targetPath);
  if (openError) {
    throw new Error(openError);
  }
  return 'external-html';
};

const normalizeModelIdList = (raw: unknown): string[] => {
  if (!Array.isArray(raw)) return [];
  const deduped = new Set<string>();
  for (const item of raw) {
    const id = String(item || '').trim();
    if (id) deduped.add(id);
  }
  return Array.from(deduped);
};

const isLikelyTranscriptionModelId = (modelId: string): boolean => {
  const id = String(modelId || '').toLowerCase();
  return id.includes('whisper')
    || id.includes('transcrib')
    || id.includes('asr')
    || id.includes('speech-to-text')
    || id.includes('stt');
};

const isLikelyImageModelId = (modelId: string): boolean => {
  const id = String(modelId || '').toLowerCase();
  return id.includes('image')
    || id.includes('dall')
    || id.includes('seedream')
    || id.includes('wan')
    || id.includes('jimeng')
    || id.includes('flux')
    || id.includes('stable')
    || id.includes('midjourney')
    || id.includes('imagen');
};

const pickPreferredOfficialModel = (
  availableModels: string[],
  current: string,
  usage: 'text' | 'transcription' | 'image',
): string => {
  const normalizedCurrent = String(current || '').trim();
  if (normalizedCurrent && availableModels.includes(normalizedCurrent)) {
    return normalizedCurrent;
  }
  if (!availableModels.length) {
    return normalizedCurrent;
  }
  if (usage === 'transcription') {
    return availableModels.find((item) => isLikelyTranscriptionModelId(item)) || availableModels[0];
  }
  if (usage === 'image') {
    return availableModels.find((item) => isLikelyImageModelId(item)) || availableModels[0];
  }
  return (
    availableModels.find((item) => !isLikelyTranscriptionModelId(item) && !isLikelyImageModelId(item))
    || availableModels.find((item) => !isLikelyTranscriptionModelId(item))
    || availableModels[0]
  );
};

const sanitizeScopedModelOverride = (availableModels: string[], current: unknown): string => {
  const normalized = String(current || '').trim();
  if (!normalized) return '';
  if (!availableModels.length) return normalized;
  return availableModels.includes(normalized) ? normalized : '';
};

const preserveNonEmptyModel = (current: unknown, fallback: string): string => {
  const normalized = String(current || '').trim();
  if (normalized) return normalized;
  return String(fallback || '').trim();
};

const isOfficialMainAiSource = (source?: MainAiSourceLike | null): boolean => {
  if (!source) return false;
  const sourceId = String(source.id || '').trim();
  const sourceName = String(source.name || '').trim();
  const sourceBase = normalizeApiBaseUrl(String(source.baseURL || source.baseUrl || '').trim());
  return (
    sourceId === REDBOX_OFFICIAL_SOURCE_ID
    || sourceName === REDBOX_OFFICIAL_SOURCE_NAME
    || sourceBase === REDBOX_OFFICIAL_OPENAI_BASE_URL
  );
};

const isOfficialGatewayEndpoint = (endpoint: string): boolean => {
  try {
    const host = new URL(endpoint).hostname.toLowerCase();
    return host === 'api.ziz.hk' || host.endsWith('.ziz.hk');
  } catch {
    return false;
  }
};

const ensureContext = (): OfficialFeatureSettingsContext => {
  if (!officialContext) {
    throw new Error('Official feature context not initialized');
  }
  return officialContext;
};

const broadcastOfficialSessionUpdate = async (
  source: 'startup' | 'monitor' | 'get-session' | 'login' | 'logout' | 'refresh' | 'api-key' | 'wechat',
  sessionHint?: RedboxAuthSession | null,
): Promise<void> => {
  const sessionData = sessionHint === undefined ? await getRedboxAuthSession() : sessionHint;
  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send('redbox-auth:session-updated', {
      source,
      session: sessionData || null,
    });
  }
};

const ensureOfficialAiRouting = async (
  sessionHint?: RedboxAuthSession | null,
  options?: { skipModelFetch?: boolean },
): Promise<{
  applied: boolean;
  baseURL: string;
  apiKeyUsed: boolean;
  modelCount: number;
}> => {
  const context = ensureContext();
  let sessionData = sessionHint || null;
  if (!sessionData) {
    try {
      sessionData = await getRedboxAuthSession();
    } catch {
      return {
        applied: false,
        baseURL: REDBOX_OFFICIAL_OPENAI_BASE_URL,
        apiKeyUsed: false,
        modelCount: 0,
      };
    }
  }
  if (!sessionData) {
    return {
      applied: false,
      baseURL: REDBOX_OFFICIAL_OPENAI_BASE_URL,
      apiKeyUsed: false,
      modelCount: 0,
    };
  }

  let effectiveApiKey = String(sessionData.apiKey || '').trim();
  if (!effectiveApiKey) {
    try {
      const ensured = await ensureRedboxSessionApiKey('RedBox Desktop');
      effectiveApiKey = String(ensured.key || '').trim();
      if (effectiveApiKey) {
        const refreshedSession = await getRedboxAuthSession();
        if (refreshedSession) {
          sessionData = refreshedSession;
        }
      }
    } catch (error) {
      const parsed = parseRedboxApiError(error);
      console.warn('[redbox-auth] ensure api key failed, fallback to access token:', parsed.message);
    }
  }
  const bearer = effectiveApiKey || String(sessionData?.accessToken || '').trim();
  if (!bearer) {
    return {
      applied: false,
      baseURL: REDBOX_OFFICIAL_OPENAI_BASE_URL,
      apiKeyUsed: false,
      modelCount: 0,
    };
  }

  let officialModels: string[] = [];
  if (!options?.skipModelFetch) {
    try {
      const officialModelInfos: RedboxModelInfo[] = await fetchRedboxModels();
      officialModels = officialModelInfos
        .map((item) => String(item.id || '').trim())
        .filter(Boolean);
    } catch (error) {
      console.warn('[redbox-auth] fetch official models failed, keep existing model settings:', error);
    }
  }

  const current = (context.getSettings() || {}) as Record<string, unknown>;
  const nextTextModel = preserveNonEmptyModel(current.model_name, REDBOX_OFFICIAL_DEFAULT_TEXT_MODEL);
  const nextTranscriptionModel = preserveNonEmptyModel(current.transcription_model, REDBOX_OFFICIAL_DEFAULT_ASR_MODEL);
  const nextImageModel = preserveNonEmptyModel(current.image_model, REDBOX_OFFICIAL_DEFAULT_IMAGE_MODEL);
  const nextEmbeddingModel = preserveNonEmptyModel(current.embedding_model, REDBOX_OFFICIAL_DEFAULT_EMBEDDING_MODEL);

  const sources = parseMainAiSources(current.ai_sources_json);
  const existingSourceIndex = sources.findIndex((item) => isOfficialMainAiSource(item));
  const existingSource = existingSourceIndex >= 0 ? sources[existingSourceIndex] : null;
  const nextOfficialSource: MainAiSourceLike = {
    ...(existingSource || {}),
    id: String(existingSource?.id || REDBOX_OFFICIAL_SOURCE_ID).trim() || REDBOX_OFFICIAL_SOURCE_ID,
    name: REDBOX_OFFICIAL_SOURCE_NAME,
    presetId: REDBOX_OFFICIAL_PRESET_ID,
    baseURL: REDBOX_OFFICIAL_OPENAI_BASE_URL,
    apiKey: bearer,
    protocol: 'openai',
    model: preserveNonEmptyModel(existingSource?.model, nextTextModel),
    models: normalizeModelIdList([
      ...(normalizeModelIdList(existingSource?.models)),
      ...officialModels,
      nextTextModel,
      nextTranscriptionModel,
      nextImageModel,
      nextEmbeddingModel,
    ]),
  };
  const nextSources = existingSourceIndex >= 0
    ? sources.map((item, index) => (index === existingSourceIndex ? nextOfficialSource : item))
    : [...sources, nextOfficialSource];

  const nextSettings: Record<string, unknown> = {
    ...current,
    api_endpoint: REDBOX_OFFICIAL_OPENAI_BASE_URL,
    api_key: bearer,
    model_name: nextTextModel,
    model_name_wander: sanitizeScopedModelOverride(officialModels, current.model_name_wander),
    model_name_chatroom: sanitizeScopedModelOverride(officialModels, current.model_name_chatroom),
    model_name_knowledge: sanitizeScopedModelOverride(officialModels, current.model_name_knowledge),
    model_name_redclaw: sanitizeScopedModelOverride(officialModels, current.model_name_redclaw),
    transcription_endpoint: REDBOX_OFFICIAL_OPENAI_BASE_URL,
    transcription_key: bearer,
    transcription_model: nextTranscriptionModel,
    embedding_endpoint: REDBOX_OFFICIAL_OPENAI_BASE_URL,
    embedding_key: bearer,
    embedding_model: nextEmbeddingModel,
    image_provider: 'openai-compatible',
    image_provider_template: 'openai-images',
    image_endpoint: REDBOX_OFFICIAL_OPENAI_BASE_URL,
    image_api_key: bearer,
    image_model: nextImageModel,
    video_endpoint: REDBOX_OFFICIAL_VIDEO_BASE_URL,
    video_api_key: bearer,
    video_model: REDBOX_OFFICIAL_VIDEO_MODELS['text-to-video'],
    ai_sources_json: JSON.stringify(nextSources),
    default_ai_source_id: nextOfficialSource.id,
  };

  context.saveSettings(context.normalizeSettingsInput(nextSettings));
  console.log('[redbox-auth] official AI routing synced', {
    baseURL: REDBOX_OFFICIAL_OPENAI_BASE_URL,
    apiKeyUsed: Boolean(effectiveApiKey),
    modelCount: officialModels.length,
  });
  return {
    applied: true,
    baseURL: REDBOX_OFFICIAL_OPENAI_BASE_URL,
    apiKeyUsed: Boolean(effectiveApiKey),
    modelCount: officialModels.length,
  };
};

const clearOfficialAiRouting = (): {
  cleared: boolean;
  fallbackSourceId: string;
  baseURL: string;
} => {
  const context = ensureContext();
  const current = (context.getSettings() || {}) as Record<string, unknown>;
  const sources = parseMainAiSources(current.ai_sources_json);
  const nonOfficialSources = sources.filter((item) => !isOfficialMainAiSource(item));
  const currentDefaultSourceId = String(current.default_ai_source_id || '').trim();
  const fallbackSource = nonOfficialSources.find((item) => String(item.id || '').trim() === currentDefaultSourceId) || nonOfficialSources[0] || null;
  const fallbackBaseURL = normalizeApiBaseUrl(String(fallbackSource?.baseURL || fallbackSource?.baseUrl || ''));
  const fallbackApiKey = String(fallbackSource?.apiKey || '').trim();
  const fallbackModels = normalizeModelIdList(fallbackSource?.models);
  const fallbackTextModel = String(fallbackSource?.model || fallbackModels[0] || '').trim();
  const fallbackTranscriptionModel = pickPreferredOfficialModel(fallbackModels, fallbackTextModel, 'transcription');
  const fallbackImageModel = pickPreferredOfficialModel(fallbackModels, fallbackTextModel, 'image');

  const nextSettings: Record<string, unknown> = {
    ...current,
    api_endpoint: fallbackBaseURL,
    api_key: fallbackApiKey,
    model_name: fallbackTextModel,
    model_name_wander: '',
    model_name_chatroom: '',
    model_name_knowledge: '',
    model_name_redclaw: '',
    transcription_endpoint: fallbackBaseURL,
    transcription_key: fallbackApiKey,
    transcription_model: fallbackTranscriptionModel,
    embedding_endpoint: fallbackBaseURL,
    embedding_key: fallbackApiKey,
    embedding_model: fallbackTextModel,
    image_provider: fallbackBaseURL ? 'openai-compatible' : '',
    image_provider_template: fallbackBaseURL ? 'openai-images' : '',
    image_endpoint: fallbackBaseURL,
    image_api_key: fallbackApiKey,
    image_model: fallbackImageModel,
    video_endpoint: REDBOX_OFFICIAL_VIDEO_BASE_URL,
    video_api_key: '',
    video_model: REDBOX_OFFICIAL_VIDEO_MODELS['text-to-video'],
    ai_sources_json: JSON.stringify(nonOfficialSources),
    default_ai_source_id: String(fallbackSource?.id || '').trim(),
  };

  context.saveSettings(context.normalizeSettingsInput(nextSettings));
  console.log('[redbox-auth] official AI routing cleared', {
    fallbackSourceId: String(fallbackSource?.id || '').trim(),
    remainingSourceCount: nonOfficialSources.length,
    baseURL: fallbackBaseURL,
  });
  return {
    cleared: true,
    fallbackSourceId: String(fallbackSource?.id || '').trim(),
    baseURL: fallbackBaseURL,
  };
};

const syncOfficialRoutingForSession = async (
  sessionData?: RedboxAuthSession | null,
  options?: { skipModelFetch?: boolean },
): Promise<{ routeSynced: boolean; session: RedboxAuthSession | null }> => {
  const effectiveSession = sessionData === undefined ? await getRedboxAuthSession() : sessionData;
  if (effectiveSession?.accessToken) {
    await ensureOfficialAiRouting(effectiveSession, options);
    return {
      routeSynced: true,
      session: (await getRedboxAuthSession()) || effectiveSession,
    };
  }
  clearOfficialAiRouting();
  return { routeSynced: false, session: null };
};

const startOfficialAuthMonitor = (): void => {
  if (officialAuthMonitorTimer) {
    clearInterval(officialAuthMonitorTimer);
  }
  officialAuthMonitorTimer = setInterval(async () => {
    if (officialAuthMonitorRunning) return;
    officialAuthMonitorRunning = true;
    try {
      const { session } = await hydrateRedboxAuthSessionOnStartup();
      const synced = await syncOfficialRoutingForSession(session, { skipModelFetch: true });
      await broadcastOfficialSessionUpdate('monitor', synced.session);
    } catch (error) {
      console.warn('[redbox-auth] background session monitor failed:', error);
    } finally {
      officialAuthMonitorRunning = false;
    }
  }, OFFICIAL_AUTH_MONITOR_INTERVAL_MS);
};

const registerOfficialFeatures = async (context: OfficialFeatureRegisterContext): Promise<void> => {
  officialContext = context;

  context.ipcMain.handle('redbox-auth:get-config', async () => ({
    success: true,
    gatewayBase: getRedboxGatewayBase(),
    appSlug: 'redbox',
    defaultWechatState: 'redconvert-desktop',
  }));

  context.ipcMain.handle('redbox-auth:get-session-cached', async () => {
    try {
      const sessionData = await getRedboxAuthSession();
      return {
        success: true,
        session: sessionData || null,
      };
    } catch (error) {
      const parsed = parseRedboxApiError(error);
      return { success: false, error: parsed.message, status: parsed.status, body: parsed.body };
    }
  });

  context.ipcMain.handle('redbox-auth:get-session', async () => {
    try {
      const { session: sessionData } = await hydrateRedboxAuthSessionOnStartup();
      let routeSynced = false;
      let routeSyncWarning = '';
      let latestSession: RedboxAuthSession | null = null;
      try {
        const synced = await syncOfficialRoutingForSession(sessionData, { skipModelFetch: false });
        routeSynced = synced.routeSynced;
        latestSession = synced.session;
      } catch (error) {
        const parsed = parseRedboxApiError(error);
        routeSyncWarning = parsed.message;
        latestSession = (await getRedboxAuthSession()) || sessionData || null;
        console.warn('[redbox-auth] get-session route sync warning:', parsed.message);
      }
      await broadcastOfficialSessionUpdate('get-session', latestSession);
      return {
        success: true,
        session: latestSession || sessionData || null,
        routeSynced,
        routeSyncWarning: routeSyncWarning || undefined,
      };
    } catch (error) {
      const parsed = parseRedboxApiError(error);
      return { success: false, error: parsed.message, status: parsed.status, body: parsed.body };
    }
  });

  context.ipcMain.handle('redbox-auth:logout', async () => {
    try {
      await logoutRedboxAuthSession();
      const routing = clearOfficialAiRouting();
      await broadcastOfficialSessionUpdate('logout', null);
      return { success: true, routing };
    } catch (error) {
      const parsed = parseRedboxApiError(error);
      return { success: false, error: parsed.message, status: parsed.status, body: parsed.body };
    }
  });

  context.ipcMain.handle('redbox-auth:send-sms-code', async (_, payload?: { phone?: string }) => {
    try {
      await sendRedboxSmsCode(String(payload?.phone || '').trim());
      return { success: true };
    } catch (error) {
      const parsed = parseRedboxApiError(error);
      return { success: false, error: parsed.message, status: parsed.status, body: parsed.body };
    }
  });

  context.ipcMain.handle('redbox-auth:login-sms', async (_, payload?: { phone?: string; code?: string; inviteCode?: string }) => {
    try {
      const sessionData = await loginRedboxBySms({
        phone: String(payload?.phone || '').trim(),
        code: String(payload?.code || '').trim(),
        inviteCode: String(payload?.inviteCode || '').trim() || undefined,
      });
      const synced = await syncOfficialRoutingForSession(sessionData);
      const latestSession = synced.session;
      await broadcastOfficialSessionUpdate('login', latestSession);
      return { success: true, session: latestSession, routeSynced: true };
    } catch (error) {
      const parsed = parseRedboxApiError(error);
      return { success: false, error: parsed.message, status: parsed.status, body: parsed.body };
    }
  });

  context.ipcMain.handle('redbox-auth:register-sms', async (_, payload?: { phone?: string; code?: string; inviteCode?: string }) => {
    try {
      const sessionData = await registerRedboxBySms({
        phone: String(payload?.phone || '').trim(),
        code: String(payload?.code || '').trim(),
        inviteCode: String(payload?.inviteCode || '').trim() || undefined,
      });
      const synced = await syncOfficialRoutingForSession(sessionData);
      const latestSession = synced.session;
      await broadcastOfficialSessionUpdate('login', latestSession);
      return { success: true, session: latestSession, routeSynced: true };
    } catch (error) {
      const parsed = parseRedboxApiError(error);
      return { success: false, error: parsed.message, status: parsed.status, body: parsed.body };
    }
  });

  context.ipcMain.handle('redbox-auth:wechat-url', async (_, payload?: { state?: string }) => {
    try {
      const data = await getRedboxWechatLoginUrl(String(payload?.state || 'redconvert-desktop').trim() || 'redconvert-desktop');
      return { success: true, data };
    } catch (error) {
      const parsed = parseRedboxApiError(error);
      return { success: false, error: parsed.message, status: parsed.status, body: parsed.body };
    }
  });

  context.ipcMain.handle('redbox-auth:wechat-status', async (_, payload?: { sessionId?: string }) => {
    try {
      const data = await pollRedboxWechatStatus(String(payload?.sessionId || '').trim());
      if (data.session) {
        const synced = await syncOfficialRoutingForSession(data.session);
        data.session = synced.session || undefined;
        await broadcastOfficialSessionUpdate('wechat', synced.session);
      }
      return { success: true, data };
    } catch (error) {
      const parsed = parseRedboxApiError(error);
      return { success: false, error: parsed.message, status: parsed.status, body: parsed.body };
    }
  });

  context.ipcMain.handle('redbox-auth:login-wechat-code', async (_, payload?: { code?: string }) => {
    try {
      const data = await loginRedboxByWechatCode(String(payload?.code || '').trim());
      const synced = await syncOfficialRoutingForSession(data);
      const latestSession = synced.session;
      await broadcastOfficialSessionUpdate('login', latestSession);
      return { success: true, session: latestSession, routeSynced: true };
    } catch (error) {
      const parsed = parseRedboxApiError(error);
      return { success: false, error: parsed.message, status: parsed.status, body: parsed.body };
    }
  });

  context.ipcMain.handle('redbox-auth:refresh', async () => {
    try {
      const sessionData = await refreshRedboxAuthSession();
      const synced = await syncOfficialRoutingForSession(sessionData);
      const latestSession = synced.session;
      await broadcastOfficialSessionUpdate('refresh', latestSession);
      return { success: true, session: latestSession, routeSynced: true };
    } catch (error) {
      const parsed = parseRedboxApiError(error);
      return { success: false, error: parsed.message, status: parsed.status, body: parsed.body };
    }
  });

  context.ipcMain.handle('redbox-auth:me', async () => {
    try {
      const user = await getRedboxCurrentUser();
      return { success: true, user };
    } catch (error) {
      const parsed = parseRedboxApiError(error);
      return { success: false, error: parsed.message, status: parsed.status, body: parsed.body };
    }
  });

  context.ipcMain.handle('redbox-auth:points', async () => {
    try {
      const points = await getRedboxPoints();
      return { success: true, points };
    } catch (error) {
      const parsed = parseRedboxApiError(error);
      return { success: false, error: parsed.message, status: parsed.status, body: parsed.body };
    }
  });

  context.ipcMain.handle('redbox-auth:models', async () => {
    try {
      const models = await fetchRedboxModels();
      return { success: true, models };
    } catch (error) {
      const parsed = parseRedboxApiError(error);
      return { success: false, error: parsed.message, status: parsed.status, body: parsed.body, models: [] };
    }
  });

  context.ipcMain.handle('redbox-auth:api-keys:list', async () => {
    try {
      const keys = await listRedboxApiKeys();
      return { success: true, keys };
    } catch (error) {
      const parsed = parseRedboxApiError(error);
      return { success: false, error: parsed.message, status: parsed.status, body: parsed.body, keys: [] };
    }
  });

  context.ipcMain.handle('redbox-auth:api-keys:create', async (_, payload?: { name?: string }) => {
    try {
      const data = await createRedboxApiKey(String(payload?.name || '').trim());
      return { success: true, data };
    } catch (error) {
      const parsed = parseRedboxApiError(error);
      return { success: false, error: parsed.message, status: parsed.status, body: parsed.body };
    }
  });

  context.ipcMain.handle('redbox-auth:api-keys:set-current', async (_, payload?: { apiKey?: string }) => {
    try {
      const sessionData = await setRedboxSessionApiKey(String(payload?.apiKey || '').trim());
      const synced = await syncOfficialRoutingForSession(sessionData);
      const latestSession = synced.session;
      await broadcastOfficialSessionUpdate('api-key', latestSession);
      return { success: true, session: latestSession, routeSynced: true };
    } catch (error) {
      const parsed = parseRedboxApiError(error);
      return { success: false, error: parsed.message, status: parsed.status, body: parsed.body };
    }
  });

  context.ipcMain.handle('redbox-auth:products', async () => {
    try {
      const products = await listRedboxProducts();
      return { success: true, products };
    } catch (error) {
      const parsed = parseRedboxApiError(error);
      return { success: false, error: parsed.message, status: parsed.status, body: parsed.body, products: [] };
    }
  });

  context.ipcMain.handle('redbox-auth:call-records', async () => {
    try {
      const records = await listRedboxCallRecords();
      return { success: true, records };
    } catch (error) {
      const parsed = parseRedboxApiError(error);
      return { success: false, error: parsed.message, status: parsed.status, body: parsed.body, records: [] };
    }
  });

  context.ipcMain.handle('redbox-auth:create-page-pay-order', async (_, payload?: {
    productId?: string;
    amount?: string | number;
    subject?: string;
    pointsToDeduct?: number;
  }) => {
    try {
      const order = await createRedboxPagePayOrder({
        productId: String(payload?.productId || '').trim(),
        amount: payload?.amount,
        subject: String(payload?.subject || '').trim(),
        pointsToDeduct: Number(payload?.pointsToDeduct || 0),
      });
      return { success: true, order };
    } catch (error) {
      const parsed = parseRedboxApiError(error);
      return { success: false, error: parsed.message, status: parsed.status, body: parsed.body };
    }
  });

  context.ipcMain.handle('redbox-auth:create-wechat-native-order', async (_, payload?: {
    productId?: string;
    amount?: string | number;
    description?: string;
  }) => {
    try {
      const order = await createRedboxWechatNativeOrder({
        productId: String(payload?.productId || '').trim(),
        amount: payload?.amount,
        description: String(payload?.description || '').trim(),
      });
      return { success: true, order };
    } catch (error) {
      const parsed = parseRedboxApiError(error);
      return { success: false, error: parsed.message, status: parsed.status, body: parsed.body };
    }
  });

  context.ipcMain.handle('redbox-auth:order-status', async (_, payload?: { outTradeNo?: string }) => {
    try {
      const order = await getRedboxOrderStatus(String(payload?.outTradeNo || '').trim());
      return { success: true, order };
    } catch (error) {
      const parsed = parseRedboxApiError(error);
      return { success: false, error: parsed.message, status: parsed.status, body: parsed.body };
    }
  });

  context.ipcMain.handle('redbox-auth:open-payment-form', async (_, payload?: { paymentForm?: string }) => {
    try {
      const opened = await openPaymentFormInBrowser(context.shell, String(payload?.paymentForm || '').trim());
      return { success: true, opened };
    } catch (error) {
      console.error('[redbox-auth] open-payment-form failed', error);
      const parsed = parseRedboxApiError(error);
      return { success: false, error: parsed.message, status: parsed.status, body: parsed.body };
    }
  });
};

const syncOfficialAiRoutingOnStartup = async (context: OfficialFeatureSettingsContext): Promise<void> => {
  officialContext = context;
  const { session } = await hydrateRedboxAuthSessionOnStartup();
  const synced = await syncOfficialRoutingForSession(session, { skipModelFetch: true });
  await broadcastOfficialSessionUpdate('startup', synced.session);
  startOfficialAuthMonitor();
};

const prepareOfficialTranscriptionAuth = async (
  context: OfficialTranscriptionAuthContext,
): Promise<OfficialTranscriptionAuthResult> => {
  if (!isOfficialGatewayEndpoint(context.endpoint)) {
    return { handled: false };
  }
  if (String(context.apiKey || '').trim().startsWith('rbx_')) {
    return {
      handled: true,
      officialGateway: true,
      authMode: 'api-key',
      apiKey: String(context.apiKey || '').trim(),
    };
  }
  try {
    const ensured = await ensureRedboxSessionApiKey('RedBox Desktop');
    return {
      handled: true,
      officialGateway: true,
      authMode: 'api-key',
      apiKey: String(ensured.key || '').trim(),
    };
  } catch (error) {
    const parsed = parseRedboxApiError(error);
    return {
      handled: true,
      officialGateway: true,
      error: `转录鉴权失败：官方端点需要 API Key（rbx_），但自动获取失败。${parsed.message || 'unknown error'}`,
    };
  }
};

const officialFeatureModule: OfficialFeatureModule = {
  registerOfficialFeatures,
  syncOfficialAiRoutingOnStartup,
  prepareOfficialTranscriptionAuth,
};

export default officialFeatureModule;
