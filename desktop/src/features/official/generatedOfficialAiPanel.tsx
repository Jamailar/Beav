import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CreditCard, Gem, QrCode, RefreshCw, Smartphone, UserRound } from 'lucide-react';
import clsx from 'clsx';
import QRCode from 'qrcode';
import type { OfficialAiPanelProps } from './index';
import { useOfficialAuthState } from '../../hooks/useOfficialAuthState';
import { extractAlipayPayQrContent } from '../../pages/settings/shared';

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

interface ModelsResponseItem {
  id: string;
}

const PANEL_DISPLAY_SNAPSHOT_KEY = 'redbox-auth:panel-display';

interface RedboxPanelDisplaySnapshot {
  user: Record<string, unknown> | null;
  points: Record<string, unknown> | null;
  models: ModelsResponseItem[];
  callRecords: RedboxCallRecordItem[];
  updatedAt: number;
}

interface AuthenticatedDataIssue {
  label: string;
  message: string;
}

const invoke = async <T,>(channel: string, payload?: unknown): Promise<T> => {
  return window.ipcRenderer.invoke(channel, payload) as Promise<T>;
};

const OFFICIAL_PANEL_REQUEST_TIMEOUT_MS = 15_000;
const WECHAT_POLL_INITIAL_DELAY_MS = 0;
const WECHAT_POLL_PENDING_INTERVAL_MS = 900;
const WECHAT_POLL_SCANNED_INTERVAL_MS = 250;
const WECHAT_POLL_ERROR_INTERVAL_MS = 1200;

const traceAuthUi = (stage: string, detail?: unknown): void => {
  console.debug(`[OfficialAiPanel] ${stage}`, detail ?? '');
};

const summarizeSessionForTrace = (sessionData: RedboxAuthSession | null) => {
  if (!sessionData) {
    return {
      loggedIn: false,
    };
  }
  const user = sessionData.user && typeof sessionData.user === 'object'
    ? sessionData.user as Record<string, unknown>
    : null;
  return {
    loggedIn: true,
    expiresAt: sessionData.expiresAt ?? null,
    updatedAt: sessionData.updatedAt ?? null,
    userId: String(user?.id || user?.phone || user?.nickname || '').trim() || null,
  };
};

