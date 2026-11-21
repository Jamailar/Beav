import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Box, Check, ChevronDown, Copy, Crown, Gem, Gift, Globe2, LockKeyhole, QrCode, RefreshCw, ShieldCheck, Smartphone, Table2, UserRound, Zap } from 'lucide-react';
import clsx from 'clsx';
import QRCode from 'qrcode';
import type { OfficialAiPanelProps } from './index';
import { useOfficialAuthState } from '../../hooks/useOfficialAuthState';
import { useMembership } from '../membership/useMembership';
import { extractAlipayPayQrContent } from '../../pages/settings/shared';
import { LegalDocumentDialog } from '../legal/LegalDocumentDialog';
import { LEGAL_DOCUMENTS, type LegalDocumentId } from '../legal/legalDocuments';
import { getAppAcquisitionSource } from '../../components/AppOnboarding';

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
  pointsDelta?: number;
  direction?: string;
  title?: string;
  entryType?: string;
  eventType?: string;
  referenceType?: string;
  balanceAfter?: number | null;
  createdAt: string;
  status: string;
  purpose?: string | null;
}

type InviteCodeRedeemResult = {
  success?: boolean;
  status?: string;
  error?: string;
  message?: string;
  inviter_reward_points?: number;
  invitee_reward_points?: number;
  redemption_id?: string;
};

function inviteCodeRedeemMessage(result?: InviteCodeRedeemResult | null): string {
  if (result?.success) {
    const points = Number(result.invitee_reward_points || 0);
    return points > 0 ? `邀请码使用成功，已到账 ${points} 积分` : '邀请码使用成功';
  }
  const status = String(result?.status || '').trim();
  if (status === 'already_bound') return '这个账号已经使用过邀请码';
  if (status === 'invalid') return '邀请码无效';
  if (status === 'self_invite') return '不能使用自己的邀请码';
  if (status === 'post_signup_disabled' || status === 'disabled') return '当前账号不能补用邀请码';
  if (status === 'post_signup_expired') return '已超过邀请码补填期限';
  if (status === 'failed') return '邀请码使用失败，请稍后重试';
  return result?.message || result?.error || '邀请码使用失败';
}

const CALL_RECORD_EVENT_LABELS: Record<string, string> = {
  invite_reward: '邀请奖励',
  order_points_topup: '积分充值',
  order_points_refund: '订单积分退回',
  order_points_deduct: '订单积分抵扣',
  redeem_ai_points: '兑换积分',
  manual_grant: '后台赠送',
  feedback_reward: '反馈奖励',
  initial_grant: '初始积分',
  wallet_init: '初始积分',
  ai_usage_refund: 'AI 调用退回',
  points_credit: '积分入账',
};

const CALL_RECORD_API_LABELS: Record<string, string> = {
  'douyin.video.detail': '抖音视频详情',
  'douyin.video.comments': '抖音视频评论',
  'douyin.user.posts': '抖音用户作品列表',
  'xiaohongshu.note.image_detail': '小红书图文笔记详情',
  'xiaohongshu.note.video_detail': '小红书视频笔记详情',
  'xiaohongshu.note.comments': '小红书笔记评论',
  'xiaohongshu.note.comment_replies': '小红书评论回复',
  'xiaohongshu.user.notes': '小红书主页笔记列表',
  'twitter.tweet.detail': 'X / Twitter 推文详情',
  'youtube.video.detail': 'YouTube 视频详情',
  'youtube.search.videos': 'YouTube 视频搜索',
  'tikhub.user.info': 'TikHub 账户信息',
};

