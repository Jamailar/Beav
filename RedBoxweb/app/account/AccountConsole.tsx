'use client';

import { FormEvent, useCallback, useEffect, useMemo, useState } from 'react';
import {
    Check,
    Copy,
    KeyRound,
    LoaderCircle,
    LogIn,
    LogOut,
    RefreshCw,
    ShieldCheck,
    Trash2,
} from 'lucide-react';

interface UserProfile {
    id?: string;
    email?: string;
    display_name?: string;
    full_name?: string;
    app_slug?: string;
    membership_type?: string;
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

interface ApiKeyItem {
    id: string;
    name: string;
    key_prefix: string;
    key_last4: string;
    is_active: boolean;
    created_at: string;
    last_used_at: string | null;
}

interface ApiKeyResponse {
    items: ApiKeyItem[];
}

type AuthState = 'checking' | 'signed_out' | 'signed_in';

const defaultUsage: UsageResponse = {
    page: 1,
    page_size: 20,
    total: 0,
    items: [],
};

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

export function AccountConsole() {
    const [authState, setAuthState] = useState<AuthState>('checking');
    const [user, setUser] = useState<UserProfile | null>(null);
    const [usage, setUsage] = useState<UsageResponse>(defaultUsage);
    const [apiKeys, setApiKeys] = useState<ApiKeyItem[]>([]);
    const [email, setEmail] = useState('');
    const [password, setPassword] = useState('');
    const [newKeyName, setNewKeyName] = useState('RedBox API Key');
    const [revealedKey, setRevealedKey] = useState('');
    const [notice, setNotice] = useState('');
    const [error, setError] = useState('');
    const [loading, setLoading] = useState(false);
    const [refreshing, setRefreshing] = useState(false);

    const usageSummary = useMemo(() => {
        return usage.items.reduce(
            (acc, item) => ({
                tokens: acc.tokens + Number(item.token || 0),
                points: acc.points + Number(item.points_cost || 0),
            }),
            { tokens: 0, points: 0 },
        );
    }, [usage.items]);

    const loadAccount = useCallback(async (quiet = false) => {
        if (!quiet) {
            setRefreshing(true);
        }
        setError('');
        try {
            const [profile, usageData, keyData] = await Promise.all([
                fetch('/api/account/me', { cache: 'no-store' }).then((response) => readJson<UserProfile>(response)),
                fetch('/api/account/usage?limit=20&page=1', { cache: 'no-store' }).then((response) => readJson<UsageResponse>(response)),
                fetch('/api/account/api-keys', { cache: 'no-store' }).then((response) => readJson<ApiKeyResponse>(response)),
            ]);
            setUser(profile);
            setUsage(usageData);
            setApiKeys(Array.isArray(keyData.items) ? keyData.items : []);
            setAuthState('signed_in');
        } catch (loadError) {
            setUser(null);
            setUsage(defaultUsage);
            setApiKeys([]);
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

    async function handleLogin(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        setLoading(true);
        setError('');
        setNotice('');
        try {
            const data = await fetch('/api/account/login', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email, password }),
            }).then((response) => readJson<{ user?: UserProfile }>(response));
            if (data.user) {
                setUser(data.user);
            }
            setPassword('');
            await loadAccount(true);
            setNotice('已登录');
        } catch (loginError) {
            setAuthState('signed_out');
            setError(loginError instanceof Error ? loginError.message : '登录失败');
        } finally {
            setLoading(false);
        }
    }

    async function handleLogout() {
        setLoading(true);
        setError('');
        setNotice('');
        try {
            await fetch('/api/account/logout', { method: 'POST' });
        } finally {
            setUser(null);
            setUsage(defaultUsage);
            setApiKeys([]);
            setRevealedKey('');
            setAuthState('signed_out');
            setLoading(false);
        }
    }

    async function createApiKey(ensureDefault = false) {
        setLoading(true);
        setError('');
        setNotice('');
        try {
            const endpoint = ensureDefault ? '/api/account/api-keys/ensure-default' : '/api/account/api-keys';
            const data = await fetch(endpoint, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: newKeyName }),
            }).then((response) => readJson<Record<string, unknown>>(response));
            const key = typeof data.key === 'string' ? data.key : '';
            setRevealedKey(key);
            setNotice(key ? 'API Key 已生成，请现在保存。' : '已有可用 API Key');
            await loadAccount(true);
        } catch (createError) {
            setError(createError instanceof Error ? createError.message : '创建 API Key 失败');
        } finally {
            setLoading(false);
        }
    }

    async function revokeApiKey(keyId: string) {
        setLoading(true);
        setError('');
        setNotice('');
        try {
            await fetch(`/api/account/api-keys/${encodeURIComponent(keyId)}/revoke`, {
                method: 'POST',
            }).then((response) => readJson(response));
            setNotice('API Key 已撤销');
            await loadAccount(true);
        } catch (revokeError) {
            setError(revokeError instanceof Error ? revokeError.message : '撤销 API Key 失败');
        } finally {
            setLoading(false);
        }
    }

    async function copyRevealedKey() {
        if (!revealedKey) return;
        await navigator.clipboard.writeText(revealedKey);
        setNotice('已复制 API Key');
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
        return (
            <section className="mx-auto grid w-full max-w-6xl gap-6 px-4 py-10 lg:grid-cols-[0.95fr_1.05fr]">
                <div className="rounded-[30px] bg-[linear-gradient(180deg,rgba(37,29,24,0.96),rgba(26,21,18,0.95))] p-8 text-white shadow-[0_24px_48px_rgba(47,28,16,0.14)]">
                    <span className="inline-flex rounded-full border border-white/10 bg-white/8 px-4 py-2 text-[11px] font-extrabold uppercase tracking-[0.18em] text-white/68">
                        Account
                    </span>
                    <h1 className="mt-5 max-w-[9ch] font-serif text-[clamp(2.7rem,6vw,5rem)] leading-[0.92] text-white">
                        登录
                        <span className="block text-[#ffd4c6]">RedBox</span>
                    </h1>
                    <div className="mt-8 grid gap-3 text-[15px] font-semibold text-white/78">
                        <div className="flex items-center gap-3">
                            <ShieldCheck className="h-5 w-5 text-[#ffd4c6]" />
                            查看自己的 AI 调用明细
                        </div>
                        <div className="flex items-center gap-3">
                            <KeyRound className="h-5 w-5 text-[#ffd4c6]" />
                            创建、复制和撤销自己的 API Key
                        </div>
                    </div>
                </div>

                <form
                    onSubmit={handleLogin}
                    className="rounded-[30px] border border-[#32231714] bg-white/76 p-6 shadow-[0_20px_44px_rgba(47,28,16,0.08)] md:p-8"
                >
                    <div className="flex items-center justify-between gap-4">
                        <div>
                            <h2 className="text-2xl font-black text-[#22170f]">账号登录</h2>
                            <p className="mt-2 text-sm font-semibold text-[#7a6758]">使用 RedBox 账号继续。</p>
                        </div>
                        <span className="flex h-11 w-11 items-center justify-center rounded-[16px] bg-[#0f5d5a]/10 text-[#0f5d5a]">
                            <LogIn className="h-5 w-5" />
                        </span>
                    </div>

                    <label className="mt-7 grid gap-2 text-sm font-bold text-[#4d3b2f]">
                        邮箱
                        <input
                            value={email}
                            onChange={(event) => setEmail(event.target.value)}
                            type="email"
                            autoComplete="email"
                            className="h-12 rounded-[16px] border border-[#32231718] bg-white/80 px-4 text-base text-[#22170f] outline-none transition focus:border-[#0f5d5a]/50 focus:ring-4 focus:ring-[#0f5d5a]/10"
                            required
                        />
                    </label>

                    <label className="mt-4 grid gap-2 text-sm font-bold text-[#4d3b2f]">
                        密码
                        <input
                            value={password}
                            onChange={(event) => setPassword(event.target.value)}
                            type="password"
                            autoComplete="current-password"
                            className="h-12 rounded-[16px] border border-[#32231718] bg-white/80 px-4 text-base text-[#22170f] outline-none transition focus:border-[#0f5d5a]/50 focus:ring-4 focus:ring-[#0f5d5a]/10"
                            required
                        />
                    </label>

                    {error ? <div className="mt-5 rounded-[18px] border border-[#c8321c]/20 bg-[#c8321c]/8 px-4 py-3 text-sm font-bold text-[#9d2a17]">{error}</div> : null}

                    <button
                        type="submit"
                        disabled={loading}
                        className="mt-6 inline-flex h-12 w-full items-center justify-center gap-2 rounded-full bg-[linear-gradient(135deg,#df6031,#b13012_65%,#881d08)] px-5 text-sm font-black text-white shadow-[0_12px_24px_rgba(177,48,18,0.22)] transition hover:translate-y-[-1px] disabled:cursor-not-allowed disabled:opacity-60"
                    >
                        {loading ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <LogIn className="h-4 w-4" />}
                        登录
                    </button>
                </form>
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
                            <strong className="text-right text-[#22170f]">{user?.email || '-'}</strong>
                        </div>
                        <div className="flex justify-between gap-4 border-b border-[#32231712] pb-3">
                            <span>应用</span>
                            <strong className="text-right text-[#22170f]">{user?.app_slug || 'redbox'}</strong>
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
                        <span className="text-xs font-extrabold uppercase tracking-[0.14em] text-[#8a715d]">积分</span>
                        <strong className="mt-4 block text-3xl font-black text-[#22170f]">{formatPoints(usageSummary.points)}</strong>
                    </article>
                </div>
            </div>

            <div className="mt-4 grid gap-4 lg:grid-cols-[1.05fr_0.95fr]">
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

                <article className="rounded-[28px] border border-[#32231714] bg-white/74 p-5 shadow-[0_18px_40px_rgba(47,28,16,0.08)]">
                    <div className="flex items-center justify-between gap-4">
                        <h2 className="text-lg font-black text-[#22170f]">API Key</h2>
                        <KeyRound className="h-5 w-5 text-[#0f5d5a]" />
                    </div>

                    <div className="mt-5 flex gap-2">
                        <input
                            value={newKeyName}
                            onChange={(event) => setNewKeyName(event.target.value)}
                            className="h-11 min-w-0 flex-1 rounded-[15px] border border-[#32231718] bg-white/80 px-4 text-sm font-semibold text-[#22170f] outline-none focus:border-[#0f5d5a]/50 focus:ring-4 focus:ring-[#0f5d5a]/10"
                        />
                        <button
                            type="button"
                            onClick={() => createApiKey(false)}
                            disabled={loading}
                            className="inline-flex h-11 shrink-0 items-center justify-center gap-2 rounded-full bg-[#0f5d5a] px-4 text-sm font-black text-white transition hover:bg-[#0c4e4b] disabled:opacity-60"
                        >
                            <KeyRound className="h-4 w-4" />
                            新建
                        </button>
                    </div>

                    <button
                        type="button"
                        onClick={() => createApiKey(true)}
                        disabled={loading}
                        className="mt-3 inline-flex h-10 w-full items-center justify-center gap-2 rounded-full border border-[#32231714] bg-white/70 px-4 text-sm font-bold text-[#4d3b2f] transition hover:bg-white disabled:opacity-60"
                    >
                        <Check className="h-4 w-4" />
                        确保默认 Key
                    </button>

                    {revealedKey ? (
                        <div className="mt-4 rounded-[18px] border border-[#0f5d5a]/18 bg-[#0f5d5a]/8 p-4">
                            <div className="flex items-center justify-between gap-3">
                                <span className="text-xs font-extrabold uppercase tracking-[0.14em] text-[#0f5d5a]">只显示一次</span>
                                <button
                                    type="button"
                                    onClick={copyRevealedKey}
                                    className="inline-flex h-8 items-center justify-center gap-1 rounded-full bg-white/80 px-3 text-xs font-black text-[#0f5d5a]"
                                >
                                    <Copy className="h-3.5 w-3.5" />
                                    复制
                                </button>
                            </div>
                            <code className="mt-3 block break-all rounded-[14px] bg-white/82 p-3 text-xs font-bold text-[#22170f]">{revealedKey}</code>
                        </div>
                    ) : null}

                    <div className="mt-5 grid gap-3">
                        {apiKeys.length > 0 ? (
                            apiKeys.map((item) => (
                                <div key={item.id} className="rounded-[18px] border border-[#32231712] bg-white/66 p-4">
                                    <div className="flex items-start justify-between gap-3">
                                        <div className="min-w-0">
                                            <div className="truncate font-black text-[#22170f]">{item.name}</div>
                                            <div className="mt-1 font-mono text-xs font-bold text-[#6b5b4d]">
                                                {item.key_prefix}...{item.key_last4}
                                            </div>
                                        </div>
                                        <button
                                            type="button"
                                            onClick={() => revokeApiKey(item.id)}
                                            disabled={loading || !item.is_active}
                                            className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-[#32231714] bg-white/80 text-[#9d2a17] transition hover:bg-[#c8321c]/8 disabled:opacity-40"
                                            aria-label="撤销 API Key"
                                        >
                                            <Trash2 className="h-4 w-4" />
                                        </button>
                                    </div>
                                    <div className="mt-3 flex flex-wrap gap-2 text-xs font-bold text-[#8a715d]">
                                        <span className="rounded-full bg-[#f3e7d9]/70 px-3 py-1">{item.is_active ? '可用' : '已撤销'}</span>
                                        <span className="rounded-full bg-[#f3e7d9]/70 px-3 py-1">创建 {formatDateTime(item.created_at)}</span>
                                        <span className="rounded-full bg-[#f3e7d9]/70 px-3 py-1">使用 {formatDateTime(item.last_used_at)}</span>
                                    </div>
                                </div>
                            ))
                        ) : (
                            <div className="rounded-[18px] border border-[#32231712] bg-white/66 px-4 py-8 text-center text-sm font-bold text-[#8a715d]">
                                还没有 API Key
                            </div>
                        )}
                    </div>
                </article>
            </div>
        </section>
    );
}