const timedInvoke = async <T,>(
  channel: string,
  payload?: unknown,
  options?: { trace?: boolean },
): Promise<T> => {
  const startedAt = performance.now();
  const trace = Boolean(options?.trace);
  if (trace) {
    traceAuthUi(`invoke:start:${channel}`, payload ?? null);
  }
  try {
    const result = await invoke<T>(channel, payload);
    if (trace) {
      traceAuthUi(`invoke:done:${channel}`, {
        elapsedMs: Math.round(performance.now() - startedAt),
        ok: true,
      });
    }
    return result;
  } catch (error) {
    if (trace) {
      traceAuthUi(`invoke:done:${channel}`, {
        elapsedMs: Math.round(performance.now() - startedAt),
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    throw error;
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

const withRequestTimeout = async <T,>(
  promise: Promise<T>,
  timeoutMs: number,
  timeoutMessage: string,
): Promise<T> => {
  return await new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(() => {
      reject(new Error(timeoutMessage));
    }, timeoutMs);

    promise.then(
      (value) => {
        window.clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        window.clearTimeout(timer);
        reject(error);
      },
    );
  });
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
  const initialPanelSnapshot = readPanelDisplaySnapshot();
  const { snapshot: authState, bootstrapped } = useOfficialAuthState();
  const [loginTab, setLoginTab] = useState<LoginTab>('wechat');
  const [user, setUser] = useState<Record<string, unknown> | null>(() => initialPanelSnapshot?.user || null);
  const [points, setPoints] = useState<Record<string, unknown> | null>(() => initialPanelSnapshot?.points || null);
  const [models, setModels] = useState<ModelsResponseItem[]>(() => initialPanelSnapshot?.models || []);
  const [callRecords, setCallRecords] = useState<RedboxCallRecordItem[]>(() => initialPanelSnapshot?.callRecords || []);
  const [rechargeAmount, setRechargeAmount] = useState('50');
  const [rechargeOrderNo, setRechargeOrderNo] = useState('');
  const [rechargeStatusText, setRechargeStatusText] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const [authBusy, setAuthBusy] = useState(false);
  const [logoutBusy, setLogoutBusy] = useState(false);
  const [paymentBusy, setPaymentBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [noticeType, setNoticeType] = useState<NoticeType>('idle');
  const [smsForm, setSmsForm] = useState({ phone: '', code: '', inviteCode: '' });
  const [wechatQrUrl, setWechatQrUrl] = useState('');
  const [wechatLoginUrl, setWechatLoginUrl] = useState('');
  const [wechatStatusText, setWechatStatusText] = useState<WechatStatus>('idle');
  const [wechatExpiresAt, setWechatExpiresAt] = useState<number>(0);
  const pollTimerRef = useRef<number | null>(null);
  const pollRunTokenRef = useRef(0);
  const pollRequestInFlightRef = useRef(false);
  const pollSessionIdRef = useRef('');
  const confirmedWechatSessionRef = useRef('');
  const backgroundRefreshQueuedRef = useRef(false);
  const lastRenderModeRef = useRef<string>('init');
  const lastSessionSignatureRef = useRef('');
  const lastBootstrapSyncSignatureRef = useRef('');
  const refreshControlsDisabled = refreshing || authBusy || logoutBusy || paymentBusy;
  const authControlsDisabled = authBusy || refreshing || logoutBusy || paymentBusy;
  const logoutDisabled = refreshControlsDisabled;
  const paymentControlsDisabled = paymentBusy || logoutBusy;
  const session = (authState?.session || null) as RedboxAuthSession | null;

  const setPanelNotice = useCallback((type: NoticeType, message: string) => {
    setNoticeType(type);
    setNotice(message);
  }, []);

  const stopWechatPolling = useCallback(() => {
    pollRunTokenRef.current += 1;
    if (pollTimerRef.current !== null) {
      window.clearTimeout(pollTimerRef.current);
      pollTimerRef.current = null;
    }
    pollRequestInFlightRef.current = false;
    pollSessionIdRef.current = '';
  }, []);

  const requestSettingsRefresh = useCallback((options?: { preserveViewState?: boolean; preserveRemoteModels?: boolean }) => {
    void onReloadSettings({
      preserveViewState: true,
      preserveRemoteModels: true,
      ...options,
    });
  }, [onReloadSettings]);

  useEffect(() => {
    const nextSessionSignature = JSON.stringify(summarizeSessionForTrace(session));
    if (lastSessionSignatureRef.current === nextSessionSignature) {
      return;
    }
    lastSessionSignatureRef.current = nextSessionSignature;
    traceAuthUi('session:committed', summarizeSessionForTrace(session));

    if (!session) {
      confirmedWechatSessionRef.current = '';
      stopWechatPolling();
      setUser(null);
      setPoints(null);
      setModels([]);
      setCallRecords([]);
      writePanelDisplaySnapshot(null);
      return;
    }

    const sessionUser = session.user && typeof session.user === 'object'
      ? session.user as Record<string, unknown>
      : null;
    setUser(sessionUser);
    if (pollSessionIdRef.current) {
      confirmedWechatSessionRef.current = pollSessionIdRef.current;
      stopWechatPolling();
      setWechatStatusText('CONFIRMED');
    }
  }, [session, stopWechatPolling]);

  useEffect(() => {
    const nextRenderMode = !bootstrapped
      ? 'bootstrapping'
      : session
        ? 'authenticated'
        : 'logged-out';
    if (lastRenderModeRef.current !== nextRenderMode) {
      lastRenderModeRef.current = nextRenderMode;
      traceAuthUi('render-mode:committed', {
        mode: nextRenderMode,
        bootstrapped,
        hasSession: Boolean(session),
      });
    }
  }, [bootstrapped, session]);

  useEffect(() => {
    writePanelDisplaySnapshot({
      user,
      points,
      models,
      callRecords,
      updatedAt: Date.now(),
    });
  }, [callRecords, models, points, user]);

  const fetchUser = useCallback(async () => {
    const result = await timedInvoke<{ success: boolean; user?: Record<string, unknown>; error?: string }>('redbox-auth:me');
    if (!result?.success) {
      throw new Error(result?.error || '拉取用户信息失败');
    }
    setUser(result.user || null);
  }, []);

  const fetchPoints = useCallback(async () => {
    const result = await timedInvoke<{ success: boolean; points?: Record<string, unknown>; error?: string }>('redbox-auth:points');
    if (!result?.success) {
      throw new Error(result?.error || '查询余额失败');
    }
    setPoints(result.points || null);
  }, []);

  const fetchModels = useCallback(async () => {
    const result = await timedInvoke<{ success: boolean; models?: ModelsResponseItem[]; error?: string }>('redbox-auth:models');
    if (!result?.success) {
      throw new Error(result?.error || '拉取模型失败');
    }
    setModels((result.models || []).filter((item) => String(item?.id || '').trim()));
  }, []);

  const fetchCallRecords = useCallback(async () => {
    const result = await timedInvoke<{ success: boolean; records?: RedboxCallRecordItem[]; error?: string }>('redbox-auth:call-records');
    if (!result?.success) {
      throw new Error(result?.error || '拉取调用记录失败');
    }
    setCallRecords((result.records || []).filter((item) => String(item?.id || '').trim()));
  }, []);

  const loadAuthenticatedData = useCallback(async (): Promise<AuthenticatedDataIssue[]> => {
    const tasks: Array<{ label: string; run: () => Promise<void> }> = [
      { label: '用户信息', run: fetchUser },
      { label: '积分余额', run: fetchPoints },
      { label: '模型列表', run: fetchModels },
      { label: '调用记录', run: fetchCallRecords },
    ];
    const results = await Promise.all(
      tasks.map(async ({ label, run }) => {
        try {
          await withRequestTimeout(
            run(),
            OFFICIAL_PANEL_REQUEST_TIMEOUT_MS,
            `${label}刷新超时，请稍后重试`,
          );
          return null;
        } catch (error) {
          const message = error instanceof Error ? error.message : `${label}刷新失败`;
          console.warn(`[OfficialAiPanel] ${label} refresh failed:`, error);
          return { label, message };
        }
      }),
    );
    return results.filter((item): item is AuthenticatedDataIssue => item !== null);
  }, [fetchCallRecords, fetchModels, fetchPoints, fetchUser]);

  const requestBackgroundRefresh = useCallback(async () => {
    const result = await timedInvoke<{ success: boolean; queued?: boolean; error?: string }>('auth:refresh-now', undefined, { trace: true });
    if (!result?.success) {
      throw new Error(result?.error || '后台刷新请求失败');
    }
    return result;
  }, []);

  const queueBackgroundRefresh = useCallback((reason: string) => {
    if (backgroundRefreshQueuedRef.current) {
      return;
    }
    backgroundRefreshQueuedRef.current = true;
    window.setTimeout(() => {
      void requestBackgroundRefresh()
        .catch((error) => {
          console.warn(`[OfficialAiPanel] background refresh failed (${reason}):`, error);
        })
        .finally(() => {
          backgroundRefreshQueuedRef.current = false;
        });
    }, 0);
  }, [requestBackgroundRefresh]);

  const refreshProfileAndPoints = useCallback(async () => {
    setRefreshing(true);
    try {
      if (!session) {
        throw new Error('当前未登录，请先登录官方账号');
      }
      const issues = await loadAuthenticatedData();
      void requestBackgroundRefresh().catch((error) => {
        console.warn('[OfficialAiPanel] background refresh request failed:', error);
      });
      if (issues.length > 0) {
        setPanelNotice('error', `刷新已完成，但部分数据未及时返回：${issues[0]?.message || issues[0]?.label}`);
      } else {
        setPanelNotice('success', '页面数据已刷新，后台缓存同步会继续完成。');
      }
    } catch (error) {
      setPanelNotice('error', error instanceof Error ? error.message : '刷新用户信息失败');
    } finally {
      setRefreshing(false);
    }
  }, [loadAuthenticatedData, requestBackgroundRefresh, session, setPanelNotice]);

  const startWechatPolling = useCallback((sessionId: string) => {
    const normalizedSessionId = String(sessionId || '').trim();
    if (!normalizedSessionId) return;
    if (confirmedWechatSessionRef.current === normalizedSessionId) {
      return;
    }
    stopWechatPolling();
    pollSessionIdRef.current = normalizedSessionId;
    const runToken = pollRunTokenRef.current;
    const scheduleNext = (delayMs: number) => {
      if (pollRunTokenRef.current !== runToken) return;
      pollTimerRef.current = window.setTimeout(() => {
        void runPoll();
      }, delayMs);
    };
    const runPoll = async () => {
      if (pollRunTokenRef.current !== runToken || pollSessionIdRef.current !== normalizedSessionId) {
        return;
      }
      if (pollRequestInFlightRef.current) {
        scheduleNext(WECHAT_POLL_PENDING_INTERVAL_MS);
        return;
      }
      pollRequestInFlightRef.current = true;
      try {
        const result = await timedInvoke<{
          success: boolean;
          data?: { status?: string; session?: RedboxAuthSession | null };
        }>('redbox-auth:wechat-status', { sessionId: normalizedSessionId });
        if (pollRunTokenRef.current !== runToken || pollSessionIdRef.current !== normalizedSessionId) {
          return;
        }
        if (!result?.success || !result.data) return;
        const status = String(result.data.status || 'PENDING').toUpperCase() as WechatStatus;
        setWechatStatusText(status);
        if (status === 'CONFIRMED') {
          confirmedWechatSessionRef.current = normalizedSessionId;
          stopWechatPolling();
          requestSettingsRefresh();
          queueBackgroundRefresh('wechat-poll');
          setPanelNotice('success', '微信登录成功');
        } else if (status === 'EXPIRED' || status === 'FAILED') {
          stopWechatPolling();
          setPanelNotice('error', status === 'EXPIRED' ? '二维码已过期，请重新获取' : '微信登录失败，请重试');
        } else {
          scheduleNext(status === 'SCANNED' ? WECHAT_POLL_SCANNED_INTERVAL_MS : WECHAT_POLL_PENDING_INTERVAL_MS);
        }
      } catch {
        if (pollRunTokenRef.current === runToken && pollSessionIdRef.current === normalizedSessionId) {
          scheduleNext(WECHAT_POLL_ERROR_INTERVAL_MS);
        }
      } finally {
        pollRequestInFlightRef.current = false;
      }
    };
    scheduleNext(WECHAT_POLL_INITIAL_DELAY_MS);
  }, [queueBackgroundRefresh, requestSettingsRefresh, setPanelNotice, stopWechatPolling]);

  const fetchWechatQr = useCallback(async (options?: { silent?: boolean }) => {
    const silent = Boolean(options?.silent);
    if (!silent) {
      setAuthBusy(true);
    }
    try {
      confirmedWechatSessionRef.current = '';
      stopWechatPolling();
      const result = await timedInvoke<{ success: boolean; data?: RedboxWechatInfo; error?: string }>(
        'redbox-auth:wechat-url',
        { state: 'redconvert-desktop' },
        { trace: true },
      );
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
        setAuthBusy(false);
      }
    }
  }, [setPanelNotice, startWechatPolling, stopWechatPolling]);

  const sendSmsCode = useCallback(async () => {
    const phone = String(smsForm.phone || '').trim();
    if (!phone) {
      setPanelNotice('error', '请先输入手机号');
      return;
    }
    setAuthBusy(true);
    try {
      const result = await timedInvoke<{ success: boolean; error?: string }>(
        'redbox-auth:send-sms-code',
        { phone },
        { trace: true },
      );
      if (!result?.success) {
        throw new Error(result?.error || '验证码发送失败');
      }
      setPanelNotice('success', '验证码已发送');
    } catch (error) {
      setPanelNotice('error', error instanceof Error ? error.message : '验证码发送失败');
    } finally {
      setAuthBusy(false);
    }
  }, [setPanelNotice, smsForm.phone]);

  const handleSmsAuth = useCallback(async (mode: 'login' | 'register') => {
    const phone = String(smsForm.phone || '').trim();
    const code = String(smsForm.code || '').trim();
    if (!phone || !code) {
      setPanelNotice('error', '请输入手机号和验证码');
      return;
    }
    setAuthBusy(true);
    try {
      const result = await timedInvoke<{ success: boolean; session?: RedboxAuthSession; error?: string }>(
        mode === 'login' ? 'redbox-auth:login-sms' : 'redbox-auth:register-sms',
        { phone, code, inviteCode: smsForm.inviteCode.trim() || undefined },
        { trace: true },
      );
      if (!result?.success || !result.session) {
        throw new Error(result?.error || (mode === 'login' ? '登录失败' : '注册失败'));
      }
      requestSettingsRefresh();
      queueBackgroundRefresh(mode);
      setPanelNotice('success', mode === 'login' ? '登录成功' : '注册并登录成功');
    } catch (error) {
      setPanelNotice('error', error instanceof Error ? error.message : (mode === 'login' ? '登录失败' : '注册失败'));
    } finally {
      setAuthBusy(false);
    }
  }, [queueBackgroundRefresh, requestSettingsRefresh, setPanelNotice, smsForm.code, smsForm.inviteCode, smsForm.phone]);

  const logout = useCallback(async () => {
    setLogoutBusy(true);
    try {
      const result = await timedInvoke<{ success: boolean; error?: string }>(
        'redbox-auth:logout',
        undefined,
        { trace: true },
      );
      if (!result?.success) {
        throw new Error(result?.error || '退出登录失败');
      }
      confirmedWechatSessionRef.current = '';
      stopWechatPolling();
      setUser(null);
      setPoints(null);
      setModels([]);
      setCallRecords([]);
      writePanelDisplaySnapshot(null);
      setRechargeOrderNo('');
      setRechargeStatusText('');
      requestSettingsRefresh();
      setPanelNotice('success', '已退出登录');
    } catch (error) {
      setPanelNotice('error', error instanceof Error ? error.message : '退出登录失败');
    } finally {
      setLogoutBusy(false);
    }
  }, [requestSettingsRefresh, setPanelNotice, stopWechatPolling]);

  const handleCreateOrderAndPay = useCallback(async () => {
    const amount = normalizeRechargeAmountInput(rechargeAmount);
    if (!amount) {
      setPanelNotice('error', '请输入充值金额');
      return;
    }
    setPaymentBusy(true);
    try {
      const orderResult = await invoke<{ success: boolean; order?: Record<string, unknown>; error?: string }>('redbox-auth:create-page-pay-order', {
        amount: amount || undefined,
        subject: `积分充值 ¥${amount}`,
        pointsToDeduct: 0,
      });
      if (!orderResult?.success || !orderResult.order) {
        throw new Error(orderResult?.error || '创建订单失败');
      }
      const outTradeNo = String(orderResult.order.out_trade_no || orderResult.order.outTradeNo || '').trim();
      const paymentForm = extractAlipayPayQrContent(orderResult.order)
        || String(orderResult.order.payment_url || orderResult.order.payment_form || orderResult.order.url || '').trim();
      console.log('[OfficialAiPanel] page-pay order created', {
        outTradeNo,
        orderKeys: Object.keys(orderResult.order || {}),
        paymentFormLength: paymentForm.length,
        paymentFormPreview: paymentForm.slice(0, 120).replace(/\s+/g, ' '),
      });
      if (!outTradeNo || !paymentForm) {
        throw new Error('订单返回缺少支付信息');
      }
      const openResult = await invoke<{ success: boolean; error?: string }>('redbox-auth:open-payment-form', { paymentForm });
      console.log('[OfficialAiPanel] open-payment-form result', openResult);
      if (!openResult?.success) {
        throw new Error(openResult?.error || '打开支付页面失败');
      }
      setRechargeOrderNo(outTradeNo);
      setRechargeStatusText(`订单 ${outTradeNo} 已创建。请在浏览器完成支付，支付成功后点击上方刷新余额。`);
      setPanelNotice('success', '支付页面已打开，请在浏览器完成支付。');
    } catch (error) {
      const message = error instanceof Error ? error.message : '充值失败';
      setRechargeStatusText(message);
      setPanelNotice('error', message);
    } finally {
      setPaymentBusy(false);
    }
  }, [rechargeAmount, setPanelNotice]);

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

  const rechargePreviewPoints = useMemo(() => {
    const amount = Number(normalizeRechargeAmountInput(rechargeAmount) || 0);
    if (!Number.isFinite(amount) || amount <= 0) return 0;
    return amount * pointsPerYuan;
  }, [pointsPerYuan, rechargeAmount]);

  useEffect(() => {
    if (!bootstrapped || !session) {
      lastBootstrapSyncSignatureRef.current = '';
      return;
    }
    const nextBootstrapSyncSignature = JSON.stringify({
      updatedAt: session.updatedAt ?? null,
      expiresAt: session.expiresAt ?? null,
      userId: summarizeSessionForTrace(session).userId ?? null,
    });
    if (lastBootstrapSyncSignatureRef.current === nextBootstrapSyncSignature) {
      return;
    }
    lastBootstrapSyncSignatureRef.current = nextBootstrapSyncSignature;
    requestSettingsRefresh();
    queueBackgroundRefresh('bootstrap');
  }, [bootstrapped, queueBackgroundRefresh, requestSettingsRefresh, session]);

  useEffect(() => {
    return () => {
      stopWechatPolling();
    };
  }, [stopWechatPolling]);

  useEffect(() => {
    const handleDataUpdated = (_event: unknown, payload?: { points?: Record<string, unknown> | null; models?: ModelsResponseItem[]; callRecords?: RedboxCallRecordItem[] }) => {
      traceAuthUi('auth:onDataChanged', {
        hasPoints: Boolean(payload?.points),
        modelCount: payload?.models?.length || 0,
        recordCount: payload?.callRecords?.length || 0,
      });
      if (payload?.points) setPoints(payload.points);
      if (payload?.models) {
        setModels((payload.models || []).filter((item) => String(item?.id || '').trim()));
      }
      if (payload?.callRecords) {
        setCallRecords((payload.callRecords || []).filter((item) => String(item?.id || '').trim()));
      }
    };
    window.ipcRenderer.auth.onDataChanged(handleDataUpdated);
    return () => {
      window.ipcRenderer.auth.offDataChanged(handleDataUpdated);
    };
  }, []);

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
            disabled={refreshControlsDisabled}
            title="刷新信息"
            className="p-1.5 text-text-tertiary hover:text-accent-primary transition-colors disabled:opacity-50"
          >
            <RefreshCw className={clsx('w-3.5 h-3.5', refreshing && 'animate-spin')} />
          </button>
          <button
            type="button"
            onClick={() => void logout()}
            disabled={logoutDisabled || !session}
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
                    disabled={authControlsDisabled}
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
                    disabled={authControlsDisabled}
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
                    disabled={authControlsDisabled}
                    className="px-3 py-1.5 text-xs border border-border rounded hover:bg-surface-secondary transition-colors disabled:opacity-50"
                  >
                    登录
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleSmsAuth('register')}
                    disabled={authControlsDisabled}
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
                  disabled={refreshControlsDisabled}
                  title="刷新余额"
                  className="p-1.5 text-text-tertiary hover:text-accent-primary transition-colors disabled:opacity-50"
                >
                  <RefreshCw className={clsx('w-3.5 h-3.5', refreshing && 'animate-spin')} />
                </button>
              </div>
            </div>
            <p className="text-[11px] text-text-tertiary">
              用户：{userName || '未命名用户'} · 模型 {models.length} 个 · 余额单位为积分（1 元 = {pointsPerYuan} 积分）
            </p>
            <div className="flex flex-wrap items-center gap-2">
              {[20, 50, 100].map((amount) => (
                <button
                  key={amount}
                  type="button"
                  onClick={() => setRechargeAmount(amount.toFixed(2))}
                  className={clsx(
                    'px-3 py-1.5 text-xs border rounded transition-all',
                    Number(rechargeAmount) === amount
                      ? 'bg-accent-primary/10 border-accent-primary text-accent-primary'
                      : 'border-border hover:bg-surface-secondary text-text-secondary',
                  )}
                >
                  ¥{amount}
                </button>
              ))}
              <div className="flex items-center gap-2 ml-1">
                <input
                  value={rechargeAmount}
                  onChange={(e) => setRechargeAmount(e.target.value)}
                  placeholder="其他金额"
                  className="w-24 bg-surface-secondary/30 rounded border border-border px-2.5 py-1.5 text-xs focus:outline-none focus:border-accent-primary transition-colors"
                />
                <button
                  type="button"
                    onClick={() => void handleCreateOrderAndPay()}
                    disabled={paymentControlsDisabled || !rechargeAmount || Number(rechargeAmount) <= 0}
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
                disabled={refreshControlsDisabled}
                title="刷新记录"
                className="p-1.5 text-text-tertiary hover:text-accent-primary transition-colors disabled:opacity-50"
              >
                <RefreshCw className={clsx('w-3.5 h-3.5', refreshing && 'animate-spin')} />
              </button>
            </div>
            {!callRecords.length ? (
              <div className="text-xs text-text-tertiary">暂无调用记录（或后端暂未开放该接口）。</div>
            ) : (
              <div className="max-h-52 overflow-auto rounded border border-border/70">
                <table className="w-full text-xs">
                  <thead className="bg-surface-secondary/40 text-text-tertiary">
                    <tr>
                      <th className="text-left px-2 py-1.5 font-medium">时间</th>
                      <th className="text-left px-2 py-1.5 font-medium">模型</th>
                      <th className="text-right px-2 py-1.5 font-medium">积分</th>
                      <th className="text-right px-2 py-1.5 font-medium">Tokens</th>
                    </tr>
                  </thead>
                  <tbody>
                    {callRecords.slice(0, 30).map((record) => (
                      <tr key={record.id} className="border-t border-border/50">
                        <td className="px-2 py-1.5 text-text-secondary">{new Date(record.createdAt).toLocaleString()}</td>
                        <td className="px-2 py-1.5 text-text-secondary">{record.model || '-'}</td>
                        <td className="px-2 py-1.5 text-right text-text-secondary">{record.points}</td>
                        <td className="px-2 py-1.5 text-right text-text-secondary">{record.tokens}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
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
