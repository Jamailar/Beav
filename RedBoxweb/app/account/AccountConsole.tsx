'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import QRCode from 'qrcode';
import {
    LoaderCircle,
    LogIn,
    LogOut,
    MessageCircle,
    RefreshCw,
} from 'lucide-react';

interface UserProfile {
    id?: string;
    email?: string;
    display_name?: string;
    full_name?: string;
    app_slug?: string;
    membership_type?: string;
    points?: number | string | null;
    balance?: number | string | null;
    pointsBalance?: number | string | null;
    current_points?: number | string | null;
    currentPoints?: number | string | null;
    available_points?: number | string | null;
    availablePoints?: number | string | null;
    last_login_at?: string | null;
}

interface UsageLog {
    id: string;
    time: string;
    model: string;
    token: number;
    points_cost: number;
}

interface UsageResponse {
    page: number;
    page_size: number;
    total: number;
    items: UsageLog[];
}

type PointsResponse = Record<string, unknown> | null;

type AuthState = 'checking' | 'signed_out' | 'signed_in';
type WechatStatus = 'idle' | 'PENDING' | 'SCANNED' | 'CONFIRMED' | 'EXPIRED' | 'FAILED';

interface WechatStartResponse {
    enabled?: boolean;
    sessionId?: string;
    qrContentUrl?: string;
    url?: string;
    expiresIn?: number;
    status?: WechatStatus | string;
    error?: string;
}

interface WechatStatusResponse {
    status?: WechatStatus | string;
    sessionId?: string;
    error?: string;
}

const defaultUsage: UsageResponse = {
    page: 1,
    page_size: 20,
    total: 0,
    items: [],
};

const wechatStatusCopy: Record<WechatStatus, string> = {
    idle: '正在准备二维码',
    PENDING: '请使用微信扫码登录',
    SCANNED: '已扫码，请在微信中确认',
    CONFIRMED: '登录成功',
    EXPIRED: '二维码已过期',
    FAILED: '登录失败，请重试',
};

const wechatPollInitialDelayMs = 0;
const wechatPollPendingIntervalMs = 900;
const wechatPollScannedIntervalMs = 250;
const wechatPollErrorIntervalMs = 1200;

function isLikelyImageUrl(value: string) {
    const normalized = value.trim().toLowerCase();
    if (!normalized) return false;
    if (normalized.startsWith('data:image/') || normalized.startsWith('blob:')) return true;
    return /\.(png|jpe?g|gif|webp|bmp|svg)(\?.*)?(#.*)?$/i.test(normalized);
}

async function buildWechatQrDataUrl(value: string) {
    const content = value.trim();
    if (!content) {
        throw new Error('二维码内容为空');
    }
    if (isLikelyImageUrl(content)) {
        return content;
    }
    return QRCode.toDataURL(content, {
        errorCorrectionLevel: 'M',
        margin: 1,
        width: 360,
        color: {
            dark: '#22170f',
            light: '#ffffff',
        },
    });
}

async function readJson<T>(response: Response): Promise<T> {
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
        const message = typeof data?.error === 'string' ? data.error : '请求失败';
        throw new Error(message);
    }
    return data as T;
}

function formatDateTime(value?: string | null) {
    if (!value) return '-';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return value;
    return new Intl.DateTimeFormat('zh-CN', {
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
    }).format(date);
}

function formatCount(value: number) {
    return Math.round(Number(value || 0)).toLocaleString('zh-CN');
}

function formatPoints(value: number) {
    return Number(value || 0).toFixed(2);
}

function unwrapPayload(data: unknown): unknown {
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
        return data;
    }
    const record = data as Record<string, unknown>;
    if (record.data && typeof record.data === 'object') {
        return record.data;
    }
    if (record.result && typeof record.result === 'object' && !Array.isArray(record.result)) {
        const result = record.result as Record<string, unknown>;
        if (result.data && typeof result.data === 'object') {
            return result.data;
        }
    }
    return data;
}

function pointsBalanceFromPayload(data: unknown): number | null {
    const payload = unwrapPayload(data);
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        return null;
    }
    const record = payload as Record<string, unknown>;
    const candidates = [
        record.points,
        record.balance,
        record.pointsBalance,
        record.current_points,
        record.currentPoints,
        record.available_points,
        record.availablePoints,
    ];
    for (const candidate of candidates) {
        const value = Number(candidate);
        if (Number.isFinite(value)) {
            return value;
        }
    }
    return null;
}

