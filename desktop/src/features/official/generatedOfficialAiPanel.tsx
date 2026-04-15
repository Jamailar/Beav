import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CreditCard, Gem, QrCode, RefreshCw, Smartphone, UserRound } from 'lucide-react';
import clsx from 'clsx';
import QRCode from 'qrcode';
import type { OfficialAiPanelProps } from './index';

type LoginTab = 'wechat' | 'sms';
type NoticeType = 'idle' | 'success' | 'error';
type WechatStatus = 'PENDING' | 'SCANNED' | 'CONFIRMED' | 'EXPIRED' | 'FAILED' | 'idle';

interface RedboxAuthSession {
  accessToken: string;
  refreshToken: string;
  tokenType: string;
  expiresAt: number | null;
  apiKey: string;
  user: Record<string, unknown> | null;
  createdAt: number;
  updatedAt: number;
}

interface RedboxWechatInfo {
  enabled: boolean;
  sessionId: string;
  qrContentUrl: string;
  url: string;
  expiresIn: number;
}

interface RedboxCallRecordItem {
  id: string;
  model: string;
  endpoint: string;
  tokens: number;
  points: number;
  createdAt: string;
  status: string;
}

interface RedboxProductItem {
  id: string;
  name: string;
  amount: number;
  pointsTopup: number;
  raw: Record<string, unknown>;
}

interface ModelsResponseItem {
  id: string;
}

interface RedboxSessionDisplaySnapshot {
  user: Record<string, unknown> | null;
  expiresAt: number | null;
  updatedAt: number;
}

const SESSION_DISPLAY_SNAPSHOT_KEY = 'redbox-auth:display-session';
const PANEL_DISPLAY_SNAPSHOT_KEY = 'redbox-auth:panel-display';

interface RedboxPanelDisplaySnapshot {
  user: Record<string, unknown> | null;
  points: Record<string, unknown> | null;
  models: ModelsResponseItem[];
  products: RedboxProductItem[];
  callRecords: RedboxCallRecordItem[];
  updatedAt: number;
}

const invoke = async <T,>(channel: string, payload?: unknown): Promise<T> => {
  return window.ipcRenderer.invoke(channel, payload) as Promise<T>;
};