function normalizeCallRecordApiKey(value: unknown): string {
  return String(value || '')
    .trim()
    .replace(/^\/+|\/+$/g, '')
    .replace(/^api\/v\d+\/forward\/[^/]+\//i, '')
    .replace(/^forward\/[^/]+\//i, '')
    .replace(/^tikhub[/:]/i, '');
}

function callRecordDisplayName(record: RedboxCallRecordItem): string {
  const title = String(record.title || '').trim();
  if (title) return title;
  const eventLabel = CALL_RECORD_EVENT_LABELS[String(record.eventType || '').trim()];
  if (eventLabel) return eventLabel;
  const candidates = [
    normalizeCallRecordApiKey(record.model),
    normalizeCallRecordApiKey(record.endpoint),
  ];
  for (const candidate of candidates) {
    if (CALL_RECORD_API_LABELS[candidate]) return CALL_RECORD_API_LABELS[candidate];
  }
  return String(record.model || record.endpoint || '-').trim() || '-';
}

function callRecordPointsDelta(record: RedboxCallRecordItem): number {
  const explicitDelta = Number(record.pointsDelta);
  if (Number.isFinite(explicitDelta) && explicitDelta !== 0) return explicitDelta;
  const points = Number(record.points || 0);
  if (!Number.isFinite(points) || points === 0) return 0;
  return String(record.direction || '').toLowerCase() === 'credit' ? points : -points;
}

function formatCallRecordPoints(record: RedboxCallRecordItem): string {
  const delta = callRecordPointsDelta(record);
  const value = Math.abs(delta || Number(record.points || 0));
  const formatted = value.toLocaleString(undefined, {
    minimumFractionDigits: Number.isInteger(value) ? 0 : 2,
    maximumFractionDigits: 2,
  });
  return delta > 0 ? `+${formatted}` : formatted;
}

function callRecordPointsClass(record: RedboxCallRecordItem): string {
  return callRecordPointsDelta(record) > 0 ? 'text-emerald-600 dark:text-emerald-300' : 'text-accent-primary';
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
const FOUNDER_SPONSOR_PRODUCT_ID = '827c5de5-c7b2-44df-b5c5-2b8b53eeb6ab';
const FOUNDER_SPONSOR_POLL_INTERVAL_MS = 3000;
const FOUNDER_SPONSOR_MAX_POLL_ATTEMPTS = 60;

const traceAuthUi = (stage: string, detail?: unknown): void => {
  console.debug(`[OfficialAiPanel] ${stage}`, detail ?? '');
};

function isLikelyMachineUserId(value: string): boolean {
  const trimmed = value.trim();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(trimmed);
}

function resolveUserDisplayName(userData: unknown): string {
  if (!userData || typeof userData !== 'object') return '';
  const record = userData as Record<string, unknown>;
  const candidates = [
    record.displayName,
    record.display_name,
    record.nickname,
    record.nickName,
    record.name,
    record.username,
    record.userName,
    record.email,
    record.phone,
    record.mobile,
  ];
  for (const candidate of candidates) {
    const value = String(candidate || '').trim();
    if (value && !isLikelyMachineUserId(value)) {
      return value;
    }
  }
  return '';
}

function orderStatusIsPaid(order: Record<string, unknown>): boolean {
  const status = String(order.status || order.payment_status || order.paymentStatus || order.trade_status || order.tradeStatus || '').trim().toLowerCase();
  return Boolean(order.paid || order.is_paid || order.isPaid)
    || ['paid', 'success', 'succeeded', 'completed', 'trade_success', 'trade_finished'].includes(status);
}

function orderStatusIsFinalFailure(order: Record<string, unknown>): boolean {
  const status = String(order.status || order.payment_status || order.paymentStatus || order.trade_status || order.tradeStatus || '').trim().toLowerCase();
  return ['closed', 'cancelled', 'canceled', 'failed', 'expired', 'trade_closed'].includes(status);
}

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
  const { state: membershipState } = useMembership();
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
  const [founderSponsorBusy, setFounderSponsorBusy] = useState(false);
  const [founderSponsorOrderNo, setFounderSponsorOrderNo] = useState('');
  const [founderSponsorStatusText, setFounderSponsorStatusText] = useState('');
  const [notice, setNotice] = useState('');
  const [noticeType, setNoticeType] = useState<NoticeType>('idle');
  const [activeLegalDocumentId, setActiveLegalDocumentId] = useState<LegalDocumentId | null>(null);
  const [callRecordsExpanded, setCallRecordsExpanded] = useState(false);
  const [inviteRedeemDialogOpen, setInviteRedeemDialogOpen] = useState(false);
  const [inviteRedeemInput, setInviteRedeemInput] = useState('');
  const [inviteRedeemBusy, setInviteRedeemBusy] = useState(false);
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
  const isFounderSponsorMember = membershipState.active;
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
      const inviteCode = String(smsForm.inviteCode || '').trim();
      const smsPayload = mode === 'register'
        ? { phone, code, inviteCode: inviteCode || undefined }
        : { phone, code };
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
      setFounderSponsorOrderNo('');
      setFounderSponsorStatusText('');
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
          acquisitionSource: getAppAcquisitionSource(),
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
      setRechargeStatusText(`订单 ${outTradeNo} 已创建。请在支付窗口完成支付，支付成功后点击上方刷新余额。`);
      setPanelNotice('success', '支付窗口已打开，请完成支付。');
    } catch (error) {
      const message = error instanceof Error ? error.message : '充值失败';
      setRechargeStatusText(message);
      setPanelNotice('error', message);
    } finally {
      setPaymentBusy(false);
    }
  }, [rechargeAmount, setPanelNotice]);

  const refreshFounderSponsorOrderStatus = useCallback(async (targetOrderNo: string) => {
    const result = await timedRequest<{ success: boolean; order?: Record<string, unknown>; error?: string }>(
      'officialAuth.getOrderStatus',
      window.ipcRenderer.officialAuth.getOrderStatus({ outTradeNo: targetOrderNo }),
    );
    const order = result?.order && typeof result.order === 'object' ? result.order : null;
    if (!result?.success || !order) {
      throw new Error(result?.error || '查询会员订单状态失败');
    }
    if (orderStatusIsPaid(order)) {
      setFounderSponsorBusy(true);
      setFounderSponsorStatusText('支付成功，正在同步会员状态...');
      await window.ipcRenderer.officialAuth.bootstrap({ reason: 'founder-sponsor-panel-paid' });
      await window.ipcRenderer.auth.refreshNow().catch(() => null);
      await loadAuthenticatedData().catch(() => []);
      requestSettingsRefresh();
      setFounderSponsorStatusText('创始赞助会员已开通。');
      setFounderSponsorOrderNo('');
      setPanelNotice('success', '创始赞助会员已开通。');
      setFounderSponsorBusy(false);
      return 'paid' as const;
    }
    if (orderStatusIsFinalFailure(order)) {
      setFounderSponsorStatusText('订单未完成或已关闭，请重新购买。');
      setFounderSponsorOrderNo('');
      setFounderSponsorBusy(false);
      return 'failed' as const;
    }
    setFounderSponsorStatusText('支付页面已打开，完成支付后会自动同步会员状态。');
    return 'pending' as const;
  }, [loadAuthenticatedData, requestSettingsRefresh, setPanelNotice]);

  const handleFounderSponsorPurchase = useCallback(async () => {
    if (isFounderSponsorMember) return;
    setFounderSponsorBusy(true);
    setFounderSponsorOrderNo('');
    setFounderSponsorStatusText('');
    try {
      const orderResult = await timedRequest<{ success: boolean; order?: Record<string, unknown>; error?: string }>(
        'officialAuth.createPagePayOrder',
        window.ipcRenderer.officialAuth.createPagePayOrder({
          productId: FOUNDER_SPONSOR_PRODUCT_ID,
          product_id: FOUNDER_SPONSOR_PRODUCT_ID,
          subject: '创始赞助会员',
          pointsToDeduct: 0,
          points_to_deduct: 0,
          acquisitionSource: getAppAcquisitionSource(),
        }),
      );
      if (!orderResult?.success || !orderResult.order) {
        throw new Error(orderResult?.error || '创建会员订单失败');
      }
      const outTradeNo = String(orderResult.order.out_trade_no || orderResult.order.outTradeNo || '').trim();
      const paymentForm = extractAlipayPayQrContent(orderResult.order)
        || String(orderResult.order.payment_url || orderResult.order.payment_form || orderResult.order.url || '').trim();
      if (!outTradeNo || !paymentForm) {
        throw new Error('订单返回缺少支付信息');
      }
      const openResult = await timedRequest<{ success: boolean; error?: string }>(
        'officialAuth.openPaymentForm',
        window.ipcRenderer.officialAuth.openPaymentForm({ paymentForm }),
      );
      if (!openResult?.success) {
        throw new Error(openResult?.error || '打开支付页面失败');
      }
      setFounderSponsorOrderNo(outTradeNo);
      setFounderSponsorStatusText('支付页面已打开，完成支付后会自动同步会员状态。');
      setPanelNotice('success', '创始赞助会员支付页面已打开。');
    } catch (error) {
      const message = error instanceof Error ? error.message : '创建会员订单失败';
      setFounderSponsorStatusText(message);
      setPanelNotice('error', message);
    } finally {
      setFounderSponsorBusy(false);
    }
  }, [isFounderSponsorMember, setPanelNotice]);

  useEffect(() => {
    if (isFounderSponsorMember) {
      setFounderSponsorOrderNo('');
      setFounderSponsorStatusText('');
      setFounderSponsorBusy(false);
      return;
    }
    if (!founderSponsorOrderNo) return;
    let cancelled = false;
    let timer: number | null = null;
    let attempts = 0;

    const poll = async () => {
      if (cancelled) return;
      attempts += 1;
      try {
        const status = await refreshFounderSponsorOrderStatus(founderSponsorOrderNo);
        if (cancelled || status !== 'pending') return;
      } catch (error) {
        if (cancelled) return;
        setFounderSponsorStatusText(error instanceof Error ? error.message : '查询会员订单状态失败');
      }
      if (!cancelled && attempts < FOUNDER_SPONSOR_MAX_POLL_ATTEMPTS) {
        timer = window.setTimeout(poll, FOUNDER_SPONSOR_POLL_INTERVAL_MS);
      }
    };

    timer = window.setTimeout(poll, 1200);
    return () => {
      cancelled = true;
      if (timer !== null) {
        window.clearTimeout(timer);
      }
    };
  }, [founderSponsorOrderNo, isFounderSponsorMember, refreshFounderSponsorOrderStatus]);

  const userName = useMemo(() => {
    return resolveUserDisplayName(user || session?.user);
  }, [session?.user, user]);
  const userAvatarUrl = useMemo(() => {
    const currentUser = user || session?.user;
    if (!currentUser || typeof currentUser !== 'object') return '';
    const record = currentUser as Record<string, unknown>;
    return String(record.avatar || record.avatarUrl || record.avatar_url || record.image || record.picture || '').trim();
  }, [session?.user, user]);
  const userInitial = useMemo(() => {
    const name = userName || 'RedBox';
    return name.trim().slice(0, 1).toUpperCase();
  }, [userName]);
  const inviteCode = useMemo(() => {
    const currentUser = user || session?.user;
    if (!currentUser || typeof currentUser !== 'object') return '';
    const record = currentUser as Record<string, unknown>;
    const candidates = [
      record.inviteCode,
      record.invite_code,
      record.invitationCode,
      record.invitation_code,
      record.referralCode,
      record.referral_code,
    ];
    for (const candidate of candidates) {
      const value = String(candidate || '').trim();
      if (value) return value;
    }
    return '';
  }, [session?.user, user]);

  const copyInviteCode = useCallback(async () => {
    if (!inviteCode) {
      setPanelNotice('error', '邀请码还未同步，请刷新后重试');
      return;
    }
    try {
      await navigator.clipboard.writeText(inviteCode);
      setPanelNotice('success', '邀请码已复制');
    } catch {
      try {
        const result = await window.ipcRenderer.clipboardWriteText(inviteCode);
        if (!result?.success) {
          throw new Error(result?.error || '复制失败');
        }
        setPanelNotice('success', '邀请码已复制');
      } catch {
        setPanelNotice('error', '复制失败，请手动选择邀请码');
      }
    }
  }, [inviteCode, setPanelNotice]);

  const submitInviteCodeRedeem = useCallback(async () => {
    const code = String(inviteRedeemInput || '').trim();
    if (!code) {
      setPanelNotice('error', '请输入邀请码');
      return;
    }
    setInviteRedeemBusy(true);
    try {
      const result = await timedRequest<InviteCodeRedeemResult>(
        'officialAuth.redeemInviteCode',
        window.ipcRenderer.officialAuth.redeemInviteCode({ inviteCode: code }),
        { trace: true },
      );
      const message = inviteCodeRedeemMessage(result);
      if (!result?.success) {
        setPanelNotice('error', message);
        return;
      }
      setPanelNotice('success', message);
      setInviteRedeemDialogOpen(false);
      setInviteRedeemInput('');
      await Promise.allSettled([fetchPoints(), fetchCallRecords()]);
      queueBackgroundRefresh('invite-code-redeem');
    } catch (error) {
      setPanelNotice('error', error instanceof Error ? error.message : '邀请码使用失败');
    } finally {
      setInviteRedeemBusy(false);
    }
  }, [fetchCallRecords, fetchPoints, inviteRedeemInput, queueBackgroundRefresh, setPanelNotice]);

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
                使用邀请码注册
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
                <div className="text-[11px] leading-5 text-text-tertiary">
                  登录即表示同意
                  <button
                    type="button"
                    onClick={() => setActiveLegalDocumentId('terms')}
                    className="mx-1 font-bold text-accent-primary hover:underline"
                  >
                    用户协议
                  </button>
                  和
                  <button
                    type="button"
                    onClick={() => setActiveLegalDocumentId('privacy')}
                    className="ml-1 font-bold text-accent-primary hover:underline"
                  >
                    隐私政策
                  </button>
                </div>
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
                  placeholder="好友邀请码（注册可选）"
                  className="w-full bg-black/[0.01] dark:bg-white/[0.01] rounded-xl border border-black/[0.05] dark:border-white/[0.05] px-3.5 py-2 text-sm focus:outline-none focus:border-accent-primary focus:bg-white dark:focus:bg-surface-primary transition-all font-medium"
                />
                <div className="text-[11px] font-medium leading-5 text-text-tertiary">
                  邀请码只在注册新账号时使用。
                </div>
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
                <div className="pt-1 text-[11px] leading-5 text-text-tertiary">
                  登录或注册即表示同意
                  <button
                    type="button"
                    onClick={() => setActiveLegalDocumentId('terms')}
                    className="mx-1 font-bold text-accent-primary hover:underline"
                  >
                    用户协议
                  </button>
                  和
                  <button
                    type="button"
                    onClick={() => setActiveLegalDocumentId('privacy')}
                    className="ml-1 font-bold text-accent-primary hover:underline"
                  >
                    隐私政策
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
          <section className={clsx(
            'rounded-xl border p-4 shadow-sm',
            isFounderSponsorMember
              ? 'border-amber-300/60 bg-[linear-gradient(135deg,rgb(255_251_235/0.92),rgb(255_255_255/0.88))] dark:border-amber-300/20 dark:bg-[linear-gradient(135deg,rgb(146_64_14/0.18),rgb(255_255_255/0.03))]'
              : 'border-black/[0.06] bg-white dark:border-white/[0.06] dark:bg-surface-primary'
          )}>
            <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-center">
              <div className="flex min-w-0 items-center gap-3">
                {isFounderSponsorMember ? (
                  <span className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-[linear-gradient(180deg,#f8d77a,#d69222)] text-white shadow-[0_10px_20px_-14px_rgb(146_64_14/0.9)]">
                    <Crown className="h-4 w-4" strokeWidth={2} />
                  </span>
                ) : null}
                <div className="h-12 w-12 shrink-0">
                  <div className={clsx(
                    'flex h-full w-full items-center justify-center overflow-hidden rounded-full text-sm font-black',
                    isFounderSponsorMember
                      ? 'bg-amber-500/12 text-amber-700 ring-1 ring-amber-300/60 dark:text-amber-200'
                      : 'bg-accent-primary/10 text-accent-primary'
                  )}>
                    {userAvatarUrl ? (
                      <img src={userAvatarUrl} alt="" className="h-full w-full object-cover" />
                    ) : (
                      userInitial
                    )}
                  </div>
                </div>
                <div className="min-w-0">
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="truncate text-base font-black text-text-primary">
                      {userName || '官方账号'}
                    </span>
                    {isFounderSponsorMember ? (
                      <span className="inline-flex h-5 shrink-0 items-center rounded-md border border-amber-300/70 bg-amber-300/12 px-1.5 text-[11px] font-black text-amber-700 dark:text-amber-200">
                        创始会员
                      </span>
                    ) : null}
                  </div>
                  <div className="mt-1 truncate text-xs font-medium text-text-tertiary">
                    {isFounderSponsorMember ? '永久身份 · AI 调用仍按积分消耗' : '免费账号 · 可升级创始赞助会员'}
                  </div>
                </div>
              </div>

              <div className="min-w-0 border-t border-black/[0.06] pt-4 lg:w-[260px] lg:justify-self-end lg:border-l lg:border-t-0 lg:pl-5 lg:pt-0 xl:w-[280px] dark:border-white/[0.08]">
                <div className="mb-2 flex min-w-0 items-center gap-2">
                  <Gift className="h-4 w-4 shrink-0 text-accent-primary" strokeWidth={1.9} />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-black text-text-primary">邀请好友，双方获得200积分</div>
                  </div>
                  <button
                    type="button"
                    onClick={() => setInviteRedeemDialogOpen(true)}
                    className="shrink-0 text-[10px] font-bold leading-none text-accent-primary hover:underline"
                  >
                    使用邀请码
                  </button>
                </div>
                <div className="grid min-w-0 gap-2 sm:grid-cols-[132px_auto] sm:items-center">
                  <div className="min-w-0 rounded-lg border border-black/[0.06] bg-black/[0.015] px-3 py-2 font-mono text-sm font-black tracking-normal text-text-primary dark:border-white/[0.08] dark:bg-white/[0.025]">
                    <span className="block truncate">{inviteCode || '待同步'}</span>
                  </div>
                  <button
                    type="button"
                    onClick={() => void copyInviteCode()}
                    disabled={!inviteCode}
                    className="inline-flex h-9 items-center justify-center gap-1.5 rounded-lg border border-black/[0.08] bg-white px-3 text-xs font-bold text-text-secondary transition-all hover:border-accent-primary/[0.24] hover:bg-accent-primary/5 hover:text-text-primary disabled:opacity-50 dark:border-white/[0.08] dark:bg-white/[0.02]"
                  >
                    <Copy className="h-3.5 w-3.5" />
                    复制
                  </button>
                </div>
              </div>
            </div>
          </section>

          <section className="overflow-hidden rounded-[18px] bg-[linear-gradient(130deg,rgb(var(--color-accent-primary)/0.075),rgb(245_158_11/0.045)_42%,rgb(255_255_255/0.82))] p-3 shadow-[0_18px_46px_-30px_rgba(194,92,16,0.38)] dark:bg-[linear-gradient(130deg,rgb(var(--color-accent-primary)/0.13),rgb(245_158_11/0.075)_42%,rgb(255_255_255/0.02))]">
            <div className="mb-3 flex items-start justify-between gap-4">
              <div className="min-w-0">
                <div className="mb-1.5 text-xs font-bold text-text-secondary">当前积分余额</div>
                <div className="flex flex-wrap items-end gap-2">
                  {hasPointsSnapshot ? (
                    <>
                      <span className="text-[30px] font-black leading-none tracking-normal text-text-primary md:text-[34px]">
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
                className="inline-flex h-8 shrink-0 items-center justify-center gap-1.5 rounded-lg border border-black/[0.08] bg-white/78 px-2.5 text-xs font-bold text-text-secondary shadow-sm transition-all hover:border-accent-primary/[0.24] hover:bg-white hover:text-text-primary disabled:opacity-50 dark:border-white/[0.08] dark:bg-surface-primary/76"
              >
                <RefreshCw className={clsx('h-3.5 w-3.5', refreshing && 'animate-spin')} />
                刷新余额
              </button>
            </div>

            {!isFounderSponsorMember ? (
              <div className="mb-3 rounded-xl border border-amber-300/55 bg-[linear-gradient(135deg,rgb(255_251_235/0.9),rgb(255_255_255/0.76))] p-3 shadow-sm dark:border-amber-300/20 dark:bg-[linear-gradient(135deg,rgb(146_64_14/0.18),rgb(255_255_255/0.035))]">
                <div className="grid gap-2.5 md:grid-cols-[minmax(0,1fr)_auto] md:items-center">
                  <div className="flex min-w-0 items-start gap-2.5">
                    <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-amber-500/12 text-amber-700 dark:text-amber-200">
                      <Crown className="h-5 w-5" strokeWidth={1.8} />
                    </span>
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-sm font-black text-text-primary">创始赞助会员</span>
                        <span className="rounded-md bg-amber-500/12 px-1.5 py-0.5 text-[11px] font-black text-amber-700 dark:text-amber-200">¥199 · 永久有效</span>
                      </div>
                      <div className="mt-1 text-xs font-medium leading-5 text-text-secondary">
                        解锁会员身份与特权功能；AI 调用、图片和视频生成仍按实际使用消耗积分。
                      </div>
                      {founderSponsorStatusText || founderSponsorOrderNo ? (
                        <div className="mt-2 truncate text-[11px] font-medium text-amber-700 dark:text-amber-200" title={founderSponsorOrderNo || founderSponsorStatusText}>
                          {founderSponsorStatusText}
                          {founderSponsorOrderNo ? ` · 订单 ${founderSponsorOrderNo}` : ''}
                        </div>
                      ) : null}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => void handleFounderSponsorPurchase()}
                    disabled={founderSponsorBusy || paymentBusy || refreshControlsDisabled}
                    className="inline-flex h-9 shrink-0 items-center justify-center gap-1.5 rounded-lg bg-amber-600 px-4 text-sm font-black text-white shadow-[0_16px_34px_-18px_rgb(146_64_14/0.9)] transition-all hover:brightness-105 active:scale-[0.99] disabled:opacity-50"
                  >
                    <Crown className="h-4 w-4" strokeWidth={1.9} />
                    {founderSponsorBusy ? '处理中...' : '¥199 解锁永久会员'}
                  </button>
                </div>
              </div>
            ) : null}

            <div className="rounded-xl bg-white/72 p-3 shadow-sm backdrop-blur dark:bg-surface-primary/64">
              <div className="mb-2.5 flex flex-wrap items-center gap-2">
                <span className="text-sm font-bold text-text-primary">选择充值金额</span>
                <span className="rounded-md bg-accent-primary/10 px-2 py-0.5 text-[11px] font-bold text-accent-primary">
                  1 元 = {Number(pointsPerYuan).toLocaleString()} 积分
                </span>
              </div>

              <div className="grid grid-cols-2 gap-2.5 lg:grid-cols-4">
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
                        'relative flex min-h-[82px] flex-col items-center justify-center rounded-lg border px-3 py-2.5 text-center transition-all active:scale-[0.99]',
                        isSelected
                          ? 'border-accent-primary bg-[linear-gradient(135deg,rgb(var(--color-accent-primary)/0.08),rgb(var(--color-surface-primary)/0.9))] text-accent-primary shadow-[0_18px_34px_-22px_rgb(var(--color-accent-primary)/0.58)] ring-1 ring-accent-primary/[0.16] dark:bg-[linear-gradient(135deg,rgb(var(--color-accent-primary)/0.24),rgb(var(--color-surface-secondary)/0.88))]'
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
                      <span className="text-[22px] font-black leading-none tracking-normal">¥{pkg.amount}</span>
                      <span className={clsx('mt-1.5 text-xs font-bold', isSelected ? 'text-accent-primary' : 'text-text-secondary')}>
                        {(pkg.amount * pointsPerYuan).toLocaleString()} 积分
                      </span>
                    </button>
                  );
                })}

                <div className="flex min-h-[82px] flex-col items-center justify-center rounded-lg border border-black/[0.08] bg-white/58 px-3 py-2.5 dark:border-white/[0.08] dark:bg-white/[0.02]">
                  <label className="mb-1.5 text-xs font-bold text-text-primary">自定义金额</label>
                  <div className="grid h-8 w-full max-w-[152px] grid-cols-[34px_1fr] overflow-hidden rounded-lg border border-black/[0.08] bg-white/72 dark:border-white/[0.08] dark:bg-surface-primary/72">
                    <span className="flex items-center justify-center border-r border-black/[0.06] text-xs font-bold text-text-secondary dark:border-white/[0.08]">¥</span>
                    <input
                      value={rechargeAmount}
                      onChange={(e) => setRechargeAmount(e.target.value)}
                      placeholder="请输入金额"
                      type="number"
                      className="min-w-0 bg-transparent px-2.5 text-xs font-bold text-text-primary outline-none placeholder:text-text-tertiary/70"
                    />
                  </div>
                  <span className="mt-1 text-[10px] font-medium text-text-tertiary">最低 ¥1</span>
                </div>
              </div>

              <div className="mt-3 grid gap-2.5 rounded-xl border border-accent-primary/[0.12] bg-[linear-gradient(135deg,rgb(var(--color-surface-primary)/0.74),rgb(var(--color-accent-primary)/0.035))] p-2.5 dark:bg-[linear-gradient(135deg,rgb(var(--color-surface-secondary)/0.86),rgb(var(--color-accent-primary)/0.10))] lg:grid-cols-[minmax(0,1fr)_auto] lg:items-center">
                <div className="text-xs font-medium leading-4 text-text-secondary">
                  <div>充值 ¥{normalizeRechargeAmountInput(rechargeAmount) || '0'}</div>
                  <div>按 1 元 = {Number(pointsPerYuan).toLocaleString()} 积分计算</div>
                  {rechargeOrderNo ? (
                    <div className="truncate text-[11px] text-text-tertiary" title={rechargeOrderNo}>订单 {rechargeOrderNo}</div>
                  ) : null}
                </div>

                <div className="grid gap-3 md:grid-cols-[auto_auto] md:items-center">
                  <div className="min-w-[150px]">
                    <div className="text-xs font-bold text-text-primary">预计到账</div>
                    <div className="mt-0.5 flex items-end gap-1.5">
                      <span className="text-[24px] font-black leading-none tracking-normal text-accent-primary">
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
                      className="inline-flex h-9 min-w-[208px] items-center justify-center gap-1.5 rounded-lg bg-accent-primary px-4 text-sm font-black text-white shadow-[0_16px_34px_-16px_rgb(var(--color-accent-primary)/0.8)] transition-all hover:brightness-105 active:scale-[0.99] disabled:opacity-45"
                    >
                      <Zap className="h-4 w-4 fill-current" />
                      立即充值
                    </button>
                    <span className="inline-flex items-center gap-1.5 text-[11px] font-bold text-text-tertiary">
                      <LockKeyhole className="h-3 w-3" />
                      安全支付，积分秒到账
                    </span>
                    <div className="text-center text-[11px] leading-4 text-text-tertiary">
                      充值或购买会员即表示同意
                      <button
                        type="button"
                        onClick={() => setActiveLegalDocumentId('terms')}
                        className="mx-1 font-bold text-accent-primary hover:underline"
                      >
                        用户协议
                      </button>
                      和
                      <button
                        type="button"
                        onClick={() => setActiveLegalDocumentId('privacy')}
                        className="ml-1 font-bold text-accent-primary hover:underline"
                      >
                        隐私政策
                      </button>
                    </div>
                  </div>
                </div>
              </div>

              {rechargeStatusText ? (
                <div className="mt-3 rounded-lg border border-black/[0.05] bg-white/56 px-3 py-2 text-[11px] font-medium leading-relaxed text-text-secondary dark:border-white/[0.08] dark:bg-white/[0.03]">
                  {rechargeStatusText}
                </div>
              ) : null}
            </div>

            <div className="mt-3 grid gap-2 px-2 py-1 md:grid-cols-3">
              {[
                { icon: Zap, title: '秒到账', desc: '充值成功后积分立即到账' },
                { icon: Box, title: '支持所有模型', desc: '全站模型通用，无使用限制' },
                { icon: ShieldCheck, title: '安全稳定', desc: '官方托管，保障调用安全与稳定' },
              ].map((item) => {
                const Icon = item.icon;
                return (
                  <div key={item.title} className="flex items-center gap-2.5 md:justify-center">
                    <span className="inline-flex h-9 w-9 items-center justify-center rounded-full bg-accent-primary/[0.08] text-accent-primary">
                      <Icon className="h-4 w-4" />
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

          <div className="rounded-xl border border-accent-primary/[0.16] bg-[linear-gradient(135deg,rgb(var(--color-accent-primary)/0.075),rgb(var(--color-surface-primary)/0.9))] px-3 py-2.5 shadow-sm dark:border-accent-primary/[0.18] dark:bg-[linear-gradient(135deg,rgb(var(--color-accent-primary)/0.16),rgb(var(--color-surface-primary)/0.84))]">
            <div className="flex items-center justify-between gap-2">
              <button
                type="button"
                onClick={() => setCallRecordsExpanded((expanded) => !expanded)}
                aria-expanded={callRecordsExpanded}
                className="flex min-w-0 items-center gap-2 rounded-lg pr-2 text-left transition-colors hover:text-accent-primary"
              >
                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-accent-primary/12 text-accent-primary">
                  <Table2 className="h-3.5 w-3.5" />
                </div>
                <span className="text-sm font-bold text-text-primary">调用记录</span>
                <ChevronDown className={clsx('h-3.5 w-3.5 shrink-0 text-accent-primary/70 transition-transform', callRecordsExpanded && 'rotate-180')} />
              </button>
              <button
                type="button"
                onClick={() => void refreshProfileAndPoints()}
                disabled={refreshControlsDisabled}
                title="刷新明细"
                className="inline-flex h-7 w-7 items-center justify-center rounded-lg text-accent-primary/70 transition-colors hover:bg-accent-primary/10 hover:text-accent-primary disabled:opacity-50"
              >
                <RefreshCw className={clsx('h-3.5 w-3.5', refreshing && 'animate-spin')} />
              </button>
            </div>
            {callRecordsExpanded ? (
              <>
                {!callRecords.length ? (
                  <div className="text-xs text-text-tertiary py-6 text-center font-medium">暂无调用记录明细（或后端服务暂未开放接口）。</div>
                ) : (
                  <div className="mt-4 max-h-80 overflow-auto rounded-xl border border-black/[0.06] dark:border-white/[0.06]">
                    <table className="w-full text-xs text-left border-collapse">
                      <thead className="bg-black/[0.015] text-text-tertiary font-bold border-b border-black/[0.04] dark:bg-white/[0.01] dark:border-white/[0.04]">
                        <tr>
                          <th className="px-5 py-3 font-bold">时间</th>
                          <th className="px-5 py-3 font-bold">项目</th>
                          <th className="px-5 py-3 text-right font-bold">积分变动</th>
                          <th className="px-5 py-3 text-right font-bold">Tokens</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-black/[0.03] dark:divide-white/[0.03]">
                        {callRecords.slice(0, 30).map((record) => (
                          <tr key={record.id} className="hover:bg-black/[0.005] dark:hover:bg-white/[0.005] transition-colors">
                            <td className="px-5 py-3 text-sm font-medium text-text-secondary">{new Date(record.createdAt).toLocaleString()}</td>
                            <td className="px-5 py-3 text-sm font-medium text-text-secondary">
                              <span className="inline-flex flex-wrap items-center gap-1.5">
                                <span>{callRecordDisplayName(record)}</span>
                                {record.purpose === 'knowledge_visual_index' && (
                                  <span className="inline-flex items-center rounded-md border border-amber-200 bg-amber-50 px-1.5 py-0.5 text-[10px] font-bold text-amber-700">
                                    知识库图像索引
                                  </span>
                                )}
                              </span>
                            </td>
                            <td className={clsx('px-5 py-3 text-right text-sm font-bold', callRecordPointsClass(record))}>
                              {formatCallRecordPoints(record)}
                            </td>
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
              </>
            ) : null}
          </div>
        </>
      )}

      {notice ? (
        <div
          className={clsx(
            'text-xs rounded-xl border px-4 py-3 font-medium leading-relaxed flex items-center gap-2.5 shadow-sm',
            noticeType === 'error'
              ? 'border-red-500/20 bg-red-500/5 text-red-500'
              : noticeType === 'success'
                ? 'border-emerald-500/20 bg-emerald-500/5 text-emerald-600'
                : 'border-accent-primary/[0.16] bg-accent-primary/[0.06] text-text-secondary',
          )}
        >
          <div className={clsx(
            "w-1.5 h-1.5 rounded-full shrink-0",
            noticeType === 'error' ? "bg-red-500" : noticeType === 'success' ? "bg-emerald-500" : "bg-accent-primary"
          )} />
          <span>{notice}</span>
        </div>
      ) : null}

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

      {inviteRedeemDialogOpen ? (
        <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/35 px-4">
          <div className="w-full max-w-[360px] rounded-2xl border border-black/[0.08] bg-white p-4 shadow-2xl dark:border-white/[0.08] dark:bg-surface-primary">
            <div className="text-sm font-black text-text-primary">使用邀请码</div>
            <input
              type="text"
              value={inviteRedeemInput}
              onChange={(event) => setInviteRedeemInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !inviteRedeemBusy) {
                  void submitInviteCodeRedeem();
                }
              }}
              placeholder="输入好友邀请码"
              autoComplete="off"
              autoCapitalize="characters"
              spellCheck={false}
              disabled={inviteRedeemBusy}
              className="mt-3 h-11 w-full rounded-xl border border-black/[0.08] bg-black/[0.015] px-3 font-mono text-sm font-black tracking-normal text-text-primary outline-none transition focus:border-accent-primary/40 focus:bg-white dark:border-white/[0.08] dark:bg-white/[0.025] dark:focus:bg-surface-primary"
            />
            <div className="mt-4 grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => {
                  if (inviteRedeemBusy) return;
                  setInviteRedeemDialogOpen(false);
                }}
                disabled={inviteRedeemBusy}
                className="h-10 rounded-xl border border-black/[0.08] bg-white text-xs font-bold text-text-secondary transition hover:bg-black/[0.025] disabled:opacity-50 dark:border-white/[0.08] dark:bg-white/[0.02]"
              >
                取消
              </button>
              <button
                type="button"
                onClick={() => void submitInviteCodeRedeem()}
                disabled={inviteRedeemBusy}
                className="h-10 rounded-xl bg-accent-primary text-xs font-bold text-white transition hover:brightness-105 disabled:opacity-50"
              >
                {inviteRedeemBusy ? '使用中…' : '确认使用'}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      <LegalDocumentDialog
        document={activeLegalDocumentId ? LEGAL_DOCUMENTS[activeLegalDocumentId] : null}
        onClose={() => setActiveLegalDocumentId(null)}
      />
    </div>
  );
};

export const tabLabel = '官方账号';
export const hasOfficialAiPanel = true;

export default OfficialAiPanel;
