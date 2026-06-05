import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Box, Check, Gem, Globe2, LockKeyhole, QrCode, RefreshCw, ShieldCheck, Smartphone, Table2, UserRound, Zap } from 'lucide-react';
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
  realm?: 'cn' | 'global';
  realmLabel?: string;
  baseUrl?: string;
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

interface OfficialRealmConfig {
  id: 'cn' | 'global';
  label: string;
  active?: boolean;
}

interface OfficialAuthConfig {
  success: boolean;
  activeRealm?: 'cn' | 'global';
  realms?: OfficialRealmConfig[];
}

const PANEL_DISPLAY_SNAPSHOT_KEY = 'redbox-auth:panel-display';

interface RedboxPanelDisplaySnapshot {
  user: Record<string, unknown> | null;
  points: Record<string, unknown> | null;
  callRecords: RedboxCallRecordItem[];
  updatedAt: number;
}

interface AuthenticatedDataIssue {
  label: string;
  message: string;
}

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

const timedRequest = async <T,>(
  operation: string,
  request: Promise<unknown>,
  options?: { trace?: boolean },
): Promise<T> => {
  const startedAt = performance.now();
  const trace = Boolean(options?.trace);
  if (trace) {
    traceAuthUi(`request:start:${operation}`);
  }
  try {
    const result = await request as T;
    if (trace) {
      traceAuthUi(`request:done:${operation}`, {
        elapsedMs: Math.round(performance.now() - startedAt),
        ok: true,
      });
    }
    return result;
  } catch (error) {
    if (trace) {
      traceAuthUi(`request:done:${operation}`, {
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
    const previous = readPanelDisplaySnapshot();
    const nextSnapshot: RedboxPanelDisplaySnapshot = {
      ...snapshot,
      points: snapshot.points || previous?.points || null,
      callRecords: snapshot.callRecords.length ? snapshot.callRecords : previous?.callRecords || [],
    };
    window.localStorage.setItem(PANEL_DISPLAY_SNAPSHOT_KEY, JSON.stringify(nextSnapshot));
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

const OfficialAiPanel = ({ onReloadSettings, onOpenPricing }: OfficialAiPanelProps) => {
  const initialPanelSnapshot = readPanelDisplaySnapshot();
  const { snapshot: authState, bootstrapped } = useOfficialAuthState();
  const [loginTab, setLoginTab] = useState<LoginTab>('wechat');
  const [user, setUser] = useState<Record<string, unknown> | null>(() => initialPanelSnapshot?.user || null);
  const [points, setPoints] = useState<Record<string, unknown> | null>(() => initialPanelSnapshot?.points || null);
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
  const [activeRealm, setActiveRealm] = useState<'cn' | 'global'>('cn');
  const [realms, setRealms] = useState<OfficialRealmConfig[]>([
    { id: 'cn', label: '中国大陆账号', active: true },
    { id: 'global', label: '海外账号' },
  ]);
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

  const refreshRealmConfig = useCallback(async () => {
    const result = await timedRequest<OfficialAuthConfig>('officialAuth.getConfig', window.ipcRenderer.officialAuth.getConfig());
    if (!result?.success) return;
    const nextActiveRealm = result.activeRealm === 'global' ? 'global' : 'cn';
    setActiveRealm(nextActiveRealm);
    if (Array.isArray(result.realms) && result.realms.length > 0) {
      setRealms(result.realms.filter((item): item is OfficialRealmConfig => item?.id === 'cn' || item?.id === 'global'));
    }
  }, []);

  const switchRealm = useCallback(async (realm: 'cn' | 'global') => {
    if (realm === activeRealm || session) return;
    setAuthBusy(true);
    setPanelNotice('idle', '');
    try {
      const result = await timedRequest<OfficialAuthConfig & { error?: string }>(
        'officialAuth.setRealm',
        window.ipcRenderer.officialAuth.setRealm({ realm }),
      );
      if (!result?.success) {
        throw new Error(result?.error || '切换账号区失败');
      }
      stopWechatPolling();
      setWechatQrUrl('');
      setWechatLoginUrl('');
      setWechatStatusText('idle');
      setWechatExpiresAt(0);
      const nextActiveRealm = result.activeRealm === 'global' ? 'global' : 'cn';
      setActiveRealm(nextActiveRealm);
      if (Array.isArray(result.realms) && result.realms.length > 0) {
        setRealms(result.realms.filter((item): item is OfficialRealmConfig => item?.id === 'cn' || item?.id === 'global'));
      }
      requestSettingsRefresh();
    } catch (error) {
      setPanelNotice('error', error instanceof Error ? error.message : '切换账号区失败');
    } finally {
      setAuthBusy(false);
    }
  }, [activeRealm, requestSettingsRefresh, session, setPanelNotice, stopWechatPolling]);

  useEffect(() => {
    void refreshRealmConfig();
  }, [refreshRealmConfig]);

  useEffect(() => {
    const sessionRealm = session?.realm === 'global' ? 'global' : session?.realm === 'cn' ? 'cn' : null;
    if (sessionRealm && sessionRealm !== activeRealm) {
      setActiveRealm(sessionRealm);
    }
  }, [activeRealm, session]);

  useEffect(() => {
    const nextSessionSignature = JSON.stringify(summarizeSessionForTrace(session));
    if (lastSessionSignatureRef.current === nextSessionSignature) {
      return;
    }
    lastSessionSignatureRef.current = nextSessionSignature;
    traceAuthUi('session:committed', summarizeSessionForTrace(session));

    if (!session) {
      if (!bootstrapped) return;
      confirmedWechatSessionRef.current = '';
      stopWechatPolling();
      setUser(null);
      setPoints(null);
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
  }, [bootstrapped, session, stopWechatPolling]);

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
    if (!user && !points && !callRecords.length) {
      return;
    }
    writePanelDisplaySnapshot({
      user,
      points,
      callRecords,
      updatedAt: Date.now(),
    });
  }, [callRecords, points, user]);

  const fetchUser = useCallback(async () => {
    const result = await timedRequest<{ success: boolean; user?: Record<string, unknown>; error?: string }>(
      'officialAuth.getMe',
      window.ipcRenderer.officialAuth.getMe(),
    );
    if (!result?.success) {
      throw new Error(result?.error || '拉取用户信息失败');
    }
    setUser(result.user || null);
  }, []);

  const fetchPoints = useCallback(async () => {
    const result = await timedRequest<{ success: boolean; points?: Record<string, unknown>; error?: string }>(
      'officialAuth.getPoints',
      window.ipcRenderer.officialAuth.getPoints(),
    );
    if (!result?.success) {
      throw new Error(result?.error || '查询余额失败');
    }
    setPoints((prev) => result.points || prev);
  }, []);

  const fetchCallRecords = useCallback(async () => {
    const result = await timedRequest<{ success: boolean; records?: RedboxCallRecordItem[]; error?: string }>(
      'officialAuth.getCallRecords',
      window.ipcRenderer.officialAuth.getCallRecords(),
    );
    if (!result?.success) {
      throw new Error(result?.error || '拉取调用记录失败');
    }
    const nextRecords = (result.records || []).filter((item) => String(item?.id || '').trim());
    setCallRecords((prev) => nextRecords.length ? nextRecords : prev);
  }, []);

  const loadAuthenticatedData = useCallback(async (): Promise<AuthenticatedDataIssue[]> => {
    const tasks: Array<{ label: string; run: () => Promise<void> }> = [
      { label: '用户信息', run: fetchUser },
      { label: '积分余额', run: fetchPoints },
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
  }, [fetchCallRecords, fetchPoints, fetchUser]);

  const requestBackgroundRefresh = useCallback(async () => {
    const result = await timedRequest<{ success: boolean; queued?: boolean; error?: string }>(
      'auth.refreshNow',
      window.ipcRenderer.auth.refreshNow(),
      { trace: true },
    );
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
        const result = await timedRequest<{
          success: boolean;
          data?: { status?: string; session?: RedboxAuthSession | null };
        }>('officialAuth.getWechatStatus', window.ipcRenderer.officialAuth.getWechatStatus({ sessionId: normalizedSessionId }));
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
      const result = await timedRequest<{ success: boolean; data?: RedboxWechatInfo; error?: string }>(
        'officialAuth.getWechatUrl',
        window.ipcRenderer.officialAuth.getWechatUrl({ state: 'redconvert-desktop' }),
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
      const result = await timedRequest<{ success: boolean; error?: string }>(
        'officialAuth.sendSmsCode',
        window.ipcRenderer.officialAuth.sendSmsCode({ phone }),
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
      const smsPayload = { phone, code, inviteCode: smsForm.inviteCode.trim() || undefined };
      const result = await timedRequest<{ success: boolean; session?: RedboxAuthSession; error?: string }>(
        mode === 'login' ? 'officialAuth.loginSms' : 'officialAuth.registerSms',
        mode === 'login'
          ? window.ipcRenderer.officialAuth.loginSms(smsPayload)
          : window.ipcRenderer.officialAuth.registerSms(smsPayload),
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
      const result = await timedRequest<{ success: boolean; error?: string }>(
        'officialAuth.logout',
        window.ipcRenderer.officialAuth.logout(),
        { trace: true },
      );
      if (!result?.success) {
        throw new Error(result?.error || '退出登录失败');
      }
      confirmedWechatSessionRef.current = '';
      stopWechatPolling();
      setUser(null);
      setPoints(null);
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
      const orderResult = await timedRequest<{ success: boolean; order?: Record<string, unknown>; error?: string }>(
        'officialAuth.createPagePayOrder',
        window.ipcRenderer.officialAuth.createPagePayOrder({
          amount: amount || undefined,
          subject: `积分充值 ¥${amount}`,
          pointsToDeduct: 0,
        }),
      );
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
      const openResult = await timedRequest<{ success: boolean; error?: string }>(
        'officialAuth.openPaymentForm',
        window.ipcRenderer.officialAuth.openPaymentForm({ paymentForm }),
      );
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
    const handleDataUpdated = (_event: unknown, payload?: { points?: Record<string, unknown> | null; callRecords?: RedboxCallRecordItem[]; records?: RedboxCallRecordItem[] }) => {
      const nextCallRecords = payload?.callRecords || payload?.records || [];
      traceAuthUi('auth:onDataChanged', {
        hasPoints: Boolean(payload?.points),
        recordCount: nextCallRecords.length,
      });
      if (payload?.points) setPoints(payload.points);
      if (payload?.callRecords || payload?.records) {
        const filteredCallRecords = nextCallRecords.filter((item) => String(item?.id || '').trim());
        setCallRecords((prev) => filteredCallRecords.length ? filteredCallRecords : prev);
      }
    };
    window.ipcRenderer.auth.onDataChanged(handleDataUpdated);
    return () => {
      window.ipcRenderer.auth.offDataChanged(handleDataUpdated);
    };
  }, []);

  return (
    <div className="rounded-2xl border border-black/[0.04] dark:border-white/[0.04] bg-black/[0.005] dark:bg-white/[0.005] p-5 space-y-5">
      {!session ? (
        !bootstrapped ? (
          <div className="rounded-xl border border-border bg-surface-primary p-5 text-sm text-text-secondary shadow-sm">
            正在检查登录状态…
          </div>
        ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
          <div className="rounded-xl border border-black/[0.04] dark:border-white/[0.04] bg-white dark:bg-surface-primary p-4 space-y-4 shadow-sm">
            <div className="flex items-center justify-between gap-2">
              <div className="inline-flex items-center gap-1.5 text-xs text-text-secondary font-bold">
                <Globe2 className="w-3.5 h-3.5" />
                账号区
              </div>
              <div className="inline-flex items-center rounded-full border border-black/[0.05] dark:border-white/[0.05] bg-black/[0.015] dark:bg-white/[0.015] p-0.5">
                {realms.map((realm) => (
                  <button
                    key={realm.id}
                    type="button"
                    onClick={() => void switchRealm(realm.id)}
                    disabled={authControlsDisabled || Boolean(session)}
                    className={clsx(
                      'px-2.5 py-1 text-[11px] font-bold rounded-full transition-colors disabled:opacity-50',
                      activeRealm === realm.id ? 'bg-white dark:bg-surface-primary shadow-sm text-text-primary' : 'text-text-secondary',
                    )}
                  >
                    {realm.label}
                  </button>
                ))}
              </div>
            </div>
            <div className="inline-flex items-center rounded-full border border-black/[0.05] dark:border-white/[0.05] bg-black/[0.015] dark:bg-white/[0.015] p-0.5">
              <button
                type="button"
                onClick={() => setLoginTab('wechat')}
                className={clsx(
                  'px-3 py-1.5 text-xs font-bold rounded-full transition-colors inline-flex items-center gap-1.5',
                  loginTab === 'wechat' ? 'bg-white dark:bg-surface-primary shadow-sm text-text-primary' : 'text-text-secondary',
                )}
              >
                <QrCode className="w-3.5 h-3.5 text-accent-primary" />
                微信扫码登录
              </button>
              <button
                type="button"
                onClick={() => setLoginTab('sms')}
                className={clsx(
                  'px-3 py-1.5 text-xs font-bold rounded-full transition-colors inline-flex items-center gap-1.5',
                  loginTab === 'sms' ? 'bg-white dark:bg-surface-primary shadow-sm text-text-primary' : 'text-text-secondary',
                )}
              >
                <Smartphone className="w-3.5 h-3.5 text-blue-500" />
                短信极速登录
              </button>
            </div>

            {loginTab === 'wechat' ? (
              <div className="space-y-4">
                <div className="h-56 rounded-xl border border-black/[0.04] dark:border-white/[0.04] bg-black/[0.01] dark:bg-white/[0.01] flex items-center justify-center overflow-hidden relative group">
                  {wechatQrUrl ? (
                    <img src={wechatQrUrl} alt="微信登录二维码" className="h-full w-full object-contain p-2" />
                  ) : (
                    <div className="text-xs font-medium text-text-tertiary">点击“获取二维码”开始安全登录</div>
                  )}
                </div>
                <div className="flex items-center justify-between gap-2">
                  <button
                    type="button"
                    onClick={() => void fetchWechatQr()}
                    disabled={authControlsDisabled}
                    className="px-4 py-2 text-xs font-bold border border-black/[0.05] dark:border-white/[0.05] bg-black/[0.01] dark:bg-white/[0.01] rounded-xl hover:bg-black/[0.03] dark:hover:bg-white/[0.03] active:scale-95 transition-all disabled:opacity-50"
                  >
                    获取最新二维码
                  </button>
                  <span className="text-[11px] font-bold text-text-tertiary">
                    状态：
                    <span className={clsx(
                      "font-black uppercase tracking-wider",
                      wechatStatusText === 'CONFIRMED' ? "text-emerald-500" : wechatStatusText === 'SCANNED' ? "text-accent-primary" : "text-text-tertiary"
                    )}>
                      {wechatStatusText === 'idle' ? '待获取' : wechatStatusText}
                    </span>
                  </span>
                </div>
                {wechatLoginUrl ? (
                  <p className="text-[11px] font-medium text-text-tertiary leading-relaxed">
                    扫码异常？
                    {' '}
                    <a href={wechatLoginUrl} target="_blank" rel="noreferrer" className="text-accent-primary hover:underline font-bold">
                      在新窗口打开微信登录链接
                    </a>
                  </p>
                ) : null}
                {wechatExpiresAt > 0 ? (
                  <p className="text-[10px] font-bold text-text-tertiary">二维码有效期至：{new Date(wechatExpiresAt).toLocaleTimeString()}</p>
                ) : null}
              </div>
            ) : (
              <div className="space-y-2.5">
                <input
                  type="text"
                  value={smsForm.phone}
                  onChange={(e) => setSmsForm((prev) => ({ ...prev, phone: e.target.value }))}
                  placeholder="手机号"
                  className="w-full bg-black/[0.01] dark:bg-white/[0.01] rounded-xl border border-black/[0.05] dark:border-white/[0.05] px-3.5 py-2 text-sm focus:outline-none focus:border-accent-primary focus:bg-white dark:focus:bg-surface-primary transition-all font-medium"
                />
                <div className="grid grid-cols-[1fr_auto] gap-2">
                  <input
                    type="text"
                    value={smsForm.code}
                    onChange={(e) => setSmsForm((prev) => ({ ...prev, code: e.target.value }))}
                    placeholder="短信验证码"
                    className="w-full bg-black/[0.01] dark:bg-white/[0.01] rounded-xl border border-black/[0.05] dark:border-white/[0.05] px-3.5 py-2 text-sm focus:outline-none focus:border-accent-primary focus:bg-white dark:focus:bg-surface-primary transition-all font-medium"
                  />
                  <button
                    type="button"
                    onClick={() => void sendSmsCode()}
                    disabled={authControlsDisabled}
                    className="px-3.5 py-2 text-xs font-bold border border-black/[0.05] dark:border-white/[0.05] bg-black/[0.01] dark:bg-white/[0.01] rounded-xl hover:bg-black/[0.03] dark:hover:bg-white/[0.03] transition-all disabled:opacity-50"
                  >
                    发送验证码
                  </button>
                </div>
                <input
                  type="text"
                  value={smsForm.inviteCode}
                  onChange={(e) => setSmsForm((prev) => ({ ...prev, inviteCode: e.target.value }))}
                  placeholder="邀请码（可选）"
                  className="w-full bg-black/[0.01] dark:bg-white/[0.01] rounded-xl border border-black/[0.05] dark:border-white/[0.05] px-3.5 py-2 text-sm focus:outline-none focus:border-accent-primary focus:bg-white dark:focus:bg-surface-primary transition-all font-medium"
                />
                <div className="flex items-center gap-2 pt-1">
                  <button
                    type="button"
                    onClick={() => void handleSmsAuth('login')}
                    disabled={authControlsDisabled}
                    className="px-4 py-2 text-xs font-extrabold text-white bg-accent-primary rounded-xl hover:brightness-105 active:scale-95 transition-all disabled:opacity-50"
                  >
                    登录账户
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleSmsAuth('register')}
                    disabled={authControlsDisabled}
                    className="px-4 py-2 text-xs font-bold border border-black/[0.05] dark:border-white/[0.05] rounded-xl hover:bg-black/[0.02] dark:hover:bg-white/[0.02] active:scale-95 transition-all disabled:opacity-50"
                  >
                    注册新账号
                  </button>
                </div>
              </div>
            )}
          </div>

          <div className="rounded-xl border border-dashed border-black/[0.08] dark:border-white/[0.08] bg-black/[0.01] dark:bg-white/[0.005] p-5 flex flex-col justify-center select-none">
            <div className="flex items-center gap-2.5 text-sm font-black text-text-primary">
              <div className="w-6 h-6 rounded-md bg-accent-primary/10 flex items-center justify-center text-accent-primary">
                <UserRound className="w-3.5 h-3.5" />
              </div>
              等待全局登录
            </div>
            <ul className="mt-4 text-xs text-text-secondary space-y-2 leading-relaxed">
              <li className="flex items-start gap-1.5">
                <span className="text-accent-primary mt-0.5">✔</span>
                <span>自动绑定官方云端 API Key 凭证</span>
              </li>
              <li className="flex items-start gap-1.5">
                <span className="text-accent-primary mt-0.5">✔</span>
                <span>同步最新的 AI 大模型配置与服务</span>
              </li>
              <li className="flex items-start gap-1.5">
                <span className="text-accent-primary mt-0.5">✔</span>
                <span>便捷查询个人积分余额与实时调用账单</span>
              </li>
            </ul>
          </div>
        </div>
        )
      ) : (
        <>
          <section className="overflow-hidden rounded-[18px] bg-[linear-gradient(130deg,rgb(var(--color-accent-primary)/0.075),rgb(245_158_11/0.045)_42%,rgb(255_255_255/0.82))] p-4 shadow-[0_18px_46px_-30px_rgba(194,92,16,0.38)] dark:bg-[linear-gradient(130deg,rgb(var(--color-accent-primary)/0.13),rgb(245_158_11/0.075)_42%,rgb(255_255_255/0.02))]">
            <div className="mb-4 flex items-start justify-between gap-4">
              <div className="min-w-0">
                <div className="mb-2 text-xs font-bold text-text-secondary">当前积分余额</div>
                <div className="flex flex-wrap items-end gap-2">
                  {hasPointsSnapshot ? (
                    <>
                      <span className="text-[32px] font-black leading-none tracking-normal text-text-primary md:text-[36px]">
                        {Number(pointsValue).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                      </span>
                      <span className="pb-1 text-sm font-bold text-text-secondary">积分</span>
                    </>
                  ) : (
                    <span className="pb-1.5 text-xl font-black tracking-normal text-text-primary">待同步</span>
                  )}
                </div>
              </div>
              <button
                type="button"
                onClick={() => void refreshProfileAndPoints()}
                disabled={refreshControlsDisabled}
                className="inline-flex h-9 shrink-0 items-center justify-center gap-1.5 rounded-lg border border-black/[0.08] bg-white/78 px-3 text-xs font-bold text-text-secondary shadow-sm transition-all hover:border-accent-primary/[0.24] hover:bg-white hover:text-text-primary disabled:opacity-50 dark:border-white/[0.08] dark:bg-surface-primary/76"
              >
                <RefreshCw className={clsx('h-3.5 w-3.5', refreshing && 'animate-spin')} />
                刷新余额
              </button>
            </div>

            <div className="rounded-xl bg-white/72 p-3.5 shadow-sm backdrop-blur dark:bg-surface-primary/64">
              <div className="mb-3.5 flex flex-wrap items-center gap-2.5">
                <span className="text-sm font-bold text-text-primary">选择充值金额</span>
                <span className="rounded-md bg-accent-primary/10 px-2 py-0.5 text-[11px] font-bold text-accent-primary">
                  1 元 = {Number(pointsPerYuan).toLocaleString()} 积分
                </span>
              </div>

              <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
                {[
                  { amount: 20, badge: '' },
                  { amount: 50, badge: '推荐' },
                  { amount: 100, badge: '' },
                ].map((pkg) => {
                  const isSelected = Number(rechargeAmount) === pkg.amount;
                  return (
                    <button
                      key={pkg.amount}
                      type="button"
                      onClick={() => setRechargeAmount(pkg.amount.toFixed(2))}
                      className={clsx(
                        'relative flex min-h-[96px] flex-col items-center justify-center rounded-lg border px-3 py-3.5 text-center transition-all active:scale-[0.99]',
                        isSelected
                          ? 'border-accent-primary bg-[linear-gradient(135deg,rgb(var(--color-accent-primary)/0.08),rgb(255_255_255/0.9))] text-accent-primary shadow-[0_18px_34px_-22px_rgb(var(--color-accent-primary)/0.58)] ring-1 ring-accent-primary/[0.16] dark:bg-surface-primary'
                          : 'border-black/[0.08] bg-white/64 text-text-primary hover:border-accent-primary/[0.26] hover:bg-white dark:border-white/[0.08] dark:bg-white/[0.025]'
                      )}
                    >
                      {pkg.badge ? (
                          <span className="absolute left-2 top-2 rounded-md bg-accent-primary px-1.5 py-0.5 text-[10px] font-black text-white shadow-sm">
                          {pkg.badge}
                        </span>
                      ) : null}
                      {isSelected ? (
                        <span className="absolute right-2 top-2 inline-flex h-[18px] w-[18px] items-center justify-center rounded-full bg-accent-primary text-white">
                          <Check className="h-3 w-3" />
                        </span>
                      ) : null}
                      <span className="text-[24px] font-black leading-none tracking-normal">¥{pkg.amount}</span>
                      <span className={clsx('mt-2.5 text-xs font-bold', isSelected ? 'text-accent-primary' : 'text-text-secondary')}>
                        {(pkg.amount * pointsPerYuan).toLocaleString()} 积分
                      </span>
                    </button>
                  );
                })}

                <div className="flex min-h-[96px] flex-col items-center justify-center rounded-lg border border-black/[0.08] bg-white/58 px-3 py-3.5 dark:border-white/[0.08] dark:bg-white/[0.02]">
                  <label className="mb-2.5 text-xs font-bold text-text-primary">自定义金额</label>
                  <div className="grid h-9 w-full max-w-[152px] grid-cols-[36px_1fr] overflow-hidden rounded-lg border border-black/[0.08] bg-white/72 dark:border-white/[0.08] dark:bg-surface-primary/72">
                    <span className="flex items-center justify-center border-r border-black/[0.06] text-xs font-bold text-text-secondary dark:border-white/[0.08]">¥</span>
                    <input
                      value={rechargeAmount}
                      onChange={(e) => setRechargeAmount(e.target.value)}
                      placeholder="请输入金额"
                      type="number"
                      className="min-w-0 bg-transparent px-2.5 text-xs font-bold text-text-primary outline-none placeholder:text-text-tertiary/70"
                    />
                  </div>
                  <span className="mt-1.5 text-[10px] font-medium text-text-tertiary">最低 ¥1</span>
                </div>
              </div>

              <div className="mt-3.5 grid gap-3 rounded-xl border border-accent-primary/[0.12] bg-[linear-gradient(135deg,rgb(255_255_255/0.74),rgb(var(--color-accent-primary)/0.035))] p-3 dark:bg-white/[0.03] lg:grid-cols-[minmax(0,1fr)_auto] lg:items-center">
                <div className="text-xs font-medium leading-5 text-text-secondary">
                  <div>充值 ¥{normalizeRechargeAmountInput(rechargeAmount) || '0'}</div>
                  <div>按 1 元 = {Number(pointsPerYuan).toLocaleString()} 积分计算</div>
                  {rechargeOrderNo ? (
                    <div className="truncate text-[11px] text-text-tertiary" title={rechargeOrderNo}>订单 {rechargeOrderNo}</div>
                  ) : null}
                </div>

                <div className="grid gap-3 md:grid-cols-[auto_auto] md:items-center">
                  <div className="min-w-[150px]">
                    <div className="text-xs font-bold text-text-primary">预计到账</div>
                    <div className="mt-1 flex items-end gap-2">
                      <span className="text-[28px] font-black leading-none tracking-normal text-accent-primary">
                        {rechargePreviewPoints > 0
                          ? Number(rechargePreviewPoints).toLocaleString(undefined, { maximumFractionDigits: 2 })
                          : '—'}
                      </span>
                      <span className="pb-0.5 text-base font-black text-accent-primary">积分</span>
                    </div>
                  </div>

                  <div className="flex flex-col items-center gap-2">
                  <button
                  type="button"
                  onClick={() => void handleCreateOrderAndPay()}
                  disabled={paymentControlsDisabled || !rechargeAmount || Number(rechargeAmount) <= 0}
                    className="inline-flex h-10 min-w-[208px] items-center justify-center gap-1.5 rounded-lg bg-accent-primary px-4 text-sm font-black text-white shadow-[0_16px_34px_-16px_rgb(var(--color-accent-primary)/0.8)] transition-all hover:brightness-105 active:scale-[0.99] disabled:opacity-45"
                  >
                    <Zap className="h-4 w-4 fill-current" />
                    立即充值
                  </button>
                  <span className="inline-flex items-center gap-1.5 text-[11px] font-bold text-text-tertiary">
                    <LockKeyhole className="h-3 w-3" />
                    安全支付，积分秒到账
                  </span>
                  </div>
                </div>
              </div>

              {rechargeStatusText ? (
                <div className="mt-4 rounded-lg border border-black/[0.05] bg-white/56 px-3 py-2 text-[11px] font-medium leading-relaxed text-text-secondary dark:border-white/[0.08] dark:bg-white/[0.03]">
                  {rechargeStatusText}
                </div>
              ) : null}
            </div>

            <div className="mt-4 grid gap-3 px-3 py-1.5 md:grid-cols-3">
              {[
                { icon: Zap, title: '秒到账', desc: '充值成功后积分立即到账' },
                { icon: Box, title: '支持所有模型', desc: '全站模型通用，无使用限制' },
                { icon: ShieldCheck, title: '安全稳定', desc: '官方托管，保障调用安全与稳定' },
              ].map((item) => {
                const Icon = item.icon;
                return (
                  <div key={item.title} className="flex items-center gap-3 md:justify-center">
                    <span className="inline-flex h-10 w-10 items-center justify-center rounded-full bg-accent-primary/[0.08] text-accent-primary">
                      <Icon className="h-5 w-5" />
                    </span>
                    <span>
                      <span className="block text-sm font-bold text-text-primary">{item.title}</span>
                      <span className="block text-xs text-text-tertiary">{item.desc}</span>
                    </span>
                  </div>
                );
              })}
            </div>
          </section>

          <div className="rounded-xl border border-black/[0.06] bg-white p-5 shadow-sm dark:border-white/[0.06] dark:bg-surface-primary">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-blue-500/10 text-blue-500">
                  <Table2 className="h-4 w-4" />
                </div>
                <span className="text-base font-bold text-text-primary">调用记录</span>
              </div>
              <button
                type="button"
                onClick={() => void refreshProfileAndPoints()}
                disabled={refreshControlsDisabled}
                title="刷新明细"
                className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-text-tertiary transition-colors hover:bg-surface-secondary/60 hover:text-text-primary disabled:opacity-50"
              >
                <RefreshCw className={clsx('h-4 w-4', refreshing && 'animate-spin')} />
              </button>
            </div>
            {!callRecords.length ? (
              <div className="text-xs text-text-tertiary py-6 text-center font-medium">暂无调用记录明细（或后端服务暂未开放接口）。</div>
            ) : (
              <div className="mt-4 max-h-80 overflow-auto rounded-xl border border-black/[0.06] dark:border-white/[0.06]">
                <table className="w-full text-xs text-left border-collapse">
                  <thead className="bg-black/[0.015] text-text-tertiary font-bold border-b border-black/[0.04] dark:bg-white/[0.01] dark:border-white/[0.04]">
                    <tr>
                      <th className="px-5 py-3 font-bold">时间</th>
                      <th className="px-5 py-3 font-bold">模型</th>
                      <th className="px-5 py-3 text-right font-bold">积分消耗</th>
                      <th className="px-5 py-3 text-right font-bold">Tokens</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-black/[0.03] dark:divide-white/[0.03]">
                    {callRecords.slice(0, 30).map((record) => (
                      <tr key={record.id} className="hover:bg-black/[0.005] dark:hover:bg-white/[0.005] transition-colors">
                        <td className="px-5 py-3 text-sm font-medium text-text-secondary">{new Date(record.createdAt).toLocaleString()}</td>
                        <td className="px-5 py-3 text-sm font-medium text-text-secondary">{record.model || '-'}</td>
                        <td className="px-5 py-3 text-right text-sm font-bold text-accent-primary">{record.points}</td>
                        <td className="px-5 py-3 text-right text-sm font-medium text-text-tertiary">{record.tokens}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {onOpenPricing ? (
              <button
                type="button"
                onClick={onOpenPricing}
                className="mt-5 inline-flex w-full items-center justify-center gap-2 rounded-lg border border-black/[0.08] bg-white/70 px-4 py-3 text-sm font-bold text-text-secondary transition-all hover:border-accent-primary/20 hover:bg-accent-primary/5 hover:text-text-primary active:scale-[0.99] dark:border-white/[0.08] dark:bg-white/[0.02]"
              >
                <Table2 className="h-4 w-4 text-text-tertiary" />
                查看完整价格表
              </button>
            ) : null}
          </div>
        </>
      )}

      {/* Notice Banner */}
      <div
        className={clsx(
          'text-xs rounded-xl border px-4 py-3 font-medium leading-relaxed flex items-center gap-2.5 shadow-sm',
          noticeType === 'error'
            ? 'border-red-500/20 bg-red-500/5 text-red-500'
            : noticeType === 'success'
              ? 'border-emerald-500/20 bg-emerald-500/5 text-emerald-600'
              : 'border-black/[0.04] dark:border-white/[0.04] bg-white dark:bg-surface-primary text-text-tertiary',
        )}
      >
        <div className={clsx(
          "w-1.5 h-1.5 rounded-full shrink-0",
          noticeType === 'error' ? "bg-red-500" : noticeType === 'success' ? "bg-emerald-500" : "bg-accent-primary"
        )} />
        <span>{notice || '官方源会自动托管调用凭据，确保您的安全稳定连接。'}</span>
      </div>

      {session ? (
        <div className="flex justify-end pt-1">
          <button
            type="button"
            onClick={() => void logout()}
            disabled={logoutDisabled}
            className="px-4 py-2 text-xs border border-red-200 dark:border-red-500/20 text-red-600 dark:text-red-400 font-bold rounded-xl hover:bg-red-50 dark:hover:bg-red-500/10 active:scale-95 transition-all disabled:opacity-50"
          >
            退出当前官方账号
          </button>
        </div>
      ) : null}
    </div>
  );
};

export const tabLabel = '官方账号';
export const hasOfficialAiPanel = true;

export default OfficialAiPanel;
