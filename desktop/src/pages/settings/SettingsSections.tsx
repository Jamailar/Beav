import { memo, useMemo, type Dispatch, type SetStateAction } from 'react';
import { Activity, AlertCircle, Database, Download, FolderOpen, Info, RefreshCw, Save, Search, Square, Trash2 } from 'lucide-react';
import clsx from 'clsx';
import { PasswordInput } from './shared';
import type {
  AgentTaskSnapshot,
  AgentTaskTrace,
  BackgroundTaskItem,
  BackgroundWorkerPoolState,
  McpServerConfig,
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
    search_provider: string;
    search_endpoint: string;
    search_api_key: string;
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
    exported: boolean;
    bundledPath?: string;
    error?: string;
} | null;

type McpOauthState = Record<string, { connected?: boolean; tokenPath?: string } | undefined>;

type FeatureFlags = {
    vectorRecommendation: boolean;
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
    recentDebugLogs: string[];
    isDebugLogsLoading: boolean;
    handleRefreshDebugLogs: () => Promise<void>;
    handleOpenDebugLogDir: () => Promise<void>;
    handleVersionTap: () => void;
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
    recentDebugLogs,
    isDebugLogsLoading,
    handleRefreshDebugLogs,
    handleOpenDebugLogDir,
    handleVersionTap,
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
}: GeneralSettingsSectionProps) {
    const assistantDaemonLogText = useMemo(
        () => (assistantDaemonLogs.length ? assistantDaemonLogs.join('\n') : '暂无 daemon 日志。'),
        [assistantDaemonLogs],
    );

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
                </div>
                <p className="text-[10px] text-text-tertiary mt-2">
                    不要直接选择现有的稿件目录、<code className="bg-surface-secondary px-1 rounded">manuscripts</code> 目录或 <code className="bg-surface-secondary px-1 rounded">documents</code> 目录，否则应用会在其中创建 <code className="bg-surface-secondary px-1 rounded">/skills/</code>、<code className="bg-surface-secondary px-1 rounded">/knowledge/</code>、<code className="bg-surface-secondary px-1 rounded">/advisors/</code>、<code className="bg-surface-secondary px-1 rounded">/manuscripts/</code> 等完整工作区结构。
                </p>
            </div>

            <div className="bg-surface-secondary/30 rounded-lg border border-border p-4 space-y-4">
                <div>
                    <h3 className="text-sm font-medium text-text-primary flex items-center gap-2">
                        <Search className="w-4 h-4" />
                        联网搜索
                    </h3>
                    <p className="text-xs text-text-tertiary mt-1">
                        `web_search` 和顾问画像外部检索会读取这里的供应商设置。未配置时默认使用 DuckDuckGo。
                    </p>
                </div>

                <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                    <div>
                        <label className="block text-xs font-medium text-text-secondary mb-1.5">
                            搜索供应商
                        </label>
                        <select
                            value={formData.search_provider}
                            onChange={(e) => setFormData((prev: any) => ({ ...prev, search_provider: e.target.value }))}
                            className="w-full bg-surface-secondary/30 rounded border border-border px-3 py-2 text-sm focus:outline-none focus:border-accent-primary transition-colors"
                        >
                            <option value="duckduckgo">DuckDuckGo（免 Key）</option>
                            <option value="tavily">Tavily API</option>
                            <option value="searxng">SearXNG / 自建搜索</option>
                        </select>
                    </div>
                    <div>
                        <label className="block text-xs font-medium text-text-secondary mb-1.5">
                            搜索服务地址
                        </label>
                        <input
                            type="text"
                            value={formData.search_endpoint}
                            onChange={(e) => setFormData((prev: any) => ({ ...prev, search_endpoint: e.target.value }))}
                            placeholder={formData.search_provider === 'tavily' ? 'https://api.tavily.com' : formData.search_provider === 'searxng' ? 'https://your-searxng.example.com' : 'DuckDuckGo 默认无需填写'}
                            className="w-full bg-surface-secondary/30 rounded border border-border px-3 py-2 text-sm focus:outline-none focus:border-accent-primary transition-colors"
                        />
                    </div>
                </div>

                <div>
                    <label className="block text-xs font-medium text-text-secondary mb-1.5">
                        搜索 API Key
                    </label>
                    <PasswordInput
                        value={formData.search_api_key}
                        onChange={(e) => setFormData((prev: any) => ({ ...prev, search_api_key: e.target.value }))}
                        placeholder={formData.search_provider === 'duckduckgo' ? 'DuckDuckGo 默认无需填写' : '按供应商要求填写'}
                        className="w-full bg-surface-secondary/30 rounded border border-border px-3 py-2 text-sm focus:outline-none focus:border-accent-primary transition-colors"
                    />
                </div>

                <p className="text-[10px] text-text-tertiary">
                    `Tavily` 需要 API Key。`SearXNG` 至少需要服务地址，如你的实例启用了鉴权，也可以在上方填写 Key。
                </p>
            </div>

            <div className="bg-surface-secondary/30 rounded-lg border border-border p-4 space-y-4">
                <div>
                    <h3 className="text-sm font-medium text-text-primary flex items-center gap-2">
                        <Activity className="w-4 h-4" />
                        全局网络代理
                    </h3>
                    <p className="text-xs text-text-tertiary mt-1">
                        开启后，主进程的外网请求会统一走这里的代理，包括模型拉取、更新检查、飞书和微信扫码。
                    </p>
                </div>
                <div className="flex items-center justify-between">
                    <label className="text-xs font-medium text-text-secondary">启用全局代理</label>
                    <button
                        type="button"
                        onClick={() => setFormData((prev: any) => ({ ...prev, proxy_enabled: !prev.proxy_enabled }))}
                        className="ui-switch-track h-7 w-12"
                        data-state={formData.proxy_enabled ? 'on' : 'off'}
                    >
                        <span className={clsx('ui-switch-thumb inline-block h-5 w-5', formData.proxy_enabled ? 'translate-x-6' : 'translate-x-1')} />
                    </button>
                </div>
                <div>
                    <label className="block text-xs font-medium text-text-secondary mb-1.5">
                        代理地址
                    </label>
                    <input
                        type="text"
                        value={formData.proxy_url}
                        onChange={(e) => setFormData((prev: any) => ({ ...prev, proxy_url: e.target.value }))}
                        placeholder="http://127.0.0.1:7890"
                        className="w-full bg-surface-secondary/30 rounded border border-border px-3 py-2 text-sm focus:outline-none focus:border-accent-primary transition-colors"
                    />
                </div>
                <div>
                    <label className="block text-xs font-medium text-text-secondary mb-1.5">
                        直连白名单
                    </label>
                    <input
                        type="text"
                        value={formData.proxy_bypass}
                        onChange={(e) => setFormData((prev: any) => ({ ...prev, proxy_bypass: e.target.value }))}
                        placeholder="localhost,127.0.0.1,::1"
                        className="w-full bg-surface-secondary/30 rounded border border-border px-3 py-2 text-sm focus:outline-none focus:border-accent-primary transition-colors"
                    />
                </div>
                <p className="text-[10px] text-text-tertiary">
                    保存后立即生效。默认会保留 `localhost`、`127.0.0.1` 和 `::1` 直连，避免本地 relay 与 daemon 回环请求走代理。
                </p>
            </div>

            <div className="bg-surface-secondary/30 rounded-lg border border-border p-4 space-y-4">
                <div className="space-y-3">
                    <div>
                        <h3 className="text-sm font-medium text-text-primary flex items-center gap-2">
                            <Activity className="w-4 h-4" />
                            长期后台值守
                        </h3>
                        <p className="text-xs text-text-tertiary mt-1">
                            用于长期在线接收飞书、微信和本地 relay 的消息。窗口关闭后，只要启用了后台保活，就会继续驻留。
                        </p>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                        <button
                            type="button"
                            onClick={() => void handleReloadAssistantDaemonStatus()}
                            className="px-3 py-1.5 border border-border rounded text-xs hover:bg-surface-secondary transition-colors"
                        >
                            刷新状态
                        </button>
                        {assistantDaemonStatus?.enabled ? (
                            <button
                                type="button"
                                onClick={() => void handleStopAssistantDaemon()}
                                disabled={assistantDaemonBusy}
                                className="px-3 py-1.5 border border-red-300 text-red-600 rounded text-xs hover:bg-red-50 transition-colors disabled:opacity-50"
                            >
                                停止值守
                            </button>
                        ) : (
                            <button
                                type="button"
                                onClick={() => void handleStartAssistantDaemon()}
                                disabled={assistantDaemonBusy}
                                className="px-3 py-1.5 bg-accent-primary text-white rounded text-xs hover:opacity-90 disabled:opacity-50"
                            >
                                启动值守
                            </button>
                        )}
                    </div>
                </div>

                <div className="rounded border border-border bg-surface-primary/60 p-3 space-y-2">
                    <div className="flex items-center justify-between gap-3">
                        <span className="text-xs text-text-tertiary">守护状态</span>
                        <span className="text-sm font-medium text-text-primary">
                            {assistantDaemonStatus?.enabled
                                ? assistantDaemonStatus.listening ? '运行中' : '已启用，待启动'
                                : '未启用'}
                        </span>
                    </div>
                    <div className="flex items-center justify-between gap-3">
                        <span className="text-xs text-text-tertiary">锁状态</span>
                        <span className="text-sm font-medium text-text-primary">
                            {assistantDaemonStatus?.lockState === 'owner' ? '当前实例持有' : '被动等待'}
                        </span>
                    </div>
                    <div className="flex items-center justify-between gap-3">
                        <span className="text-xs text-text-tertiary">处理中</span>
                        <span className="text-sm font-medium text-text-primary">{assistantDaemonStatus?.activeTaskCount ?? 0}</span>
                    </div>
                    <div className="flex items-center justify-between gap-3">
                        <span className="text-xs text-text-tertiary">排队会话</span>
                        <span className="text-sm font-medium text-text-primary">{assistantDaemonStatus?.queuedPeerCount ?? 0}</span>
                    </div>
                </div>

                {assistantDaemonStatus?.blockedBy && (
                    <div className="text-xs text-amber-700 bg-amber-500/10 border border-amber-300 rounded p-3">
                        当前实例未持有后台锁：{assistantDaemonStatus.blockedBy}
                    </div>
                )}
                {assistantDaemonStatus?.lastError && (
                    <div className="text-xs text-red-600 bg-red-500/10 border border-red-300 rounded p-3">
                        最近错误：{assistantDaemonStatus.lastError}
                    </div>
                )}

                <div className="rounded border border-border bg-surface-primary/60 p-4 space-y-3">
                    <div className="flex items-center justify-between">
                        <label className="text-xs font-medium text-text-secondary">启用 daemon</label>
                        <button
                            type="button"
                            onClick={() => setAssistantDaemonDraft((prev) => ({ ...prev, enabled: !prev.enabled }))}
                            className="ui-switch-track h-7 w-12"
                            data-state={assistantDaemonDraft.enabled ? 'on' : 'off'}
                        >
                            <span className={clsx('ui-switch-thumb inline-block h-5 w-5', assistantDaemonDraft.enabled ? 'translate-x-6' : 'translate-x-1')} />
                        </button>
                    </div>
                    <div className="flex items-center justify-between">
                        <label className="text-xs font-medium text-text-secondary">开机自动启用</label>
                        <button
                            type="button"
                            onClick={() => setAssistantDaemonDraft((prev) => ({ ...prev, autoStart: !prev.autoStart }))}
                            className="ui-switch-track h-7 w-12"
                            data-state={assistantDaemonDraft.autoStart ? 'on' : 'off'}
                        >
                            <span className={clsx('ui-switch-thumb inline-block h-5 w-5', assistantDaemonDraft.autoStart ? 'translate-x-6' : 'translate-x-1')} />
                        </button>
                    </div>
                    <div className="flex items-center justify-between">
                        <label className="text-xs font-medium text-text-secondary">关闭窗口后继续后台运行</label>
                        <button
                            type="button"
                            onClick={() => setAssistantDaemonDraft((prev) => ({ ...prev, keepAliveWhenNoWindow: !prev.keepAliveWhenNoWindow }))}
                            className="ui-switch-track h-7 w-12"
                            data-state={assistantDaemonDraft.keepAliveWhenNoWindow ? 'on' : 'off'}
                        >
                            <span className={clsx('ui-switch-thumb inline-block h-5 w-5', assistantDaemonDraft.keepAliveWhenNoWindow ? 'translate-x-6' : 'translate-x-1')} />
                        </button>
                    </div>
                    <div>
                        <label className="block text-xs font-medium text-text-secondary mb-1.5">监听地址</label>
                        <input
                            type="text"
                            value={assistantDaemonDraft.host}
                            onChange={(e) => setAssistantDaemonDraft((prev) => ({ ...prev, host: e.target.value }))}
                            className="w-full bg-surface-primary rounded border border-border px-3 py-2 text-sm focus:outline-none focus:border-accent-primary"
                        />
                    </div>
                    <div>
                        <label className="block text-xs font-medium text-text-secondary mb-1.5">监听端口</label>
                        <input
                            type="number"
                            value={assistantDaemonDraft.port}
                            onChange={(e) => setAssistantDaemonDraft((prev) => ({ ...prev, port: e.target.value }))}
                            className="w-full bg-surface-primary rounded border border-border px-3 py-2 text-sm focus:outline-none focus:border-accent-primary"
                        />
                    </div>
                </div>

                <div className="space-y-3">
                    <div className="rounded border border-border bg-surface-primary/60 p-3">
                        <div className="text-[11px] text-text-tertiary mb-1">飞书接入</div>
                        <div className="text-xs text-text-secondary">
                            模式：{assistantDaemonStatus?.feishu.receiveMode || assistantDaemonDraft.feishu.receiveMode}
                        </div>
                        <div className="text-xs text-text-secondary mt-1">
                            {assistantDaemonDraft.feishu.receiveMode === 'websocket'
                                ? assistantDaemonStatus?.feishu.websocketRunning
                                    ? '长连接已建立'
                                    : `长连接待启动${assistantDaemonStatus?.feishu.websocketReconnectAt ? `，下次重连 ${new Date(assistantDaemonStatus.feishu.websocketReconnectAt).toLocaleString()}` : ''}`
                                : `Webhook: ${assistantDaemonStatus?.feishu.webhookUrl || '未生成'}`}
                        </div>
                    </div>
                    <div className="rounded border border-border bg-surface-primary/60 p-3">
                        <div className="text-[11px] text-text-tertiary mb-1">微信接入</div>
                        <div className="text-xs text-text-secondary">
                            Relay: {assistantDaemonStatus?.weixin.webhookUrl || '未生成'}
                        </div>
                        <div className="text-xs text-text-secondary mt-1">
                            sidecar: {assistantDaemonStatus?.weixin.sidecarRunning ? `运行中 (pid ${assistantDaemonStatus.weixin.sidecarPid})` : '未运行'}
                        </div>
                        <div className="text-xs text-text-secondary mt-1">
                            账号: {assistantDaemonStatus?.weixin.connected ? `已登录${assistantDaemonStatus.weixin.accountId ? ` (${assistantDaemonStatus.weixin.accountId})` : ''}` : '未登录'}
                        </div>
                    </div>
                    <details className="rounded border border-border bg-surface-primary/60 p-3">
                        <summary className="cursor-pointer list-none text-[11px] text-text-tertiary">
                            最近 daemon 日志
                        </summary>
                        <pre className="mt-3 max-h-40 overflow-auto whitespace-pre-wrap break-all text-[11px] leading-5 text-text-secondary">
                            {assistantDaemonLogText}
                        </pre>
                    </details>
                </div>

                <details className="rounded border border-border bg-surface-primary/60 p-4">
                    <summary className="cursor-pointer list-none flex items-center justify-between gap-3">
                        <div>
                            <h4 className="text-sm font-medium text-text-primary">飞书</h4>
                            <p className="text-[11px] text-text-tertiary mt-1">
                                默认折叠。需要时再展开填写 App ID、Secret 和接收模式。
                            </p>
                        </div>
                        <span className="text-[11px] text-text-tertiary">
                            {assistantDaemonDraft.feishu.enabled ? '已启用' : '未启用'}
                        </span>
                    </summary>
                    <div className="mt-4 space-y-3">
                        <div className="flex items-center justify-between">
                            <label className="text-xs font-medium text-text-secondary">启用飞书接入</label>
                            <button
                                type="button"
                                onClick={() => setAssistantDaemonDraft((prev) => ({ ...prev, feishu: { ...prev.feishu, enabled: !prev.feishu.enabled } }))}
                                className="ui-switch-track h-7 w-12"
                                data-state={assistantDaemonDraft.feishu.enabled ? 'on' : 'off'}
                            >
                                <span className={clsx('ui-switch-thumb inline-block h-5 w-5', assistantDaemonDraft.feishu.enabled ? 'translate-x-6' : 'translate-x-1')} />
                            </button>
                        </div>
                        <div>
                            <label className="block text-xs font-medium text-text-secondary mb-1.5">接收模式</label>
                            <select
                                value={assistantDaemonDraft.feishu.receiveMode}
                                onChange={(e) => setAssistantDaemonDraft((prev) => ({ ...prev, feishu: { ...prev.feishu, receiveMode: e.target.value as 'webhook' | 'websocket' } }))}
                                className="w-full bg-surface-secondary/30 rounded border border-border px-3 py-2 text-sm focus:outline-none focus:border-accent-primary"
                            >
                                <option value="webhook">Webhook</option>
                                <option value="websocket">官方长连接</option>
                            </select>
                        </div>
                        <div>
                            <label className="block text-xs font-medium text-text-secondary mb-1.5">事件路径</label>
                            <input
                                type="text"
                                value={assistantDaemonDraft.feishu.endpointPath}
                                onChange={(e) => setAssistantDaemonDraft((prev) => ({ ...prev, feishu: { ...prev.feishu, endpointPath: e.target.value } }))}
                                className="w-full bg-surface-secondary/30 rounded border border-border px-3 py-2 text-sm focus:outline-none focus:border-accent-primary"
                            />
                        </div>
                        <div>
                            <label className="block text-xs font-medium text-text-secondary mb-1.5">App ID</label>
                            <input
                                type="text"
                                value={assistantDaemonDraft.feishu.appId}
                                onChange={(e) => setAssistantDaemonDraft((prev) => ({ ...prev, feishu: { ...prev.feishu, appId: e.target.value } }))}
                                className="w-full bg-surface-secondary/30 rounded border border-border px-3 py-2 text-sm focus:outline-none focus:border-accent-primary"
                            />
                        </div>
                        <div>
                            <label className="block text-xs font-medium text-text-secondary mb-1.5">App Secret</label>
                            <PasswordInput
                                value={assistantDaemonDraft.feishu.appSecret}
                                onChange={(e) => setAssistantDaemonDraft((prev) => ({ ...prev, feishu: { ...prev.feishu, appSecret: e.target.value } }))}
                                className="w-full bg-surface-secondary/30 rounded border border-border px-3 py-2 text-sm focus:outline-none focus:border-accent-primary"
                            />
                        </div>
                        <div>
                            <label className="block text-xs font-medium text-text-secondary mb-1.5">Verification Token</label>
                            <PasswordInput
                                value={assistantDaemonDraft.feishu.verificationToken}
                                onChange={(e) => setAssistantDaemonDraft((prev) => ({ ...prev, feishu: { ...prev.feishu, verificationToken: e.target.value } }))}
                                className="w-full bg-surface-secondary/30 rounded border border-border px-3 py-2 text-sm focus:outline-none focus:border-accent-primary"
                            />
                        </div>
                        <div>
                            <label className="block text-xs font-medium text-text-secondary mb-1.5">Encrypt Key</label>
                            <PasswordInput
                                value={assistantDaemonDraft.feishu.encryptKey}
                                onChange={(e) => setAssistantDaemonDraft((prev) => ({ ...prev, feishu: { ...prev.feishu, encryptKey: e.target.value } }))}
                                className="w-full bg-surface-secondary/30 rounded border border-border px-3 py-2 text-sm focus:outline-none focus:border-accent-primary"
                            />
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
                </details>

                <details className="rounded border border-border bg-surface-primary/60 p-4">
                    <summary className="cursor-pointer list-none flex items-center justify-between gap-3">
                        <div>
                            <h4 className="text-sm font-medium text-text-primary">微信 sidecar</h4>
                            <p className="text-[11px] text-text-tertiary mt-1">
                                默认折叠。正常情况下只需要扫码登录，其他参数都藏在高级设置里。
                            </p>
                        </div>
                        <span className="text-[11px] text-text-tertiary">
                            {assistantDaemonDraft.weixin.enabled ? '已启用' : '未启用'}
                        </span>
                    </summary>
                    <div className="mt-4 space-y-3">
                        <div className="flex items-center justify-between">
                            <label className="text-xs font-medium text-text-secondary">启用微信 sidecar</label>
                            <button
                                type="button"
                                onClick={() => setAssistantDaemonDraft((prev) => ({ ...prev, weixin: { ...prev.weixin, enabled: !prev.weixin.enabled } }))}
                                className="ui-switch-track h-7 w-12"
                                data-state={assistantDaemonDraft.weixin.enabled ? 'on' : 'off'}
                            >
                                <span className={clsx('ui-switch-thumb inline-block h-5 w-5', assistantDaemonDraft.weixin.enabled ? 'translate-x-6' : 'translate-x-1')} />
                            </button>
                        </div>
                        <div className="rounded border border-border bg-surface-secondary/20 p-3 space-y-3">
                            <div className="text-[11px] text-text-tertiary">
                                连接方式：应用会调用 `@weixin-claw/core` 访问腾讯 iLink 网关拉取登录二维码。扫码成功后，本地会保存 bot token 和 accountId，后续由内置 sidecar 长连收发消息。
                            </div>
                            <div className="flex flex-wrap items-center gap-2">
                                <button
                                    type="button"
                                    onClick={() => void handleStartAssistantDaemonWeixinLogin()}
                                    disabled={assistantDaemonWeixinLoginBusy}
                                    className="px-3 py-1.5 border border-border rounded text-xs hover:bg-surface-secondary transition-colors disabled:opacity-50"
                                >
                                    开始扫码
                                </button>
                                <button
                                    type="button"
                                    onClick={() => void handleCheckAssistantDaemonWeixinLogin()}
                                    disabled={assistantDaemonWeixinLoginBusy || !assistantDaemonWeixinLogin?.sessionKey}
                                    className="px-3 py-1.5 border border-border rounded text-xs hover:bg-surface-secondary transition-colors disabled:opacity-50"
                                >
                                    检查登录结果
                                </button>
                                {assistantDaemonWeixinLogin && (
                                    <button
                                        type="button"
                                        onClick={handleClearAssistantDaemonWeixinLogin}
                                        className="px-3 py-1.5 border border-border rounded text-xs hover:bg-surface-secondary transition-colors"
                                    >
                                        清空二维码
                                    </button>
                                )}
                            </div>
                            {assistantDaemonWeixinLogin?.message && (
                                <p className="text-[11px] text-text-tertiary">{assistantDaemonWeixinLogin.message}</p>
                            )}
                            {!assistantDaemonWeixinLogin?.qrcodeUrl && (
                                <p className="text-[10px] text-text-tertiary">
                                    如果这里直接报 `fetch failed`，通常不是扫码逻辑问题，而是当前机器访问 `https://ilinkai.weixin.qq.com` 失败。先在上面的“全局网络代理”里配好代理，再保存设置后重试。
                                </p>
                            )}
                            {assistantDaemonWeixinLogin?.qrcodeUrl && (
                                <div className="space-y-2">
                                    <img
                                        src={assistantDaemonWeixinLogin.qrcodeImageUrl || assistantDaemonWeixinLogin.qrcodeUrl}
                                        alt="微信登录二维码"
                                        className="h-40 w-40 rounded border border-border bg-surface-secondary/30 object-contain p-2"
                                    />
                                    <p className="text-[10px] text-text-tertiary break-all">{assistantDaemonWeixinLogin.qrcodeUrl}</p>
                                </div>
                            )}
                        </div>
                        <label className="flex items-center gap-2 text-xs text-text-secondary">
                            <input
                                type="checkbox"
                                checked={assistantDaemonDraft.weixin.autoStartSidecar}
                                onChange={(e) => setAssistantDaemonDraft((prev) => ({ ...prev, weixin: { ...prev.weixin, autoStartSidecar: e.target.checked } }))}
                                className="rounded border-border"
                            />
                            daemon 启动时自动拉起微信 sidecar
                        </label>
                        <div className="text-[10px] text-text-tertiary">
                            当前登录：{assistantDaemonStatus?.weixin.connected ? '已连接' : '未连接'}
                            {assistantDaemonStatus?.weixin.accountId ? ` / ${assistantDaemonStatus.weixin.accountId}` : ''}
                            {assistantDaemonStatus?.weixin.userId ? ` / 用户 ${assistantDaemonStatus.weixin.userId}` : ''}
                        </div>
                        <div className="text-[10px] text-text-tertiary">
                            状态目录：<code className="bg-surface-secondary px-1 rounded">{assistantDaemonStatus?.weixin.stateDir || '未初始化'}</code>
                        </div>
                        {!!assistantDaemonStatus?.weixin.availableAccountIds?.length && (
                            <div className="text-[10px] text-text-tertiary">
                                已保存账号：{assistantDaemonStatus.weixin.availableAccountIds.join(', ')}
                            </div>
                        )}
                        <details className="rounded border border-border bg-surface-primary/60 p-3">
                            <summary className="cursor-pointer list-none text-[11px] text-text-tertiary">
                                微信高级设置
                            </summary>
                            <div className="mt-3 space-y-3">
                                <div>
                                    <label className="block text-xs font-medium text-text-secondary mb-1.5">Relay 路径</label>
                                    <input
                                        type="text"
                                        value={assistantDaemonDraft.weixin.endpointPath}
                                        onChange={(e) => setAssistantDaemonDraft((prev) => ({ ...prev, weixin: { ...prev.weixin, endpointPath: e.target.value } }))}
                                        className="w-full bg-surface-secondary/30 rounded border border-border px-3 py-2 text-sm focus:outline-none focus:border-accent-primary"
                                    />
                                </div>
                                <div>
                                    <label className="block text-xs font-medium text-text-secondary mb-1.5">Relay Token</label>
                                    <PasswordInput
                                        value={assistantDaemonDraft.weixin.authToken}
                                        onChange={(e) => setAssistantDaemonDraft((prev) => ({ ...prev, weixin: { ...prev.weixin, authToken: e.target.value } }))}
                                        className="w-full bg-surface-secondary/30 rounded border border-border px-3 py-2 text-sm focus:outline-none focus:border-accent-primary"
                                    />
                                </div>
                                <div>
                                    <label className="block text-xs font-medium text-text-secondary mb-1.5">微信账号 ID</label>
                                    <input
                                        type="text"
                                        value={assistantDaemonDraft.weixin.accountId}
                                        onChange={(e) => setAssistantDaemonDraft((prev) => ({ ...prev, weixin: { ...prev.weixin, accountId: e.target.value } }))}
                                        placeholder="扫码成功后会自动写入，也可以手动指定"
                                        className="w-full bg-surface-secondary/30 rounded border border-border px-3 py-2 text-sm focus:outline-none focus:border-accent-primary"
                                    />
                                </div>
                                <div>
                                    <label className="block text-xs font-medium text-text-secondary mb-1.5">Cursor 文件</label>
                                    <input
                                        type="text"
                                        value={assistantDaemonDraft.weixin.cursorFile}
                                        onChange={(e) => setAssistantDaemonDraft((prev) => ({ ...prev, weixin: { ...prev.weixin, cursorFile: e.target.value } }))}
                                        placeholder="留空使用 redclaw/weixin-sidecar.cursor.json"
                                        className="w-full bg-surface-secondary/30 rounded border border-border px-3 py-2 text-sm focus:outline-none focus:border-accent-primary"
                                    />
                                </div>
                                <div>
                                    <label className="block text-xs font-medium text-text-secondary mb-1.5">启动命令</label>
                                    <input
                                        type="text"
                                        value={assistantDaemonDraft.weixin.sidecarCommand}
                                        onChange={(e) => setAssistantDaemonDraft((prev) => ({ ...prev, weixin: { ...prev.weixin, sidecarCommand: e.target.value } }))}
                                        placeholder="留空使用当前 Electron 运行时"
                                        className="w-full bg-surface-secondary/30 rounded border border-border px-3 py-2 text-sm focus:outline-none focus:border-accent-primary"
                                    />
                                </div>
                                <div>
                                    <label className="block text-xs font-medium text-text-secondary mb-1.5">启动参数</label>
                                    <input
                                        type="text"
                                        value={assistantDaemonDraft.weixin.sidecarArgs}
                                        onChange={(e) => setAssistantDaemonDraft((prev) => ({ ...prev, weixin: { ...prev.weixin, sidecarArgs: e.target.value } }))}
                                        placeholder="留空使用内置 bootstrap"
                                        className="w-full bg-surface-secondary/30 rounded border border-border px-3 py-2 text-sm focus:outline-none focus:border-accent-primary"
                                    />
                                </div>
                                <div>
                                    <label className="block text-xs font-medium text-text-secondary mb-1.5">工作目录</label>
                                    <input
                                        type="text"
                                        value={assistantDaemonDraft.weixin.sidecarCwd}
                                        onChange={(e) => setAssistantDaemonDraft((prev) => ({ ...prev, weixin: { ...prev.weixin, sidecarCwd: e.target.value } }))}
                                        className="w-full bg-surface-secondary/30 rounded border border-border px-3 py-2 text-sm focus:outline-none focus:border-accent-primary"
                                    />
                                </div>
                                <div>
                                    <label className="block text-xs font-medium text-text-secondary mb-1.5">sidecar 环境变量（JSON）</label>
                                    <textarea
                                        value={assistantDaemonDraft.weixin.sidecarEnvText}
                                        onChange={(e) => setAssistantDaemonDraft((prev) => ({ ...prev, weixin: { ...prev.weixin, sidecarEnvText: e.target.value } }))}
                                        rows={4}
                                        placeholder='{"HTTP_PROXY":"http://127.0.0.1:7890"}'
                                        className="w-full bg-surface-secondary/30 rounded border border-border px-3 py-2 text-xs font-mono focus:outline-none focus:border-accent-primary"
                                    />
                                </div>
                            </div>
                        </details>
                        <p className="text-[10px] text-text-tertiary">
                            已改为使用正式版 `@weixin-claw/core`。默认直接复用当前 Electron 39 / Node 22 运行时，不再要求单独安装 `node22`。
                        </p>
                    </div>
                </details>

                <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                    <button
                        type="button"
                        onClick={() => void handleSaveAssistantDaemonConfig()}
                        disabled={assistantDaemonBusy}
                        className="inline-flex items-center gap-2 px-3 py-2 bg-accent-primary text-white rounded text-xs font-medium hover:opacity-90 disabled:opacity-50"
                    >
                        <Save className="w-3.5 h-3.5" />
                        保存后台通信配置
                    </button>
                    <span className="text-[11px] text-text-tertiary">
                        保存后不会自动重启现有进程；如改动了端口或接入方式，建议再点一次“启动值守/停止值守”。
                    </span>
                </div>
            </div>
            <div className="bg-surface-secondary/30 rounded-lg border border-border p-4 space-y-4">
                <div className="flex items-start justify-between gap-4">
                    <div>
                        <h3 className="text-sm font-medium text-text-primary">调试日志</h3>
                        <p className="text-xs text-text-tertiary mt-1">
                            开启后会把主进程日志、聊天日志和工具诊断日志写入本地日志文件，便于追踪 RedClaw 工具调用失败。
                        </p>
                    </div>
                    <button
                        type="button"
                        onClick={() => setFormData((prev: any) => ({ ...prev, debug_log_enabled: !prev.debug_log_enabled }))}
                        className="ui-switch-track h-7 w-12"
                        data-state={formData.debug_log_enabled ? 'on' : 'off'}
                    >
                        <span
                            className={clsx('ui-switch-thumb inline-block h-5 w-5', formData.debug_log_enabled ? 'translate-x-6' : 'translate-x-1')}
                        />
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
                        打开日志目录
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

interface KnowledgeSettingsSectionProps {
    vectorStats: { documents?: number; vectors?: number } | null;
    handleRebuildIndex: () => Promise<void>;
    isRebuilding: boolean;
}

export function KnowledgeSettingsSection({ vectorStats, handleRebuildIndex, isRebuilding }: KnowledgeSettingsSectionProps) {
    return (
        <section className="space-y-6">
            <h2 className="text-lg font-medium text-text-primary mb-6">知识库索引管理</h2>

            <div className="grid grid-cols-2 gap-4">
                <div className="bg-surface-secondary/30 rounded-lg border border-border p-4">
                    <div className="text-xs text-text-tertiary mb-1">已索引文档</div>
                    <div className="text-2xl font-bold text-text-primary">
                        {vectorStats?.documents || 0}
                    </div>
                </div>
                <div className="bg-surface-secondary/30 rounded-lg border border-border p-4">
                    <div className="text-xs text-text-tertiary mb-1">向量切片数</div>
                    <div className="text-2xl font-bold text-text-primary">
                        {vectorStats?.vectors || 0}
                    </div>
                </div>
            </div>

            <div className="bg-surface-secondary/20 rounded-lg border border-border p-4">
                <h3 className="text-sm font-medium text-text-primary mb-2 flex items-center gap-2">
                    <Database className="w-4 h-4" />
                    索引操作
                </h3>
                <p className="text-xs text-text-tertiary mb-4">
                    如果发现检索结果不准确或知识库内容未更新，可以尝试重建索引。
                    此操作会清空当前所有向量数据并重新扫描知识库文件。
                </p>

                <div className="flex gap-3">
                    <button
                        type="button"
                        onClick={() => void handleRebuildIndex()}
                        disabled={isRebuilding}
                        className="flex items-center px-4 py-2 border border-red-200 bg-red-50/50 text-red-600 text-xs font-medium rounded hover:bg-red-100/50 transition-colors disabled:opacity-50"
                    >
                        {isRebuilding ? <RefreshCw className="w-3.5 h-3.5 mr-2 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5 mr-2" />}
                        {isRebuilding ? '重建中...' : '重建所有索引'}
                    </button>
                </div>
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
    handleUpdateMcpServer: (id: string, updater: (item: McpServerConfig) => McpServerConfig) => void;
    handleDeleteMcpServer: (id: string) => Promise<void>;
    stringifyEnvRecord: (env?: Record<string, string>) => string;
    parseEnvText: (text: string) => Record<string, string>;
    mcpOauthState: McpOauthState;
    handleRefreshMcpOAuth: (server: McpServerConfig) => Promise<void>;
    handleTestMcpServer: (server: McpServerConfig) => Promise<void>;
    mcpTestingId: string;
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
    runtimeSessions: Array<{
        id: string;
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
    runtimeDraftMode: 'redclaw' | 'knowledge' | 'chatroom' | 'advisor-discussion' | 'background-maintenance';
    setRuntimeDraftMode: Dispatch<SetStateAction<'redclaw' | 'knowledge' | 'chatroom' | 'advisor-discussion' | 'background-maintenance'>>;
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
    handleUpdateMcpServer,
    handleDeleteMcpServer,
    stringifyEnvRecord,
    parseEnvText,
    mcpOauthState,
    handleRefreshMcpOAuth,
    handleTestMcpServer,
    mcpTestingId,
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

                {mcpServers.length === 0 ? (
                    <div className="text-xs text-text-tertiary border border-dashed border-border rounded-lg px-3 py-5 text-center">
                        暂无 MCP Server。你可以新增一条，或使用“一键导入本机配置”。
                    </div>
                ) : (
                    <div className="space-y-3">
                        {mcpServers.map((server) => (
                            <div key={server.id} className="border border-border rounded-lg p-3 bg-surface-primary/40 space-y-3">
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
                            <div>导出目录: {browserPluginStatus?.exportPath || '尚未生成'}</div>
                        </div>
                        <div className="mt-3 text-[11px] text-text-secondary space-y-1">
                            <div>1. 点击“一键准备插件”</div>
                            <div>2. 在 Chrome / Edge 打开扩展管理页并开启开发者模式</div>
                            <div>3. 点击“加载已解压的扩展程序”，选择上方导出目录</div>
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

                        <div className="grid grid-cols-1 xl:grid-cols-[340px_minmax(0,1fr)] gap-4">
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
                                            disabled={selectedBackgroundTask.status !== 'running' || Boolean(backgroundTaskActionRunning[selectedBackgroundTask.id])}
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
                                    {runtimeSessions.length === 0 ? (
                                        <div className="text-[11px] text-text-tertiary">暂无 runtime session。</div>
                                    ) : (
                                        <div className="space-y-2 max-h-80 overflow-auto pr-1">
                                            {runtimeSessions.map((session) => (
                                                <button
                                                    key={session.id}
                                                    type="button"
                                                    onClick={() => setSelectedRuntimeSessionId(session.id)}
                                                    className={clsx(
                                                        'w-full text-left rounded border p-3 transition-colors',
                                                        selectedRuntimeSessionId === session.id
                                                            ? 'border-accent-primary bg-accent-primary/5'
                                                            : 'border-border bg-surface-secondary/20 hover:bg-surface-secondary/30'
                                                    )}
                                                >
                                                    <div className="text-xs font-medium text-text-primary truncate">
                                                        {session.chatSession?.title || session.id}
                                                    </div>
                                                    <div className="text-[11px] text-text-tertiary mt-1 font-mono truncate">
                                                        {session.id}
                                                    </div>
                                                    <div className="flex flex-wrap gap-2 mt-2 text-[11px] text-text-tertiary">
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
                                        <div className="text-xs font-medium text-text-primary">Session Transcript / Checkpoints</div>
                                        {selectedRuntimeSession ? (
                                            <span className="text-[11px] text-text-tertiary font-mono truncate">{selectedRuntimeSession.id}</span>
                                        ) : null}
                                    </div>
                                    {!selectedRuntimeSession ? (
                                        <div className="text-[11px] text-text-tertiary">请选择左侧一条 runtime session。</div>
                                    ) : isRuntimeSessionLoading ? (
                                        <div className="text-[11px] text-text-tertiary">加载中...</div>
                                    ) : (
                                        <div className="space-y-3">
                                            <div className="rounded border border-border bg-surface-secondary/20 p-3">
                                                <div className="text-[11px] font-medium text-text-primary">最近 Checkpoints</div>
                                                <div className="mt-2 space-y-2">
                                                    {runtimeSessionCheckpoints.length === 0 ? (
                                                        <div className="text-[11px] text-text-tertiary">暂无 checkpoint。</div>
                                                    ) : runtimeSessionCheckpoints.map((checkpoint) => (
                                                        <div key={checkpoint.id} className="rounded border border-border bg-surface-primary/60 p-2">
                                                            <div className="flex items-center justify-between gap-2">
                                                                <span className="text-[11px] font-medium text-text-primary">{checkpoint.summary}</span>
                                                                <span className="text-[10px] text-text-tertiary">{checkpoint.checkpointType}</span>
                                                            </div>
                                                            <div className="text-[10px] text-text-tertiary mt-1">
                                                                {new Date(checkpoint.createdAt).toLocaleString()}
                                                            </div>
                                                        </div>
                                                    ))}
                                                </div>
                                            </div>

                                            <div className="rounded border border-border bg-surface-secondary/20 p-3">
                                                <div className="text-[11px] font-medium text-text-primary">最近 Transcript</div>
                                                <div className="mt-2 max-h-[32rem] overflow-auto space-y-2 pr-1">
                                                    {runtimeSessionTranscript.length === 0 ? (
                                                        <div className="text-[11px] text-text-tertiary">暂无 transcript。</div>
                                                    ) : runtimeSessionTranscript.map((item) => (
                                                        <details key={item.id} className="rounded border border-border bg-surface-primary/60 p-2">
                                                            <summary className="cursor-pointer flex items-center justify-between gap-2 text-[11px]">
                                                                <span className="font-medium text-text-primary">
                                                                    {item.recordType} · {item.role}
                                                                </span>
                                                                <span className="text-text-tertiary">{new Date(item.createdAt).toLocaleString()}</span>
                                                            </summary>
                                                            <pre className="mt-2 whitespace-pre-wrap break-all text-[11px] leading-5 text-text-secondary">
                                                                {item.content || '(empty)'}
                                                            </pre>
                                                        </details>
                                                    ))}
                                                </div>
                                            </div>

                                            <div className="rounded border border-border bg-surface-secondary/20 p-3">
                                                <div className="text-[11px] font-medium text-text-primary">Tool Result Store</div>
                                                <div className="mt-2 max-h-[24rem] overflow-auto space-y-2 pr-1">
                                                    {runtimeSessionToolResults.length === 0 ? (
                                                        <div className="text-[11px] text-text-tertiary">暂无完整 tool result 记录。</div>
                                                    ) : runtimeSessionToolResults.map((item) => (
                                                        <details key={item.id} className="rounded border border-border bg-surface-primary/60 p-2">
                                                            <summary className="cursor-pointer flex items-center justify-between gap-2 text-[11px]">
                                                                <span className="font-medium text-text-primary">
                                                                    {item.toolName} · {item.success ? 'success' : 'error'}
                                                                </span>
                                                                <span className="text-text-tertiary">{new Date(item.createdAt).toLocaleString()}</span>
                                                            </summary>
                                                            <div className="mt-2 space-y-2 text-[11px] text-text-secondary">
                                                                <div className="flex flex-wrap gap-2 text-text-tertiary">
                                                                    <span className="font-mono break-all">call: {item.callId}</span>
                                                                    {item.command ? <span className="font-mono break-all">cmd: {item.command}</span> : null}
                                                                    {item.truncated ? (
                                                                        <span>budget: {item.originalChars ?? 0} → {item.promptChars ?? 0}</span>
                                                                    ) : (
                                                                        <span>budget: full</span>
                                                                    )}
                                                                </div>
                                                                {item.promptText ? (
                                                                    <div>
                                                                        <div className="text-[10px] text-text-tertiary mb-1">Prompt 注入文本</div>
                                                                        <pre className="whitespace-pre-wrap break-all leading-5">{item.promptText}</pre>
                                                                    </div>
                                                                ) : null}
                                                                {item.summaryText ? (
                                                                    <div>
                                                                        <div className="text-[10px] text-text-tertiary mb-1">摘要</div>
                                                                        <pre className="whitespace-pre-wrap break-all leading-5">{item.summaryText}</pre>
                                                                    </div>
                                                                ) : null}
                                                                {item.resultText ? (
                                                                    <div>
                                                                        <div className="text-[10px] text-text-tertiary mb-1">完整结果</div>
                                                                        <pre className="whitespace-pre-wrap break-all leading-5">{item.resultText}</pre>
                                                                    </div>
                                                                ) : null}
                                                            </div>
                                                        </details>
                                                    ))}
                                                </div>
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

interface ExperimentalSettingsSectionProps {
    flags: FeatureFlags;
    updateFlag: (key: keyof FeatureFlags, value: boolean) => void;
}

export function ExperimentalSettingsSection({ flags, updateFlag }: ExperimentalSettingsSectionProps) {
    return (
        <section className="space-y-6">
            <div>
                <h2 className="text-lg font-medium text-text-primary mb-2">实验性功能</h2>
                <p className="text-xs text-text-tertiary">
                    以下功能仍在开发和测试中，可能不稳定或影响性能。请谨慎开启。
                </p>
            </div>

            <div className="space-y-4">
                <div className="bg-surface-secondary/30 rounded-lg border border-border p-4">
                    <div className="flex items-start justify-between">
                        <div className="flex-1 pr-4">
                            <h3 className="text-sm font-medium text-text-primary flex items-center gap-2">
                                向量推荐
                                <span className="px-1.5 py-0.5 rounded text-[10px] bg-amber-500/10 text-amber-600 font-medium">
                                    Beta
                                </span>
                            </h3>
                            <p className="text-xs text-text-tertiary mt-1.5 leading-relaxed">
                                在稿件编辑器的分栏视图中，根据当前稿件内容的向量相似度对知识库进行智能排序。
                                开启后，与当前内容最相关的素材会优先显示。
                            </p>
                            <p className="text-[10px] text-text-tertiary mt-2 flex items-center gap-1">
                                <AlertCircle className="w-3 h-3" />
                                此功能会调用 Embedding API 计算向量，可能产生额外费用
                            </p>
                        </div>
                        <button
                            type="button"
                            onClick={() => updateFlag('vectorRecommendation', !flags.vectorRecommendation)}
                            className="ui-switch-track w-11 h-6 shrink-0"
                            data-state={flags.vectorRecommendation ? 'on' : 'off'}
                        >
                            <div
                                className={clsx(
                                    'ui-switch-thumb top-1 w-4 h-4',
                                    flags.vectorRecommendation ? 'translate-x-6' : 'translate-x-1'
                                )}
                            />
                        </button>
                    </div>
                </div>
            </div>

        </section>
    );
}

interface SettingsSaveBarProps {
    activeTab: 'general' | 'ai' | 'knowledge' | 'tools' | 'memory' | 'experimental';
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
