import { memo, useMemo, useState, type Dispatch, type ReactNode, type SetStateAction } from 'react';
import { Activity, Check, ChevronDown, Copy, Database, Download, FolderOpen, Info, MessageSquareText, RefreshCw, Save, Search, Square, Trash2 } from 'lucide-react';
import clsx from 'clsx';
import { PasswordInput, resolveRuntimeAssetUrl } from './shared';
import type {
  AgentTaskSnapshot,
  AgentTaskTrace,
  BackgroundTaskItem,
  BackgroundWorkerPoolState,
  McpServerRuntimeItem,
  McpServerConfig,
  McpSessionState,
  MemoryHistoryEntry,
  MemoryMaintenanceStatus,
    MemorySearchResult,
    RoleSpec,
    RuntimeToolResultItem,
    ToolDiagnosticDescriptor,
    ToolDiagnosticRunResult,
    UserMemory,
} from './shared';

type SettingsFormData = {
    workspace_dir: string;
    debug_log_enabled: boolean;
    proxy_enabled: boolean;
    proxy_url: string;
    proxy_bypass: string;
};

type YtdlpStatus = {
    installed?: boolean;
    version?: string;
    path?: string;
} | null;

type BrowserPluginStatus = {
    success: boolean;
    bundled: boolean;
    exportPath: string;
    pluginPath?: string;
    exported: boolean;
    bundledPath?: string;
    error?: string;
} | null;

type McpOauthState = Record<string, { connected?: boolean; tokenPath?: string } | undefined>;

type RuntimeDiagnosticsSummary = {
    generatedAt?: number;
    runtimeWarm?: {
        lastWarmedAt?: number;
        entries?: Array<{
            mode: string;
            warmedAt: number;
            systemPromptChars: number;
            longTermContextChars: number;
            hasModelConfig: boolean;
        }>;
    };
    phase0?: {
        personaGeneration?: {
            count?: number;
            avgElapsedMs?: number;
            avgSearchElapsedMs?: number;
            avgKnowledgeFiles?: number;
            byAdvisor?: Array<Record<string, unknown>>;
            recent?: Array<Record<string, unknown>>;
        };
        knowledgeIngest?: {
            count?: number;
            avgElapsedMs?: number;
            avgImportedFiles?: number;
            avgTotalKnowledgeFiles?: number;
            byAdvisor?: Array<Record<string, unknown>>;
            recent?: Array<Record<string, unknown>>;
        };
        runtimeQueries?: {
            count?: number;
            avgElapsedMs?: number;
            avgPromptChars?: number;
            avgActiveSkillCount?: number;
            byAdvisor?: Array<Record<string, unknown>>;
            byMode?: Array<Record<string, unknown>>;
            recent?: Array<Record<string, unknown>>;
        };
        skillInvocations?: {
            count?: number;
            avgElapsedMs?: number;
            avgActiveSkillCount?: number;
            bySkill?: Array<Record<string, unknown>>;
            recent?: Array<Record<string, unknown>>;
        };
        toolCalls?: {
            count?: number;
            successCount?: number;
            successRate?: number;
            byAdvisor?: Array<Record<string, unknown>>;
            byTool?: Array<Record<string, unknown>>;
            recent?: Array<Record<string, unknown>>;
        };
    };
};

type AssistantDaemonStatus = {
    enabled: boolean;
    autoStart: boolean;
    keepAliveWhenNoWindow: boolean;
    host: string;
    port: number;
    listening: boolean;
    lockState: 'owner' | 'passive';
    blockedBy: string | null;
    lastError: string | null;
    activeTaskCount: number;
    queuedPeerCount: number;
    feishu: {
        enabled: boolean;
        receiveMode: 'webhook' | 'websocket';
        endpointPath: string;
        verificationToken?: string;
        encryptKey?: string;
        appId?: string;
        appSecret?: string;
        replyUsingChatId: boolean;
        webhookUrl: string;
        websocketRunning: boolean;
        websocketReconnectAt?: string | null;
    };
    relay: {
        enabled: boolean;
        endpointPath: string;
        authToken?: string;
        webhookUrl: string;
    };
    knowledgeApi: {
        endpointPath: string;
        webhookUrl: string;
    };
    weixin: {
        enabled: boolean;
        endpointPath: string;
        authToken?: string;
        accountId?: string;
        autoStartSidecar: boolean;
        cursorFile?: string;
        sidecarCommand?: string;
        sidecarArgs?: string[];
        sidecarCwd?: string;
        sidecarEnv?: Record<string, string>;
        webhookUrl: string;
        sidecarRunning: boolean;
        sidecarPid?: number;
        connected: boolean;
        userId?: string;
        stateDir: string;
        availableAccountIds: string[];
    };
};

const copyTextWithClipboard = async (text: string): Promise<boolean> => {
    try {
        await navigator.clipboard.writeText(text);
        return true;
    } catch {
        try {
            const textarea = document.createElement('textarea');
            textarea.value = text;
            textarea.style.position = 'fixed';
            textarea.style.opacity = '0';
            document.body.appendChild(textarea);
            textarea.focus();
            textarea.select();
            const ok = document.execCommand('copy');
            document.body.removeChild(textarea);
            return ok;
        } catch {
            return false;
        }
    }
};

function DiagnosticCopyButton({ text, label = '复制' }: { text: string; label?: string }) {
    const [copied, setCopied] = useState(false);

    const handleCopy = async () => {
        if (!String(text || '').trim()) return;
        const ok = await copyTextWithClipboard(text);
        if (!ok) return;
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1400);
    };

    return (
        <button
            type="button"
            onClick={() => void handleCopy()}
            className="inline-flex items-center gap-1 rounded-md border border-border/60 bg-surface-primary/92 px-2 py-1 text-[11px] text-text-tertiary shadow-sm transition-colors hover:border-border hover:bg-surface-primary hover:text-text-primary"
            title={label}
        >
            {copied ? <Check className="h-3.5 w-3.5 text-green-500" /> : <Copy className="h-3.5 w-3.5" />}
            <span>{copied ? '已复制' : label}</span>
        </button>
    );
}

type AssistantDaemonDraft = {
    enabled: boolean;
    autoStart: boolean;
    keepAliveWhenNoWindow: boolean;
    host: string;
    port: string;
    feishu: {
        enabled: boolean;
        receiveMode: 'webhook' | 'websocket';
        endpointPath: string;
        verificationToken: string;
        encryptKey: string;
        appId: string;
        appSecret: string;
        replyUsingChatId: boolean;
    };
    relay: {
        enabled: boolean;
        endpointPath: string;
        authToken: string;
    };
    weixin: {
        enabled: boolean;
        endpointPath: string;
        authToken: string;
        accountId: string;
        autoStartSidecar: boolean;
        cursorFile: string;
        sidecarCommand: string;
        sidecarArgs: string;
        sidecarCwd: string;
        sidecarEnvText: string;
    };
};

type AssistantDaemonWeixinLoginState = {
    sessionKey?: string;
    qrcodeUrl?: string;
    qrcodeImageUrl?: string;
    message: string;
    accountId?: string;
    userId?: string;
    connected: boolean;
    stateDir?: string;
};

interface GeneralSettingsSectionProps {
    appVersion: string;
    formData: SettingsFormData;
    setFormData: Dispatch<SetStateAction<any>>;
    handlePickWorkspaceDir: () => Promise<void>;
    handleResetWorkspaceDir: () => void;
    handleOpenKnowledgeApiGuide: () => Promise<void>;
    recentDebugLogs: string[];
    isDebugLogsLoading: boolean;
    handleRefreshDebugLogs: () => Promise<void>;
    handleOpenDebugLogDir: () => Promise<void>;
    handleVersionTap: () => void;
}

interface RemoteConnectionSettingsSectionProps {
    assistantDaemonStatus: AssistantDaemonStatus | null;
    assistantDaemonDraft: AssistantDaemonDraft;
    setAssistantDaemonDraft: Dispatch<SetStateAction<AssistantDaemonDraft>>;
    assistantDaemonLogs: string[];
    assistantDaemonBusy: boolean;
    assistantDaemonWeixinLogin: AssistantDaemonWeixinLoginState | null;
    assistantDaemonWeixinLoginBusy: boolean;
    handleReloadAssistantDaemonStatus: () => Promise<void>;
    handleSaveAssistantDaemonConfig: () => Promise<void>;
    handleStartAssistantDaemon: () => Promise<void>;
    handleStopAssistantDaemon: () => Promise<void>;
    handleStartAssistantDaemonWeixinLogin: () => Promise<void>;
    handleCheckAssistantDaemonWeixinLogin: () => Promise<void>;
    handleClearAssistantDaemonWeixinLogin: () => void;
}

function GeneralSettingsSectionInner({
    appVersion,
    formData,
    setFormData,
    handlePickWorkspaceDir,
    handleResetWorkspaceDir,
    handleOpenKnowledgeApiGuide,
    recentDebugLogs,
    isDebugLogsLoading,
    handleRefreshDebugLogs,
    handleOpenDebugLogDir,
    handleVersionTap,
}: GeneralSettingsSectionProps) {
    const [isProxySettingsExpanded, setIsProxySettingsExpanded] = useState(false);

    return (
        <section className="space-y-6">
            <h2 className="text-lg font-medium text-text-primary mb-6">常规设置</h2>

            <div className="bg-surface-secondary/30 rounded-lg border border-border p-4">
                <div className="flex items-start justify-between">
                    <div>
                        <h3 className="text-sm font-medium text-text-primary flex items-center gap-2">
                            <Info className="w-4 h-4" />
                            红盒子 RedBox
                        </h3>
                        <p className="text-xs text-text-tertiary mt-1">
                            当前版本:{' '}
                            <button
                                type="button"
                                onClick={handleVersionTap}
                                className="font-mono hover:text-text-primary transition-colors"
                            >
                                {appVersion || '加载中...'}
                            </button>
                        </p>
                        <p className="text-xs text-text-tertiary mt-1">
                            自动更新已关闭，请前往 GitHub Releases 手动下载新版本。
                        </p>
                    </div>
                    <a
                        href="https://github.com/Jamailar/RedBox/releases"
                        target="_blank"
                        rel="noreferrer"
                        className="flex items-center gap-2 px-3 py-1.5 border border-border text-text-primary text-xs font-medium rounded hover:bg-surface-secondary"
                    >
                        <Download className="w-3 h-3" />
                        打开下载页
                    </a>
                </div>
            </div>

            <div className="group">
                <label className="block text-xs font-medium text-text-secondary mb-1.5">
                    工作区根目录
                </label>
                <p className="text-[10px] text-text-tertiary mb-2">
                    RedConvert 会在这里创建完整工作区结构。留空则使用默认目录 ~/.redconvert
                </p>
                <div className="flex items-center gap-2">
                    <div className="flex-1 relative">
                        <FolderOpen className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-text-tertiary" />
                        <input
                            type="text"
                            value={formData.workspace_dir}
                            onChange={(e) => setFormData((d: any) => ({ ...d, workspace_dir: e.target.value }))}
                            placeholder="~/.redconvert"
                            className="w-full bg-surface-secondary/30 rounded border border-border pl-10 pr-3 py-2 text-sm focus:outline-none focus:border-accent-primary transition-colors"
                        />
                    </div>
                    <button
                        type="button"
                        onClick={() => void handlePickWorkspaceDir()}
                        className="shrink-0 rounded border border-border px-3 py-2 text-xs font-medium text-text-primary hover:bg-surface-secondary transition-colors"
                    >
                        选择文件夹
                    </button>
                    <button
                        type="button"
                        onClick={handleResetWorkspaceDir}
                        disabled={!String(formData.workspace_dir || '').trim()}
                        className="shrink-0 rounded border border-border px-3 py-2 text-xs font-medium text-text-secondary hover:bg-surface-secondary transition-colors disabled:cursor-not-allowed disabled:opacity-50"
                    >
                        恢复默认
                    </button>
                </div>
                <p className="text-[10px] text-text-tertiary mt-2">
                    不要直接选择现有的稿件目录、<code className="bg-surface-secondary px-1 rounded">manuscripts</code> 目录或 <code className="bg-surface-secondary px-1 rounded">documents</code> 目录，否则应用会在其中创建 <code className="bg-surface-secondary px-1 rounded">/skills/</code>、<code className="bg-surface-secondary px-1 rounded">/knowledge/</code>、<code className="bg-surface-secondary px-1 rounded">/advisors/</code>、<code className="bg-surface-secondary px-1 rounded">/manuscripts/</code> 等完整工作区结构。
                </p>
            </div>

            <div className={clsx(
                'overflow-hidden rounded-lg border border-border bg-surface-secondary/30 transition-colors',
                isProxySettingsExpanded && 'border-accent-primary/30',
            )}>
                <div className="flex items-center gap-3 px-4 py-3">
                    <button
                        type="button"
                        onClick={() => setIsProxySettingsExpanded((prev) => !prev)}
                        className="flex min-w-0 flex-1 items-center gap-3 text-left"
                        aria-expanded={isProxySettingsExpanded}
                        aria-controls="general-proxy-settings-panel"
                    >
                        <span className="flex h-5 w-5 shrink-0 items-center justify-center text-text-tertiary">
                            <ChevronDown className={clsx('h-4 w-4 transition-transform', isProxySettingsExpanded ? 'rotate-0' : '-rotate-90')} />
                        </span>
                        <h3 className="truncate text-sm font-medium text-text-primary">全局网络代理</h3>
                    </button>
                    <button
                        type="button"
                        onClick={() => setFormData((prev: any) => ({ ...prev, proxy_enabled: !prev.proxy_enabled }))}
                        className="ui-switch-track shrink-0"
                        data-size="lg"
                        data-state={formData.proxy_enabled ? 'on' : 'off'}
                        aria-label="启用全局代理"
                    >
                        <span className="ui-switch-thumb" />
                    </button>
                </div>

                {isProxySettingsExpanded && (
                    <div id="general-proxy-settings-panel" className="space-y-4 border-t border-border/70 px-4 py-4">
                        <p className="text-xs text-text-tertiary">
                            用于扫码登录、远程请求和需要走代理的外部连接。
                        </p>
                        <div>
                            <label className="mb-1.5 block text-xs font-medium text-text-secondary">代理地址</label>
                            <input
                                type="text"
                                value={formData.proxy_url}
                                onChange={(e) => setFormData((prev: any) => ({ ...prev, proxy_url: e.target.value }))}
                                placeholder="http://127.0.0.1:7890"
                                className="w-full bg-surface-secondary/30 rounded border border-border px-3 py-2 text-sm transition-colors focus:border-accent-primary focus:outline-none"
                            />
                        </div>
                        <div>
                            <label className="mb-1.5 block text-xs font-medium text-text-secondary">直连白名单</label>
                            <input
                                type="text"
                                value={formData.proxy_bypass}
                                onChange={(e) => setFormData((prev: any) => ({ ...prev, proxy_bypass: e.target.value }))}
                                placeholder="localhost,127.0.0.1,::1"
                                className="w-full bg-surface-secondary/30 rounded border border-border px-3 py-2 text-sm transition-colors focus:border-accent-primary focus:outline-none"
                            />
                        </div>
                        <p className="text-[10px] text-text-tertiary">
                            默认保留 `localhost`、`127.0.0.1` 和 `::1` 直连。
                        </p>
                    </div>
                )}
            </div>

            <div className="rounded-lg border border-border bg-surface-secondary/30 px-4 py-3">
                <div className="flex items-center justify-between gap-3">
                    <span className="text-sm font-medium text-text-primary">知识库导入</span>
                    <button
                        type="button"
                        onClick={() => void handleOpenKnowledgeApiGuide()}
                        className="text-xs font-medium text-accent-primary transition-colors hover:opacity-80"
                    >
                        打开 API 文档
                    </button>
                </div>
            </div>

            <div className="bg-surface-secondary/30 rounded-lg border border-border p-4 space-y-4">
                <div className="flex items-start justify-between gap-4">
                    <div>
                        <h3 className="text-sm font-medium text-text-primary">调试日志</h3>
                        <p className="text-xs text-text-tertiary mt-1">
                            开启后会保留当前运行期间的主进程日志、聊天日志和工具诊断日志预览，便于追踪 RedClaw 工具调用失败。
                        </p>
                    </div>
                    <button
                        type="button"
                        onClick={() => setFormData((prev: any) => ({ ...prev, debug_log_enabled: !prev.debug_log_enabled }))}
                        className="ui-switch-track"
                        data-size="lg"
                        data-state={formData.debug_log_enabled ? 'on' : 'off'}
                    >
                        <span className="ui-switch-thumb" />
                    </button>
                </div>
                <div className="flex items-center gap-2">
                    <button
                        type="button"
                        onClick={() => void handleRefreshDebugLogs()}
                        className="px-3 py-1.5 border border-border rounded text-xs hover:bg-surface-secondary transition-colors"
                    >
                        {isDebugLogsLoading ? '刷新中...' : '刷新日志'}
                    </button>
                    <button
                        type="button"
                        onClick={() => void handleOpenDebugLogDir()}
                        className="px-3 py-1.5 border border-border rounded text-xs hover:bg-surface-secondary transition-colors"
                    >
                        打开数据目录
                    </button>
                </div>
                <div className="rounded-lg border border-border bg-surface-primary/60 p-3">
                    <div className="text-[11px] text-text-tertiary mb-2">最近日志预览</div>
                    <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all text-[11px] leading-5 text-text-secondary">
                        {recentDebugLogs.length ? recentDebugLogs.join('\n') : '暂无日志。开启后保存设置并重试相关操作。'}
                    </pre>
                </div>
            </div>
        </section>
    );
}

export const GeneralSettingsSection = memo(GeneralSettingsSectionInner);

type RemoteConnectionSubTab = 'api' | 'channels';
type RemoteChannelId = 'feishu' | 'weixin';
type RemotePlatformLogoId = 'telegram' | 'lark' | 'dingtalk' | 'weixin' | 'wecom' | 'slack' | 'discord';

const REMOTE_PLATFORM_LOGO_PATHS: Record<RemotePlatformLogoId, { path: string; alt: string }> = {
    telegram: { path: 'channel-logos/telegram.svg', alt: 'Telegram' },
    lark: { path: 'channel-logos/lark.svg', alt: 'Lark' },
    dingtalk: { path: 'channel-logos/dingtalk.svg', alt: '钉钉' },
    weixin: { path: 'channel-logos/weixin.svg', alt: '微信' },
    wecom: { path: 'channel-logos/wecom.svg', alt: '企业微信' },
    slack: { path: 'channel-logos/slack.svg', alt: 'Slack' },
    discord: { path: 'channel-logos/discord.svg', alt: 'Discord' },
};

const REMOTE_CHANNEL_TAB_LOGO_IDS: RemotePlatformLogoId[] = [
    'lark',
    'weixin',
];

const resolveRemotePlatformLogo = (id: RemotePlatformLogoId) => {
    const logo = REMOTE_PLATFORM_LOGO_PATHS[id];
    return {
        ...logo,
        src: resolveRuntimeAssetUrl(logo.path),
    };
};