function displayEmail(value?: string) {
    const email = String(value || '').trim();
    if (!email || email.toLowerCase().endsWith('@wechat.local')) {
        return '未绑定';
    }
    return email;
}

export function AccountConsole() {
    const [authState, setAuthState] = useState<AuthState>('checking');
    const [user, setUser] = useState<UserProfile | null>(null);
    const [usage, setUsage] = useState<UsageResponse>(defaultUsage);
    const [points, setPoints] = useState<PointsResponse>(null);
    const [wechatQrUrl, setWechatQrUrl] = useState('');
    const [wechatLoginUrl, setWechatLoginUrl] = useState('');
    const [wechatSessionId, setWechatSessionId] = useState('');
    const [wechatStatus, setWechatStatus] = useState<WechatStatus>('idle');
    const [wechatExpiresAt, setWechatExpiresAt] = useState(0);
    const [notice, setNotice] = useState('');
    const [error, setError] = useState('');
    const [loading, setLoading] = useState(false);
    const [wechatLoading, setWechatLoading] = useState(false);
    const [refreshing, setRefreshing] = useState(false);
    const pollTimerRef = useRef<number | null>(null);
    const pollRunTokenRef = useRef(0);
    const pollSessionIdRef = useRef('');
    const pollInFlightRef = useRef(false);

    const usageSummary = useMemo(() => {
        return usage.items.reduce(
            (acc, item) => ({
                tokens: acc.tokens + Number(item.token || 0),
            }),
            { tokens: 0 },
        );
    }, [usage.items]);

    const pointsBalance = useMemo(() => {
        return pointsBalanceFromPayload(points) ?? pointsBalanceFromPayload(user);
    }, [points, user]);

    const loadAccount = useCallback(async (quiet = false) => {
        if (!quiet) {
            setRefreshing(true);
        }
        setError('');
        try {
            const [profile, usageData, pointsData] = await Promise.all([
                fetch('/api/account/me', { cache: 'no-store' }).then((response) => readJson<UserProfile>(response)),
                fetch('/api/account/usage?limit=20&page=1', { cache: 'no-store' }).then((response) => readJson<UsageResponse>(response)),
                fetch('/api/account/points', { cache: 'no-store' }).then((response) => readJson<PointsResponse>(response)).catch(() => null),
            ]);
            setUser(profile);
            setUsage(usageData);
            setPoints(pointsData);
            setAuthState('signed_in');
        } catch (loadError) {
            setUser(null);
            setUsage(defaultUsage);
            setPoints(null);
            setAuthState('signed_out');
            if (!quiet) {
                setError(loadError instanceof Error ? loadError.message : '读取账号信息失败');
            }
        } finally {
            setRefreshing(false);
        }
    }, []);

    useEffect(() => {
        loadAccount(true);
    }, [loadAccount]);

    const stopWechatPolling = useCallback(() => {
        pollRunTokenRef.current += 1;
        if (pollTimerRef.current !== null) {
            window.clearTimeout(pollTimerRef.current);
            pollTimerRef.current = null;
        }
        pollSessionIdRef.current = '';
        pollInFlightRef.current = false;
    }, []);

    const startWechatPolling = useCallback((sessionId: string) => {
        const normalizedSessionId = sessionId.trim();
        if (!normalizedSessionId) return;

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
            if (pollInFlightRef.current) {
                scheduleNext(wechatPollPendingIntervalMs);
                return;
            }

            pollInFlightRef.current = true;
            try {
                const data = await fetch(`/api/account/wechat/status?session_id=${encodeURIComponent(normalizedSessionId)}`, {
                    cache: 'no-store',
                }).then((response) => readJson<WechatStatusResponse>(response));
                if (pollRunTokenRef.current !== runToken || pollSessionIdRef.current !== normalizedSessionId) {
                    return;
                }

                const nextStatus = String(data.status || 'PENDING').toUpperCase() as WechatStatus;
                setWechatStatus(nextStatus);

                if (nextStatus === 'CONFIRMED') {
                    stopWechatPolling();
                    setNotice('微信登录成功');
                    await loadAccount(true);
                    return;
                }

                if (nextStatus === 'EXPIRED' || nextStatus === 'FAILED') {
                    stopWechatPolling();
                    setError(nextStatus === 'EXPIRED' ? '二维码已过期，请刷新后重试' : '微信登录失败，请刷新后重试');
                    return;
                }

                scheduleNext(nextStatus === 'SCANNED' ? wechatPollScannedIntervalMs : wechatPollPendingIntervalMs);
            } catch {
                if (pollRunTokenRef.current === runToken && pollSessionIdRef.current === normalizedSessionId) {
                    scheduleNext(wechatPollErrorIntervalMs);
                }
            } finally {
                pollInFlightRef.current = false;
            }
        };

        scheduleNext(wechatPollInitialDelayMs);
    }, [loadAccount, stopWechatPolling]);

    const fetchWechatQr = useCallback(async (options?: { silent?: boolean }) => {
        const silent = Boolean(options?.silent);
        setWechatLoading(true);
        setError('');
        if (!silent) {
            setNotice('');
        }
        try {
            stopWechatPolling();
            const data = await fetch('/api/account/wechat/start', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ state: 'redboxweb' }),
            }).then((response) => readJson<WechatStartResponse>(response));
            if (data.enabled === false) {
                throw new Error('微信扫码登录暂未启用');
            }
            const qrContent = String(data.qrContentUrl || data.url || '').trim();
            if (!qrContent) {
                throw new Error('后端未返回二维码内容');
            }
            const sessionId = String(data.sessionId || '').trim();
            setWechatQrUrl(await buildWechatQrDataUrl(qrContent));
            setWechatLoginUrl(String(data.url || '').trim());
            setWechatSessionId(sessionId);
            setWechatStatus(String(data.status || 'PENDING').toUpperCase() as WechatStatus);
            setWechatExpiresAt(Date.now() + Math.max(10, Number(data.expiresIn || 120)) * 1000);
            if (!silent) {
                setNotice('请使用微信扫码登录');
            }
            if (sessionId) {
                startWechatPolling(sessionId);
            }
        } catch (qrError) {
            stopWechatPolling();
            setWechatQrUrl('');
            setWechatSessionId('');
            setWechatStatus('FAILED');
            setError(qrError instanceof Error ? qrError.message : '获取微信登录二维码失败');
        } finally {
            setWechatLoading(false);
        }
    }, [startWechatPolling, stopWechatPolling]);

    useEffect(() => {
        if (authState === 'signed_out' && !wechatQrUrl && !wechatLoading) {
            void fetchWechatQr({ silent: true });
        }
    }, [authState, fetchWechatQr, wechatLoading, wechatQrUrl]);

    useEffect(() => {
        return () => stopWechatPolling();
    }, [stopWechatPolling]);

    async function handleLogout() {
        setLoading(true);
        setError('');
        setNotice('');
        try {
            await fetch('/api/account/logout', { method: 'POST' });
        } finally {
            setUser(null);
            setUsage(defaultUsage);
            setPoints(null);
            setAuthState('signed_out');
            setLoading(false);
        }
    }

    if (authState === 'checking') {
        return (
            <section className="mx-auto grid min-h-[52vh] w-full max-w-6xl place-items-center px-4 py-16">
                <div className="flex items-center gap-3 rounded-[22px] border border-[#32231714] bg-white/70 px-5 py-4 text-sm font-bold text-[#5f4a3c] shadow-[0_18px_40px_rgba(47,28,16,0.08)]">
                    <LoaderCircle className="h-4 w-4 animate-spin" />
                    正在检查登录状态
                </div>
            </section>
        );
    }

    if (authState === 'signed_out') {
        const minutesUntilExpiry = wechatExpiresAt > Date.now() ? Math.max(1, Math.ceil((wechatExpiresAt - Date.now()) / 60000)) : 0;
        const canOpenWechatLink = Boolean(wechatLoginUrl && wechatLoginUrl !== wechatQrUrl);

        return (
            <section className="mx-auto grid w-full max-w-2xl px-4 py-10">
                <div className="rounded-[30px] border border-[#32231714] bg-white/78 p-6 shadow-[0_20px_44px_rgba(47,28,16,0.08)] md:p-8">
                    <div className="flex items-center justify-between gap-4">
                        <div>
                            <h1 className="text-2xl font-black text-[#22170f]">微信扫码登录</h1>
                            <p className="mt-2 text-sm font-semibold text-[#7a6758]">使用微信扫码继续登录 RedBox。</p>
                        </div>
                        <span className="flex h-11 w-11 items-center justify-center rounded-[16px] bg-[#0f5d5a]/10 text-[#0f5d5a]">
                            <MessageCircle className="h-5 w-5" />
                        </span>
                    </div>

                    <div className="mt-7 grid place-items-center rounded-[24px] border border-[#32231714] bg-[#fffaf6] p-5">
                        <div className="grid h-[280px] w-full max-w-[280px] place-items-center rounded-[20px] bg-white p-4 shadow-[0_14px_34px_rgba(47,28,16,0.08)]">
                            {wechatQrUrl ? (
                                <img src={wechatQrUrl} alt="微信登录二维码" className="h-full w-full object-contain" />
                            ) : (
                                <div className="flex flex-col items-center gap-3 text-sm font-bold text-[#8a715d]">
                                    <LoaderCircle className="h-5 w-5 animate-spin" />
                                    正在获取二维码
                                </div>
                            )}
                        </div>
                        <div className="mt-4 flex flex-wrap items-center justify-center gap-2 text-center text-sm font-bold text-[#6b5b4d]">
                            <span className="inline-flex h-2.5 w-2.5 rounded-full bg-[#0f5d5a]" />
                            {wechatStatusCopy[wechatStatus] || wechatStatusCopy.PENDING}
                            {minutesUntilExpiry > 0 && wechatStatus !== 'CONFIRMED' ? <span className="text-[#9a7c69]">约 {minutesUntilExpiry} 分钟内有效</span> : null}
                            {wechatSessionId && (wechatStatus === 'PENDING' || wechatStatus === 'SCANNED') ? <span className="sr-only">扫码会话已建立</span> : null}
                        </div>
                    </div>

                    {error ? <div className="mt-5 rounded-[18px] border border-[#c8321c]/20 bg-[#c8321c]/8 px-4 py-3 text-sm font-bold text-[#9d2a17]">{error}</div> : null}
                    {notice ? <div className="mt-5 rounded-[18px] border border-[#0f5d5a]/18 bg-[#0f5d5a]/8 px-4 py-3 text-sm font-bold text-[#0f5d5a]">{notice}</div> : null}

                    <div className="mt-6 flex flex-col gap-3 sm:flex-row">
                        <button
                            type="button"
                            onClick={() => fetchWechatQr()}
                            disabled={wechatLoading}
                            className="inline-flex h-12 flex-1 items-center justify-center gap-2 rounded-full bg-[linear-gradient(135deg,#df6031,#b13012_65%,#881d08)] px-5 text-sm font-black text-white shadow-[0_12px_24px_rgba(177,48,18,0.22)] transition hover:translate-y-[-1px] disabled:cursor-not-allowed disabled:opacity-60"
                        >
                            {wechatLoading ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
                            刷新二维码
                        </button>
                        {canOpenWechatLink ? (
                            <a
                                href={wechatLoginUrl}
                                target="_blank"
                                rel="noreferrer"
                                className="inline-flex h-12 flex-1 items-center justify-center gap-2 rounded-full border border-[#32231714] bg-white/76 px-5 text-sm font-black text-[#22170f] transition hover:bg-white"
                            >
                                <LogIn className="h-4 w-4" />
                                打开登录链接
                            </a>
                        ) : null}
                    </div>
                </div>
            </section>
        );
    }

    return (
        <section className="mx-auto w-full max-w-6xl px-4 py-8 pb-20">
            <div className="flex flex-wrap items-end justify-between gap-4">
                <div>
                    <span className="inline-flex rounded-full border border-[#32231714] bg-white/72 px-4 py-2 text-[11px] font-extrabold uppercase tracking-[0.18em] text-[#6d5a4f]">
                        Console
                    </span>
                    <h1 className="mt-4 font-serif text-[clamp(2.4rem,5vw,4.5rem)] leading-[0.95] text-[#20150f]">
                        账号控制台
                    </h1>
                </div>
                <div className="flex flex-wrap gap-2">
                    <button
                        type="button"
                        onClick={() => loadAccount(false)}
                        disabled={refreshing}
                        className="inline-flex h-10 items-center justify-center gap-2 rounded-full border border-[#32231714] bg-white/70 px-4 text-sm font-bold text-[#4d3b2f] transition hover:bg-white"
                    >
                        <RefreshCw className={`h-4 w-4 ${refreshing ? 'animate-spin' : ''}`} />
                        刷新
                    </button>
                    <button
                        type="button"
                        onClick={handleLogout}
                        disabled={loading}
                        className="inline-flex h-10 items-center justify-center gap-2 rounded-full border border-[#32231714] bg-white/70 px-4 text-sm font-bold text-[#4d3b2f] transition hover:bg-white"
                    >
                        <LogOut className="h-4 w-4" />
                        退出
                    </button>
                </div>
            </div>

            {notice ? <div className="mt-5 rounded-[18px] border border-[#0f5d5a]/18 bg-[#0f5d5a]/8 px-4 py-3 text-sm font-bold text-[#0f5d5a]">{notice}</div> : null}
            {error ? <div className="mt-5 rounded-[18px] border border-[#c8321c]/20 bg-[#c8321c]/8 px-4 py-3 text-sm font-bold text-[#9d2a17]">{error}</div> : null}

            <div className="mt-6 grid gap-4 lg:grid-cols-[0.9fr_1.1fr]">
                <article className="rounded-[28px] border border-[#32231714] bg-white/74 p-6 shadow-[0_18px_40px_rgba(47,28,16,0.08)]">
                    <h2 className="text-xl font-black text-[#22170f]">{user?.display_name || user?.full_name || user?.email}</h2>
                    <div className="mt-5 grid gap-3 text-sm font-semibold text-[#6b5b4d]">
                        <div className="flex justify-between gap-4 border-b border-[#32231712] pb-3">
                            <span>邮箱</span>
                            <strong className="text-right text-[#22170f]">{displayEmail(user?.email)}</strong>
                        </div>
                        <div className="flex justify-between gap-4">
                            <span>最近登录</span>
                            <strong className="text-right text-[#22170f]">{formatDateTime(user?.last_login_at)}</strong>
                        </div>
                    </div>
                </article>

                <div className="grid gap-4 sm:grid-cols-3">
                    <article className="rounded-[28px] border border-[#32231714] bg-white/74 p-5 shadow-[0_18px_40px_rgba(47,28,16,0.08)]">
                        <span className="text-xs font-extrabold uppercase tracking-[0.14em] text-[#8a715d]">调用</span>
                        <strong className="mt-4 block text-3xl font-black text-[#22170f]">{formatCount(usage.total)}</strong>
                    </article>
                    <article className="rounded-[28px] border border-[#32231714] bg-white/74 p-5 shadow-[0_18px_40px_rgba(47,28,16,0.08)]">
                        <span className="text-xs font-extrabold uppercase tracking-[0.14em] text-[#8a715d]">Token</span>
                        <strong className="mt-4 block text-3xl font-black text-[#22170f]">{formatCount(usageSummary.tokens)}</strong>
                    </article>
                    <article className="rounded-[28px] border border-[#32231714] bg-white/74 p-5 shadow-[0_18px_40px_rgba(47,28,16,0.08)]">
                        <span className="text-xs font-extrabold uppercase tracking-[0.14em] text-[#8a715d]">积分余额</span>
                        <strong className="mt-4 block text-3xl font-black text-[#22170f]">{pointsBalance === null ? '-' : formatPoints(pointsBalance)}</strong>
                    </article>
                </div>
            </div>

            <div className="mt-4">
                <article className="overflow-hidden rounded-[28px] border border-[#32231714] bg-white/74 shadow-[0_18px_40px_rgba(47,28,16,0.08)]">
                    <div className="flex items-center justify-between gap-4 border-b border-[#32231712] px-5 py-4">
                        <h2 className="text-lg font-black text-[#22170f]">调用详情</h2>
                        <span className="text-xs font-bold text-[#8a715d]">最近 20 条</span>
                    </div>
                    <div className="overflow-x-auto">
                        <table className="w-full min-w-[620px] border-collapse text-left text-sm">
                            <thead className="bg-[#f3e7d9]/60 text-xs uppercase tracking-[0.12em] text-[#8a715d]">
                                <tr>
                                    <th className="px-5 py-3">时间</th>
                                    <th className="px-5 py-3">模型</th>
                                    <th className="px-5 py-3 text-right">Token</th>
                                    <th className="px-5 py-3 text-right">积分</th>
                                </tr>
                            </thead>
                            <tbody>
                                {usage.items.length > 0 ? (
                                    usage.items.map((item) => (
                                        <tr key={item.id} className="border-t border-[#32231710]">
                                            <td className="px-5 py-3 font-semibold text-[#6b5b4d]">{formatDateTime(item.time)}</td>
                                            <td className="px-5 py-3 font-bold text-[#22170f]">{item.model || '-'}</td>
                                            <td className="px-5 py-3 text-right font-bold text-[#22170f]">{formatCount(item.token)}</td>
                                            <td className="px-5 py-3 text-right font-bold text-[#a43816]">{formatPoints(item.points_cost)}</td>
                                        </tr>
                                    ))
                                ) : (
                                    <tr>
                                        <td colSpan={4} className="px-5 py-10 text-center font-bold text-[#8a715d]">
                                            暂无调用记录
                                        </td>
                                    </tr>
                                )}
                            </tbody>
                        </table>
                    </div>
                </article>
            </div>
        </section>
    );
}