const readDisplaySessionSnapshot = (): RedboxAuthSession | null => {
  try {
    const raw = window.localStorage.getItem(SESSION_DISPLAY_SNAPSHOT_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as RedboxSessionDisplaySnapshot;
    if (!parsed || typeof parsed !== 'object') return null;
    return {
      accessToken: 'cached-display-session',
      refreshToken: '',
      tokenType: 'Bearer',
      expiresAt: Number.isFinite(Number(parsed.expiresAt)) ? Number(parsed.expiresAt) : null,
      apiKey: '',
      user: parsed.user && typeof parsed.user === 'object' ? parsed.user : null,
      createdAt: Number(parsed.updatedAt || Date.now()),
      updatedAt: Number(parsed.updatedAt || Date.now()),
    };
  } catch {
    return null;
  }
};

const writeDisplaySessionSnapshot = (sessionData: RedboxAuthSession | null): void => {
  try {
    if (!sessionData?.accessToken) {
      window.localStorage.removeItem(SESSION_DISPLAY_SNAPSHOT_KEY);
      return;
    }
    window.localStorage.setItem(SESSION_DISPLAY_SNAPSHOT_KEY, JSON.stringify({
      user: sessionData.user || null,
      expiresAt: Number.isFinite(Number(sessionData.expiresAt)) ? Number(sessionData.expiresAt) : null,
      updatedAt: Number(sessionData.updatedAt || Date.now()),
    } satisfies RedboxSessionDisplaySnapshot));
  } catch {
    // ignore snapshot failures
  }
};

const readPanelDisplaySnapshot = (): RedboxPanelDisplaySnapshot | null => {
  try {
    const raw = window.localStorage.getItem(PANEL_DISPLAY_SNAPSHOT_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as RedboxPanelDisplaySnapshot;
    if (!parsed || typeof parsed !== 'object') return null;
    return {
      user: parsed.user && typeof parsed.user === 'object' ? parsed.user : null,
      points: parsed.points && typeof parsed.points === 'object' ? parsed.points : null,
      models: Array.isArray(parsed.models) ? parsed.models : [],
      products: Array.isArray(parsed.products) ? parsed.products : [],
      callRecords: Array.isArray(parsed.callRecords) ? parsed.callRecords : [],
      updatedAt: Number(parsed.updatedAt || Date.now()),
    };
  } catch {
    return null;
  }
};

const writePanelDisplaySnapshot = (snapshot: RedboxPanelDisplaySnapshot | null): void => {
  try {
    if (!snapshot) {
      window.localStorage.removeItem(PANEL_DISPLAY_SNAPSHOT_KEY);
      return;
    }
    window.localStorage.setItem(PANEL_DISPLAY_SNAPSHOT_KEY, JSON.stringify(snapshot));
  } catch {
    // ignore snapshot failures
  }
};

const normalizeRechargeAmountInput = (raw: string): string => {
  const text = String(raw || '').trim();
  if (!text) return '';
  const value = Number(text);
  if (!Number.isFinite(value) || value <= 0) return '';
  return value.toFixed(2);
};

const asRecord = (value: unknown): Record<string, unknown> | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
};

const pickText = (...values: unknown[]): string => {
  for (const value of values) {
    const text = String(value ?? '').trim();
    if (text) return text;
  }
  return '';
};

const pickNumber = (...values: unknown[]): number => {
  for (const value of values) {
    const next = Number(value);
    if (Number.isFinite(next)) return next;
  }
  return 0;
};

const normalizeDateTime = (value: unknown): string => {
  if (value === null || value === undefined || value === '') return '';
  if (typeof value === 'number' && Number.isFinite(value)) {
    const millis = value > 10_000_000_000 ? value : value * 1000;
    return new Date(millis).toISOString();
  }
  const text = String(value).trim();
  if (!text) return '';
  if (/^\d+$/.test(text)) {
    const numeric = Number(text);
    if (Number.isFinite(numeric)) {
      const millis = numeric > 10_000_000_000 ? numeric : numeric * 1000;
      return new Date(millis).toISOString();
    }
  }
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? '' : parsed.toISOString();
};

const normalizeProductItem = (value: unknown, index: number): RedboxProductItem | null => {
  const record = asRecord(value);
  if (!record) return null;
  const amount = pickNumber(record.amount, record.price, record.total_amount, record.totalAmount);
  const pointsTopup = pickNumber(
    record.points_topup,
    record.pointsTopup,
    record.points,
    record.credit,
    record.credits,
  );
  const id = pickText(record.id, record.product_id, record.productId, `product-${index}`);
  const name = pickText(
    record.name,
    record.title,
    pointsTopup > 0 ? `${pointsTopup} 积分` : '',
    amount > 0 ? `¥${amount.toFixed(2)}` : '',
  );
  if (amount > 0 && amount <= 1) {
    return null;
  }
  return {
    id,
    name: name || `充值档位 ${index + 1}`,
    amount,
    pointsTopup,
    raw: record,
  };
};

const normalizeCallRecordItem = (value: unknown, index: number): RedboxCallRecordItem | null => {
  const record = asRecord(value);
  if (!record) return null;
  const createdAt = normalizeDateTime(
    record.createdAt ?? record.created_at ?? record.timestamp ?? record.called_at ?? record.call_time,
  );
  const tokens = pickNumber(
    record.tokens,
    record.total_tokens,
    record.totalTokens,
    record.token_count,
    pickNumber(record.prompt_tokens, record.promptTokens) + pickNumber(record.completion_tokens, record.completionTokens),
  );
  const points = pickNumber(record.points, record.cost_points, record.costPoints, record.cost, record.amount);
  const id = pickText(
    record.id,
    record.record_id,
    record.recordId,
    record.request_id,
    record.requestId,
    `${createdAt}-${pickText(record.model, record.model_name, record.modelName)}-${index}`,
  );
  return {
    id,
    model: pickText(record.model, record.model_name, record.modelName, record.model_id, record.modelId),
    endpoint: pickText(record.endpoint, record.path, record.api, record.channel),
    tokens,
    points,
    createdAt,
    status: pickText(record.status, record.state, record.result, 'UNKNOWN'),
  };
};

const normalizeOrderStatus = (value: unknown): string => {
  const record = asRecord(value);
  const status = pickText(
    record?.trade_status,
    record?.tradeStatus,
    record?.status,
    record?.state,
  );
  return status.toUpperCase();
};

const isPaidOrder = (value: unknown): boolean => {
  const status = normalizeOrderStatus(value);
  return ['SUCCESS', 'PAID', 'TRADE_SUCCESS', 'COMPLETED', 'FINISHED'].includes(status);
};

const getOrderPaymentForm = (value: unknown): string => {
  const record = asRecord(value);
  return pickText(
    record?.payment_form,
    record?.paymentForm,
    record?.payment_url,
    record?.paymentUrl,
    record?.pay_url,
    record?.payUrl,
    record?.url,
  );
};

const isLikelyImageUrl = (value: string): boolean => {
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized) return false;
  if (normalized.startsWith('data:image/')) return true;
  if (normalized.startsWith('blob:')) return true;
  return /\.(png|jpe?g|gif|webp|bmp|svg)(\?.*)?(#.*)?$/i.test(normalized);
};

const buildWechatQrDataUrl = async (value: string): Promise<string> => {
  const content = String(value || '').trim();
  if (!content) {
    throw new Error('二维码内容为空');
  }
  if (isLikelyImageUrl(content)) {
    return content;
  }
  return QRCode.toDataURL(content, {
    errorCorrectionLevel: 'M',
    margin: 1,
    width: 520,
    color: {
      dark: '#111111',
      light: '#ffffff',
    },
  });
};

const OfficialAiPanel = ({ onReloadSettings }: OfficialAiPanelProps) => {
  const presetRechargeOptions = [10, 20, 50, 100];
  const initialPanelSnapshot = readPanelDisplaySnapshot();
  const [loginTab, setLoginTab] = useState<LoginTab>('wechat');
  const [session, setSession] = useState<RedboxAuthSession | null>(() => readDisplaySessionSnapshot());
  const [bootstrapped, setBootstrapped] = useState(false);
  const [user, setUser] = useState<Record<string, unknown> | null>(() => initialPanelSnapshot?.user || null);
  const [points, setPoints] = useState<Record<string, unknown> | null>(() => initialPanelSnapshot?.points || null);
  const [models, setModels] = useState<ModelsResponseItem[]>(() => initialPanelSnapshot?.models || []);
  const [products, setProducts] = useState<RedboxProductItem[]>(() => initialPanelSnapshot?.products || []);
  const [callRecords, setCallRecords] = useState<RedboxCallRecordItem[]>(() => initialPanelSnapshot?.callRecords || []);
  const [callRecordsError, setCallRecordsError] = useState('');
  const [rechargeAmount, setRechargeAmount] = useState('9.90');
  const [selectedProductId, setSelectedProductId] = useState('');
  const [rechargeOrderNo, setRechargeOrderNo] = useState('');
  const [rechargeStatusText, setRechargeStatusText] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [noticeType, setNoticeType] = useState<NoticeType>('idle');
  const [smsForm, setSmsForm] = useState({ phone: '', code: '', inviteCode: '' });
  const [wechatQrUrl, setWechatQrUrl] = useState('');
  const [wechatLoginUrl, setWechatLoginUrl] = useState('');
  const [wechatStatusText, setWechatStatusText] = useState<WechatStatus>('idle');
  const [wechatExpiresAt, setWechatExpiresAt] = useState<number>(0);
  const pollTimerRef = useRef<number | null>(null);
  const orderPollTimerRef = useRef<number | null>(null);

  const setPanelNotice = useCallback((type: NoticeType, message: string) => {
    setNoticeType(type);
    setNotice(message);
  }, []);

  const stopWechatPolling = useCallback(() => {
    if (pollTimerRef.current !== null) {
      window.clearInterval(pollTimerRef.current);
      pollTimerRef.current = null;
    }
  }, []);

  const stopOrderPolling = useCallback(() => {
    if (orderPollTimerRef.current !== null) {
      window.clearInterval(orderPollTimerRef.current);
      orderPollTimerRef.current = null;
    }
  }, []);

  const applySession = useCallback((sessionData: RedboxAuthSession | null) => {
    setSession(sessionData);
    writeDisplaySessionSnapshot(sessionData);
  }, []);

  const requestSettingsRefresh = useCallback((options?: { preserveViewState?: boolean; preserveRemoteModels?: boolean }) => {
    void onReloadSettings({
      preserveViewState: true,
      preserveRemoteModels: true,
      ...options,
    });
  }, [onReloadSettings]);

  useEffect(() => {
    writePanelDisplaySnapshot({
      user,
      points,
      models,
      products,
      callRecords,
      updatedAt: Date.now(),
    });
  }, [callRecords, models, points, products, user]);

  const hydrateCachedSession = useCallback(async () => {
    const result = await invoke<{ success: boolean; session?: RedboxAuthSession | null; error?: string }>('redbox-auth:get-session-cached');
    if (!result?.success) {
      const fallback = readDisplaySessionSnapshot();
      if (fallback?.accessToken) {
        applySession(fallback);
        return fallback;
      }
      return null;
    }
    const sessionData = result.session || null;
    if (sessionData?.accessToken) {
      applySession(sessionData);
      return sessionData;
    }
    const fallback = readDisplaySessionSnapshot();
    if (fallback?.accessToken) {
      applySession(fallback);
      return fallback;
    }
    applySession(null);
    return sessionData;
  }, [applySession]);

  const fetchUser = useCallback(async () => {
    const result = await invoke<{ success: boolean; user?: Record<string, unknown>; error?: string }>('redbox-auth:me');
    if (!result?.success) {
      throw new Error(result?.error || '拉取用户信息失败');
    }
    setUser(result.user || null);
  }, []);

  const fetchPoints = useCallback(async () => {
    const result = await invoke<{ success: boolean; points?: Record<string, unknown>; error?: string }>('redbox-auth:points');
    if (!result?.success) {
      throw new Error(result?.error || '查询余额失败');
    }
    setPoints(result.points || null);
  }, []);

  const fetchModels = useCallback(async () => {
    const result = await invoke<{ success: boolean; models?: ModelsResponseItem[]; error?: string }>('redbox-auth:models');
    if (!result?.success) {
      throw new Error(result?.error || '拉取模型失败');
    }
    setModels((result.models || []).filter((item) => String(item?.id || '').trim()));
  }, []);

  const fetchProducts = useCallback(async () => {
    const result = await invoke<{ success: boolean; products?: unknown[]; error?: string }>('redbox-auth:products');
    if (!result?.success) {
      throw new Error(result?.error || '拉取充值档位失败');
    }
    setProducts((result.products || [])
      .map((item, index) => normalizeProductItem(item, index))
      .filter((item): item is RedboxProductItem => Boolean(item)));
  }, []);

  const fetchCallRecords = useCallback(async () => {
    const result = await invoke<{ success: boolean; records?: unknown[]; error?: string }>('redbox-auth:call-records');
    const normalized = (result.records || [])
      .map((item, index) => normalizeCallRecordItem(item, index))
      .filter((item): item is RedboxCallRecordItem => Boolean(item));
    if (normalized.length) {
      setCallRecords(normalized);
    }
    if (!result?.success) {
      setCallRecordsError(result?.error || '拉取调用记录失败');
      throw new Error(result?.error || '拉取调用记录失败');
    }
    setCallRecordsError('');
    setCallRecords((result.records || [])
      .map((item, index) => normalizeCallRecordItem(item, index))
      .filter((item): item is RedboxCallRecordItem => Boolean(item)));
  }, []);

  const loadAuthenticatedData = useCallback(async () => {
    await Promise.allSettled([fetchUser(), fetchPoints(), fetchModels(), fetchProducts(), fetchCallRecords()]);
  }, [fetchCallRecords, fetchModels, fetchPoints, fetchProducts, fetchUser]);

  const requestBackgroundRefresh = useCallback(async () => {
    const result = await invoke<{ success: boolean; queued?: boolean; tokenRefreshed?: boolean; error?: string }>('redbox-auth:refresh');
    if (!result?.success) {
      throw new Error(result?.error || '刷新登录态失败');
    }
    return result;
  }, []);

  const refreshProfileAndPoints = useCallback(async () => {
    setBusy(true);
    try {
      if (!session?.accessToken) {
        throw new Error('当前未登录，请先登录官方账号');
      }
      const refreshResult = await requestBackgroundRefresh();
      await loadAuthenticatedData();
      setPanelNotice('success', refreshResult.tokenRefreshed ? '令牌与账户信息已刷新' : '账户信息已刷新');
    } catch (error) {
      setPanelNotice('error', error instanceof Error ? error.message : '刷新用户信息失败');
    } finally {
      setBusy(false);
    }
  }, [loadAuthenticatedData, requestBackgroundRefresh, session, setPanelNotice]);

  const startWechatPolling = useCallback((sessionId: string) => {
    stopWechatPolling();
    const normalizedSessionId = String(sessionId || '').trim();
    if (!normalizedSessionId) return;
    pollTimerRef.current = window.setInterval(async () => {
      try {
        const result = await invoke<{
          success: boolean;
          data?: { status?: string; session?: RedboxAuthSession | null };
        }>('redbox-auth:wechat-status', { sessionId: normalizedSessionId });
        if (!result?.success || !result.data) return;
        const status = String(result.data.status || 'PENDING').toUpperCase() as WechatStatus;
        setWechatStatusText(status);
        if (status === 'CONFIRMED') {
          stopWechatPolling();
          if (result.data.session) {
            applySession(result.data.session);
          }
          requestSettingsRefresh();
          await loadAuthenticatedData();
          setPanelNotice('success', '微信登录成功');
        } else if (status === 'EXPIRED' || status === 'FAILED') {
          stopWechatPolling();
          setPanelNotice('error', status === 'EXPIRED' ? '二维码已过期，请重新获取' : '微信登录失败，请重试');
        }
      } catch {
        // keep polling quietly
      }
    }, 2200);
  }, [applySession, loadAuthenticatedData, requestSettingsRefresh, setPanelNotice, stopWechatPolling]);

  const fetchWechatQr = useCallback(async (options?: { silent?: boolean }) => {
    const silent = Boolean(options?.silent);
    if (!silent) {
      setBusy(true);
    }
    try {
      const result = await invoke<{ success: boolean; data?: RedboxWechatInfo; error?: string }>('redbox-auth:wechat-url', { state: 'redconvert-desktop' });
      if (!result?.success || !result.data) {
        throw new Error(result?.error || '获取二维码失败');
      }
      const qrContent = String(result.data.qrContentUrl || result.data.url || '').trim();
      if (!qrContent) {
        throw new Error('后端未返回二维码内容');
      }
      setWechatLoginUrl(String(result.data.url || '').trim());
      setWechatQrUrl(await buildWechatQrDataUrl(qrContent));
      setWechatStatusText('PENDING');
      setWechatExpiresAt(Date.now() + Math.max(10, Number(result.data.expiresIn || 120)) * 1000);
      setPanelNotice('success', '请使用微信扫码登录');
      if (result.data.sessionId) {
        startWechatPolling(result.data.sessionId);
      }
    } catch (error) {
      setPanelNotice('error', error instanceof Error ? error.message : '获取二维码失败');
    } finally {
      if (!silent) {
        setBusy(false);
      }
    }
  }, [setPanelNotice, startWechatPolling]);

  const sendSmsCode = useCallback(async () => {
    const phone = String(smsForm.phone || '').trim();
    if (!phone) {
      setPanelNotice('error', '请先输入手机号');
      return;
    }
    setBusy(true);
    try {
      const result = await invoke<{ success: boolean; error?: string }>('redbox-auth:send-sms-code', { phone });
      if (!result?.success) {
        throw new Error(result?.error || '验证码发送失败');
      }
      setPanelNotice('success', '验证码已发送');
    } catch (error) {
      setPanelNotice('error', error instanceof Error ? error.message : '验证码发送失败');
    } finally {
      setBusy(false);
    }
  }, [setPanelNotice, smsForm.phone]);

  const handleSmsAuth = useCallback(async (mode: 'login' | 'register') => {
    const phone = String(smsForm.phone || '').trim();
    const code = String(smsForm.code || '').trim();
    if (!phone || !code) {
      setPanelNotice('error', '请输入手机号和验证码');
      return;
    }
    setBusy(true);
    try {
      const result = await invoke<{ success: boolean; session?: RedboxAuthSession; error?: string }>(
        mode === 'login' ? 'redbox-auth:login-sms' : 'redbox-auth:register-sms',
        { phone, code, inviteCode: smsForm.inviteCode.trim() || undefined },
      );
      if (!result?.success || !result.session) {
        throw new Error(result?.error || (mode === 'login' ? '登录失败' : '注册失败'));
      }
      applySession(result.session);
      requestSettingsRefresh();
      await loadAuthenticatedData();
      setPanelNotice('success', mode === 'login' ? '登录成功' : '注册并登录成功');
    } catch (error) {
      setPanelNotice('error', error instanceof Error ? error.message : (mode === 'login' ? '登录失败' : '注册失败'));
    } finally {
      setBusy(false);
    }
  }, [applySession, loadAuthenticatedData, requestSettingsRefresh, setPanelNotice, smsForm.code, smsForm.inviteCode, smsForm.phone]);

  const logout = useCallback(async () => {
    setBusy(true);
    try {
      const result = await invoke<{ success: boolean; error?: string }>('redbox-auth:logout');
      if (!result?.success) {
        throw new Error(result?.error || '退出登录失败');
      }
      stopWechatPolling();
      stopOrderPolling();
      applySession(null);
      setUser(null);
      setPoints(null);
      setModels([]);
      setProducts([]);
      setCallRecords([]);
      setCallRecordsError('');
      writePanelDisplaySnapshot(null);
      setSelectedProductId('');
      setRechargeOrderNo('');
      setRechargeStatusText('');
      requestSettingsRefresh();
      setPanelNotice('success', '已退出登录');
    } catch (error) {
      setPanelNotice('error', error instanceof Error ? error.message : '退出登录失败');
    } finally {
      setBusy(false);
    }
  }, [applySession, requestSettingsRefresh, setPanelNotice, stopOrderPolling, stopWechatPolling]);

  const startOrderStatusPolling = useCallback((outTradeNo: string) => {
    stopOrderPolling();
    const normalized = String(outTradeNo || '').trim();
    if (!normalized) return;
    orderPollTimerRef.current = window.setInterval(async () => {
      try {
        const result = await invoke<{ success: boolean; order?: Record<string, unknown>; error?: string }>('redbox-auth:order-status', {
          outTradeNo: normalized,
        });
        if (!result?.success || !result.order) return;
        if (isPaidOrder(result.order)) {
          stopOrderPolling();
          await loadAuthenticatedData();
          setRechargeStatusText(`订单 ${normalized} 已支付，余额已同步更新。`);
          setPanelNotice('success', '充值成功，余额已更新。');
        }
      } catch {
        // keep polling quietly
      }
    }, 3000);
  }, [loadAuthenticatedData, setPanelNotice, stopOrderPolling]);

  const handleCreateOrderAndPay = useCallback(async () => {
    const amount = normalizeRechargeAmountInput(rechargeAmount);
    if (!amount) {
      setPanelNotice('error', '请输入充值金额');
      return;
    }
    setBusy(true);
    try {
      const selectedProduct = products.find((item) => item.id === selectedProductId) || null;
      const orderResult = await invoke<{ success: boolean; order?: Record<string, unknown>; error?: string }>('redbox-auth:create-page-pay-order', {
        productId: selectedProduct?.id || undefined,
        amount: Number(amount),
        subject: `积分充值 ¥${amount}`,
        pointsToDeduct: 0,
      });
      if (!orderResult?.success || !orderResult.order) {
        throw new Error(orderResult?.error || '创建订单失败');
      }
      const outTradeNo = String(orderResult.order.out_trade_no || orderResult.order.outTradeNo || '').trim();
      const paymentForm = getOrderPaymentForm(orderResult.order);
      if (!outTradeNo || !paymentForm) {
        throw new Error('订单返回缺少支付信息');
      }
      const openResult = await invoke<{ success: boolean; error?: string }>('redbox-auth:open-payment-form', { paymentForm });
      if (!openResult?.success) {
        throw new Error(openResult?.error || '打开支付页面失败');
      }
      stopOrderPolling();
      setRechargeOrderNo(outTradeNo);
      setRechargeStatusText(`订单 ${outTradeNo} 已创建，正在等待支付结果。`);
      startOrderStatusPolling(outTradeNo);
      setPanelNotice('success', '支付页面已打开，请在浏览器完成支付。');
    } catch (error) {
      const message = error instanceof Error ? error.message : '充值失败';
      setRechargeStatusText(message);
      setPanelNotice('error', message);
    } finally {
      setBusy(false);
    }
  }, [products, rechargeAmount, selectedProductId, setPanelNotice, startOrderStatusPolling, stopOrderPolling]);

  const userName = useMemo(() => {
    const currentUser = user || session?.user;
    if (!currentUser || typeof currentUser !== 'object') return '';
    return String(
      (currentUser as Record<string, unknown>).nickname
      || (currentUser as Record<string, unknown>).name
      || (currentUser as Record<string, unknown>).phone
      || (currentUser as Record<string, unknown>).id
      || '',
    ).trim();
  }, [session?.user, user]);

  const pointsValue = useMemo(() => {
    if (!points || typeof points !== 'object') return 0;
    const record = points as Record<string, unknown>;
    const candidates = [record.points, record.balance, record.current_points, record.currentPoints, record.available_points, record.availablePoints];
    for (const candidate of candidates) {
      const value = Number(candidate);
      if (Number.isFinite(value)) return value;
    }
    return 0;
  }, [points]);
  const hasPointsSnapshot = points && typeof points === 'object';

  const pointsPerYuan = useMemo(() => {
    if (!points || typeof points !== 'object') return 100;
    const record = points as Record<string, unknown>;
    const pricing = record.pricing && typeof record.pricing === 'object'
      ? (record.pricing as Record<string, unknown>)
      : null;
    const value = Number(pricing?.points_per_yuan ?? record.points_per_yuan ?? record.pointsPerYuan ?? 100);
    return Number.isFinite(value) && value > 0 ? value : 100;
  }, [points]);

  const selectedProduct = useMemo(() => {
    return products.find((item) => item.id === selectedProductId) || null;
  }, [products, selectedProductId]);

  const rechargePreviewPoints = useMemo(() => {
    const amount = Number(normalizeRechargeAmountInput(rechargeAmount) || 0);
    if (!Number.isFinite(amount) || amount <= 0) return 0;
    if (selectedProduct?.pointsTopup) return selectedProduct.pointsTopup;
    return amount * pointsPerYuan;
  }, [pointsPerYuan, rechargeAmount, selectedProduct]);

  useEffect(() => {
    let canceled = false;
    const bootstrap = async () => {
      try {
        const cachedSession = await hydrateCachedSession();
        if (canceled) return;
        if (cachedSession?.accessToken) {
          requestSettingsRefresh();
          await loadAuthenticatedData();
        }
      } catch {
        // ignore
      } finally {
        if (!canceled) {
          setBootstrapped(true);
        }
      }
    };
    void bootstrap();
    return () => {
      canceled = true;
      stopWechatPolling();
      stopOrderPolling();
    };
  }, [hydrateCachedSession, loadAuthenticatedData, requestSettingsRefresh, stopOrderPolling, stopWechatPolling]);

  useEffect(() => {
    const handleSessionUpdated = async (_event: unknown, payload?: { session?: RedboxAuthSession | null }) => {
      const nextSession = payload?.session || null;
      applySession(nextSession);
      if (!nextSession?.accessToken) {
        stopOrderPolling();
        setUser(null);
        setPoints(null);
        setModels([]);
        setProducts([]);
        setCallRecords([]);
        setCallRecordsError('');
        return;
      }
      requestSettingsRefresh();
      await loadAuthenticatedData();
    };
    window.ipcRenderer.on('redbox-auth:session-updated', handleSessionUpdated);
    return () => {
      window.ipcRenderer.off('redbox-auth:session-updated', handleSessionUpdated);
    };
  }, [applySession, loadAuthenticatedData, requestSettingsRefresh, stopOrderPolling]);

  useEffect(() => {
    const handleDataUpdated = async () => {
      await loadAuthenticatedData();
    };
    window.ipcRenderer.on('redbox-auth:data-updated', handleDataUpdated);
    return () => {
      window.ipcRenderer.off('redbox-auth:data-updated', handleDataUpdated);
    };
  }, [loadAuthenticatedData]);

  useEffect(() => {
    if (!selectedProductId) return;
    if (products.some((item) => item.id === selectedProductId)) return;
    setSelectedProductId('');
  }, [products, selectedProductId]);

  return (
    <div className="rounded-xl border border-border bg-surface-secondary/20 p-4 space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-medium text-text-primary">官方账号登录</h3>
          <p className="text-[11px] text-text-tertiary mt-1">登录后自动同步官方模型与推荐配置。</p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => void refreshProfileAndPoints()}
            disabled={busy}
            title="刷新信息"
            className="p-1.5 text-text-tertiary hover:text-accent-primary transition-colors disabled:opacity-50"
          >
            <RefreshCw className={clsx('w-3.5 h-3.5', busy && 'animate-spin')} />
          </button>
          <button
            type="button"
            onClick={() => void logout()}
            disabled={busy || !session}
            className="px-2.5 py-1 text-xs border border-red-300 text-red-600 rounded hover:bg-red-50/70 transition-colors disabled:opacity-50"
          >
            退出
          </button>
        </div>
      </div>

      {!session ? (
        !bootstrapped ? (
          <div className="rounded-lg border border-border bg-surface-primary p-4 text-sm text-text-secondary">
            正在检查登录状态…
          </div>
        ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <div className="rounded-lg border border-border bg-surface-primary p-3 space-y-3">
            <div className="inline-flex items-center rounded-full border border-border bg-surface-secondary/30 p-1">
              <button
                type="button"
                onClick={() => setLoginTab('wechat')}
                className={clsx(
                  'px-3 py-1 text-xs rounded-full transition-colors inline-flex items-center gap-1',
                  loginTab === 'wechat' ? 'bg-surface-primary border border-border text-text-primary' : 'text-text-secondary',
                )}
              >
                <QrCode className="w-3.5 h-3.5" />
                微信登录
              </button>
              <button
                type="button"
                onClick={() => setLoginTab('sms')}
                className={clsx(
                  'px-3 py-1 text-xs rounded-full transition-colors inline-flex items-center gap-1',
                  loginTab === 'sms' ? 'bg-surface-primary border border-border text-text-primary' : 'text-text-secondary',
                )}
              >
                <Smartphone className="w-3.5 h-3.5" />
                短信登录
              </button>
            </div>

            {loginTab === 'wechat' ? (
              <div className="space-y-3">
                <div className="h-56 rounded-lg border border-border bg-surface-secondary/20 flex items-center justify-center overflow-hidden">
                  {wechatQrUrl ? (
                    <img src={wechatQrUrl} alt="微信登录二维码" className="h-full w-full object-contain p-2" />
                  ) : (
                    <div className="text-xs text-text-tertiary">点击“获取二维码”开始登录</div>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => void fetchWechatQr()}
                    disabled={busy}
                    className="px-3 py-1.5 text-xs border border-border rounded hover:bg-surface-secondary transition-colors disabled:opacity-50"
                  >
                    获取二维码
                  </button>
                  <span className="text-[11px] text-text-tertiary">状态：{wechatStatusText === 'idle' ? '待获取' : wechatStatusText}</span>
                </div>
                {wechatLoginUrl ? (
                  <p className="text-[11px] text-text-tertiary">
                    扫码异常？
                    {' '}
                    <a href={wechatLoginUrl} target="_blank" rel="noreferrer" className="text-accent-primary hover:underline">
                      打开微信登录链接
                    </a>
                  </p>
                ) : null}
                {wechatExpiresAt > 0 ? (
                  <p className="text-[11px] text-text-tertiary">有效期至：{new Date(wechatExpiresAt).toLocaleTimeString()}</p>
                ) : null}
              </div>
            ) : (
              <div className="space-y-2">
                <input
                  type="text"
                  value={smsForm.phone}
                  onChange={(e) => setSmsForm((prev) => ({ ...prev, phone: e.target.value }))}
                  placeholder="手机号"
                  className="w-full bg-surface-secondary/30 rounded border border-border px-3 py-2 text-sm focus:outline-none focus:border-accent-primary transition-colors"
                />
                <div className="grid grid-cols-[1fr_auto] gap-2">
                  <input
                    type="text"
                    value={smsForm.code}
                    onChange={(e) => setSmsForm((prev) => ({ ...prev, code: e.target.value }))}
                    placeholder="短信验证码"
                    className="w-full bg-surface-secondary/30 rounded border border-border px-3 py-2 text-sm focus:outline-none focus:border-accent-primary transition-colors"
                  />
                  <button
                    type="button"
                    onClick={() => void sendSmsCode()}
                    disabled={busy}
                    className="px-3 py-2 text-xs border border-border rounded hover:bg-surface-secondary transition-colors disabled:opacity-50"
                  >
                    发送验证码
                  </button>
                </div>
                <input
                  type="text"
                  value={smsForm.inviteCode}
                  onChange={(e) => setSmsForm((prev) => ({ ...prev, inviteCode: e.target.value }))}
                  placeholder="邀请码（可选）"
                  className="w-full bg-surface-secondary/30 rounded border border-border px-3 py-2 text-sm focus:outline-none focus:border-accent-primary transition-colors"
                />
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => void handleSmsAuth('login')}
                    disabled={busy}
                    className="px-3 py-1.5 text-xs border border-border rounded hover:bg-surface-secondary transition-colors disabled:opacity-50"
                  >
                    登录
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleSmsAuth('register')}
                    disabled={busy}
                    className="px-3 py-1.5 text-xs border border-border rounded hover:bg-surface-secondary transition-colors disabled:opacity-50"
                  >
                    注册并登录
                  </button>
                </div>
              </div>
            )}
          </div>

          <div className="rounded-lg border border-dashed border-border bg-surface-primary/50 p-4 flex flex-col justify-center">
            <div className="flex items-center gap-2 text-sm font-medium text-text-primary">
              <UserRound className="w-4 h-4" />
              登录后可用
            </div>
            <ul className="mt-3 text-xs text-text-secondary space-y-1">
              <li>1. 自动绑定官方 API Key</li>
              <li>2. 自动同步模型与推荐配置</li>
              <li>3. 查看积分余额与调用记录</li>
              <li>4. 浏览器跳转充值积分</li>
            </ul>
          </div>
        </div>
        )
      ) : (
        <>
          <div className="rounded-lg border border-border bg-surface-primary p-3 space-y-3">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2 text-sm font-medium text-text-primary">
                <Gem className="w-4 h-4" />
                积分余额
              </div>
              <div className="flex items-center gap-2">
                <span className="text-sm font-semibold text-text-primary">
                  {hasPointsSnapshot
                    ? `${Number(pointsValue).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} 积分`
                    : '—'}
                </span>
                <button
                  type="button"
                  onClick={() => void refreshProfileAndPoints()}
                  disabled={busy}
                  title="刷新余额"
                  className="p-1.5 text-text-tertiary hover:text-accent-primary transition-colors disabled:opacity-50"
                >
                  <RefreshCw className={clsx('w-3.5 h-3.5', busy && 'animate-spin')} />
                </button>
              </div>
            </div>
            <p className="text-[11px] text-text-tertiary">
              用户：{userName || '未命名用户'} · 模型 {models.length} 个 · 余额单位为积分（1 元 = {pointsPerYuan} 积分）
            </p>
            <div className="space-y-3">
              <div className="flex flex-wrap items-center gap-2">
                {presetRechargeOptions.map((amount) => (
                  <button
                    key={`preset-${amount}`}
                    type="button"
                    onClick={() => {
                      setSelectedProductId('');
                      setRechargeAmount(amount.toFixed(2));
                    }}
                    className={clsx(
                      'px-3 py-1.5 text-xs border rounded transition-all',
                      !selectedProductId && Number(rechargeAmount) === amount
                        ? 'bg-accent-primary/10 border-accent-primary text-accent-primary'
                        : 'border-border hover:bg-surface-secondary text-text-secondary',
                    )}
                  >
                    ¥{amount}
                  </button>
                ))}
              </div>
              {products.length ? (
                <div className="flex flex-wrap items-center gap-2">
                  {products.map((product) => (
                <button
                  key={product.id}
                  type="button"
                  onClick={() => {
                    setSelectedProductId(product.id);
                    if (product.amount > 0) {
                      setRechargeAmount(product.amount.toFixed(2));
                    }
                  }}
                  className={clsx(
                    'px-3 py-1.5 text-xs border rounded transition-all',
                    selectedProductId === product.id
                      ? 'bg-accent-primary/10 border-accent-primary text-accent-primary'
                      : 'border-border hover:bg-surface-secondary text-text-secondary',
                  )}
                >
                  <span>{product.name}</span>
                  {product.amount > 0 ? <span className="ml-1">¥{product.amount}</span> : null}
                </button>
                  ))}
                </div>
              ) : null}
              <div className="flex flex-wrap items-center gap-2">
                <input
                  value={rechargeAmount}
                  onChange={(e) => {
                    setSelectedProductId('');
                    setRechargeAmount(e.target.value);
                  }}
                  placeholder="其他金额"
                  className="w-24 bg-surface-secondary/30 rounded border border-border px-2.5 py-1.5 text-xs focus:outline-none focus:border-accent-primary transition-colors"
                />
                <button
                  type="button"
                  onClick={() => void handleCreateOrderAndPay()}
                  disabled={busy || !normalizeRechargeAmountInput(rechargeAmount)}
                  className="inline-flex items-center gap-1.5 px-4 py-1.5 text-xs bg-accent-primary text-white rounded hover:brightness-110 shadow-sm transition-all disabled:opacity-50 disabled:grayscale"
                >
                  <CreditCard className="w-3.5 h-3.5" />
                  立即充值
                </button>
              </div>
            </div>
            {rechargePreviewPoints > 0 ? (
              <p className="text-[11px] text-accent-primary font-medium">
                预计到账：{Number(rechargePreviewPoints).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} 积分
                {rechargeOrderNo ? ` · 当前订单：${rechargeOrderNo}` : ''}
              </p>
            ) : null}
            {rechargeStatusText ? (
              <p className="text-[11px] text-text-secondary">{rechargeStatusText}</p>
            ) : null}
          </div>

          <div className="rounded-lg border border-border bg-surface-primary p-3 space-y-3">
            <div className="flex items-center justify-between gap-2">
              <div className="text-sm font-medium text-text-primary">调用记录</div>
              <button
                type="button"
                onClick={() => void refreshProfileAndPoints()}
                disabled={busy}
                title="刷新记录"
                className="p-1.5 text-text-tertiary hover:text-accent-primary transition-colors disabled:opacity-50"
              >
                <RefreshCw className={clsx('w-3.5 h-3.5', busy && 'animate-spin')} />
              </button>
            </div>
            {!callRecords.length ? (
              <div className={clsx('text-xs', callRecordsError ? 'text-amber-600' : 'text-text-tertiary')}>
                {callRecordsError || '暂无调用记录。'}
              </div>
            ) : (
              <div className="space-y-2">
                {callRecordsError ? (
                  <div className="text-[11px] text-amber-600">{callRecordsError}</div>
                ) : null}
                <div className="max-h-52 overflow-auto rounded border border-border/70">
                <table className="w-full text-xs">
                  <thead className="bg-surface-secondary/40 text-text-tertiary">
                    <tr>
                      <th className="text-left px-2 py-1.5 font-medium">时间</th>
                      <th className="text-left px-2 py-1.5 font-medium">模型</th>
                      <th className="text-left px-2 py-1.5 font-medium">状态</th>
                      <th className="text-right px-2 py-1.5 font-medium">积分</th>
                      <th className="text-right px-2 py-1.5 font-medium">Tokens</th>
                    </tr>
                  </thead>
                  <tbody>
                    {callRecords.slice(0, 30).map((record) => (
                      <tr key={record.id} className="border-t border-border/50">
                        <td className="px-2 py-1.5 text-text-secondary">{record.createdAt ? new Date(record.createdAt).toLocaleString() : '-'}</td>
                        <td className="px-2 py-1.5 text-text-secondary">{record.model || '-'}</td>
                        <td className="px-2 py-1.5 text-text-secondary">{record.status || '-'}</td>
                        <td className="px-2 py-1.5 text-right text-text-secondary">{record.points}</td>
                        <td className="px-2 py-1.5 text-right text-text-secondary">{record.tokens}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                </div>
              </div>
            )}
          </div>
        </>
      )}

      <div
        className={clsx(
          'text-[11px] rounded border px-3 py-2',
          noticeType === 'error'
            ? 'border-red-500/30 bg-red-500/5 text-red-500'
            : noticeType === 'success'
              ? 'border-emerald-500/30 bg-emerald-500/5 text-emerald-600'
              : 'border-border bg-surface-primary text-text-tertiary',
        )}
      >
        {notice || '登录后可自动同步官方源并托管调用凭据。'}
      </div>
    </div>
  );
};

export const tabLabel = '登录';
export const hasOfficialAiPanel = true;

export default OfficialAiPanel;