interface RemoteChannelCardProps {
    id: RemoteChannelId;
    title: string;
    description: string;
    enabled: boolean;
    expanded: boolean;
    onToggleExpanded: (id: RemoteChannelId) => void;
    onToggleEnabled?: () => void;
    iconSrc?: string;
    iconAlt?: string;
    iconNode?: ReactNode;
    badgeLabel?: string;
    badgeToneClassName?: string;
    toggleDisabled?: boolean;
    children: ReactNode;
}

type ApiSectionId = 'overview' | 'daemon' | 'listen' | 'status' | 'logs';

interface ApiSectionCardProps {
    title: string;
    eyebrow?: string;
    description: string;
    expanded: boolean;
    onToggle: () => void;
    actions?: ReactNode;
    children?: ReactNode;
}

function ApiSectionCard({
    title,
    eyebrow,
    description,
    expanded,
    onToggle,
    actions,
    children,
}: ApiSectionCardProps) {
    return (
        <section className={clsx(
            'overflow-hidden rounded-[22px] border border-border bg-surface-primary/90 shadow-[0_14px_32px_rgba(15,23,42,0.045)] transition-colors',
            expanded && 'border-accent-primary/30',
        )}>
            <div className="flex items-start gap-3 px-4 py-3.5 sm:px-5">
                <button
                    type="button"
                    onClick={onToggle}
                    className="flex min-w-0 flex-1 items-start gap-3 text-left"
                >
                    <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center text-text-tertiary">
                        <ChevronDown className={clsx('h-4 w-4 transition-transform', expanded ? 'rotate-0' : '-rotate-90')} />
                    </span>
                    <div className="min-w-0 flex-1">
                        {eyebrow && (
                            <div className="text-[10px] font-medium uppercase tracking-[0.18em] text-text-tertiary">{eyebrow}</div>
                        )}
                        <h3 className="mt-1 text-sm font-medium text-text-primary">{title}</h3>
                        <p className="mt-1 text-xs leading-5 text-text-secondary">{description}</p>
                    </div>
                </button>
                {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
            </div>
            {expanded && children && (
                <div className="border-t border-border/70 bg-surface-secondary/10 px-4 py-4 sm:px-5">
                    {children}
                </div>
            )}
        </section>
    );
}

function RemoteChannelCard({
    id,
    title,
    description,
    enabled,
    expanded,
    onToggleExpanded,
    onToggleEnabled,
    iconSrc,
    iconAlt,
    iconNode,
    badgeLabel,
    badgeToneClassName,
    toggleDisabled,
    children,
}: RemoteChannelCardProps) {
    const showToggle = Boolean(onToggleEnabled) || toggleDisabled;
    return (
        <div className={clsx(
            'overflow-hidden rounded-[24px] border border-border bg-surface-primary/80 shadow-[0_18px_40px_rgba(15,23,42,0.06)] transition-colors',
            expanded && 'border-accent-primary/40',
        )}>
            <div className="flex items-center gap-2.5 px-4 py-3 sm:px-5">
                <button
                    type="button"
                    onClick={() => onToggleExpanded(id)}
                    className="flex min-w-0 flex-1 items-center gap-2.5 text-left"
                >
                    <span className="flex h-5 w-5 shrink-0 items-center justify-center text-text-tertiary">
                        <ChevronDown className={clsx('h-4 w-4 transition-transform', expanded ? 'rotate-0' : '-rotate-90')} />
                    </span>
                    <span className="flex h-5 w-5 shrink-0 items-center justify-center">
                        {iconSrc ? (
                            <img src={iconSrc} alt={iconAlt || title} className="h-4.5 w-4.5 object-contain" />
                        ) : iconNode ? (
                            <span className="text-text-secondary">{iconNode}</span>
                        ) : null}
                    </span>
                    <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                            <h3 className="truncate text-sm font-medium text-text-primary">{title}</h3>
                            {badgeLabel && (
                                <span className={clsx(
                                    'inline-flex items-center rounded-full border px-2.5 py-0.5 text-[10px] font-medium',
                                    badgeToneClassName || 'border-border bg-surface-secondary/40 text-text-tertiary',
                                )}>
                                    {badgeLabel}
                                </span>
                            )}
                        </div>
                    </div>
                </button>
                <div className="flex shrink-0 items-center gap-1.5">
                    {showToggle && (
                        <button
                            type="button"
                            onClick={onToggleEnabled}
                            disabled={toggleDisabled || !onToggleEnabled}
                            className="ui-switch-track disabled:cursor-not-allowed disabled:opacity-55"
                            data-size="md"
                            data-state={enabled ? 'on' : 'off'}
                            aria-label={`${title} 开关`}
                            aria-disabled={toggleDisabled || !onToggleEnabled ? true : undefined}
                        >
                            <span className="ui-switch-thumb" />
                        </button>
                    )}
                </div>
            </div>
            {expanded && (
                <div className="border-t border-border/80 bg-surface-secondary/10 px-4 py-3.5 sm:px-5">
                    <p className="mb-3 text-xs leading-5 text-text-secondary">{description}</p>
                    {children}
                </div>
            )}
        </div>
    );
}

function RemoteConnectionSettingsSectionInner({
    assistantDaemonStatus,
    assistantDaemonDraft,
    setAssistantDaemonDraft,
    assistantDaemonLogs,
    assistantDaemonBusy,
    assistantDaemonWeixinLogin,
    assistantDaemonWeixinLoginBusy,
    handleReloadAssistantDaemonStatus,
    handleSaveAssistantDaemonConfig,
    handleStartAssistantDaemon,
    handleStopAssistantDaemon,
    handleStartAssistantDaemonWeixinLogin,
    handleCheckAssistantDaemonWeixinLogin,
    handleClearAssistantDaemonWeixinLogin,
}: RemoteConnectionSettingsSectionProps) {
    const [activeSubTab, setActiveSubTab] = useState<RemoteConnectionSubTab>('channels');
    const [expandedChannelId, setExpandedChannelId] = useState<RemoteChannelId | null>('weixin');
    const [expandedApiSections, setExpandedApiSections] = useState<Record<ApiSectionId, boolean>>({
        overview: true,
        daemon: true,
        listen: true,
        status: true,
        logs: true,
    });
    const assistantDaemonLogText = useMemo(
        () => (assistantDaemonLogs.length ? assistantDaemonLogs.join('\n') : '暂无 daemon 日志。'),
        [assistantDaemonLogs],
    );
    const handleToggleExpandedChannel = (id: RemoteChannelId) => {
        setExpandedChannelId((current) => current === id ? null : id);
    };
    const handleToggleApiSection = (id: ApiSectionId) => {
        setExpandedApiSections((current) => ({ ...current, [id]: !current[id] }));
    };

    return (
        <section className="space-y-6">
            <div className="flex justify-center">
                <div className="inline-flex items-center rounded-full border border-border bg-surface-secondary/40 p-1 shadow-sm">
                    <button
                        type="button"
                        onClick={() => setActiveSubTab('api')}
                        className={clsx(
                            'inline-flex items-center gap-2 rounded-full px-5 py-2 text-xs transition-colors',
                            activeSubTab === 'api'
                                ? 'border border-border bg-surface-primary text-text-primary shadow-sm'
                                : 'text-text-secondary hover:text-text-primary',
                        )}
                    >
                        <Database className="h-4 w-4" />
                        API
                    </button>
                    <button
                        type="button"
                        onClick={() => setActiveSubTab('channels')}
                        className={clsx(
                            'inline-flex items-center gap-2 rounded-full px-4 py-2 text-xs transition-colors',
                            activeSubTab === 'channels'
                                ? 'border border-border bg-surface-primary text-text-primary shadow-sm'
                                : 'text-text-secondary hover:text-text-primary',
                        )}
                    >
                        <MessageSquareText className="h-4 w-4" />
                        <span>频道</span>
                        <span className="hidden items-center gap-1.5 sm:inline-flex">
                            {REMOTE_CHANNEL_TAB_LOGO_IDS.map((logoId) => {
                                const logo = resolveRemotePlatformLogo(logoId);
                                return (
                                    <span
                                        key={logoId}
                                        className="inline-flex h-5 w-5 items-center justify-center rounded-full border border-border/70 bg-surface-primary/80"
                                        title={logo.alt}
                                        aria-label={logo.alt}
                                    >
                                        <img src={logo.src} alt={logo.alt} className="h-3.5 w-3.5 object-contain" />
                                    </span>
                                );
                            })}
                        </span>
                    </button>
                </div>
            </div>

            {activeSubTab === 'api' ? (
                <div className="space-y-4">
                    <ApiSectionCard
                        title="远程 API 与后台值守"
                        eyebrow="概览"
                        description="管理本地监听地址、后台常驻与第三方接入方式。"
                        expanded={expandedApiSections.overview}
                        onToggle={() => handleToggleApiSection('overview')}
                        actions={(
                            <>
                                <button
                                    type="button"
                                    onClick={() => void handleReloadAssistantDaemonStatus()}
                                    className="inline-flex items-center gap-1.5 rounded-full border border-border bg-surface-primary/80 px-3 py-1.5 text-[11px] font-medium text-text-secondary transition-colors hover:bg-surface-secondary"
                                >
                                    <RefreshCw className="h-3 w-3" />
                                    刷新
                                </button>
                                <button
                                    type="button"
                                    onClick={() => void handleSaveAssistantDaemonConfig()}
                                    disabled={assistantDaemonBusy}
                                    className="inline-flex items-center gap-1.5 rounded-full bg-accent-primary px-3 py-1.5 text-[11px] font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
                                >
                                    <Save className="h-3 w-3" />
                                    保存
                                </button>
                            </>
                        )}
                    >
                        <div className="flex flex-wrap gap-2">
                            <span className={clsx(
                                'inline-flex items-center rounded-full border px-2.5 py-1 text-[10px] font-medium',
                                assistantDaemonDraft.enabled
                                    ? 'border-sky-300/70 bg-sky-500/10 text-sky-700'
                                    : 'border-border bg-surface-secondary/60 text-text-tertiary',
                            )}>
                                后台值守 {assistantDaemonDraft.enabled ? '已开启' : '已关闭'}
                            </span>
                            <span className="inline-flex items-center rounded-full border border-border bg-surface-secondary/50 px-2.5 py-1 text-[10px] font-medium text-text-secondary">
                                监听 {String(assistantDaemonDraft.host || '').trim() || '127.0.0.1'}:{String(assistantDaemonDraft.port || '').trim() || '31937'}
                            </span>
                        </div>
                    </ApiSectionCard>

                    <ApiSectionCard
                        title="后台值守"
                        eyebrow="Step 1"
                        description="控制后台进程常驻、任务处理与远程入口的长期运行方式。"
                        expanded={expandedApiSections.daemon}
                        onToggle={() => handleToggleApiSection('daemon')}
                        actions={(
                            <button
                                type="button"
                                onClick={() => setAssistantDaemonDraft((prev) => ({ ...prev, enabled: !prev.enabled }))}
                                className="ui-switch-track"
                                data-size="md"
                                data-state={assistantDaemonDraft.enabled ? 'on' : 'off'}
                                aria-label="后台值守开关"
                            >
                                <span className="ui-switch-thumb" />
                            </button>
                        )}
                    >
                        <div className="space-y-2.5">
                            <div className="flex items-center justify-between rounded-[16px] border border-border bg-surface-secondary/20 px-3.5 py-3">
                                <div>
                                    <div className="text-sm font-medium text-text-primary">开机自动启用</div>
                                    <div className="mt-1 text-[11px] text-text-tertiary">适合长期运行的本机环境。</div>
                                </div>
                                <button
                                    type="button"
                                    onClick={() => setAssistantDaemonDraft((prev) => ({ ...prev, autoStart: !prev.autoStart }))}
                                    className="ui-switch-track"
                                    data-size="md"
                                    data-state={assistantDaemonDraft.autoStart ? 'on' : 'off'}
                                >
                                    <span className="ui-switch-thumb" />
                                </button>
                            </div>
                            <div className="flex items-center justify-between rounded-[16px] border border-border bg-surface-secondary/20 px-3.5 py-3">
                                <div>
                                    <div className="text-sm font-medium text-text-primary">关闭窗口后继续后台运行</div>
                                    <div className="mt-1 text-[11px] text-text-tertiary">适合扫码接入和常驻消息处理。</div>
                                </div>
                                <button
                                    type="button"
                                    onClick={() => setAssistantDaemonDraft((prev) => ({ ...prev, keepAliveWhenNoWindow: !prev.keepAliveWhenNoWindow }))}
                                    className="ui-switch-track"
                                    data-size="md"
                                    data-state={assistantDaemonDraft.keepAliveWhenNoWindow ? 'on' : 'off'}
                                >
                                    <span className="ui-switch-thumb" />
                                </button>
                            </div>
                        </div>

                        <div className="mt-4 flex flex-wrap items-center gap-2">
                            {assistantDaemonStatus?.enabled ? (
                                <button
                                    type="button"
                                    onClick={() => void handleStopAssistantDaemon()}
                                    disabled={assistantDaemonBusy}
                                    className="rounded-full border border-red-300 px-3.5 py-1.5 text-[11px] font-medium text-red-600 transition-colors hover:bg-red-50 disabled:opacity-50"
                                >
                                    停止值守
                                </button>
                            ) : (
                                <button
                                    type="button"
                                    onClick={() => void handleStartAssistantDaemon()}
                                    disabled={assistantDaemonBusy}
                                    className="rounded-full bg-accent-primary px-3.5 py-1.5 text-[11px] font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
                                >
                                    启动值守
                                </button>
                            )}
                        </div>
                    </ApiSectionCard>

                    <ApiSectionCard
                        title="监听配置"
                        eyebrow="Step 3"
                        description="API、Webhook 和频道接入都复用这组监听地址。"
                        expanded={expandedApiSections.listen}
                        onToggle={() => handleToggleApiSection('listen')}
                    >
                        <div className="space-y-3">
                            <div>
                                <label className="mb-1.5 block text-xs font-medium text-text-secondary">监听地址</label>
                                <input
                                    type="text"
                                    value={assistantDaemonDraft.host}
                                    onChange={(e) => setAssistantDaemonDraft((prev) => ({ ...prev, host: e.target.value }))}
                                    className="w-full rounded border border-border bg-surface-secondary/30 px-3 py-2 text-sm focus:border-accent-primary focus:outline-none"
                                />
                            </div>
                            <div>
                                <label className="mb-1.5 block text-xs font-medium text-text-secondary">监听端口</label>
                                <input
                                    type="number"
                                    value={assistantDaemonDraft.port}
                                    onChange={(e) => setAssistantDaemonDraft((prev) => ({ ...prev, port: e.target.value }))}
                                    className="w-full rounded border border-border bg-surface-secondary/30 px-3 py-2 text-sm focus:border-accent-primary focus:outline-none"
                                />
                            </div>
                        </div>
                    </ApiSectionCard>

                    <ApiSectionCard
                        title="运行状态"
                        eyebrow="Step 4"
                        description="观察当前值守实例、监听状态和任务负载。"
                        expanded={expandedApiSections.status}
                        onToggle={() => handleToggleApiSection('status')}
                    >
                        <div className="flex flex-wrap gap-2.5">
                            <div className="min-w-[200px] flex-1 rounded-[16px] border border-border bg-surface-secondary/20 p-3.5">
                                <div className="text-[10px] uppercase tracking-[0.16em] text-text-tertiary">入口地址</div>
                                <div className="mt-1.5 break-all text-sm font-medium text-text-primary">
                                    {String(assistantDaemonDraft.host || '').trim() || '127.0.0.1'}:{String(assistantDaemonDraft.port || '').trim() || '31937'}
                                </div>
                                <p className="mt-1 text-[11px] text-text-tertiary">
                                    {assistantDaemonStatus?.listening ? '监听中' : '未监听'}
                                </p>
                            </div>
                            <div className="min-w-[200px] flex-1 rounded-[16px] border border-border bg-surface-secondary/20 p-3.5">
                                <div className="text-[10px] uppercase tracking-[0.16em] text-text-tertiary">任务负载</div>
                                <div className="mt-1.5 text-sm font-medium text-text-primary">
                                    {assistantDaemonStatus?.activeTaskCount ?? 0} 处理中 / {assistantDaemonStatus?.queuedPeerCount ?? 0} 排队
                                </div>
                                <p className="mt-1 text-[11px] text-text-tertiary">当前任务状态。</p>
                            </div>
                        </div>

                        {assistantDaemonStatus?.blockedBy && (
                            <div className="mt-3 rounded-[16px] border border-amber-300 bg-amber-500/10 px-3.5 py-3 text-[11px] text-amber-700">
                                当前实例未持有后台锁：{assistantDaemonStatus.blockedBy}
                            </div>
                        )}
                        {assistantDaemonStatus?.lastError && (
                            <div className="mt-3 rounded-[16px] border border-red-300 bg-red-500/10 px-3.5 py-3 text-[11px] text-red-600">
                                最近错误：{assistantDaemonStatus.lastError}
                            </div>
                        )}
                    </ApiSectionCard>

                    <ApiSectionCard
                        title="最近 daemon 日志"
                        eyebrow="Step 5"
                        description="只保留最近的后台日志，便于快速定位远程连接问题。"
                        expanded={expandedApiSections.logs}
                        onToggle={() => handleToggleApiSection('logs')}
                    >
                        <pre className="max-h-52 overflow-auto whitespace-pre-wrap break-all rounded-[16px] border border-border bg-surface-secondary/25 p-3 text-[11px] leading-5 text-text-secondary">
                            {assistantDaemonLogText}
                        </pre>
                    </ApiSectionCard>
                </div>
            ) : (
                <div className="space-y-4">
                    <div className="px-1 pb-2 pt-1">
                        <h3 className="text-[28px] font-medium tracking-[0.01em] text-text-primary">渠道配置</h3>
                        <p className="mt-8 text-lg leading-8 text-text-secondary">
                            连接飞书、微信等渠道。
                        </p>
                        <div className="mt-6 flex flex-col gap-3 text-sm text-text-secondary md:flex-row md:flex-wrap md:items-center md:gap-6">
                            <div className="flex items-center gap-3">
                                <span className="inline-flex h-8 min-w-8 items-center justify-center rounded-full bg-surface-secondary px-2 text-sm font-semibold text-text-primary">1</span>
                                <span>选择一个渠道并完成凭据配置。</span>
                            </div>
                            <div className="flex items-center gap-3">
                                <span className="inline-flex h-8 min-w-8 items-center justify-center rounded-full bg-surface-secondary px-2 text-sm font-semibold text-text-primary">2</span>
                                <span>启用该渠道后，即可开始收发远程消息。</span>
                            </div>
                        </div>
                    </div>

                    <RemoteChannelCard
                        id="feishu"
                        title="飞书"
                        description="配置飞书接入参数。"
                        enabled={assistantDaemonDraft.feishu.enabled}
                        expanded={expandedChannelId === 'feishu'}
                        onToggleExpanded={handleToggleExpandedChannel}
                        onToggleEnabled={() => setAssistantDaemonDraft((prev) => ({ ...prev, feishu: { ...prev.feishu, enabled: !prev.feishu.enabled } }))}
                        iconSrc={resolveRemotePlatformLogo('lark').src}
                        iconAlt="飞书"
                    >
                        <div className="space-y-4">
                            <div className="rounded-2xl border border-border bg-surface-primary/70 p-4 text-xs leading-6 text-text-secondary">
                                {assistantDaemonDraft.feishu.receiveMode === 'websocket'
                                    ? assistantDaemonStatus?.feishu?.websocketRunning
                                        ? '长连接已建立。'
                                        : `等待建立长连接${assistantDaemonStatus?.feishu?.websocketReconnectAt ? `；下次重连 ${new Date(assistantDaemonStatus.feishu.websocketReconnectAt).toLocaleString()}` : '。'}`
                                    : `当前 Webhook 地址：${assistantDaemonStatus?.feishu?.webhookUrl || '未生成'}`}
                            </div>
                            <div className="grid gap-4 md:grid-cols-2">
                                <div>
                                    <label className="mb-1.5 block text-xs font-medium text-text-secondary">接收模式</label>
                                    <select
                                        value={assistantDaemonDraft.feishu.receiveMode}
                                        onChange={(e) => setAssistantDaemonDraft((prev) => ({ ...prev, feishu: { ...prev.feishu, receiveMode: e.target.value as 'webhook' | 'websocket' } }))}
                                        className="w-full rounded border border-border bg-surface-secondary/30 px-3 py-2 text-sm focus:border-accent-primary focus:outline-none"
                                    >
                                        <option value="webhook">Webhook</option>
                                        <option value="websocket">官方长连接</option>
                                    </select>
                                </div>
                                <div>
                                    <label className="mb-1.5 block text-xs font-medium text-text-secondary">事件路径</label>
                                    <input
                                        type="text"
                                        value={assistantDaemonDraft.feishu.endpointPath}
                                        onChange={(e) => setAssistantDaemonDraft((prev) => ({ ...prev, feishu: { ...prev.feishu, endpointPath: e.target.value } }))}
                                        className="w-full rounded border border-border bg-surface-secondary/30 px-3 py-2 text-sm focus:border-accent-primary focus:outline-none"
                                    />
                                </div>
                                <div>
                                    <label className="mb-1.5 block text-xs font-medium text-text-secondary">App ID</label>
                                    <input
                                        type="text"
                                        value={assistantDaemonDraft.feishu.appId}
                                        onChange={(e) => setAssistantDaemonDraft((prev) => ({ ...prev, feishu: { ...prev.feishu, appId: e.target.value } }))}
                                        className="w-full rounded border border-border bg-surface-secondary/30 px-3 py-2 text-sm focus:border-accent-primary focus:outline-none"
                                    />
                                </div>
                                <div>
                                    <label className="mb-1.5 block text-xs font-medium text-text-secondary">App Secret</label>
                                    <PasswordInput
                                        value={assistantDaemonDraft.feishu.appSecret}
                                        onChange={(e) => setAssistantDaemonDraft((prev) => ({ ...prev, feishu: { ...prev.feishu, appSecret: e.target.value } }))}
                                        className="w-full rounded border border-border bg-surface-secondary/30 px-3 py-2 text-sm focus:border-accent-primary focus:outline-none"
                                    />
                                </div>
                                <div>
                                    <label className="mb-1.5 block text-xs font-medium text-text-secondary">Verification Token</label>
                                    <PasswordInput
                                        value={assistantDaemonDraft.feishu.verificationToken}
                                        onChange={(e) => setAssistantDaemonDraft((prev) => ({ ...prev, feishu: { ...prev.feishu, verificationToken: e.target.value } }))}
                                        className="w-full rounded border border-border bg-surface-secondary/30 px-3 py-2 text-sm focus:border-accent-primary focus:outline-none"
                                    />
                                </div>
                                <div>
                                    <label className="mb-1.5 block text-xs font-medium text-text-secondary">Encrypt Key</label>
                                    <PasswordInput
                                        value={assistantDaemonDraft.feishu.encryptKey}
                                        onChange={(e) => setAssistantDaemonDraft((prev) => ({ ...prev, feishu: { ...prev.feishu, encryptKey: e.target.value } }))}
                                        className="w-full rounded border border-border bg-surface-secondary/30 px-3 py-2 text-sm focus:border-accent-primary focus:outline-none"
                                    />
                                </div>
                            </div>
                            <label className="flex items-center gap-2 text-xs text-text-secondary">
                                <input
                                    type="checkbox"
                                    checked={assistantDaemonDraft.feishu.replyUsingChatId}
                                    onChange={(e) => setAssistantDaemonDraft((prev) => ({ ...prev, feishu: { ...prev.feishu, replyUsingChatId: e.target.checked } }))}
                                    className="rounded border-border"
                                />
                                优先按 chat_id 回复
                            </label>
                        </div>
                    </RemoteChannelCard>

                    <RemoteChannelCard
                        id="weixin"
                        title="微信 sidecar"
                        description="扫码登录并配置微信接入。"
                        enabled={assistantDaemonDraft.weixin.enabled}
                        expanded={expandedChannelId === 'weixin'}
                        onToggleExpanded={handleToggleExpandedChannel}
                        onToggleEnabled={() => setAssistantDaemonDraft((prev) => ({ ...prev, weixin: { ...prev.weixin, enabled: !prev.weixin.enabled } }))}
                        iconSrc={resolveRemotePlatformLogo('weixin').src}
                        iconAlt="微信"
                    >
                        <div className="space-y-4">
                            <div className="flex flex-wrap items-center gap-2">
                                <button
                                    type="button"
                                    onClick={() => void handleStartAssistantDaemonWeixinLogin()}
                                    disabled={assistantDaemonWeixinLoginBusy}
                                    className="rounded-full border border-border px-3 py-1.5 text-xs font-medium transition-colors hover:bg-surface-secondary disabled:opacity-50"
                                >
                                    开始扫码
                                </button>
                                <button
                                    type="button"
                                    onClick={() => void handleCheckAssistantDaemonWeixinLogin()}
                                    disabled={assistantDaemonWeixinLoginBusy || !assistantDaemonWeixinLogin?.sessionKey}
                                    className="rounded-full border border-border px-3 py-1.5 text-xs font-medium transition-colors hover:bg-surface-secondary disabled:opacity-50"
                                >
                                    检查登录结果
                                </button>
                                {assistantDaemonWeixinLogin && (
                                    <button
                                        type="button"
                                        onClick={handleClearAssistantDaemonWeixinLogin}
                                        className="rounded-full border border-border px-3 py-1.5 text-xs font-medium transition-colors hover:bg-surface-secondary"
                                    >
                                        清空二维码
                                    </button>
                                )}
                            </div>

                            {assistantDaemonWeixinLogin?.message && (
                                <p className="text-xs text-text-tertiary">{assistantDaemonWeixinLogin.message}</p>
                            )}

                            {!assistantDaemonWeixinLogin?.qrcodeUrl && (
                                <p className="text-[11px] leading-5 text-text-tertiary">
                                    如果这里直接报 `fetch failed`，通常不是扫码逻辑本身有问题，而是当前机器访问 `https://ilinkai.weixin.qq.com` 失败。先在“常规设置”里配好全局代理，再保存设置后重试。
                                </p>
                            )}

                            {assistantDaemonWeixinLogin?.qrcodeUrl && (
                                <div className="flex flex-col gap-3 rounded-2xl border border-border bg-surface-secondary/20 p-4 md:flex-row md:items-center">
                                    <img
                                        src={assistantDaemonWeixinLogin.qrcodeImageUrl || assistantDaemonWeixinLogin.qrcodeUrl}
                                        alt="微信登录二维码"
                                        className="h-40 w-40 rounded-xl border border-border bg-surface-primary/70 object-contain p-2"
                                    />
                                    <div className="space-y-2 text-xs text-text-tertiary">
                                        <div>使用微信扫码完成设备登录。</div>
                                        <div className="break-all">{assistantDaemonWeixinLogin.qrcodeUrl}</div>
                                    </div>
                                </div>
                            )}

                            <label className="flex items-center gap-2 text-xs text-text-secondary">
                                <input
                                    type="checkbox"
                                    checked={assistantDaemonDraft.weixin.autoStartSidecar}
                                    onChange={(e) => setAssistantDaemonDraft((prev) => ({ ...prev, weixin: { ...prev.weixin, autoStartSidecar: e.target.checked } }))}
                                    className="rounded border-border"
                                />
                                daemon 启动时自动拉起微信 sidecar
                            </label>

                            <div className="grid gap-3 md:grid-cols-2">
                                <div className="rounded-2xl border border-border bg-surface-secondary/20 p-4 text-xs text-text-tertiary">
                                    当前登录：{assistantDaemonStatus?.weixin?.connected ? '已连接' : '未连接'}
                                    {assistantDaemonStatus?.weixin?.accountId ? ` / ${assistantDaemonStatus.weixin.accountId}` : ''}
                                    {assistantDaemonStatus?.weixin?.userId ? ` / 用户 ${assistantDaemonStatus.weixin.userId}` : ''}
                                </div>
                                <div className="rounded-2xl border border-border bg-surface-secondary/20 p-4 text-xs text-text-tertiary">
                                    状态目录：
                                    <code className="ml-1 rounded bg-surface-secondary px-1.5 py-0.5">
                                        {assistantDaemonStatus?.weixin?.stateDir || '未初始化'}
                                    </code>
                                </div>
                            </div>

                            {!!assistantDaemonStatus?.weixin?.availableAccountIds?.length && (
                                <div className="text-[11px] text-text-tertiary">
                                    已保存账号：{assistantDaemonStatus.weixin?.availableAccountIds?.join(', ')}
                                </div>
                            )}

                            <details className="rounded-2xl border border-border bg-surface-primary/70 p-4">
                                <summary className="cursor-pointer list-none text-xs font-medium text-text-secondary">微信高级设置</summary>
                                <div className="mt-4 grid gap-4 md:grid-cols-2">
                                    <div>
                                        <label className="mb-1.5 block text-xs font-medium text-text-secondary">Relay 路径</label>
                                        <input
                                            type="text"
                                            value={assistantDaemonDraft.weixin.endpointPath}
                                            onChange={(e) => setAssistantDaemonDraft((prev) => ({ ...prev, weixin: { ...prev.weixin, endpointPath: e.target.value } }))}
                                            className="w-full rounded border border-border bg-surface-secondary/30 px-3 py-2 text-sm focus:border-accent-primary focus:outline-none"
                                        />
                                    </div>
                                    <div>
                                        <label className="mb-1.5 block text-xs font-medium text-text-secondary">Relay Token</label>
                                        <PasswordInput
                                            value={assistantDaemonDraft.weixin.authToken}
                                            onChange={(e) => setAssistantDaemonDraft((prev) => ({ ...prev, weixin: { ...prev.weixin, authToken: e.target.value } }))}
                                            className="w-full rounded border border-border bg-surface-secondary/30 px-3 py-2 text-sm focus:border-accent-primary focus:outline-none"
                                        />
                                    </div>
                                    <div>
                                        <label className="mb-1.5 block text-xs font-medium text-text-secondary">微信账号 ID</label>
                                        <input
                                            type="text"
                                            value={assistantDaemonDraft.weixin.accountId}
                                            onChange={(e) => setAssistantDaemonDraft((prev) => ({ ...prev, weixin: { ...prev.weixin, accountId: e.target.value } }))}
                                            placeholder="可手动填写"
                                            className="w-full rounded border border-border bg-surface-secondary/30 px-3 py-2 text-sm focus:border-accent-primary focus:outline-none"
                                        />
                                    </div>
                                    <div>
                                        <label className="mb-1.5 block text-xs font-medium text-text-secondary">Cursor 文件</label>
                                        <input
                                            type="text"
                                            value={assistantDaemonDraft.weixin.cursorFile}
                                            onChange={(e) => setAssistantDaemonDraft((prev) => ({ ...prev, weixin: { ...prev.weixin, cursorFile: e.target.value } }))}
                                            placeholder="留空使用 redclaw/weixin-sidecar.cursor.json"
                                            className="w-full rounded border border-border bg-surface-secondary/30 px-3 py-2 text-sm focus:border-accent-primary focus:outline-none"
                                        />
                                    </div>
                                    <div>
                                        <label className="mb-1.5 block text-xs font-medium text-text-secondary">启动命令</label>
                                        <input
                                            type="text"
                                            value={assistantDaemonDraft.weixin.sidecarCommand}
                                            onChange={(e) => setAssistantDaemonDraft((prev) => ({ ...prev, weixin: { ...prev.weixin, sidecarCommand: e.target.value } }))}
                                            placeholder="留空使用当前 Electron 运行时"
                                            className="w-full rounded border border-border bg-surface-secondary/30 px-3 py-2 text-sm focus:border-accent-primary focus:outline-none"
                                        />
                                    </div>
                                    <div>
                                        <label className="mb-1.5 block text-xs font-medium text-text-secondary">启动参数</label>
                                        <input
                                            type="text"
                                            value={assistantDaemonDraft.weixin.sidecarArgs}
                                            onChange={(e) => setAssistantDaemonDraft((prev) => ({ ...prev, weixin: { ...prev.weixin, sidecarArgs: e.target.value } }))}
                                            placeholder="留空使用内置 bootstrap"
                                            className="w-full rounded border border-border bg-surface-secondary/30 px-3 py-2 text-sm focus:border-accent-primary focus:outline-none"
                                        />
                                    </div>
                                    <div>
                                        <label className="mb-1.5 block text-xs font-medium text-text-secondary">工作目录</label>
                                        <input
                                            type="text"
                                            value={assistantDaemonDraft.weixin.sidecarCwd}
                                            onChange={(e) => setAssistantDaemonDraft((prev) => ({ ...prev, weixin: { ...prev.weixin, sidecarCwd: e.target.value } }))}
                                            className="w-full rounded border border-border bg-surface-secondary/30 px-3 py-2 text-sm focus:border-accent-primary focus:outline-none"
                                        />
                                    </div>
                                    <div className="md:col-span-2">
                                        <label className="mb-1.5 block text-xs font-medium text-text-secondary">sidecar 环境变量（JSON）</label>
                                        <textarea
                                            value={assistantDaemonDraft.weixin.sidecarEnvText}
                                            onChange={(e) => setAssistantDaemonDraft((prev) => ({ ...prev, weixin: { ...prev.weixin, sidecarEnvText: e.target.value } }))}
                                            rows={4}
                                            placeholder='{"HTTP_PROXY":"http://127.0.0.1:7890"}'
                                            className="w-full rounded border border-border bg-surface-secondary/30 px-3 py-2 text-xs font-mono focus:border-accent-primary focus:outline-none"
                                        />
                                    </div>
                                </div>
                            </details>

                        </div>
                    </RemoteChannelCard>
                </div>
            )}
        </section>
    );
}

export const RemoteConnectionSettingsSection = memo(RemoteConnectionSettingsSectionInner);

interface MemorySettingsSectionProps {
    newMemoryType: UserMemory['type'];
    setNewMemoryType: Dispatch<SetStateAction<UserMemory['type']>>;
    newMemoryContent: string;
    setNewMemoryContent: Dispatch<SetStateAction<string>>;
    handleAddMemory: () => Promise<void>;
    isMemoryLoading: boolean;
    memories: UserMemory[];
    archivedMemories: UserMemory[];
    memoryHistory: MemoryHistoryEntry[];
    maintenanceStatus: MemoryMaintenanceStatus | null;
    onRunMaintenance: () => Promise<void>;
    memorySearchQuery: string;
    setMemorySearchQuery: Dispatch<SetStateAction<string>>;
    includeArchivedInSearch: boolean;
    setIncludeArchivedInSearch: Dispatch<SetStateAction<boolean>>;
    memorySearchResults: MemorySearchResult[];
    isMemorySearching: boolean;
    onSearchMemories: () => Promise<void>;
    handleDeleteMemory: (id: string) => void;
}

const memoryTypeTone = (type: UserMemory['type']) => (
    type === 'preference' ? 'bg-purple-500/10 text-purple-500'
        : type === 'fact' ? 'bg-blue-500/10 text-blue-500'
            : 'bg-gray-500/10 text-text-tertiary'
);

const memoryTypeLabel = (type: UserMemory['type']) => (
    type === 'preference' ? '偏好' : type === 'fact' ? '事实' : '一般'
);

const historyActionLabel = (action: MemoryHistoryEntry['action']) => {
    switch (action) {
        case 'create': return '创建';
        case 'update': return '更新';
        case 'dedupe': return '去重合并';
        case 'archive': return '归档';
        case 'delete': return '删除';
        case 'access': return '访问';
        default: return action;
    }
};

export function MemorySettingsSection({
    newMemoryType,
    setNewMemoryType,
    newMemoryContent,
    setNewMemoryContent,
    handleAddMemory,
    isMemoryLoading,
    memories,
    archivedMemories,
    memoryHistory,
    maintenanceStatus,
    onRunMaintenance,
    memorySearchQuery,
    setMemorySearchQuery,
    includeArchivedInSearch,
    setIncludeArchivedInSearch,
    memorySearchResults,
    isMemorySearching,
    onSearchMemories,
    handleDeleteMemory,
}: MemorySettingsSectionProps) {
    return (
        <section className="space-y-6">
            <div>
                <h2 className="text-lg font-medium text-text-primary mb-2">用户记忆管理</h2>
                <p className="text-xs text-text-tertiary">
                    AI 会自动从对话中提取并保存关于您的偏好和重要信息。您可以在此手动管理这些记忆。
                </p>
            </div>

            <div className="bg-surface-secondary/30 rounded-lg border border-border p-4">
                <div className="flex gap-2">
                    <select
                        value={newMemoryType}
                        onChange={(e) => setNewMemoryType(e.target.value as UserMemory['type'])}
                        className="bg-surface-secondary/50 border border-border rounded px-2 py-1.5 text-xs focus:outline-none focus:border-accent-primary"
                    >
                        <option value="general">一般</option>
                        <option value="preference">偏好</option>
                        <option value="fact">事实</option>
                    </select>
                    <input
                        type="text"
                        value={newMemoryContent}
                        onChange={(e) => setNewMemoryContent(e.target.value)}
                        onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                                e.preventDefault();
                                void handleAddMemory();
                            }
                        }}
                        placeholder="添加一条新记忆，例如：'我喜欢简洁的代码风格'..."
                        className="flex-1 bg-surface-secondary/50 border border-border rounded px-3 py-1.5 text-xs focus:outline-none focus:border-accent-primary"
                    />
                    <button
                        type="button"
                        onClick={() => void handleAddMemory()}
                        disabled={!newMemoryContent.trim()}
                        className="px-4 py-1.5 bg-accent-primary text-white text-xs font-medium rounded hover:opacity-90 disabled:opacity-50"
                    >
                        添加
                    </button>
                </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <div className="bg-surface-secondary/20 rounded-lg border border-border p-4">
                    <div className="text-[11px] text-text-tertiary mb-1">当前有效记忆</div>
                    <div className="text-2xl font-semibold text-text-primary">{memories.length}</div>
                </div>
                <div className="bg-surface-secondary/20 rounded-lg border border-border p-4">
                    <div className="text-[11px] text-text-tertiary mb-1">归档版本</div>
                    <div className="text-2xl font-semibold text-text-primary">{archivedMemories.length}</div>
                </div>
                <div className="bg-surface-secondary/20 rounded-lg border border-border p-4">
                    <div className="text-[11px] text-text-tertiary mb-1">历史事件</div>
                    <div className="text-2xl font-semibold text-text-primary">{memoryHistory.length}</div>
                </div>
            </div>

            <div className="bg-surface-secondary/20 rounded-lg border border-border p-4 space-y-3">
                <div className="flex items-center justify-between gap-3">
                    <div>
                        <h3 className="text-sm font-medium text-text-primary">后台记忆整理器</h3>
                        <p className="text-[11px] text-text-tertiary mt-1">
                            独立于对话循环之外，周期性使用 LLM 整理、去重、归档和更新长期记忆。
                        </p>
                    </div>
                    <button
                        type="button"
                        onClick={() => void onRunMaintenance()}
                        className="inline-flex items-center gap-2 px-3 py-1.5 border border-border rounded text-xs font-medium text-text-primary hover:bg-surface-secondary"
                    >
                        <RefreshCw className={clsx('w-3.5 h-3.5', maintenanceStatus?.running && 'animate-spin')} />
                        立即整理
                    </button>
                </div>
                <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
                    <div className="bg-surface-primary/60 rounded border border-border p-3">
                        <div className="text-[10px] text-text-tertiary mb-1">状态</div>
                        <div className="text-sm font-medium text-text-primary">
                            {maintenanceStatus?.running
                                ? '整理中'
                                : maintenanceStatus?.lockState === 'owner'
                                    ? '主实例待命'
                                    : maintenanceStatus?.started
                                        ? '被动等待'
                                        : '未启动'}
                        </div>
                    </div>
                    <div className="bg-surface-primary/60 rounded border border-border p-3">
                        <div className="text-[10px] text-text-tertiary mb-1">待处理变更</div>
                        <div className="text-sm font-medium text-text-primary">{maintenanceStatus?.pendingMutations ?? 0}</div>
                    </div>
                    <div className="bg-surface-primary/60 rounded border border-border p-3">
                        <div className="text-[10px] text-text-tertiary mb-1">上次执行</div>
                        <div className="text-xs text-text-primary">
                            {maintenanceStatus?.lastRunAt ? new Date(maintenanceStatus.lastRunAt).toLocaleString() : '暂无'}
                        </div>
                    </div>
                    <div className="bg-surface-primary/60 rounded border border-border p-3">
                        <div className="text-[10px] text-text-tertiary mb-1">下次计划</div>
                        <div className="text-xs text-text-primary">
                            {maintenanceStatus?.nextScheduledAt ? new Date(maintenanceStatus.nextScheduledAt).toLocaleString() : '按需触发'}
                        </div>
                    </div>
                </div>
                {(maintenanceStatus?.blockedBy || maintenanceStatus?.lastScanAt) && (
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                        <div className="bg-surface-primary/60 rounded border border-border p-3">
                            <div className="text-[10px] text-text-tertiary mb-1">锁状态</div>
                            <div className="text-xs text-text-primary">
                                {maintenanceStatus?.lockState === 'owner'
                                    ? '当前实例持有整理锁'
                                    : maintenanceStatus?.blockedBy
                                        ? `被 ${maintenanceStatus.blockedBy} 持有`
                                        : '未持有整理锁'}
                            </div>
                        </div>
                        <div className="bg-surface-primary/60 rounded border border-border p-3">
                            <div className="text-[10px] text-text-tertiary mb-1">最近扫描</div>
                            <div className="text-xs text-text-primary">
                                {maintenanceStatus?.lastScanAt ? new Date(maintenanceStatus.lastScanAt).toLocaleString() : '暂无'}
                            </div>
                        </div>
                    </div>
                )}
                {maintenanceStatus?.lastSummary && (
                    <div className="text-xs text-text-secondary">
                        最近摘要：{maintenanceStatus.lastSummary}
                    </div>
                )}
                {maintenanceStatus?.lastError && (
                    <div className="text-xs text-red-500 bg-red-500/5 border border-red-200 rounded p-3">
                        最近错误：{maintenanceStatus.lastError}
                    </div>
                )}
            </div>

            <div className="bg-surface-secondary/20 rounded-lg border border-border p-4 space-y-3">
                <div className="flex items-center justify-between gap-3">
                    <div>
                        <h3 className="text-sm font-medium text-text-primary">记忆搜索</h3>
                        <p className="text-[11px] text-text-tertiary mt-1">
                            文档型检索，不使用向量。按内容、标签、类型和新近度综合排序。
                        </p>
                    </div>
                    <label className="flex items-center gap-2 text-xs text-text-secondary">
                        <input
                            type="checkbox"
                            checked={includeArchivedInSearch}
                            onChange={(e) => setIncludeArchivedInSearch(e.target.checked)}
                            className="rounded border-border"
                        />
                        包含归档
                    </label>
                </div>
                <div className="flex gap-2">
                    <div className="flex-1 relative">
                        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-text-tertiary" />
                        <input
                            type="text"
                            value={memorySearchQuery}
                            onChange={(e) => setMemorySearchQuery(e.target.value)}
                            onKeyDown={(e) => {
                                if (e.key === 'Enter') {
                                    e.preventDefault();
                                    void onSearchMemories();
                                }
                            }}
                            placeholder="搜索记忆，例如：redclaw、用户偏好、封面..."
                            className="w-full bg-surface-primary/60 border border-border rounded pl-10 pr-3 py-2 text-sm focus:outline-none focus:border-accent-primary"
                        />
                    </div>
                    <button
                        type="button"
                        onClick={() => void onSearchMemories()}
                        disabled={!memorySearchQuery.trim()}
                        className="px-4 py-2 border border-border rounded text-xs font-medium text-text-primary hover:bg-surface-secondary disabled:opacity-50"
                    >
                        搜索
                    </button>
                </div>
                {!memorySearchQuery.trim() ? (
                    <div className="text-[11px] text-text-tertiary">输入关键词后执行检索。</div>
                ) : isMemorySearching ? (
                    <div className="text-[11px] text-text-tertiary">搜索中...</div>
                ) : memorySearchResults.length === 0 ? (
                    <div className="text-[11px] text-text-tertiary">没有命中结果。</div>
                ) : (
                    <div className="space-y-2">
                        {memorySearchResults.slice(0, 12).map((memory) => (
                            <div key={memory.id} className="p-3 bg-surface-primary/60 border border-border rounded-lg">
                                <div className="flex items-center gap-2 flex-wrap mb-1">
                                    <span className={clsx('px-1.5 py-0.5 rounded text-[10px] font-medium uppercase tracking-wider', memoryTypeTone(memory.type))}>
                                        {memoryTypeLabel(memory.type)}
                                    </span>
                                    {memory.status === 'archived' && (
                                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-orange-500/10 text-orange-600">已归档</span>
                                    )}
                                    <span className="text-[10px] text-text-tertiary">score {memory.score}</span>
                                    {(memory.matchReasons || []).length > 0 && (
                                        <span className="text-[10px] text-text-tertiary">{memory.matchReasons.join(' · ')}</span>
                                    )}
                                </div>
                                <div className="text-sm text-text-secondary">{memory.content}</div>
                            </div>
                        ))}
                    </div>
                )}
            </div>

            <div className="space-y-2">
                <div className="flex items-center justify-between">
                    <h3 className="text-sm font-medium text-text-primary">当前有效记忆</h3>
                    <span className="text-[11px] text-text-tertiary">只展示当前生效版本</span>
                </div>
                {isMemoryLoading ? (
                    <div className="text-center py-8 text-text-tertiary text-xs">加载中...</div>
                ) : memories.length === 0 ? (
                    <div className="text-center py-8 text-text-tertiary text-xs border border-dashed border-border rounded-lg">
                        暂无记忆数据。AI 会在聊天中自动学习，或者您可以手动添加。
                    </div>
                ) : (
                    memories.map((memory) => (
                        <div key={memory.id} className="group flex items-start justify-between p-3 bg-surface-secondary/20 border border-border rounded-lg hover:border-accent-primary/30 transition-colors">
                            <div className="flex-1">
                                <div className="flex items-center gap-2 mb-1">
                                    <span className={clsx(
                                        'px-1.5 py-0.5 rounded text-[10px] font-medium uppercase tracking-wider',
                                        memoryTypeTone(memory.type)
                                    )}>
                                        {memoryTypeLabel(memory.type)}
                                    </span>
                                    <span className="text-[10px] text-text-tertiary">
                                        {new Date(memory.updated_at || memory.created_at).toLocaleString()}
                                    </span>
                                    {(memory.revision || 1) > 1 && (
                                        <span className="text-[10px] text-amber-600 bg-amber-500/10 px-1.5 py-0.5 rounded">
                                            rev {memory.revision}
                                        </span>
                                    )}
                                </div>
                                <p className="text-sm text-text-secondary">{memory.content}</p>
                                {(memory.tags?.length || 0) > 0 && (
                                    <div className="mt-2 flex flex-wrap gap-1">
                                        {memory.tags.map((tag) => (
                                            <span key={tag} className="text-[10px] px-1.5 py-0.5 rounded bg-surface-primary border border-border text-text-tertiary">
                                                {tag}
                                            </span>
                                        ))}
                                    </div>
                                )}
                            </div>
                            <button
                                onClick={() => handleDeleteMemory(memory.id)}
                                className="opacity-0 group-hover:opacity-100 p-1.5 text-text-tertiary hover:text-red-500 hover:bg-red-500/10 rounded transition-all"
                                title="删除"
                            >
                                <Trash2 className="w-4 h-4" />
                            </button>
                        </div>
                    ))
                )}
            </div>

            <div className="space-y-2">
                <div className="flex items-center justify-between">
                    <h3 className="text-sm font-medium text-text-primary">归档记忆</h3>
                    <span className="text-[11px] text-text-tertiary">旧版本、冲突覆盖、容量裁剪都会归档到这里</span>
                </div>
                {isMemoryLoading ? (
                    <div className="text-center py-6 text-text-tertiary text-xs">加载中...</div>
                ) : archivedMemories.length === 0 ? (
                    <div className="text-center py-6 text-text-tertiary text-xs border border-dashed border-border rounded-lg">
                        暂无归档记忆。
                    </div>
                ) : (
                    <div className="space-y-2">
                        {archivedMemories.slice(0, 50).map((memory) => (
                            <div key={memory.id} className="p-3 bg-surface-secondary/10 border border-border rounded-lg">
                                <div className="flex items-center gap-2 mb-1 flex-wrap">
                                    <span className={clsx('px-1.5 py-0.5 rounded text-[10px] font-medium uppercase tracking-wider', memoryTypeTone(memory.type))}>
                                        {memoryTypeLabel(memory.type)}
                                    </span>
                                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-orange-500/10 text-orange-600">
                                        已归档
                                    </span>
                                    <span className="text-[10px] text-text-tertiary">
                                        {new Date(memory.archived_at || memory.updated_at || memory.created_at).toLocaleString()}
                                    </span>
                                    {memory.archive_reason && (
                                        <span className="text-[10px] text-text-tertiary">原因: {memory.archive_reason}</span>
                                    )}
                                </div>
                                <p className="text-sm text-text-secondary">{memory.content}</p>
                            </div>
                        ))}
                    </div>
                )}
            </div>

            <div className="space-y-2">
                <div className="flex items-center justify-between">
                    <h3 className="text-sm font-medium text-text-primary">记忆历史</h3>
                    <span className="text-[11px] text-text-tertiary">展示最近的记忆维护轨迹</span>
                </div>
                {isMemoryLoading ? (
                    <div className="text-center py-6 text-text-tertiary text-xs">加载中...</div>
                ) : memoryHistory.length === 0 ? (
                    <div className="text-center py-6 text-text-tertiary text-xs border border-dashed border-border rounded-lg">
                        暂无历史记录。
                    </div>
                ) : (
                    <div className="space-y-2">
                        {memoryHistory.slice(0, 80).map((entry) => (
                            <div key={entry.id} className="p-3 bg-surface-secondary/10 border border-border rounded-lg">
                                <div className="flex items-center gap-2 flex-wrap">
                                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-accent-primary/10 text-accent-primary">
                                        {historyActionLabel(entry.action)}
                                    </span>
                                    <span className="text-[10px] text-text-tertiary">
                                        {new Date(entry.timestamp).toLocaleString()}
                                    </span>
                                    {entry.reason && (
                                        <span className="text-[10px] text-text-tertiary">{entry.reason}</span>
                                    )}
                                </div>
                                <div className="mt-2 text-xs text-text-secondary space-y-1">
                                    {entry.before?.content && (
                                        <div>旧: {entry.before.content}</div>
                                    )}
                                    {entry.after?.content && (
                                        <div>新: {entry.after.content}</div>
                                    )}
                                    {!entry.before?.content && !entry.after?.content && (
                                        <div>origin: {entry.origin_id}</div>
                                    )}
                                </div>
                            </div>
                        ))}
                    </div>
                )}
            </div>
        </section>
    );
}

interface ToolsSettingsSectionProps {
    isSyncingMcp: boolean;
    handleDiscoverAndImportMcp: () => Promise<void>;
    handleAddMcpServer: () => void;
    handleSaveMcpServers: () => Promise<void>;
    mcpStatusMessage: string;
    mcpServers: McpServerConfig[];
    mcpRuntimeItems: McpServerRuntimeItem[];
    mcpLiveSessions: McpSessionState[];
    handleUpdateMcpServer: (id: string, updater: (item: McpServerConfig) => McpServerConfig) => void;
    handleDeleteMcpServer: (id: string) => Promise<void>;
    handleDisconnectMcpServer: (server: McpServerConfig) => Promise<void>;
    handleDisconnectAllMcpSessions: () => Promise<void>;
    stringifyEnvRecord: (env?: Record<string, string>) => string;
    parseEnvText: (text: string) => Record<string, string>;
    mcpOauthState: McpOauthState;
    handleRefreshMcpOAuth: (server: McpServerConfig) => Promise<void>;
    handleTestMcpServer: (server: McpServerConfig) => Promise<void>;
    mcpTestingId: string;
    mcpInspectingId: string;
    ytdlpStatus: YtdlpStatus;
    handleInstallYtdlp: () => Promise<void>;
    handleUpdateYtdlp: () => Promise<void>;
    browserPluginStatus: BrowserPluginStatus;
    isPreparingBrowserPlugin: boolean;
    handlePrepareBrowserPlugin: () => Promise<void>;
    handleOpenBrowserPluginDir: () => Promise<void>;
    isInstallingTool: boolean;
    installProgress: number;
    showDeveloperDiagnostics: boolean;
    toolDiagnostics: ToolDiagnosticDescriptor[];
    toolDiagnosticResults: Record<string, ToolDiagnosticRunResult | undefined>;
    toolDiagnosticRunning: Record<string, 'direct' | 'ai' | undefined>;
    handleRunDirectToolDiagnostic: (toolName: string) => Promise<void>;
    handleRunAiToolDiagnostic: (toolName: string) => Promise<void>;
    handleRefreshToolDiagnostics: () => Promise<void>;
    handleRunAllDirectToolDiagnostics: () => Promise<void>;
    handleRunAllAiToolDiagnostics: () => Promise<void>;
    runtimeTasks: AgentTaskSnapshot[];
    runtimeRoles: RoleSpec[];
    runtimeDiagnosticsSummary: RuntimeDiagnosticsSummary | null;
    runtimeSessions: Array<{
        id: string;
        runtimeMode?: string;
        contextBinding?: {
            contextType?: string;
            contextId?: string;
            isContextBound?: boolean;
        } | null;
        transcriptCount: number;
        checkpointCount: number;
        chatSession?: { id: string; title?: string; updatedAt?: string } | null;
    }>;
    backgroundTasks: BackgroundTaskItem[];
    backgroundWorkerPool: BackgroundWorkerPoolState;
    selectedRuntimeTaskId: string;
    setSelectedRuntimeTaskId: Dispatch<SetStateAction<string>>;
    selectedRuntimeSessionId: string;
    setSelectedRuntimeSessionId: Dispatch<SetStateAction<string>>;
    selectedBackgroundTaskId: string;
    setSelectedBackgroundTaskId: Dispatch<SetStateAction<string>>;
    runtimeTaskTraces: AgentTaskTrace[];
    runtimeSessionTranscript: Array<{
        id: number;
        sessionId: string;
        recordType: string;
        role: string;
        content: string;
        payload?: unknown;
        createdAt: number;
    }>;
    runtimeSessionCheckpoints: Array<{
        id: string;
        sessionId: string;
        checkpointType: string;
        summary: string;
        payload?: unknown;
        createdAt: number;
    }>;
    runtimeSessionToolResults: RuntimeToolResultItem[];
    runtimeHooks: Array<{
        id: string;
        event: string;
        type: string;
        matcher?: string;
        enabled?: boolean;
    }>;
    runtimeDraftInput: string;
    setRuntimeDraftInput: Dispatch<SetStateAction<string>>;
    runtimeDraftMode: 'redclaw' | 'knowledge' | 'chatroom' | 'advisor-discussion' | 'background-maintenance' | 'diagnostics';
    setRuntimeDraftMode: Dispatch<SetStateAction<'redclaw' | 'knowledge' | 'chatroom' | 'advisor-discussion' | 'background-maintenance' | 'diagnostics'>>;
    isRuntimeLoading: boolean;
    isRuntimeTraceLoading: boolean;
    isRuntimeSessionLoading: boolean;
    isBackgroundTasksLoading: boolean;
    isRuntimeCreating: boolean;
    runtimeTaskActionRunning: Record<string, 'resume' | 'cancel' | undefined>;
    backgroundTaskActionRunning: Record<string, 'cancel' | undefined>;
    handleRefreshRuntimeData: () => Promise<void>;
    handleCreateRuntimeTask: () => Promise<void>;
    handleResumeRuntimeTask: (taskId: string) => Promise<void>;
    handleCancelRuntimeTask: (taskId: string) => Promise<void>;
    handleCancelBackgroundTask: (taskId: string) => Promise<void>;
}

export function ToolsSettingsSection({
    isSyncingMcp,
    handleDiscoverAndImportMcp,
    handleAddMcpServer,
    handleSaveMcpServers,
    mcpStatusMessage,
    mcpServers,
    mcpRuntimeItems,
    mcpLiveSessions,
    handleUpdateMcpServer,
    handleDeleteMcpServer,
    handleDisconnectMcpServer,
    handleDisconnectAllMcpSessions,
    stringifyEnvRecord,
    parseEnvText,
    mcpOauthState,
    handleRefreshMcpOAuth,
    handleTestMcpServer,
    mcpTestingId,
    mcpInspectingId,
    ytdlpStatus,
    handleInstallYtdlp,
    handleUpdateYtdlp,
    browserPluginStatus,
    isPreparingBrowserPlugin,
    handlePrepareBrowserPlugin,
    handleOpenBrowserPluginDir,
    isInstallingTool,
    installProgress,
    showDeveloperDiagnostics,
    toolDiagnostics,
    toolDiagnosticResults,
    toolDiagnosticRunning,
    handleRunDirectToolDiagnostic,
    handleRunAiToolDiagnostic,
    handleRefreshToolDiagnostics,
    handleRunAllDirectToolDiagnostics,
    handleRunAllAiToolDiagnostics,
    runtimeTasks,
    runtimeRoles,
    runtimeDiagnosticsSummary,
    runtimeSessions,
    backgroundTasks,
    backgroundWorkerPool,
    selectedRuntimeTaskId,
    setSelectedRuntimeTaskId,
    selectedRuntimeSessionId,
    setSelectedRuntimeSessionId,
    selectedBackgroundTaskId,
    setSelectedBackgroundTaskId,
    runtimeTaskTraces,
    runtimeSessionTranscript,
    runtimeSessionCheckpoints,
    runtimeSessionToolResults,
    runtimeHooks,
    runtimeDraftInput,
    setRuntimeDraftInput,
    runtimeDraftMode,
    setRuntimeDraftMode,
    isRuntimeLoading,
    isRuntimeTraceLoading,
    isRuntimeSessionLoading,
    isBackgroundTasksLoading,
    isRuntimeCreating,
    runtimeTaskActionRunning,
    backgroundTaskActionRunning,
    handleRefreshRuntimeData,
    handleCreateRuntimeTask,
    handleResumeRuntimeTask,
    handleCancelRuntimeTask,
    handleCancelBackgroundTask,
}: ToolsSettingsSectionProps) {
    const [runtimeSessionQuery, setRuntimeSessionQuery] = useState('');
    const mcpRuntimeMap = useMemo(
        () =>
            Object.fromEntries(
                mcpRuntimeItems.map((item) => [item.server.id, item.session || null]),
            ) as Record<string, McpSessionState | null>,
        [mcpRuntimeItems],
    );

    const runtimeSessionSourceLabel = (session: {
        id: string;
        runtimeMode?: string;
        contextBinding?: { contextType?: string | null } | null;
    }) => {
        const runtimeMode = String(session.runtimeMode || '').trim();
        const contextType = String(session.contextBinding?.contextType || '').trim();
        if (runtimeMode === 'wander' || contextType === 'wander' || session.id.startsWith('session_wander_')) {
            return 'wander';
        }
        if (runtimeMode === 'chatroom' || contextType === 'chatroom' || session.id.startsWith('chatroom:')) {
            return 'chatroom';
        }
        if (runtimeMode === 'video-editor') {
            return 'video';
        }
        if (runtimeMode === 'audio-editor') {
            return 'audio';
        }
        if (contextType === 'file' || contextType === 'theme' || contextType === 'project') {
            return contextType;
        }
        return runtimeMode || contextType || 'chat';
    };

    const filteredRuntimeSessions = useMemo(() => {
        const keyword = runtimeSessionQuery.trim().toLowerCase();
        if (!keyword) return runtimeSessions;
        return runtimeSessions.filter((session) => {
            const haystack = [
                session.id,
                session.chatSession?.title,
                session.runtimeMode,
                session.contextBinding?.contextType,
                runtimeSessionSourceLabel(session),
            ]
                .filter(Boolean)
                .join(' ')
                .toLowerCase();
            return haystack.includes(keyword);
        });
    }, [runtimeSessionQuery, runtimeSessions]);

    const formatMcpTime = (value?: number) => {
        if (!value) return '未使用';
        const date = new Date(value);
        return Number.isNaN(date.getTime()) ? '未使用' : date.toLocaleString();
    };

    const availabilityTone = (tool: ToolDiagnosticDescriptor) => {
        switch (tool.availabilityStatus) {
            case 'available':
                return 'bg-green-500/10 text-green-600';
            case 'missing_context':
                return 'bg-amber-500/10 text-amber-600';
            case 'internal_only':
                return 'bg-purple-500/10 text-purple-600';
            case 'not_in_current_pack':
                return 'bg-slate-500/10 text-slate-600';
            default:
                return 'bg-red-500/10 text-red-600';
        }
    };

    const selectedRuntimeTask = runtimeTasks.find((task) => task.id === selectedRuntimeTaskId) || null;
    const selectedRuntimeSession = runtimeSessions.find((session) => session.id === selectedRuntimeSessionId) || null;
    const selectedBackgroundTask = backgroundTasks.find((task) => task.id === selectedBackgroundTaskId) || null;

    const runtimeSessionMetaText = useMemo(() => {
        if (!selectedRuntimeSession) return '';
        return [
            `session: ${selectedRuntimeSession.id}`,
            `title: ${selectedRuntimeSession.chatSession?.title || selectedRuntimeSession.id}`,
            `source: ${runtimeSessionSourceLabel(selectedRuntimeSession)}`,
            selectedRuntimeSession.runtimeMode ? `runtimeMode: ${selectedRuntimeSession.runtimeMode}` : '',
            selectedRuntimeSession.contextBinding?.contextType ? `contextType: ${selectedRuntimeSession.contextBinding.contextType}` : '',
            selectedRuntimeSession.contextBinding?.contextId ? `contextId: ${selectedRuntimeSession.contextBinding.contextId}` : '',
            selectedRuntimeSession.chatSession?.updatedAt ? `updatedAt: ${new Date(selectedRuntimeSession.chatSession.updatedAt).toLocaleString()}` : '',
            `transcriptCount: ${selectedRuntimeSession.transcriptCount}`,
            `checkpointCount: ${selectedRuntimeSession.checkpointCount}`,
            `toolResultCount: ${runtimeSessionToolResults.length}`,
        ].filter(Boolean).join('\n');
    }, [runtimeSessionToolResults.length, selectedRuntimeSession]);

    const runtimeSessionCheckpointsText = useMemo(() => {
        if (runtimeSessionCheckpoints.length === 0) return '暂无 checkpoint。';
        return runtimeSessionCheckpoints.map((checkpoint, index) => [
            `#${index + 1}`,
            `time: ${new Date(checkpoint.createdAt).toLocaleString()}`,
            `type: ${checkpoint.checkpointType}`,
            `summary: ${checkpoint.summary || '(empty)'}`,
            checkpoint.payload ? `payload:\n${JSON.stringify(checkpoint.payload, null, 2)}` : '',
        ].filter(Boolean).join('\n')).join('\n\n');
    }, [runtimeSessionCheckpoints]);

    const runtimeSessionTranscriptText = useMemo(() => {
        if (runtimeSessionTranscript.length === 0) return '暂无 transcript。';
        return runtimeSessionTranscript.map((item, index) => [
            `#${index + 1}`,
            `time: ${new Date(item.createdAt).toLocaleString()}`,
            `recordType: ${item.recordType}`,
            `role: ${item.role}`,
            `content:\n${item.content || '(empty)'}`,
            item.payload ? `payload:\n${JSON.stringify(item.payload, null, 2)}` : '',
        ].filter(Boolean).join('\n')).join('\n\n');
    }, [runtimeSessionTranscript]);

    const runtimeSessionToolResultsText = useMemo(() => {
        if (runtimeSessionToolResults.length === 0) return '暂无完整 tool result 记录。';
        return runtimeSessionToolResults.map((item, index) => [
            `#${index + 1}`,
            `time: ${new Date(item.createdAt).toLocaleString()}`,
            `tool: ${item.toolName}`,
            `status: ${item.success ? 'success' : 'error'}`,
            `callId: ${item.callId}`,
            item.command ? `command: ${item.command}` : '',
            item.truncated ? `budget: ${item.originalChars ?? 0} -> ${item.promptChars ?? 0}` : 'budget: full',
            item.promptText ? `promptText:\n${item.promptText}` : '',
            item.summaryText ? `summaryText:\n${item.summaryText}` : '',
            item.resultText ? `resultText:\n${item.resultText}` : '',
            item.payload ? `payload:\n${JSON.stringify(item.payload, null, 2)}` : '',
        ].filter(Boolean).join('\n')).join('\n\n');
    }, [runtimeSessionToolResults]);

    const runtimeSessionFullLogText = useMemo(() => {
        if (!selectedRuntimeSession) return '';
        return [
            '[Session]',
            runtimeSessionMetaText,
            '',
            '[Checkpoints]',
            runtimeSessionCheckpointsText,
            '',
            '[Transcript]',
            runtimeSessionTranscriptText,
            '',
            '[Tool Results]',
            runtimeSessionToolResultsText,
        ].join('\n');
    }, [
        runtimeSessionCheckpointsText,
        runtimeSessionMetaText,
        runtimeSessionToolResultsText,
        runtimeSessionTranscriptText,
        selectedRuntimeSession,
    ]);

    const availabilityLabel = (tool: ToolDiagnosticDescriptor) => {
        switch (tool.availabilityStatus) {
            case 'available':
                return '可用';
            case 'missing_context':
                return '当前上下文不可用';
            case 'internal_only':
                return '内部工具';
            case 'not_in_current_pack':
                return '当前 pack 未暴露';
            default:
                return '注册异常';
        }
    };

    const taskStatusTone = (status: AgentTaskSnapshot['status']) => {
        switch (status) {
            case 'completed':
                return 'bg-green-500/10 text-green-600';
            case 'running':
                return 'bg-blue-500/10 text-blue-600';
            case 'failed':
                return 'bg-red-500/10 text-red-600';
            case 'cancelled':
                return 'bg-slate-500/10 text-slate-600';
            default:
                return 'bg-amber-500/10 text-amber-600';
        }
    };

    const backgroundTaskStatusTone = (status: BackgroundTaskItem['status']) => {
        switch (status) {
            case 'completed':
                return 'bg-green-500/10 text-green-600';
            case 'running':
                return 'bg-blue-500/10 text-blue-600';
            case 'failed':
                return 'bg-red-500/10 text-red-600';
            case 'cancelled':
                return 'bg-slate-500/10 text-slate-600';
            default:
                return 'bg-amber-500/10 text-amber-600';
        }
    };

    const backgroundTaskPhaseTone = (phase: BackgroundTaskItem['phase']) => {
        switch (phase) {
            case 'thinking':
                return 'bg-violet-500/10 text-violet-600';
            case 'tooling':
                return 'bg-sky-500/10 text-sky-600';
            case 'responding':
                return 'bg-emerald-500/10 text-emerald-600';
            case 'updating':
                return 'bg-amber-500/10 text-amber-600';
            case 'completed':
                return 'bg-green-500/10 text-green-600';
            case 'failed':
                return 'bg-red-500/10 text-red-600';
            case 'cancelled':
                return 'bg-slate-500/10 text-slate-600';
            default:
                return 'bg-border text-text-tertiary';
        }
    };

    return (
        <section className="space-y-6">
            <h2 className="text-lg font-medium text-text-primary mb-6">外部工具管理</h2>

            <div className="bg-surface-secondary/30 rounded-lg border border-border p-4 space-y-4">
                <div className="flex items-start justify-between gap-3">
                    <div>
                        <h3 className="text-sm font-medium text-text-primary">MCP 数据源中台</h3>
                        <p className="text-xs text-text-tertiary mt-1">
                            管理 MCP Server，并支持从本机常见客户端一键导入配置。
                        </p>
                    </div>
                    <div className="flex items-center gap-2">
                        <button
                            type="button"
                            onClick={() => void handleDiscoverAndImportMcp()}
                            disabled={isSyncingMcp}
                            className="px-3 py-1.5 border border-border rounded text-xs hover:bg-surface-secondary transition-colors disabled:opacity-50"
                        >
                            {isSyncingMcp ? '导入中...' : '一键导入本机配置'}
                        </button>
                        <button
                            type="button"
                            onClick={handleAddMcpServer}
                            disabled={isSyncingMcp}
                            className="px-3 py-1.5 border border-border rounded text-xs hover:bg-surface-secondary transition-colors disabled:opacity-50"
                        >
                            新增 Server
                        </button>
                        <button
                            type="button"
                            onClick={() => void handleSaveMcpServers()}
                            disabled={isSyncingMcp}
                            className="px-3 py-1.5 bg-accent-primary text-white rounded text-xs hover:opacity-90 disabled:opacity-50"
                        >
                            保存 MCP
                        </button>
                    </div>
                </div>

                {mcpStatusMessage && (
                    <div className="text-xs text-text-secondary border border-border rounded px-3 py-2 bg-surface-primary/60">
                        {mcpStatusMessage}
                    </div>
                )}

                <div className="rounded-lg border border-border bg-surface-primary/40 p-3 space-y-3">
                    <div className="flex items-start justify-between gap-3">
                        <div>
                            <div className="text-xs font-medium text-text-primary">运行时会话</div>
                            <div className="text-[11px] text-text-tertiary mt-1">
                                已连接 {mcpLiveSessions.length} 个 session，展示当前 manager 持有的 MCP 运行时状态。
                            </div>
                        </div>
                        <button
                            type="button"
                            onClick={() => void handleDisconnectAllMcpSessions()}
                            disabled={mcpInspectingId === '__all__' || mcpLiveSessions.length === 0}
                            className="px-2.5 py-1.5 border border-border rounded text-xs hover:bg-surface-secondary transition-colors disabled:opacity-50"
                        >
                            {mcpInspectingId === '__all__' ? '断开中...' : '断开全部'}
                        </button>
                    </div>

                    {mcpLiveSessions.length === 0 ? (
                        <div className="text-[11px] text-text-tertiary border border-dashed border-border rounded px-3 py-4 text-center">
                            暂无活跃 MCP session。测试连接或调用资源后会出现在这里。
                        </div>
                    ) : (
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                            {mcpLiveSessions.map((session) => (
                                <div key={session.key} className="rounded-lg border border-border bg-surface-secondary/20 p-3 space-y-2">
                                    <div className="flex items-center justify-between gap-2">
                                        <div className="min-w-0">
                                            <div className="text-sm font-medium text-text-primary truncate">{session.serverName}</div>
                                            <div className="text-[11px] text-text-tertiary font-mono truncate">{session.serverId}</div>
                                        </div>
                                        <div className="flex items-center gap-2">
                                            <span className="px-2 py-0.5 rounded-full text-[10px] bg-emerald-500/10 text-emerald-600">
                                                {session.connectionStrategy}
                                            </span>
                                            <span className="px-2 py-0.5 rounded-full text-[10px] bg-surface-secondary text-text-secondary">
                                                {session.transport}
                                            </span>
                                        </div>
                                    </div>
                                    <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-[11px] text-text-secondary">
                                        <div>调用次数：{session.callCount}</div>
                                        <div>Tools：{session.toolCount}</div>
                                        <div>Resources：{session.resourceCount}</div>
                                        <div>Templates：{session.resourceTemplateCount}</div>
                                        <div className="col-span-2">最近使用：{formatMcpTime(session.lastUsedAt)}</div>
                                    </div>
                                </div>
                            ))}
                        </div>
                    )}
                </div>

                {mcpServers.length === 0 ? (
                    <div className="text-xs text-text-tertiary border border-dashed border-border rounded-lg px-3 py-5 text-center">
                        暂无 MCP Server。你可以新增一条，或使用“一键导入本机配置”。
                    </div>
                ) : (
                    <div className="space-y-3">
                        {mcpServers.map((server) => (
                            <div key={server.id} className="border border-border rounded-lg p-3 bg-surface-primary/40 space-y-3">
                                {mcpRuntimeMap[server.id] && (
                                    <div className="rounded-md border border-border bg-surface-secondary/20 px-3 py-2 text-[11px] text-text-secondary">
                                        <div className="flex flex-wrap items-center gap-2">
                                            <span className="font-medium text-text-primary">Runtime</span>
                                            <span>{mcpRuntimeMap[server.id]?.connectionStrategy}</span>
                                            <span>calls {mcpRuntimeMap[server.id]?.callCount}</span>
                                            <span>last {formatMcpTime(mcpRuntimeMap[server.id]?.lastUsedAt)}</span>
                                        </div>
                                    </div>
                                )}
                                <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
                                    <div className="md:col-span-2">
                                        <label className="block text-[11px] text-text-tertiary mb-1">名称</label>
                                        <input
                                            type="text"
                                            value={server.name}
                                            onChange={(e) => handleUpdateMcpServer(server.id, (item) => ({ ...item, name: e.target.value }))}
                                            className="w-full bg-surface-secondary/30 rounded border border-border px-3 py-2 text-sm focus:outline-none focus:border-accent-primary transition-colors"
                                        />
                                        <div className="mt-1 text-[11px] text-text-tertiary font-mono">id: {server.id}</div>
                                    </div>
                                    <div>
                                        <label className="block text-[11px] text-text-tertiary mb-1">传输协议</label>
                                        <select
                                            value={server.transport}
                                            onChange={(e) => handleUpdateMcpServer(server.id, (item) => ({ ...item, transport: e.target.value as McpServerConfig['transport'] }))}
                                            className="w-full bg-surface-secondary/30 rounded border border-border px-3 py-2 text-sm focus:outline-none focus:border-accent-primary transition-colors"
                                        >
                                            <option value="stdio">stdio</option>
                                            <option value="streamable-http">streamable-http</option>
                                            <option value="sse">sse</option>
                                        </select>
                                    </div>
                                    <div className="flex items-end justify-between gap-2">
                                        <label className="inline-flex items-center gap-2 text-xs text-text-secondary">
                                            <input
                                                type="checkbox"
                                                checked={server.enabled}
                                                onChange={(e) => handleUpdateMcpServer(server.id, (item) => ({ ...item, enabled: e.target.checked }))}
                                            />
                                            启用
                                        </label>
                                        <button
                                            type="button"
                                            onClick={() => void handleDeleteMcpServer(server.id)}
                                            className="px-2.5 py-1.5 border border-red-300 text-red-600 rounded text-xs hover:bg-red-50/70 transition-colors"
                                        >
                                            删除
                                        </button>
                                    </div>
                                </div>

                                {server.transport === 'stdio' ? (
                                    <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                                        <div>
                                            <label className="block text-[11px] text-text-tertiary mb-1">Command</label>
                                            <input
                                                type="text"
                                                value={server.command || ''}
                                                onChange={(e) => handleUpdateMcpServer(server.id, (item) => ({ ...item, command: e.target.value }))}
                                                placeholder="npx"
                                                className="w-full bg-surface-secondary/30 rounded border border-border px-3 py-2 text-sm focus:outline-none focus:border-accent-primary transition-colors"
                                            />
                                        </div>
                                        <div>
                                            <label className="block text-[11px] text-text-tertiary mb-1">Args（空格分隔）</label>
                                            <input
                                                type="text"
                                                value={(server.args || []).join(' ')}
                                                onChange={(e) => handleUpdateMcpServer(server.id, (item) => ({
                                                    ...item,
                                                    args: e.target.value.split(' ').map((arg) => arg.trim()).filter(Boolean),
                                                }))}
                                                placeholder="-y @modelcontextprotocol/server-filesystem /path"
                                                className="w-full bg-surface-secondary/30 rounded border border-border px-3 py-2 text-sm focus:outline-none focus:border-accent-primary transition-colors"
                                            />
                                        </div>
                                        <div>
                                            <label className="block text-[11px] text-text-tertiary mb-1">Env（每行 KEY=VALUE）</label>
                                            <textarea
                                                value={stringifyEnvRecord(server.env)}
                                                onChange={(e) => handleUpdateMcpServer(server.id, (item) => ({
                                                    ...item,
                                                    env: parseEnvText(e.target.value),
                                                }))}
                                                rows={3}
                                                className="w-full bg-surface-secondary/30 rounded border border-border px-3 py-2 text-xs focus:outline-none focus:border-accent-primary transition-colors"
                                            />
                                        </div>
                                    </div>
                                ) : (
                                    <div>
                                        <label className="block text-[11px] text-text-tertiary mb-1">URL</label>
                                        <input
                                            type="text"
                                            value={server.url || ''}
                                            onChange={(e) => handleUpdateMcpServer(server.id, (item) => ({ ...item, url: e.target.value }))}
                                            placeholder="https://your-mcp-host/sse"
                                            className="w-full bg-surface-secondary/30 rounded border border-border px-3 py-2 text-sm focus:outline-none focus:border-accent-primary transition-colors"
                                        />
                                    </div>
                                )}

                                <div className="flex items-center justify-between gap-3">
                                    <div className="text-[11px] text-text-tertiary">
                                        OAuth: {mcpOauthState[server.id]?.connected ? '已连接' : '未连接'}
                                        {mcpOauthState[server.id]?.tokenPath ? (
                                            <span className="ml-1 font-mono">{mcpOauthState[server.id]?.tokenPath}</span>
                                        ) : null}
                                    </div>
                                    <div className="flex items-center gap-2">
                                        <button
                                            type="button"
                                            onClick={() => void handleRefreshMcpOAuth(server)}
                                            className="px-2.5 py-1.5 border border-border rounded text-xs hover:bg-surface-secondary transition-colors"
                                        >
                                            刷新 OAuth
                                        </button>
                                        <button
                                            type="button"
                                            onClick={() => void handleTestMcpServer(server)}
                                            disabled={mcpTestingId === server.id}
                                            className="px-2.5 py-1.5 border border-border rounded text-xs hover:bg-surface-secondary transition-colors disabled:opacity-50"
                                        >
                                            {mcpTestingId === server.id ? '测试中...' : '测试连接'}
                                        </button>
                                        <button
                                            type="button"
                                            onClick={() => void handleDisconnectMcpServer(server)}
                                            disabled={mcpInspectingId === server.id || !mcpRuntimeMap[server.id]}
                                            className="px-2.5 py-1.5 border border-border rounded text-xs hover:bg-surface-secondary transition-colors disabled:opacity-50"
                                        >
                                            {mcpInspectingId === server.id ? '断开中...' : '断开会话'}
                                        </button>
                                    </div>
                                </div>
                            </div>
                        ))}
                    </div>
                )}
            </div>

            <div className="bg-surface-secondary/30 rounded-lg border border-border p-4">
                <div className="flex items-start justify-between gap-3">
                    <div>
                        <h3 className="text-sm font-medium text-text-primary flex items-center gap-2">
                            浏览器采集插件
                            {browserPluginStatus?.bundled ? (
                                <span className="px-1.5 py-0.5 rounded text-[10px] bg-green-500/10 text-green-500 font-medium">已内置</span>
                            ) : (
                                <span className="px-1.5 py-0.5 rounded text-[10px] bg-red-500/10 text-red-500 font-medium">未发现</span>
                            )}
                        </h3>
                        <p className="text-xs text-text-tertiary mt-1">
                            安装包内已自带 Chrome / Edge 采集插件。由于浏览器安全限制，无法静默安装；这里提供一键准备和打开目录，降低安装难度。
                        </p>
                        <div className="mt-2 text-[10px] text-text-tertiary font-mono space-y-1">
                            <div>状态: {browserPluginStatus?.bundled ? '内置资源可用' : (browserPluginStatus?.error || '插件资源缺失')}</div>
                            <div>内置路径: {browserPluginStatus?.bundledPath || '未解析到'}</div>
                            <div>外层目录: {browserPluginStatus?.exportPath || '尚未生成'}</div>
                            <div>插件目录: {browserPluginStatus?.pluginPath || '尚未生成'}</div>
                        </div>
                        <div className="mt-3 text-[11px] text-text-secondary space-y-1">
                            <div>1. 点击“一键准备插件”</div>
                            <div>2. 在 Chrome 或 Edge 打开扩展管理页并开启开发者模式</div>
                            <div>3. 把“RedBox Browser Extension”文件夹拖进浏览器，或在“加载已解压的扩展程序”里选择该文件夹</div>
                        </div>
                    </div>
                    <div className="flex flex-col gap-2 shrink-0">
                        <button
                            type="button"
                            onClick={() => void handlePrepareBrowserPlugin()}
                            disabled={isPreparingBrowserPlugin}
                            className="flex items-center gap-2 px-3 py-1.5 bg-accent-primary text-white text-xs font-medium rounded hover:opacity-90 disabled:opacity-50"
                        >
                            {isPreparingBrowserPlugin ? <RefreshCw className="w-3 h-3 animate-spin" /> : <Download className="w-3 h-3" />}
                            {isPreparingBrowserPlugin ? '准备中...' : '一键准备插件'}
                        </button>
                        <button
                            type="button"
                            onClick={() => void handleOpenBrowserPluginDir()}
                            disabled={isPreparingBrowserPlugin}
                            className="flex items-center gap-2 px-3 py-1.5 border border-border text-text-primary text-xs font-medium rounded hover:bg-surface-secondary disabled:opacity-50"
                        >
                            <FolderOpen className="w-3 h-3" />
                            打开插件目录
                        </button>
                    </div>
                </div>
            </div>

            <div className="bg-surface-secondary/30 rounded-lg border border-border p-4">
                <div className="flex items-start justify-between">
                    <div>
                        <h3 className="text-sm font-medium text-text-primary flex items-center gap-2">
                            yt-dlp (YouTube 下载器)
                            {ytdlpStatus?.installed ? (
                                <span className="px-1.5 py-0.5 rounded text-[10px] bg-green-500/10 text-green-500 font-medium">已安装</span>
                            ) : (
                                <span className="px-1.5 py-0.5 rounded text-[10px] bg-red-500/10 text-red-500 font-medium">未安装</span>
                            )}
                        </h3>
                        <p className="text-xs text-text-tertiary mt-1">
                            用于智囊团功能的 YouTube 视频信息获取和字幕下载。
                        </p>
                        <div className="mt-2 text-[10px] text-text-tertiary font-mono">
                            {ytdlpStatus?.version && <div>版本: {ytdlpStatus.version}</div>}
                            {ytdlpStatus?.path && <div>路径: {ytdlpStatus.path}</div>}
                        </div>
                    </div>
                    <div className="flex flex-col gap-2">
                        {!ytdlpStatus?.installed ? (
                            <button
                                type="button"
                                onClick={() => void handleInstallYtdlp()}
                                disabled={isInstallingTool}
                                className="flex items-center gap-2 px-3 py-1.5 bg-accent-primary text-white text-xs font-medium rounded hover:opacity-90 disabled:opacity-50"
                            >
                                {isInstallingTool ? <RefreshCw className="w-3 h-3 animate-spin" /> : <Download className="w-3 h-3" />}
                                {isInstallingTool ? '安装中...' : '一键安装'}
                            </button>
                        ) : (
                            <button
                                type="button"
                                onClick={() => void handleUpdateYtdlp()}
                                disabled={isInstallingTool}
                                className="flex items-center gap-2 px-3 py-1.5 border border-border text-text-primary text-xs font-medium rounded hover:bg-surface-secondary disabled:opacity-50"
                            >
                                {isInstallingTool ? <RefreshCw className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
                                {isInstallingTool ? '更新中...' : '检查更新'}
                            </button>
                        )}
                    </div>
                </div>

                {isInstallingTool && installProgress > 0 && (
                    <div className="mt-4">
                        <div className="h-1 bg-border rounded-full overflow-hidden">
                            <div
                                className="h-full bg-accent-primary transition-all duration-300"
                                style={{ width: `${installProgress}%` }}
                            />
                        </div>
                        <div className="flex justify-between mt-1">
                            <span className="text-[10px] text-text-tertiary">下载中...</span>
                            <span className="text-[10px] text-text-tertiary">{installProgress}%</span>
                        </div>
                    </div>
                )}
            </div>

            {showDeveloperDiagnostics && (
                <div className="space-y-4">
                    <div className="bg-surface-secondary/30 rounded-lg border border-border p-4 space-y-4">
                        <div className="flex items-start justify-between gap-3">
                            <div>
                                <h3 className="text-sm font-medium text-text-primary">阶段 0 基线观测</h3>
                                <p className="text-xs text-text-tertiary mt-1">
                                    汇总成员 persona 生成、知识导入、runtime 查询、skill 激活和工具调用的最近 100 条基线数据。
                                </p>
                            </div>
                            <div className="text-[11px] text-text-tertiary">
                                {runtimeDiagnosticsSummary?.generatedAt
                                    ? `更新于 ${new Date(runtimeDiagnosticsSummary.generatedAt).toLocaleString()}`
                                    : '暂无观测数据'}
                            </div>
                        </div>

                        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-3">
                            <div className="rounded-lg border border-border bg-surface-primary/50 p-3">
                                <div className="text-[11px] text-text-tertiary">Persona 生成</div>
                                <div className="text-lg font-semibold text-text-primary mt-1">
                                    {runtimeDiagnosticsSummary?.phase0?.personaGeneration?.count ?? 0}
                                </div>
                                <div className="text-[11px] text-text-tertiary mt-1">
                                    平均耗时 {Number(runtimeDiagnosticsSummary?.phase0?.personaGeneration?.avgElapsedMs ?? 0).toFixed(1)} ms
                                </div>
                            </div>
                            <div className="rounded-lg border border-border bg-surface-primary/50 p-3">
                                <div className="text-[11px] text-text-tertiary">知识导入</div>
                                <div className="text-lg font-semibold text-text-primary mt-1">
                                    {runtimeDiagnosticsSummary?.phase0?.knowledgeIngest?.count ?? 0}
                                </div>
                                <div className="text-[11px] text-text-tertiary mt-1">
                                    平均导入 {Number(runtimeDiagnosticsSummary?.phase0?.knowledgeIngest?.avgImportedFiles ?? 0).toFixed(1)} 个文件
                                </div>
                            </div>
                            <div className="rounded-lg border border-border bg-surface-primary/50 p-3">
                                <div className="text-[11px] text-text-tertiary">Runtime 查询</div>
                                <div className="text-lg font-semibold text-text-primary mt-1">
                                    {runtimeDiagnosticsSummary?.phase0?.runtimeQueries?.count ?? 0}
                                </div>
                                <div className="text-[11px] text-text-tertiary mt-1">
                                    平均 prompt {Number(runtimeDiagnosticsSummary?.phase0?.runtimeQueries?.avgPromptChars ?? 0).toFixed(1)} chars
                                </div>
                                <div className="text-[11px] text-text-tertiary mt-1">
                                    平均 active skills {Number(runtimeDiagnosticsSummary?.phase0?.runtimeQueries?.avgActiveSkillCount ?? 0).toFixed(1)}
                                </div>
                            </div>
                            <div className="rounded-lg border border-border bg-surface-primary/50 p-3">
                                <div className="text-[11px] text-text-tertiary">工具调用</div>
                                <div className="text-lg font-semibold text-text-primary mt-1">
                                    {runtimeDiagnosticsSummary?.phase0?.toolCalls?.count ?? 0}
                                </div>
                                <div className="text-[11px] text-text-tertiary mt-1">
                                    成功率 {(Number(runtimeDiagnosticsSummary?.phase0?.toolCalls?.successRate ?? 0) * 100).toFixed(1)}%
                                </div>
                            </div>
                        </div>

                        <div className="grid grid-cols-1 xl:grid-cols-3 gap-3">
                            <div className="rounded-lg border border-border bg-surface-primary/50 p-3 space-y-2">
                                <div className="text-xs font-medium text-text-primary">按成员</div>
                                {(runtimeDiagnosticsSummary?.phase0?.personaGeneration?.byAdvisor ?? []).length ? (
                                    <div className="space-y-2">
                                        {(runtimeDiagnosticsSummary?.phase0?.personaGeneration?.byAdvisor ?? []).slice(0, 6).map((row, index) => (
                                            <div key={`${String(row.advisorId ?? index)}`} className="rounded border border-border bg-surface-secondary/20 p-2">
                                                <div className="flex items-center justify-between gap-2">
                                                    <div className="text-[11px] font-medium text-text-primary">
                                                        {String(row.advisorName ?? row.advisorId ?? '未知成员')}
                                                    </div>
                                                    <div className="text-[10px] text-text-tertiary">
                                                        {String(row.count ?? 0)} 次
                                                    </div>
                                                </div>
                                                <div className="text-[10px] text-text-tertiary mt-1">
                                                    persona {Number(row.avgElapsedMs ?? 0).toFixed(1)} ms
                                                </div>
                                            </div>
                                        ))}
                                    </div>
                                ) : (
                                    <div className="text-[11px] text-text-tertiary">暂无成员基线数据。</div>
                                )}
                            </div>

                            <div className="rounded-lg border border-border bg-surface-primary/50 p-3 space-y-2">
                                <div className="text-xs font-medium text-text-primary">按 Runtime Mode</div>
                                {(runtimeDiagnosticsSummary?.phase0?.runtimeQueries?.byMode ?? []).length ? (
                                    <div className="space-y-2">
                                        {(runtimeDiagnosticsSummary?.phase0?.runtimeQueries?.byMode ?? []).slice(0, 6).map((row, index) => (
                                            <div key={`${String(row.runtimeMode ?? index)}`} className="rounded border border-border bg-surface-secondary/20 p-2">
                                                <div className="flex items-center justify-between gap-2">
                                                    <div className="text-[11px] font-medium text-text-primary">{String(row.runtimeMode ?? 'unknown')}</div>
                                                    <div className="text-[10px] text-text-tertiary">{String(row.count ?? 0)} 次</div>
                                                </div>
                                                <div className="text-[10px] text-text-tertiary mt-1">
                                                    prompt {Number(row.avgPromptChars ?? 0).toFixed(1)} chars
                                                </div>
                                                <div className="text-[10px] text-text-tertiary mt-1">
                                                    active skills {Number(row.avgActiveSkillCount ?? 0).toFixed(1)}
                                                </div>
                                            </div>
                                        ))}
                                    </div>
                                ) : (
                                    <div className="text-[11px] text-text-tertiary">暂无 runtime 查询数据。</div>
                                )}
                            </div>

                            <div className="rounded-lg border border-border bg-surface-primary/50 p-3 space-y-2">
                                <div className="text-xs font-medium text-text-primary">最近工具结果</div>
                                {(runtimeDiagnosticsSummary?.phase0?.toolCalls?.recent ?? []).length ? (
                                    <div className="space-y-2">
                                        {(runtimeDiagnosticsSummary?.phase0?.toolCalls?.recent ?? []).slice(0, 6).map((row, index) => (
                                            <div key={`${String(row.sessionId ?? 'session')}:${String(row.toolName ?? index)}:${index}`} className="rounded border border-border bg-surface-secondary/20 p-2">
                                                <div className="flex items-center justify-between gap-2">
                                                    <div className="text-[11px] font-medium text-text-primary">{String(row.toolName ?? 'tool')}</div>
                                                    <span className={clsx(
                                                        'text-[10px] px-1.5 py-0.5 rounded',
                                                        Boolean(row.success) ? 'bg-green-500/10 text-green-600' : 'bg-red-500/10 text-red-600'
                                                    )}>
                                                        {Boolean(row.success) ? 'success' : 'failed'}
                                                    </span>
                                                </div>
                                                <div className="text-[10px] text-text-tertiary mt-1">
                                                    {String(row.advisorName ?? row.advisorId ?? row.sessionId ?? '未绑定成员')}
                                                </div>
                                            </div>
                                        ))}
                                    </div>
                                ) : (
                                    <div className="text-[11px] text-text-tertiary">暂无工具调用结果。</div>
                                )}
                            </div>
                        </div>

                        <div className="rounded-lg border border-border bg-surface-primary/50 p-3 space-y-2">
                            <div className="text-xs font-medium text-text-primary">Runtime Warm</div>
                            {(runtimeDiagnosticsSummary?.runtimeWarm?.entries ?? []).length ? (
                                <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-2">
                                    {(runtimeDiagnosticsSummary?.runtimeWarm?.entries ?? []).map((entry) => (
                                        <div key={entry.mode} className="rounded border border-border bg-surface-secondary/20 p-2">
                                            <div className="flex items-center justify-between gap-2">
                                                <div className="text-[11px] font-medium text-text-primary">{entry.mode}</div>
                                                <div className="text-[10px] text-text-tertiary">
                                                    {entry.hasModelConfig ? 'model' : 'default'}
                                                </div>
                                            </div>
                                            <div className="text-[10px] text-text-tertiary mt-1">
                                                prompt {entry.systemPromptChars} chars
                                            </div>
                                            <div className="text-[10px] text-text-tertiary mt-1">
                                                long-term {entry.longTermContextChars} chars
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            ) : (
                                <div className="text-[11px] text-text-tertiary">暂无 runtime warm 数据。</div>
                            )}
                        </div>
                    </div>

                    <div className="bg-surface-secondary/30 rounded-lg border border-border p-4 space-y-4">
                        <div className="flex items-start justify-between gap-3">
                            <div>
                                <h3 className="text-sm font-medium text-text-primary">AI Runtime 调试中心</h3>
                                <p className="text-xs text-text-tertiary mt-1">
                                    查看当前角色注册表、任务图运行状态和单任务 trace，确认新 runtime 是否按预期执行。
                                </p>
                            </div>
                            <button
                                type="button"
                                onClick={() => void handleRefreshRuntimeData()}
                                className="px-3 py-1.5 border border-border rounded text-xs hover:bg-surface-secondary transition-colors"
                            >
                                {isRuntimeLoading ? '刷新中...' : '刷新 Runtime'}
                            </button>
                        </div>

                        <div className="grid grid-cols-1 xl:grid-cols-[280px_minmax(0,1fr)] gap-4">
                            <div className="space-y-4">
                                <div className="rounded-lg border border-border bg-surface-primary/50 p-3 space-y-3">
                                    <div className="text-xs font-medium text-text-primary">角色注册表</div>
                                    {runtimeRoles.length === 0 ? (
                                        <div className="text-[11px] text-text-tertiary">暂无角色定义。</div>
                                    ) : (
                                        <div className="space-y-2">
                                            {runtimeRoles.map((role) => (
                                                <div key={role.roleId} className="rounded border border-border bg-surface-secondary/30 p-2">
                                                    <div className="flex items-center justify-between gap-2">
                                                        <div className="text-xs font-medium text-text-primary">{role.roleId}</div>
                                                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-surface-secondary border border-border text-text-tertiary">
                                                            {role.allowedToolPack}
                                                        </span>
                                                    </div>
                                                    <p className="text-[11px] text-text-tertiary mt-1 leading-5">{role.purpose}</p>
                                                </div>
                                            ))}
                                        </div>
                                    )}
                                </div>

                                <div className="rounded-lg border border-border bg-surface-primary/50 p-3 space-y-3">
                                    <div className="text-xs font-medium text-text-primary">手动创建任务</div>
                                    <select
                                        value={runtimeDraftMode}
                                        onChange={(e) => setRuntimeDraftMode(e.target.value as typeof runtimeDraftMode)}
                                        className="w-full bg-surface-secondary/30 rounded border border-border px-3 py-2 text-sm focus:outline-none focus:border-accent-primary transition-colors"
                                    >
                                        <option value="redclaw">redclaw</option>
                                        <option value="knowledge">knowledge</option>
                                        <option value="chatroom">chatroom</option>
                                        <option value="advisor-discussion">advisor-discussion</option>
                                        <option value="background-maintenance">background-maintenance</option>
                                        <option value="diagnostics">diagnostics</option>
                                    </select>
                                    <textarea
                                        value={runtimeDraftInput}
                                        onChange={(e) => setRuntimeDraftInput(e.target.value)}
                                        rows={4}
                                        placeholder="输入一条开发者测试任务，例如：根据随机漫步素材写一篇文案并保存到稿件。"
                                        className="w-full bg-surface-secondary/30 rounded border border-border px-3 py-2 text-sm focus:outline-none focus:border-accent-primary transition-colors"
                                    />
                                    <button
                                        type="button"
                                        onClick={() => void handleCreateRuntimeTask()}
                                        disabled={isRuntimeCreating}
                                        className="w-full px-3 py-2 bg-accent-primary text-white rounded text-xs font-medium hover:opacity-90 disabled:opacity-50"
                                    >
                                        {isRuntimeCreating ? '创建中...' : '创建任务图'}
                                    </button>
                                </div>
                            </div>

                            <div className="space-y-4">
                                <div className="rounded-lg border border-border bg-surface-primary/50 p-3 space-y-3">
                                    <div className="flex items-center justify-between gap-2">
                                        <div className="text-xs font-medium text-text-primary">任务图实例</div>
                                        <span className="text-[11px] text-text-tertiary">共 {runtimeTasks.length} 条</span>
                                    </div>
                                    {runtimeTasks.length === 0 ? (
                                        <div className="text-[11px] text-text-tertiary">暂无任务实例。</div>
                                    ) : (
                                        <div className="space-y-2 max-h-80 overflow-auto pr-1">
                                            {runtimeTasks.map((task) => (
                                                <button
                                                    key={task.id}
                                                    type="button"
                                                    onClick={() => setSelectedRuntimeTaskId(task.id)}
                                                    className={clsx(
                                                        'w-full text-left rounded border p-3 transition-colors',
                                                        selectedRuntimeTaskId === task.id
                                                            ? 'border-accent-primary bg-accent-primary/5'
                                                            : 'border-border bg-surface-secondary/20 hover:bg-surface-secondary/30'
                                                    )}
                                                >
                                                    <div className="flex items-center justify-between gap-2">
                                                        <div className="min-w-0">
                                                            <div className="text-xs font-medium text-text-primary truncate">{task.goal || task.taskType}</div>
                                                            <div className="text-[11px] text-text-tertiary mt-1 font-mono truncate">{task.id}</div>
                                                        </div>
                                                        <span className={clsx('text-[10px] px-1.5 py-0.5 rounded', taskStatusTone(task.status))}>
                                                            {task.status}
                                                        </span>
                                                    </div>
                                                    <div className="flex flex-wrap gap-2 mt-2 text-[11px] text-text-tertiary">
                                                        <span>mode: {task.runtimeMode}</span>
                                                        {task.roleId ? <span>role: {task.roleId}</span> : null}
                                                        {task.intent ? <span>intent: {task.intent}</span> : null}
                                                    </div>
                                                </button>
                                            ))}
                                        </div>
                                    )}
                                </div>

                                <div className="rounded-lg border border-border bg-surface-primary/50 p-3 space-y-3">
                                    <div className="flex items-center justify-between gap-2">
                                        <div className="text-xs font-medium text-text-primary">任务详情 / Trace</div>
                                        {selectedRuntimeTask ? (
                                            <div className="flex items-center gap-2">
                                                <button
                                                    type="button"
                                                    onClick={() => void handleResumeRuntimeTask(selectedRuntimeTask.id)}
                                                    disabled={Boolean(runtimeTaskActionRunning[selectedRuntimeTask.id])}
                                                    className="px-2.5 py-1.5 border border-border rounded text-xs hover:bg-surface-secondary transition-colors disabled:opacity-50"
                                                >
                                                    {runtimeTaskActionRunning[selectedRuntimeTask.id] === 'resume' ? '恢复中...' : '恢复'}
                                                </button>
                                                <button
                                                    type="button"
                                                    onClick={() => void handleCancelRuntimeTask(selectedRuntimeTask.id)}
                                                    disabled={Boolean(runtimeTaskActionRunning[selectedRuntimeTask.id])}
                                                    className="px-2.5 py-1.5 border border-red-300 text-red-600 rounded text-xs hover:bg-red-50/70 transition-colors disabled:opacity-50"
                                                >
                                                    {runtimeTaskActionRunning[selectedRuntimeTask.id] === 'cancel' ? '取消中...' : '取消'}
                                                </button>
                                            </div>
                                        ) : null}
                                    </div>

                                    {!selectedRuntimeTask ? (
                                        <div className="text-[11px] text-text-tertiary">请选择左侧一条任务查看节点和 trace。</div>
                                    ) : (
                                        <div className="space-y-3">
                                            <div className="rounded border border-border bg-surface-secondary/20 p-3">
                                                <div className="flex items-center gap-2 flex-wrap">
                                                    <span className="text-xs font-medium text-text-primary">{selectedRuntimeTask.goal || selectedRuntimeTask.taskType}</span>
                                                    <span className={clsx('text-[10px] px-1.5 py-0.5 rounded', taskStatusTone(selectedRuntimeTask.status))}>
                                                        {selectedRuntimeTask.status}
                                                    </span>
                                                    {selectedRuntimeTask.roleId ? (
                                                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-surface-secondary border border-border text-text-tertiary">
                                                            {selectedRuntimeTask.roleId}
                                                        </span>
                                                    ) : null}
                                                </div>
                                                <div className="mt-2 text-[11px] text-text-tertiary space-y-1">
                                                    <div className="font-mono break-all">{selectedRuntimeTask.id}</div>
                                                    {selectedRuntimeTask.route?.reasoning ? (
                                                        <div>route: {selectedRuntimeTask.route.reasoning}</div>
                                                    ) : null}
                                                    {selectedRuntimeTask.lastError ? (
                                                        <div className="text-red-600">error: {selectedRuntimeTask.lastError}</div>
                                                    ) : null}
                                                </div>
                                            </div>

                                            <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
                                                <div className="rounded border border-border bg-surface-secondary/20 p-3 space-y-2">
                                                    <div className="text-[11px] font-medium text-text-primary">节点状态</div>
                                                    <div className="space-y-2">
                                                        {selectedRuntimeTask.graph.map((node) => (
                                                            <div key={node.id} className="rounded border border-border bg-surface-primary/60 p-2">
                                                                <div className="flex items-center justify-between gap-2">
                                                                    <div className="text-[11px] font-medium text-text-primary">{node.title}</div>
                                                                    <span className={clsx('text-[10px] px-1.5 py-0.5 rounded', taskStatusTone(node.status === 'failed' ? 'failed' : node.status === 'completed' ? 'completed' : node.status === 'running' ? 'running' : 'pending'))}>
                                                                        {node.status}
                                                                    </span>
                                                                </div>
                                                                <div className="text-[10px] text-text-tertiary mt-1">{node.type}</div>
                                                                {node.summary ? <div className="text-[11px] text-text-secondary mt-1">{node.summary}</div> : null}
                                                                {node.error ? <div className="text-[11px] text-red-600 mt-1">{node.error}</div> : null}
                                                            </div>
                                                        ))}
                                                    </div>
                                                </div>

                                                <div className="rounded border border-border bg-surface-secondary/20 p-3 space-y-2">
                                                    <div className="text-[11px] font-medium text-text-primary">产物 / Checkpoints</div>
                                                    <div className="space-y-2">
                                                        {selectedRuntimeTask.artifacts.map((artifact) => (
                                                            <div key={artifact.id} className="rounded border border-border bg-surface-primary/60 p-2 text-[11px] text-text-secondary">
                                                                <div className="font-medium text-text-primary">{artifact.label}</div>
                                                                <div className="text-text-tertiary mt-1">{artifact.type}</div>
                                                                {artifact.path ? <div className="font-mono break-all mt-1">{artifact.path}</div> : null}
                                                            </div>
                                                        ))}
                                                        {selectedRuntimeTask.checkpoints.map((checkpoint) => (
                                                            <div key={checkpoint.id} className="rounded border border-border bg-surface-primary/60 p-2 text-[11px] text-text-secondary">
                                                                <div className="font-medium text-text-primary">{checkpoint.summary}</div>
                                                                <div className="text-text-tertiary mt-1">node: {checkpoint.nodeId}</div>
                                                            </div>
                                                        ))}
                                                        {selectedRuntimeTask.artifacts.length === 0 && selectedRuntimeTask.checkpoints.length === 0 ? (
                                                            <div className="text-[11px] text-text-tertiary">暂无产物或 checkpoint。</div>
                                                        ) : null}
                                                    </div>
                                                </div>
                                            </div>

                                            <div className="rounded border border-border bg-surface-secondary/20 p-3 space-y-2">
                                                <div className="text-[11px] font-medium text-text-primary">执行 Trace</div>
                                                {isRuntimeTraceLoading ? (
                                                    <div className="text-[11px] text-text-tertiary">加载中...</div>
                                                ) : runtimeTaskTraces.length === 0 ? (
                                                    <div className="text-[11px] text-text-tertiary">暂无 trace。</div>
                                                ) : (
                                                    <div className="max-h-72 overflow-auto space-y-2 pr-1">
                                                        {runtimeTaskTraces.map((trace) => (
                                                            <details key={trace.id} className="rounded border border-border bg-surface-primary/60 p-2">
                                                                <summary className="cursor-pointer flex items-center justify-between gap-2 text-[11px]">
                                                                    <span className="font-medium text-text-primary">{trace.eventType}</span>
                                                                    <span className="text-text-tertiary">{new Date(trace.createdAt).toLocaleString()}</span>
                                                                </summary>
                                                                <pre className="mt-2 whitespace-pre-wrap break-all text-[11px] leading-5 text-text-secondary">
                                                                    {JSON.stringify(trace.payload ?? {}, null, 2)}
                                                                </pre>
                                                            </details>
                                                        ))}
                                                    </div>
                                                )}
                                            </div>
                                        </div>
                                    )}
                                </div>
                            </div>
                        </div>
                    </div>

                    <div className="bg-surface-secondary/30 rounded-lg border border-border p-4 space-y-4">
                        <div className="flex items-start justify-between gap-3">
                            <div>
                                <h3 className="text-sm font-medium text-text-primary">后台任务中心</h3>
                                <p className="text-xs text-text-tertiary mt-1">
                                    对齐 Claude DreamTask / headless runtime 的任务注册表。这里展示后台 Agent 的 running/completed/failed/cancelled 状态、实时过程和取消入口。
                                </p>
                            </div>
                            <div className="flex items-center gap-2 text-[11px] text-text-tertiary">
                                <span>tasks {backgroundTasks.length}</span>
                                {isBackgroundTasksLoading ? <span>同步中...</span> : null}
                            </div>
                        </div>

                        <div className="grid grid-cols-1 xl:grid-cols-[340px_minmax(0,1fr)] gap-4">
                            <div className="rounded-lg border border-border bg-surface-primary/50 p-3 space-y-3">
                                <div className="flex items-center justify-between gap-2">
                                    <div className="text-xs font-medium text-text-primary">后台任务列表</div>
                                    <span className="text-[11px] text-text-tertiary">最近 {backgroundTasks.length} 条</span>
                                </div>
                                {backgroundTasks.length === 0 ? (
                                    <div className="text-[11px] text-text-tertiary">暂无后台任务。</div>
                                ) : (
                                    <div className="space-y-2 max-h-96 overflow-auto pr-1">
                                        {backgroundTasks.map((task) => (
                                            <button
                                                key={task.id}
                                                type="button"
                                                onClick={() => setSelectedBackgroundTaskId(task.id)}
                                                className={clsx(
                                                    'w-full text-left rounded border p-3 transition-colors',
                                                    selectedBackgroundTaskId === task.id
                                                        ? 'border-accent-primary bg-accent-primary/5'
                                                        : 'border-border bg-surface-secondary/20 hover:bg-surface-secondary/30'
                                                )}
                                            >
                                                <div className="flex items-center justify-between gap-2">
                                                    <div className="min-w-0">
                                                        <div className="text-xs font-medium text-text-primary truncate">{task.title}</div>
                                                <div className="text-[11px] text-text-tertiary mt-1 truncate">{task.kind}</div>
                                                    </div>
                                                    <span className={clsx('text-[10px] px-1.5 py-0.5 rounded', backgroundTaskStatusTone(task.status))}>
                                                        {task.status}
                                                    </span>
                                                </div>
                                                <div className="mt-2 text-[11px] text-text-tertiary space-y-1">
                                                    <div className="flex items-center gap-2">
                                                        <span className={clsx('text-[10px] px-1.5 py-0.5 rounded', backgroundTaskPhaseTone(task.phase))}>
                                                            {task.phase}
                                                        </span>
                                                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-surface-secondary border border-border text-text-tertiary">
                                                            {task.workerState}
                                                        </span>
                                                        {task.workerMode ? (
                                                            <span className="text-[10px] px-1.5 py-0.5 rounded bg-surface-secondary border border-border text-text-tertiary">
                                                                {task.workerMode}
                                                            </span>
                                                        ) : null}
                                                        {task.workerLabel ? (
                                                            <span className="text-[10px] px-1.5 py-0.5 rounded bg-surface-secondary border border-border text-text-tertiary">
                                                                {task.workerLabel}
                                                            </span>
                                                        ) : null}
                                                        <span>attempt {task.attemptCount}</span>
                                                        <span className="font-mono truncate">{task.id}</span>
                                                    </div>
                                                    {task.latestText ? (
                                                        <div className="line-clamp-2 text-text-secondary">{task.latestText}</div>
                                                    ) : null}
                                                </div>
                                            </button>
                                        ))}
                                    </div>
                                )}
                            </div>

                            <div className="rounded-lg border border-border bg-surface-primary/50 p-3 space-y-3">
                                <div className="flex items-center justify-between gap-2">
                                    <div className="text-xs font-medium text-text-primary">后台任务详情</div>
                                    {selectedBackgroundTask ? (
                                        <button
                                            type="button"
                                            onClick={() => void handleCancelBackgroundTask(selectedBackgroundTask.id)}
                                            disabled={!['queued', 'leased', 'running', 'retrying'].includes(selectedBackgroundTask.workerState) || Boolean(backgroundTaskActionRunning[selectedBackgroundTask.id])}
                                            className="inline-flex items-center gap-2 px-2.5 py-1.5 border border-red-300 text-red-600 rounded text-xs hover:bg-red-50/70 transition-colors disabled:opacity-50"
                                        >
                                            <Square className="w-3.5 h-3.5" />
                                            {backgroundTaskActionRunning[selectedBackgroundTask.id] === 'cancel' ? '取消中...' : '停止任务'}
                                        </button>
                                    ) : null}
                                </div>

                                {!selectedBackgroundTask ? (
                                    <div className="text-[11px] text-text-tertiary">请选择左侧一条后台任务。</div>
                                ) : (
                                    <div className="space-y-3">
                                        <div className="rounded border border-border bg-surface-secondary/20 p-3">
                                            <div className="flex items-center gap-2 flex-wrap">
                                                <span className="text-xs font-medium text-text-primary">{selectedBackgroundTask.title}</span>
                                                <span className={clsx('text-[10px] px-1.5 py-0.5 rounded', backgroundTaskStatusTone(selectedBackgroundTask.status))}>
                                                    {selectedBackgroundTask.status}
                                                </span>
                                                <span className={clsx('text-[10px] px-1.5 py-0.5 rounded', backgroundTaskPhaseTone(selectedBackgroundTask.phase))}>
                                                    {selectedBackgroundTask.phase}
                                                </span>
                                                <span className="text-[10px] px-1.5 py-0.5 rounded bg-surface-secondary border border-border text-text-tertiary">
                                                    {selectedBackgroundTask.kind}
                                                </span>
                                            </div>
                                            <div className="mt-2 text-[11px] text-text-tertiary space-y-1">
                                                <div className="font-mono break-all">{selectedBackgroundTask.id}</div>
                                                {selectedBackgroundTask.sessionId ? <div>session: {selectedBackgroundTask.sessionId}</div> : null}
                                                {selectedBackgroundTask.contextId ? <div>context: {selectedBackgroundTask.contextId}</div> : null}
                                                <div>created: {new Date(selectedBackgroundTask.createdAt).toLocaleString()}</div>
                                                <div>updated: {new Date(selectedBackgroundTask.updatedAt).toLocaleString()}</div>
                                                {selectedBackgroundTask.completedAt ? <div>completed: {new Date(selectedBackgroundTask.completedAt).toLocaleString()}</div> : null}
                                                <div>attempts: {selectedBackgroundTask.attemptCount}</div>
                                                <div>workerState: {selectedBackgroundTask.workerState}</div>
                                                {selectedBackgroundTask.workerMode ? <div>workerMode: {selectedBackgroundTask.workerMode}</div> : null}
                                                {selectedBackgroundTask.workerLabel ? <div>workerLabel: {selectedBackgroundTask.workerLabel}</div> : null}
                                                {typeof selectedBackgroundTask.workerPid === 'number' ? <div>workerPid: {selectedBackgroundTask.workerPid}</div> : null}
                                                {selectedBackgroundTask.workerLastHeartbeatAt ? <div>workerHeartbeat: {new Date(selectedBackgroundTask.workerLastHeartbeatAt).toLocaleString()}</div> : null}
                                                <div>rollback: {selectedBackgroundTask.rollbackState}</div>
                                                {selectedBackgroundTask.cancelReason ? <div>cancelReason: {selectedBackgroundTask.cancelReason}</div> : null}
                                                {selectedBackgroundTask.rollbackError ? <div className="text-red-600">rollbackError: {selectedBackgroundTask.rollbackError}</div> : null}
                                                {selectedBackgroundTask.summary ? (
                                                    <div className="text-text-secondary">summary: {selectedBackgroundTask.summary}</div>
                                                ) : null}
                                                {selectedBackgroundTask.error ? (
                                                    <div className="text-red-600">error: {selectedBackgroundTask.error}</div>
                                                ) : null}
                                            </div>
                                        </div>

                                        <div className="rounded border border-border bg-surface-secondary/20 p-3 space-y-2">
                                            <div className="flex items-center gap-2 text-[11px] font-medium text-text-primary">
                                                <Activity className="w-3.5 h-3.5" />
                                                实时过程
                                            </div>
                                            {selectedBackgroundTask.turns.length === 0 ? (
                                                <div className="text-[11px] text-text-tertiary">暂无过程记录。</div>
                                            ) : (
                                                <div className="max-h-96 overflow-auto space-y-2 pr-1">
                                                    {selectedBackgroundTask.turns.map((turn) => (
                                                        <div key={turn.id} className="rounded border border-border bg-surface-primary/60 p-2">
                                                            <div className="flex items-center justify-between gap-2">
                                                                <span className="text-[10px] px-1.5 py-0.5 rounded bg-surface-secondary border border-border text-text-tertiary">
                                                                    {turn.source}
                                                                </span>
                                                                <span className="text-[10px] text-text-tertiary">
                                                                    {new Date(turn.at).toLocaleTimeString()}
                                                                </span>
                                                            </div>
                                                            <div className="mt-2 text-[11px] leading-5 text-text-secondary whitespace-pre-wrap break-words">
                                                                {turn.text}
                                                            </div>
                                                        </div>
                                                    ))}
                                                </div>
                                            )}
                                        </div>

                                        <div className="rounded border border-border bg-surface-secondary/20 p-3 space-y-3">
                                            <div className="flex items-center justify-between gap-2">
                                                <div className="text-[11px] font-medium text-text-primary">Worker 池</div>
                                                <span className="text-[10px] text-text-tertiary">
                                                    json {backgroundWorkerPool.json.length} / runtime {backgroundWorkerPool.runtime.length}
                                                </span>
                                            </div>

                                            {backgroundWorkerPool.json.length === 0 && backgroundWorkerPool.runtime.length === 0 ? (
                                                <div className="text-[11px] text-text-tertiary">当前还没有持久 worker 被拉起。</div>
                                            ) : (
                                                <div className="space-y-3">
                                                    {([
                                                        ['JSON Workers', backgroundWorkerPool.json],
                                                        ['Runtime Workers', backgroundWorkerPool.runtime],
                                                    ] as const).map(([label, items]) => (
                                                        <div key={label} className="space-y-2">
                                                            <div className="text-[10px] uppercase tracking-wide text-text-tertiary">{label}</div>
                                                            {items.length === 0 ? (
                                                                <div className="text-[11px] text-text-tertiary">暂无</div>
                                                            ) : (
                                                                <div className="space-y-2">
                                                                    {items.map((worker) => (
                                                                        <div key={worker.id} className="rounded border border-border bg-surface-primary/60 p-2 text-[11px] text-text-secondary">
                                                                            <div className="flex items-center gap-2 flex-wrap">
                                                                                <span className="font-medium text-text-primary">{worker.id}</span>
                                                                                <span className="text-[10px] px-1.5 py-0.5 rounded bg-surface-secondary border border-border text-text-tertiary">
                                                                                    {worker.mode}
                                                                                </span>
                                                                                <span className={clsx(
                                                                                    'text-[10px] px-1.5 py-0.5 rounded border',
                                                                                    worker.busy
                                                                                        ? 'bg-orange-50 border-orange-200 text-orange-700'
                                                                                        : 'bg-emerald-50 border-emerald-200 text-emerald-700',
                                                                                )}>
                                                                                    {worker.busy ? 'busy' : 'idle'}
                                                                                </span>
                                                                                <span className={clsx(
                                                                                    'text-[10px] px-1.5 py-0.5 rounded border',
                                                                                    worker.ready
                                                                                        ? 'bg-sky-50 border-sky-200 text-sky-700'
                                                                                        : 'bg-surface-secondary border-border text-text-tertiary',
                                                                                )}>
                                                                                    {worker.ready ? 'ready' : 'booting'}
                                                                                </span>
                                                                            </div>
                                                                            <div className="mt-2 space-y-1 text-text-tertiary">
                                                                                {typeof worker.pid === 'number' ? <div>pid: {worker.pid}</div> : null}
                                                                                {worker.sessionId ? <div>session: {worker.sessionId}</div> : null}
                                                                                {worker.taskId ? <div>task: {worker.taskId}</div> : null}
                                                                                {worker.lastHeartbeatAt ? <div>heartbeat: {new Date(worker.lastHeartbeatAt).toLocaleString()}</div> : null}
                                                                                {worker.lastUsedAt ? <div>lastUsed: {new Date(worker.lastUsedAt).toLocaleString()}</div> : null}
                                                                            </div>
                                                                        </div>
                                                                    ))}
                                                                </div>
                                                            )}
                                                        </div>
                                                    ))}
                                                </div>
                                            )}
                                        </div>
                                    </div>
                                )}
                            </div>
                        </div>
                    </div>

                    <div className="bg-surface-secondary/30 rounded-lg border border-border p-4 space-y-4">
                        <div className="flex items-start justify-between gap-3">
                            <div>
                                <h3 className="text-sm font-medium text-text-primary">Runtime Session / Transcript</h3>
                                <p className="text-xs text-text-tertiary mt-1">
                                    查看统一运行时的会话 transcript、checkpoint 和当前已注册 hooks，确认会话恢复与 compact 语义是否正常。
                                </p>
                            </div>
                            <div className="flex items-center gap-2 text-[11px] text-text-tertiary">
                                <span>sessions {runtimeSessions.length}</span>
                                <span>hooks {runtimeHooks.length}</span>
                            </div>
                        </div>

                        <div className="grid grid-cols-1 xl:grid-cols-[340px_minmax(0,1fr)] gap-4">
                            <div className="space-y-4">
                                <div className="rounded-lg border border-border bg-surface-primary/50 p-3 space-y-3">
                                    <div className="flex items-center justify-between gap-2">
                                        <div className="text-xs font-medium text-text-primary">运行时会话</div>
                                        <span className="text-[11px] text-text-tertiary">共 {runtimeSessions.length} 条</span>
                                    </div>
                                    <input
                                        type="text"
                                        value={runtimeSessionQuery}
                                        onChange={(event) => setRuntimeSessionQuery(event.target.value)}
                                        placeholder="搜索 session / wander / chatroom / video..."
                                        className="w-full bg-surface-secondary/30 rounded border border-border px-3 py-2 text-sm focus:outline-none focus:border-accent-primary transition-colors"
                                    />
                                    {filteredRuntimeSessions.length === 0 ? (
                                        <div className="text-[11px] text-text-tertiary">暂无 runtime session。</div>
                                    ) : (
                                        <div className="space-y-2 max-h-80 overflow-auto pr-1">
                                            {filteredRuntimeSessions.map((session) => (
                                                <button
                                                    key={session.id}
                                                    type="button"
                                                    onClick={() => setSelectedRuntimeSessionId(session.id)}
                                                    className={clsx(
                                                        'w-full text-left rounded border px-2.5 py-2 transition-colors',
                                                        selectedRuntimeSessionId === session.id
                                                            ? 'border-accent-primary bg-accent-primary/5'
                                                            : 'border-border bg-surface-secondary/20 hover:bg-surface-secondary/30'
                                                    )}
                                                >
                                                    <div className="text-xs font-medium text-text-primary truncate">
                                                        {session.chatSession?.title || session.id}
                                                    </div>
                                                    <div className="text-[10px] text-text-tertiary mt-1 font-mono truncate">
                                                        {session.id}
                                                    </div>
                                                    <div className="flex flex-wrap gap-1.5 mt-2 text-[10px] text-text-tertiary">
                                                        <span className="px-1.5 py-0.5 rounded bg-surface-secondary border border-border text-text-secondary">
                                                            {runtimeSessionSourceLabel(session)}
                                                        </span>
                                                        {session.runtimeMode ? (
                                                            <span className="px-1.5 py-0.5 rounded bg-surface-secondary/60 border border-border text-text-tertiary">
                                                                mode: {session.runtimeMode}
                                                            </span>
                                                        ) : null}
                                                        {session.contextBinding?.contextType ? (
                                                            <span className="px-1.5 py-0.5 rounded bg-surface-secondary/60 border border-border text-text-tertiary">
                                                                ctx: {session.contextBinding.contextType}
                                                            </span>
                                                        ) : null}
                                                        <span>transcript: {session.transcriptCount}</span>
                                                        <span>checkpoint: {session.checkpointCount}</span>
                                                    </div>
                                                </button>
                                            ))}
                                        </div>
                                    )}
                                </div>

                                <div className="rounded-lg border border-border bg-surface-primary/50 p-3 space-y-3">
                                    <div className="text-xs font-medium text-text-primary">Hook 注册表</div>
                                    {runtimeHooks.length === 0 ? (
                                        <div className="text-[11px] text-text-tertiary">暂无 runtime hook。</div>
                                    ) : (
                                        <div className="space-y-2 max-h-80 overflow-auto pr-1">
                                            {runtimeHooks.map((hook) => (
                                                <div key={hook.id} className="rounded border border-border bg-surface-secondary/20 p-2">
                                                    <div className="flex items-center justify-between gap-2">
                                                        <div className="text-[11px] font-medium text-text-primary">{hook.id}</div>
                                                        <span className={clsx(
                                                            'text-[10px] px-1.5 py-0.5 rounded',
                                                            hook.enabled === false ? 'bg-red-500/10 text-red-600' : 'bg-green-500/10 text-green-600'
                                                        )}>
                                                            {hook.enabled === false ? 'disabled' : 'enabled'}
                                                        </span>
                                                    </div>
                                                    <div className="flex flex-wrap gap-2 mt-2 text-[11px] text-text-tertiary">
                                                        <span>{hook.event}</span>
                                                        <span>{hook.type}</span>
                                                        {hook.matcher ? <span>match: {hook.matcher}</span> : null}
                                                    </div>
                                                </div>
                                            ))}
                                        </div>
                                    )}
                                </div>
                            </div>

                            <div className="space-y-4">
                                <div className="rounded-lg border border-border bg-surface-primary/50 p-3 space-y-3">
                                    <div className="flex items-center justify-between gap-2">
                                        <div className="text-xs font-medium text-text-primary">Session Logs</div>
                                        <div className="flex items-center gap-2">
                                            {selectedRuntimeSession ? (
                                                <span className="text-[11px] text-text-tertiary font-mono truncate">{selectedRuntimeSession.id}</span>
                                            ) : null}
                                            {selectedRuntimeSession ? <DiagnosticCopyButton text={runtimeSessionFullLogText} label="复制全部" /> : null}
                                        </div>
                                    </div>
                                    {!selectedRuntimeSession ? (
                                        <div className="text-[11px] text-text-tertiary">请选择左侧一条 runtime session。</div>
                                    ) : isRuntimeSessionLoading ? (
                                        <div className="text-[11px] text-text-tertiary">加载中...</div>
                                    ) : (
                                        <div className="space-y-3">
                                            <div className="rounded border border-border bg-surface-secondary/20 p-3">
                                                <div className="flex items-center justify-between gap-2">
                                                    <div className="text-[11px] font-medium text-text-primary">Session Meta</div>
                                                    <DiagnosticCopyButton text={runtimeSessionMetaText} />
                                                </div>
                                                <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-all rounded border border-border bg-surface-primary/60 p-3 text-[11px] leading-5 text-text-secondary">
                                                    {runtimeSessionMetaText || '暂无 session 元数据。'}
                                                </pre>
                                            </div>

                                            <div className="rounded border border-border bg-surface-secondary/20 p-3">
                                                <div className="flex items-center justify-between gap-2">
                                                    <div className="text-[11px] font-medium text-text-primary">Checkpoints</div>
                                                    <DiagnosticCopyButton text={runtimeSessionCheckpointsText} />
                                                </div>
                                                <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-all rounded border border-border bg-surface-primary/60 p-3 text-[11px] leading-5 text-text-secondary">
                                                    {runtimeSessionCheckpointsText}
                                                </pre>
                                            </div>

                                            <div className="rounded border border-border bg-surface-secondary/20 p-3">
                                                <div className="flex items-center justify-between gap-2">
                                                    <div className="text-[11px] font-medium text-text-primary">Transcript</div>
                                                    <DiagnosticCopyButton text={runtimeSessionTranscriptText} />
                                                </div>
                                                <pre className="mt-2 max-h-[28rem] overflow-auto whitespace-pre-wrap break-all rounded border border-border bg-surface-primary/60 p-3 text-[11px] leading-5 text-text-secondary">
                                                    {runtimeSessionTranscriptText}
                                                </pre>
                                            </div>

                                            <div className="rounded border border-border bg-surface-secondary/20 p-3">
                                                <div className="flex items-center justify-between gap-2">
                                                    <div className="text-[11px] font-medium text-text-primary">Tool Result Store</div>
                                                    <DiagnosticCopyButton text={runtimeSessionToolResultsText} />
                                                </div>
                                                <pre className="mt-2 max-h-[28rem] overflow-auto whitespace-pre-wrap break-all rounded border border-border bg-surface-primary/60 p-3 text-[11px] leading-5 text-text-secondary">
                                                    {runtimeSessionToolResultsText}
                                                </pre>
                                            </div>
                                        </div>
                                    )}
                                </div>
                            </div>
                        </div>
                    </div>

                    <div className="bg-surface-secondary/30 rounded-lg border border-border p-4 space-y-4">
                        <div className="flex items-start justify-between gap-3">
                            <div>
                                <h3 className="text-sm font-medium text-text-primary">开发者工具调用诊断</h3>
                                <p className="text-xs text-text-tertiary mt-1">
                                    直接测试用于验证工具本身是否可用，AI 调用测试用于验证模型是否真的会正确发起 tool_call。
                                </p>
                            </div>
                            <div className="flex items-center gap-2">
                                <button
                                    type="button"
                                    onClick={() => void handleRefreshToolDiagnostics()}
                                    className="px-3 py-1.5 border border-border rounded text-xs hover:bg-surface-secondary transition-colors"
                                >
                                    刷新列表
                                </button>
                                <button
                                    type="button"
                                    onClick={() => void handleRunAllDirectToolDiagnostics()}
                                    className="px-3 py-1.5 border border-border rounded text-xs hover:bg-surface-secondary transition-colors"
                                >
                                    全部直接测试
                                </button>
                                <button
                                    type="button"
                                    onClick={() => void handleRunAllAiToolDiagnostics()}
                                    className="px-3 py-1.5 border border-border rounded text-xs hover:bg-surface-secondary transition-colors"
                                >
                                    全部 AI 测试
                                </button>
                            </div>
                        </div>

                        {toolDiagnostics.length === 0 ? (
                            <div className="text-xs text-text-tertiary border border-dashed border-border rounded-lg px-3 py-5 text-center">
                                暂无可诊断工具。
                            </div>
                        ) : (
                            <div className="space-y-3">
                                {toolDiagnostics.map((tool) => {
                                    const result = toolDiagnosticResults[tool.name];
                                    const runningMode = toolDiagnosticRunning[tool.name];
                                    const isRunnable = tool.availabilityStatus === 'available';
                                    return (
                                        <div key={tool.name} className="rounded-lg border border-border bg-surface-primary/50 p-3 space-y-3">
                                            <div className="flex items-start justify-between gap-3">
                                                <div className="min-w-0">
                                                    <div className="flex items-center gap-2 flex-wrap">
                                                        <span className="text-sm font-medium text-text-primary">{tool.displayName}</span>
                                                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-surface-secondary border border-border text-text-tertiary">
                                                            {tool.name}
                                                        </span>
                                                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-surface-secondary border border-border text-text-tertiary">
                                                            {tool.kind}
                                                        </span>
                                                        <span className={clsx('text-[10px] px-1.5 py-0.5 rounded', availabilityTone(tool))}>
                                                            {availabilityLabel(tool)}
                                                        </span>
                                                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-surface-secondary border border-border text-text-tertiary">
                                                            {tool.visibility}
                                                        </span>
                                                    </div>
                                                    <p className="text-xs text-text-tertiary mt-1">{tool.description || '暂无描述'}</p>
                                                    <p className="text-[11px] text-text-tertiary mt-1">{tool.availabilityReason}</p>
                                                </div>
                                                <div className="flex items-center gap-2 shrink-0">
                                                    <button
                                                        type="button"
                                                        onClick={() => void handleRunDirectToolDiagnostic(tool.name)}
                                                        disabled={!isRunnable || Boolean(runningMode)}
                                                        className="px-3 py-1.5 border border-border rounded text-xs hover:bg-surface-secondary disabled:opacity-50"
                                                    >
                                                        {runningMode === 'direct' ? '直接测试中...' : '直接测试'}
                                                    </button>
                                                    <button
                                                        type="button"
                                                        onClick={() => void handleRunAiToolDiagnostic(tool.name)}
                                                        disabled={!isRunnable || Boolean(runningMode)}
                                                        className="px-3 py-1.5 border border-border rounded text-xs hover:bg-surface-secondary disabled:opacity-50"
                                                    >
                                                        {runningMode === 'ai' ? 'AI 测试中...' : 'AI 调用测试'}
                                                    </button>
                                                </div>
                                            </div>

                                            {result && (
                                                <div className={clsx(
                                                    'rounded border p-3 text-xs space-y-2',
                                                    result.success
                                                        ? 'border-green-200 bg-green-500/5'
                                                        : 'border-red-200 bg-red-500/5'
                                                )}>
                                                    <div className="flex items-center gap-2">
                                                        <span className={clsx(
                                                            'px-1.5 py-0.5 rounded text-[10px] font-medium',
                                                            result.success ? 'bg-green-500/10 text-green-600' : 'bg-red-500/10 text-red-600'
                                                        )}>
                                                            {result.mode === 'direct' ? '直接测试' : 'AI 调用测试'}
                                                        </span>
                                                        <span className="text-text-secondary">
                                                            {result.success ? '成功' : (result.error || '失败')}
                                                        </span>
                                                    </div>
                                                    <details>
                                                        <summary className="cursor-pointer text-text-secondary">查看详情</summary>
                                                        <pre className="mt-2 max-h-56 overflow-auto whitespace-pre-wrap break-all rounded bg-surface-primary/70 p-3 text-[11px] leading-5 text-text-secondary">
                                                            {JSON.stringify(result, null, 2)}
                                                        </pre>
                                                    </details>
                                                </div>
                                            )}
                                        </div>
                                    );
                                })}
                            </div>
                        )}
                    </div>
                </div>
            )}
        </section>
    );
}

interface SettingsSaveBarProps {
    activeTab: 'general' | 'ai' | 'tools' | 'memory' | 'remote';
    status: 'idle' | 'saving' | 'saved' | 'error';
}

export function SettingsSaveBar({ activeTab, status }: SettingsSaveBarProps) {
    if (activeTab !== 'general' && activeTab !== 'ai') {
        return null;
    }

    return (
        <div className="fixed bottom-0 left-48 right-0 p-4 bg-surface-primary border-t border-border flex items-center justify-between z-10 transition-all">
            <div className="text-xs">
                {status === 'saved' && <span className="text-status-success">保存成功</span>}
                {status === 'error' && <span className="text-status-error">保存失败</span>}
            </div>

            <button
                type="submit"
                disabled={status === 'saving'}
                className="flex items-center px-6 py-2 bg-text-primary text-background text-sm font-medium rounded-md hover:opacity-90 transition-opacity disabled:opacity-50 shadow-sm"
            >
                <Save className="w-4 h-4 mr-2" />
                {status === 'saving' ? '保存中...' : '保存配置'}
            </button>
        </div>
    );
}
