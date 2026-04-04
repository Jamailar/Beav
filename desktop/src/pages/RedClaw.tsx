import { useCallback, useEffect, useMemo, useState, type MouseEvent as ReactMouseEvent } from 'react';
import {
    Bot,
    Check,
    ChevronLeft,
    ChevronRight,
    Download,
    Loader2,
    Minimize2,
    Play,
    RefreshCw,
    Sparkles,
    X,
} from 'lucide-react';
import { clsx } from 'clsx';
import { Chat } from './Chat';
import type { PendingChatMessage } from '../App';

const REDCLAW_CONTEXT_ID = 'redclaw-singleton';
const REDCLAW_CONTEXT_TYPE = 'redclaw';
const REDCLAW_CONTEXT = [
    'RedClaw 是一个面向自媒体内容生产与运营的 AI 工作台。',
    '工作目标：基于用户目标推进选题、内容、配图、发布与复盘，并给出可执行的工作流建议。',
    '默认输出结构：目标拆解、内容策略、执行步骤、风险提示。',
].join('\n');

const REDCLAW_SHORTCUTS = [
    { label: '🎯 新建项目', text: '这是一个新的自媒体内容目标，请先创建 RedClaw 项目，再推进完整工作流。' },
    { label: '🧠 生成文案包', text: '请基于当前项目目标生成完整内容文案包，并通过 app_cli 调用 redclaw save-copy 保存。' },
    { label: '🖼️ 生成配图包', text: '请为当前项目生成封面与配图提示词，并通过 app_cli 调用 redclaw save-image 保存。' },
    { label: '📊 复盘本次发布', text: '请基于当前项目进行发布复盘，并通过 app_cli 调用 redclaw save-retro 保存。' },
];

const REDCLAW_WELCOME_SHORTCUTS = [
    { label: '🚀 新建项目', text: '我想开始一个新的自媒体内容项目，请先明确目标并创建项目。' },
    { label: '✍️ 继续文案', text: '继续当前项目，先回顾项目状态，再完成文案包。' },
    { label: '🎨 继续配图', text: '继续当前项目，完善封面和配图提示词，并保存配图包。' },
    { label: '🔁 做复盘', text: '我已经发布了内容，请引导我输入数据并完成复盘。' },
];

const RUNNER_INTERVAL_OPTIONS = [10, 20, 30, 60];
const RUNNER_MAX_AUTOMATION_OPTIONS = [1, 2, 3, 5];
const HEARTBEAT_INTERVAL_OPTIONS = [15, 30, 60, 120];
const REDCLAW_SIDEBAR_MIN_WIDTH = 300;
const REDCLAW_SIDEBAR_MAX_WIDTH = 560;
const REDCLAW_SIDEBAR_DEFAULT_WIDTH = 380;
const REDCLAW_WELCOME_ICON_SRC = new URL('../../public/Box.png', import.meta.url).href;

type ScheduleMode = 'interval' | 'daily' | 'weekly' | 'once';
type RunnerResult = 'success' | 'error' | 'skipped';

type SidebarTab = 'skills';

interface RunnerScheduledTask {
    id: string;
    name: string;
    enabled: boolean;
    mode: ScheduleMode;
    prompt: string;
    projectId?: string;
    intervalMinutes?: number;
    time?: string;
    weekdays?: number[];
    runAt?: string;
    createdAt: string;
    updatedAt: string;
    lastRunAt?: string;
    lastResult?: RunnerResult;
    lastError?: string;
    nextRunAt?: string;
}

interface RunnerLongCycleTask {
    id: string;
    name: string;
    enabled: boolean;
    status: 'running' | 'paused' | 'completed';
    objective: string;
    stepPrompt: string;
    projectId?: string;
    intervalMinutes: number;
    totalRounds: number;
    completedRounds: number;
    createdAt: string;
    updatedAt: string;
    lastRunAt?: string;
    lastResult?: RunnerResult;
    lastError?: string;
    nextRunAt?: string;
}

interface RunnerStatus {
    enabled: boolean;
    lockState: 'owner' | 'passive';
    blockedBy: string | null;
    intervalMinutes: number;
    keepAliveWhenNoWindow: boolean;
    maxProjectsPerTick: number;
    maxAutomationPerTick?: number;
    isTicking: boolean;
    currentProjectId: string | null;
    currentAutomationTaskId?: string | null;
    nextAutomationFireAt?: string | null;
    inFlightTaskIds?: string[];
    inFlightLongCycleTaskIds?: string[];
    heartbeatInFlight?: boolean;
    lastTickAt: string | null;
    nextTickAt: string | null;
    nextMaintenanceAt?: string | null;
    lastError: string | null;
    heartbeat?: {
        enabled: boolean;
        intervalMinutes: number;
        suppressEmptyReport: boolean;
        reportToMainSession: boolean;
        prompt?: string;
        lastRunAt?: string;
        nextRunAt?: string;
        lastDigest?: string;
    };
    scheduledTasks?: Record<string, RunnerScheduledTask>;
    longCycleTasks?: Record<string, RunnerLongCycleTask>;
}

interface RedClawProjectSummary {
    id: string;
    goal: string;
    platform?: string;
    taskType?: string;
    status: string;
    updatedAt: string;
}

interface ScheduleTemplate {
    id: string;
    label: string;
    description: string;
    name: string;
    mode: ScheduleMode;
    intervalMinutes?: number;
    time?: string;
    weekdays?: number[];
    prompt: string;
}

interface LongTemplate {
    id: string;
    label: string;
    description: string;
    name: string;
    objective: string;
    stepPrompt: string;
    intervalMinutes: number;
    totalRounds: number;
}

interface ScheduleDraft {
    templateId: string;
    name: string;
    mode: ScheduleMode;
    projectId: string;
    intervalMinutes: number;
    time: string;
    weekdays: number[];
    runAtLocal: string;
    prompt: string;
}

interface LongDraft {
    templateId: string;
    name: string;
    projectId: string;
    objective: string;
    stepPrompt: string;
    intervalMinutes: number;
    totalRounds: number;
}

interface RedClawProps {
    pendingMessage?: PendingChatMessage | null;
    onPendingMessageConsumed?: () => void;
    onNavigateWorkboard?: () => void;
}

const SCHEDULE_TEMPLATES: ScheduleTemplate[] = [
    {
        id: 'daily-creation',
        label: '每日创作推进',
        description: '每天自动推进当前项目的文案与发布计划',
        name: '每日创作推进',
        mode: 'daily',
        time: '09:30',
        prompt: '请优先选择当前最重要的 RedClaw 项目，推进一次完整创作流程：补齐标题候选、正文、标签和发布计划，并保存文案包。',
    },
    {
        id: 'daily-image',
        label: '每日配图完善',
        description: '每天补齐封面与配图提示词并保存',
        name: '每日配图完善',
        mode: 'daily',
        time: '14:00',
        prompt: '请检查当前重点项目的配图状态，产出封面和配图提示词并保存配图包；若已有配图包，迭代优化。',
    },
    {
        id: 'weekly-retro',
        label: '每周复盘',
        description: '固定每周总结执行结果并给出下一步',
        name: '每周复盘',
        mode: 'weekly',
        time: '21:00',
        weekdays: [1, 4],
        prompt: '请对本周 RedClaw 项目执行情况进行复盘，输出有效动作、问题、下周假设和优先级动作。',
    },
    {
        id: 'interval-watch',
        label: '短周期巡检',
        description: '按固定间隔巡检项目卡点与风险',
        name: '项目巡检',
        mode: 'interval',
        intervalMinutes: 60,
        prompt: '请巡检所有进行中项目，识别卡点和阻塞，输出最小下一步行动，并推动至少一个项目前进。',
    },
];

const LONG_TEMPLATES: LongTemplate[] = [
    {
        id: 'growth-sprint',
        label: '增长冲刺',
        description: '围绕一个目标持续多轮优化',
        name: '30天增长冲刺',
        objective: '在 30 天内建立稳定的自媒体内容产出节奏并提升互动率。',
        stepPrompt: '执行一轮增长冲刺：复盘上一轮结果、调整选题策略、产出新的内容动作并落地到项目。',
        intervalMinutes: 720,
        totalRounds: 30,
    },
    {
        id: 'ip-building',
        label: '个人IP构建',
        description: '持续沉淀人设与内容母题',
        name: '个人IP构建计划',
        objective: '建立清晰的人设定位与可复用内容母题，形成稳定输出体系。',
        stepPrompt: '推进一轮 IP 构建：提炼用户画像、选题母题和表达风格，并输出可执行内容任务。',
        intervalMinutes: 1440,
        totalRounds: 21,
    },
    {
        id: 'topic-lab',
        label: '选题实验室',
        description: '持续验证高潜选题',
        name: '选题实验室',
        objective: '持续验证并筛选高潜选题，形成数据驱动的选题库。',
        stepPrompt: '执行一轮选题实验：提出 3 个选题假设，评估优先级，并推进最优选题进入创作。',
        intervalMinutes: 480,
        totalRounds: 20,
    },
];

const WEEKDAY_OPTIONS = [
    { value: 1, label: '周一' },
    { value: 2, label: '周二' },
    { value: 3, label: '周三' },
    { value: 4, label: '周四' },
    { value: 5, label: '周五' },
    { value: 6, label: '周六' },
    { value: 0, label: '周日' },
];

function normalizeClawHubSlug(input: string): string {
    const value = (input || '').trim();
    if (!value) return '';

    if (/^https?:\/\//i.test(value)) {
        try {
            const url = new URL(value);
            if (url.hostname !== 'clawhub.ai' && url.hostname !== 'www.clawhub.ai') {
                return '';
            }
            const parts = url.pathname.split('/').filter(Boolean);
            if (parts[0] === 'skills' && parts[1]) {
                return parts[1].trim().toLowerCase();
            }
            return '';
        } catch {
            return '';
        }
    }

    return value
        .replace(/^clawhub\//i, '')
        .replace(/^\/+|\/+$/g, '')
        .trim()
        .toLowerCase();
}

function formatDateTime(value?: string | null): string {
    if (!value) return '-';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '-';
    return date.toLocaleString();
}

function pickScheduleTemplate(templateId: string): ScheduleTemplate {
    return SCHEDULE_TEMPLATES.find((item) => item.id === templateId) || SCHEDULE_TEMPLATES[0];
}

function pickLongTemplate(templateId: string): LongTemplate {
    return LONG_TEMPLATES.find((item) => item.id === templateId) || LONG_TEMPLATES[0];
}

function scheduleDraftFromTemplate(template: ScheduleTemplate, keepProjectId = ''): ScheduleDraft {
    return {
        templateId: template.id,
        name: template.name,
        mode: template.mode,
        projectId: keepProjectId,
        intervalMinutes: template.intervalMinutes || 60,
        time: template.time || '09:00',
        weekdays: template.weekdays || [1],
        runAtLocal: '',
        prompt: template.prompt,
    };
}

function longDraftFromTemplate(template: LongTemplate, keepProjectId = ''): LongDraft {
    return {
        templateId: template.id,
        name: template.name,
        projectId: keepProjectId,
        objective: template.objective,
        stepPrompt: template.stepPrompt,
        intervalMinutes: template.intervalMinutes,
        totalRounds: template.totalRounds,
    };
}

function modeLabel(task: RunnerScheduledTask): string {
    if (task.mode === 'interval') return `每 ${task.intervalMinutes || 60} 分钟`;
    if (task.mode === 'daily') return `每天 ${task.time || '--:--'}`;
    if (task.mode === 'weekly') {
        const weekdays = Array.isArray(task.weekdays) ? task.weekdays : [];
        const names = weekdays
            .map((day) => WEEKDAY_OPTIONS.find((item) => item.value === day)?.label)
            .filter(Boolean)
            .join('、');
        return `${names || '每周'} ${task.time || '--:--'}`;
    }
    return `一次性 ${formatDateTime(task.runAt)}`;
}

function resultTone(result?: RunnerResult): string {
    if (result === 'success') return 'text-green-600';
    if (result === 'error') return 'text-red-500';
    if (result === 'skipped') return 'text-amber-500';
    return 'text-text-tertiary';
}

export function RedClaw({ pendingMessage, onPendingMessageConsumed, onNavigateWorkboard }: RedClawProps) {
    const [sessionId, setSessionId] = useState<string | null>(null);
    const [isSessionLoading, setIsSessionLoading] = useState(true);
    const [activeSpaceName, setActiveSpaceName] = useState<string>('默认空间');
    const [chatRefreshKey, setChatRefreshKey] = useState(0);
    const [chatActionLoading, setChatActionLoading] = useState<'clear' | 'compact' | null>(null);
    const [chatActionMessage, setChatActionMessage] = useState('');

    const [sidebarCollapsed, setSidebarCollapsed] = useState(true);
    const [sidebarTab, setSidebarTab] = useState<SidebarTab>('skills');
    const [sidebarWidth, setSidebarWidth] = useState<number>(() => {
        if (typeof window === 'undefined') return REDCLAW_SIDEBAR_DEFAULT_WIDTH;
        const raw = Number(localStorage.getItem('redclaw:sidebarWidth') || REDCLAW_SIDEBAR_DEFAULT_WIDTH);
        if (!Number.isFinite(raw)) return REDCLAW_SIDEBAR_DEFAULT_WIDTH;
        return Math.min(REDCLAW_SIDEBAR_MAX_WIDTH, Math.max(REDCLAW_SIDEBAR_MIN_WIDTH, raw));
    });
    const [isSidebarResizing, setIsSidebarResizing] = useState(false);

    const [skills, setSkills] = useState<SkillDefinition[]>([]);
    const [isSkillsLoading, setIsSkillsLoading] = useState(false);
    const [skillsMessage, setSkillsMessage] = useState('');
    const [installSource, setInstallSource] = useState('');
    const [isInstallingSkill, setIsInstallingSkill] = useState(false);

    const [runnerStatus, setRunnerStatus] = useState<RunnerStatus | null>(null);
    const [automationLoading, setAutomationLoading] = useState(false);
    const [automationMessage, setAutomationMessage] = useState('');
    const [projects, setProjects] = useState<RedClawProjectSummary[]>([]);

    const [runnerIntervalMinutes, setRunnerIntervalMinutes] = useState<number>(20);
    const [runnerMaxAutomationPerTick, setRunnerMaxAutomationPerTick] = useState<number>(2);

    const [heartbeatEnabled, setHeartbeatEnabled] = useState(true);
    const [heartbeatIntervalMinutes, setHeartbeatIntervalMinutes] = useState<number>(30);
    const [heartbeatSuppressEmpty, setHeartbeatSuppressEmpty] = useState(true);
    const [heartbeatReportToMainSession, setHeartbeatReportToMainSession] = useState(true);

    const [scheduleAdvanced, setScheduleAdvanced] = useState(false);
    const [scheduleDraft, setScheduleDraft] = useState<ScheduleDraft>(() => scheduleDraftFromTemplate(SCHEDULE_TEMPLATES[0]));
    const [isAddingSchedule, setIsAddingSchedule] = useState(false);

    const [longAdvanced, setLongAdvanced] = useState(false);
    const [longDraft, setLongDraft] = useState<LongDraft>(() => longDraftFromTemplate(LONG_TEMPLATES[0]));
    const [isAddingLong, setIsAddingLong] = useState(false);

    const initSession = useCallback(async () => {
        setIsSessionLoading(true);
        try {
            const spaceInfo = await window.ipcRenderer.invoke('spaces:list') as {
                activeSpaceId?: string;
                spaces?: Array<{ id: string; name: string }>;
            } | null;
            const activeSpaceId = spaceInfo?.activeSpaceId || 'default';
            const spaceName = spaceInfo?.spaces?.find((space) => space.id === activeSpaceId)?.name || activeSpaceId;
            setActiveSpaceName(spaceName);

            const session = await window.ipcRenderer.chat.getOrCreateContextSession({
                contextId: `${REDCLAW_CONTEXT_ID}:${activeSpaceId}`,
                contextType: REDCLAW_CONTEXT_TYPE,
                title: `RedClaw · ${spaceName}`,
                initialContext: `${REDCLAW_CONTEXT}\n当前空间: ${spaceName} (${activeSpaceId})`,
            });
            setSessionId(session.id);
        } catch (error) {
            console.error('Failed to initialize RedClaw session:', error);
            setSessionId(null);
        } finally {
            setIsSessionLoading(false);
        }
    }, []);

    const applyRunnerForm = useCallback((status: RunnerStatus) => {
        setRunnerIntervalMinutes(status.intervalMinutes || 20);
        setRunnerMaxAutomationPerTick(status.maxAutomationPerTick || 2);
        setHeartbeatEnabled(status.heartbeat?.enabled !== false);
        setHeartbeatIntervalMinutes(status.heartbeat?.intervalMinutes || 30);
        setHeartbeatSuppressEmpty(status.heartbeat?.suppressEmptyReport !== false);
        setHeartbeatReportToMainSession(status.heartbeat?.reportToMainSession !== false);
    }, []);

    const loadRunnerStatus = useCallback(async (syncForm = false) => {
        setAutomationLoading(true);
        try {
            const status = await window.ipcRenderer.redclawRunner.getStatus() as RunnerStatus;
            setRunnerStatus(status);
            if (syncForm) {
                applyRunnerForm(status);
            }
        } catch (error) {
            console.error('Failed to load runner status:', error);
            setAutomationMessage('加载自动化状态失败');
        } finally {
            setAutomationLoading(false);
        }
    }, [applyRunnerForm]);

    const loadProjects = useCallback(async () => {
        try {
            const list = await window.ipcRenderer.invoke('redclaw:list-projects', { limit: 60 }) as RedClawProjectSummary[];
            if (Array.isArray(list)) {
                setProjects(list);
            }
        } catch (error) {
            console.error('Failed to load RedClaw projects:', error);
            setProjects([]);
        }
    }, []);

    const loadSkills = useCallback(async () => {
        setIsSkillsLoading(true);
        try {
            const list = await window.ipcRenderer.listSkills();
            setSkills((list || []) as SkillDefinition[]);
        } catch (error) {
            console.error('Failed to load skills:', error);
            setSkills([]);
        } finally {
            setIsSkillsLoading(false);
        }
    }, []);

    useEffect(() => {
        void initSession();
        void loadRunnerStatus(true);
        void loadProjects();
    }, [initSession, loadProjects, loadRunnerStatus]);

    useEffect(() => {
        const onSpaceChanged = () => {
            void initSession();
            void loadRunnerStatus(true);
            void loadProjects();
            void loadSkills();
        };
        window.ipcRenderer.on('space:changed', onSpaceChanged);
        return () => {
            window.ipcRenderer.off('space:changed', onSpaceChanged);
        };
    }, [initSession, loadProjects, loadRunnerStatus, loadSkills]);

    useEffect(() => {
        if (sidebarTab !== 'skills') return;
        void loadSkills();
    }, [sidebarTab, loadSkills]);

    useEffect(() => {
        const onRunnerStatus = (_event: unknown, status: RunnerStatus) => {
            if (!status || typeof status !== 'object') return;
            setRunnerStatus(status);
        };
        window.ipcRenderer.on('redclaw:runner-status', onRunnerStatus);
        return () => {
            window.ipcRenderer.off('redclaw:runner-status', onRunnerStatus);
        };
    }, []);

    useEffect(() => {
        if (!chatActionMessage) return;
        const timer = window.setTimeout(() => setChatActionMessage(''), 2600);
        return () => window.clearTimeout(timer);
    }, [chatActionMessage]);

    useEffect(() => {
        localStorage.setItem('redclaw:sidebarWidth', String(Math.round(sidebarWidth)));
    }, [sidebarWidth]);

    useEffect(() => {
        if (!automationMessage) return;
        const timer = window.setTimeout(() => setAutomationMessage(''), 2800);
        return () => window.clearTimeout(timer);
    }, [automationMessage]);

    useEffect(() => {
        if (!skillsMessage) return;
        const timer = window.setTimeout(() => setSkillsMessage(''), 2800);
        return () => window.clearTimeout(timer);
    }, [skillsMessage]);

    const enabledSkillCount = useMemo(() => skills.filter((skill) => !skill.disabled).length, [skills]);

    const scheduledTasks = useMemo(() => {
        const list = Object.values(runnerStatus?.scheduledTasks || {}) as RunnerScheduledTask[];
        return list.sort((a, b) => {
            const aTime = a.nextRunAt ? new Date(a.nextRunAt).getTime() : Number.MAX_SAFE_INTEGER;
            const bTime = b.nextRunAt ? new Date(b.nextRunAt).getTime() : Number.MAX_SAFE_INTEGER;
            return aTime - bTime;
        });
    }, [runnerStatus]);

    const longTasks = useMemo(() => {
        const list = Object.values(runnerStatus?.longCycleTasks || {}) as RunnerLongCycleTask[];
        return list.sort((a, b) => {
            const aTime = a.nextRunAt ? new Date(a.nextRunAt).getTime() : Number.MAX_SAFE_INTEGER;
            const bTime = b.nextRunAt ? new Date(b.nextRunAt).getTime() : Number.MAX_SAFE_INTEGER;
            return aTime - bTime;
        });
    }, [runnerStatus]);

    const compactRedClawContext = useCallback(async () => {
        if (!sessionId || chatActionLoading) return;
        setChatActionLoading('compact');
        try {
            const result = await window.ipcRenderer.chat.compactContext(sessionId);
            if (!result?.success) {
                setChatActionMessage(result?.message || '压缩失败，请稍后重试');
                return;
            }
            if (result.compacted) {
                setChatRefreshKey((value) => value + 1);
            }
            setChatActionMessage(result.message || (result.compacted ? '上下文已压缩' : '暂无可压缩内容'));
        } catch (error) {
            console.error('Failed to compact RedClaw context:', error);
            setChatActionMessage('压缩失败，请稍后重试');
        } finally {
            setChatActionLoading(null);
        }
    }, [chatActionLoading, sessionId]);

    const toggleSkill = useCallback(async (skill: SkillDefinition) => {
        try {
            const channel = skill.disabled ? 'skills:enable' : 'skills:disable';
            const res = await window.ipcRenderer.invoke(channel, { name: skill.name }) as { success?: boolean; error?: string };
            if (!res?.success) {
                setSkillsMessage(res?.error || '技能状态更新失败');
                return;
            }
            setSkillsMessage(skill.disabled ? `已启用：${skill.name}` : `已禁用：${skill.name}`);
            await loadSkills();
        } catch (error) {
            console.error('Failed to toggle skill:', error);
            setSkillsMessage('技能状态更新失败');
        }
    }, [loadSkills]);

    const installSkill = useCallback(async () => {
        if (isInstallingSkill) return;

        const slug = normalizeClawHubSlug(installSource);
        if (!slug) {
            setSkillsMessage('请输入 ClawHub 技能 slug 或技能链接');
            return;
        }

        setIsInstallingSkill(true);
        try {
            const result = await window.ipcRenderer.invoke('skills:market-install', { slug, tag: 'latest' }) as {
                success?: boolean;
                error?: string;
                displayName?: string;
            };
            if (!result?.success) {
                setSkillsMessage(result?.error || '技能安装失败');
                return;
            }
            setInstallSource('');
            setSkillsMessage(`已安装技能：${result.displayName || slug}`);
            await loadSkills();
        } catch (error) {
            console.error('Failed to install skill:', error);
            setSkillsMessage('技能安装失败');
        } finally {
            setIsInstallingSkill(false);
        }
    }, [installSource, isInstallingSkill, loadSkills]);

    const toggleRunner = useCallback(async () => {
        if (!runnerStatus) return;
        setAutomationLoading(true);
        try {
            if (runnerStatus.enabled) {
                await window.ipcRenderer.redclawRunner.stop();
                setAutomationMessage('后台任务已暂停');
            } else {
                await window.ipcRenderer.redclawRunner.start({
                    intervalMinutes: runnerIntervalMinutes,
                    maxAutomationPerTick: runnerMaxAutomationPerTick,
                    heartbeatEnabled,
                    heartbeatIntervalMinutes,
                });
                setAutomationMessage('后台任务已启动');
            }
            await loadRunnerStatus(true);
        } catch (error) {
            console.error('Failed to toggle runner:', error);
            setAutomationMessage('更新后台状态失败');
        } finally {
            setAutomationLoading(false);
        }
    }, [
        heartbeatEnabled,
        heartbeatIntervalMinutes,
        loadRunnerStatus,
        runnerIntervalMinutes,
        runnerMaxAutomationPerTick,
        runnerStatus,
    ]);

    const runRunnerNow = useCallback(async () => {
        setAutomationLoading(true);
        try {
            await window.ipcRenderer.redclawRunner.runNow({});
            setAutomationMessage('已触发后台立即执行');
            await loadRunnerStatus(false);
        } catch (error) {
            console.error('Failed to run runner now:', error);
            setAutomationMessage('触发后台执行失败');
        } finally {
            setAutomationLoading(false);
        }
    }, [loadRunnerStatus]);

    const saveRunnerConfig = useCallback(async () => {
        setAutomationLoading(true);
        try {
            await window.ipcRenderer.redclawRunner.setConfig({
                intervalMinutes: runnerIntervalMinutes,
                maxAutomationPerTick: runnerMaxAutomationPerTick,
            });
            setAutomationMessage('后台配置已保存');
            await loadRunnerStatus(true);
        } catch (error) {
            console.error('Failed to save runner config:', error);
            setAutomationMessage('保存后台配置失败');
        } finally {
            setAutomationLoading(false);
        }
    }, [loadRunnerStatus, runnerIntervalMinutes, runnerMaxAutomationPerTick]);

    const saveHeartbeatConfig = useCallback(async () => {
        setAutomationLoading(true);
        try {
            await window.ipcRenderer.redclawRunner.setConfig({
                heartbeatEnabled,
                heartbeatIntervalMinutes,
                heartbeatSuppressEmptyReport: heartbeatSuppressEmpty,
                heartbeatReportToMainSession,
            });
            setAutomationMessage('心跳配置已保存');
            await loadRunnerStatus(true);
        } catch (error) {
            console.error('Failed to save heartbeat config:', error);
            setAutomationMessage('保存心跳配置失败');
        } finally {
            setAutomationLoading(false);
        }
    }, [heartbeatEnabled, heartbeatIntervalMinutes, heartbeatReportToMainSession, heartbeatSuppressEmpty, loadRunnerStatus]);

    const applyScheduleTemplate = useCallback((templateId: string) => {
        const template = pickScheduleTemplate(templateId);
        setScheduleDraft((prev) => scheduleDraftFromTemplate(template, prev.projectId));
    }, []);

    const addScheduleTask = useCallback(async () => {
        if (isAddingSchedule) return;
        const draft = scheduleDraft;
        if (!draft.prompt.trim()) {
            setAutomationMessage('任务指令不能为空');
            return;
        }
        if ((draft.mode === 'daily' || draft.mode === 'weekly') && !draft.time.trim()) {
            setAutomationMessage('请设置执行时间');
            return;
        }
        if (draft.mode === 'weekly' && draft.weekdays.length === 0) {
            setAutomationMessage('请至少选择一个周几');
            return;
        }

        let runAt: string | undefined;
        if (draft.mode === 'once') {
            const ms = new Date(draft.runAtLocal).getTime();
            if (!Number.isFinite(ms)) {
                setAutomationMessage('请设置一次性任务时间');
                return;
            }
            runAt = new Date(ms).toISOString();
        }

        setIsAddingSchedule(true);
        try {
            const result = await window.ipcRenderer.redclawRunner.addScheduled({
                name: draft.name.trim() || '定时任务',
                mode: draft.mode,
                prompt: draft.prompt.trim(),
                projectId: draft.projectId || undefined,
                intervalMinutes: draft.mode === 'interval' ? draft.intervalMinutes : undefined,
                time: draft.mode === 'daily' || draft.mode === 'weekly' ? draft.time : undefined,
                weekdays: draft.mode === 'weekly' ? draft.weekdays : undefined,
                runAt,
                enabled: true,
            });
            if (!result?.success) {
                setAutomationMessage(result?.error || '新增定时任务失败');
                return;
            }
            setAutomationMessage('已新增定时任务');
            applyScheduleTemplate(draft.templateId);
            await loadRunnerStatus(false);
        } catch (error) {
            console.error('Failed to add schedule task:', error);
            setAutomationMessage('新增定时任务失败');
        } finally {
            setIsAddingSchedule(false);
        }
    }, [applyScheduleTemplate, isAddingSchedule, loadRunnerStatus, scheduleDraft]);

    const toggleScheduleTask = useCallback(async (task: RunnerScheduledTask) => {
        setAutomationLoading(true);
        try {
            const result = await window.ipcRenderer.redclawRunner.setScheduledEnabled({
                taskId: task.id,
                enabled: !task.enabled,
            });
            if (!result?.success) {
                setAutomationMessage(result?.error || '更新定时任务失败');
                return;
            }
            setAutomationMessage(task.enabled ? '定时任务已暂停' : '定时任务已启用');
            await loadRunnerStatus(false);
        } catch (error) {
            console.error('Failed to toggle schedule task:', error);
            setAutomationMessage('更新定时任务失败');
        } finally {
            setAutomationLoading(false);
        }
    }, [loadRunnerStatus]);

    const runScheduleTaskNow = useCallback(async (taskId: string) => {
        setAutomationLoading(true);
        try {
            const result = await window.ipcRenderer.redclawRunner.runScheduledNow({ taskId });
            if (!result?.success) {
                setAutomationMessage(result?.error || '触发执行失败');
                return;
            }
            setAutomationMessage('已触发定时任务执行');
            await loadRunnerStatus(false);
        } catch (error) {
            console.error('Failed to run schedule now:', error);
            setAutomationMessage('触发执行失败');
        } finally {
            setAutomationLoading(false);
        }
    }, [loadRunnerStatus]);

    const removeScheduleTask = useCallback(async (taskId: string) => {
        setAutomationLoading(true);
        try {
            const result = await window.ipcRenderer.redclawRunner.removeScheduled({ taskId });
            if (!result?.success) {
                setAutomationMessage(result?.error || '删除定时任务失败');
                return;
            }
            setAutomationMessage('定时任务已删除');
            await loadRunnerStatus(false);
        } catch (error) {
            console.error('Failed to remove schedule task:', error);
            setAutomationMessage('删除定时任务失败');
        } finally {
            setAutomationLoading(false);
        }
    }, [loadRunnerStatus]);

    const applyLongTemplate = useCallback((templateId: string) => {
        const template = pickLongTemplate(templateId);
        setLongDraft((prev) => longDraftFromTemplate(template, prev.projectId));
    }, []);

    const addLongTask = useCallback(async () => {
        if (isAddingLong) return;
        const draft = longDraft;
        if (!draft.objective.trim() || !draft.stepPrompt.trim()) {
            setAutomationMessage('请填写长期目标与每轮指令');
            return;
        }

        setIsAddingLong(true);
        try {
            const result = await window.ipcRenderer.redclawRunner.addLongCycle({
                name: draft.name.trim() || '长周期任务',
                objective: draft.objective.trim(),
                stepPrompt: draft.stepPrompt.trim(),
                projectId: draft.projectId || undefined,
                intervalMinutes: draft.intervalMinutes,
                totalRounds: draft.totalRounds,
                enabled: true,
            });
            if (!result?.success) {
                setAutomationMessage(result?.error || '新增长周期任务失败');
                return;
            }
            setAutomationMessage('已新增长周期任务');
            applyLongTemplate(draft.templateId);
            await loadRunnerStatus(false);
        } catch (error) {
            console.error('Failed to add long task:', error);
            setAutomationMessage('新增长周期任务失败');
        } finally {
            setIsAddingLong(false);
        }
    }, [applyLongTemplate, isAddingLong, loadRunnerStatus, longDraft]);

    const toggleLongTask = useCallback(async (task: RunnerLongCycleTask) => {
        setAutomationLoading(true);
        try {
            const result = await window.ipcRenderer.redclawRunner.setLongCycleEnabled({
                taskId: task.id,
                enabled: !task.enabled,
            });
            if (!result?.success) {
                setAutomationMessage(result?.error || '更新长周期任务失败');
                return;
            }
            setAutomationMessage(task.enabled ? '长周期任务已暂停' : '长周期任务已启用');
            await loadRunnerStatus(false);
        } catch (error) {
            console.error('Failed to toggle long task:', error);
            setAutomationMessage('更新长周期任务失败');
        } finally {
            setAutomationLoading(false);
        }
    }, [loadRunnerStatus]);

    const runLongTaskNow = useCallback(async (taskId: string) => {
        setAutomationLoading(true);
        try {
            const result = await window.ipcRenderer.redclawRunner.runLongCycleNow({ taskId });
            if (!result?.success) {
                setAutomationMessage(result?.error || '触发执行失败');
                return;
            }
            setAutomationMessage('已触发长周期任务执行');
            await loadRunnerStatus(false);
        } catch (error) {
            console.error('Failed to run long task now:', error);
            setAutomationMessage('触发执行失败');
        } finally {
            setAutomationLoading(false);
        }
    }, [loadRunnerStatus]);

    const removeLongTask = useCallback(async (taskId: string) => {
        setAutomationLoading(true);
        try {
            const result = await window.ipcRenderer.redclawRunner.removeLongCycle({ taskId });
            if (!result?.success) {
                setAutomationMessage(result?.error || '删除长周期任务失败');
                return;
            }
            setAutomationMessage('长周期任务已删除');
            await loadRunnerStatus(false);
        } catch (error) {
            console.error('Failed to remove long task:', error);
            setAutomationMessage('删除长周期任务失败');
        } finally {
            setAutomationLoading(false);
        }
    }, [loadRunnerStatus]);

    const startSidebarResize = useCallback((event: ReactMouseEvent<HTMLDivElement>) => {
        event.preventDefault();
        event.stopPropagation();
        setIsSidebarResizing(true);
        const startX = event.clientX;
        const startWidth = sidebarWidth;

        const handleMouseMove = (moveEvent: MouseEvent) => {
            const delta = startX - moveEvent.clientX;
            const next = Math.min(
                REDCLAW_SIDEBAR_MAX_WIDTH,
                Math.max(REDCLAW_SIDEBAR_MIN_WIDTH, startWidth + delta)
            );
            setSidebarWidth(next);
        };

        const handleMouseUp = () => {
            setIsSidebarResizing(false);
            window.removeEventListener('mousemove', handleMouseMove);
            window.removeEventListener('mouseup', handleMouseUp);
        };

        window.addEventListener('mousemove', handleMouseMove);
        window.addEventListener('mouseup', handleMouseUp);
    }, [sidebarWidth]);

    return (
        <div className="h-full min-h-0 flex overflow-hidden bg-surface-primary">
            <div className="relative flex-1 min-w-0 overflow-hidden">
                {isSessionLoading ? (
                    <div className="h-full flex items-center justify-center">
                        <div className="flex flex-col items-center gap-3 text-text-tertiary">
                            <Loader2 className="w-6 h-6 animate-spin" />
                            <span className="text-xs">正在初始化 RedClaw...</span>
                        </div>
                    </div>
                ) : sessionId ? (
                    <div className="h-full min-h-0 flex flex-col">
                        <div className="relative min-h-0 flex-1 overflow-hidden">
                            <Chat
                                key={`${sessionId}:${chatRefreshKey}`}
                                fixedSessionId={sessionId}
                                pendingMessage={pendingMessage}
                                onMessageConsumed={onPendingMessageConsumed}
                                defaultCollapsed={true}
                                showClearButton={true}
                                fixedSessionBannerText=""
                                showWelcomeShortcuts={false}
                                showComposerShortcuts={false}
                                fixedSessionContextIndicatorMode={sidebarCollapsed ? 'corner-ring' : 'none'}
                                shortcuts={REDCLAW_SHORTCUTS}
                                welcomeShortcuts={REDCLAW_WELCOME_SHORTCUTS}
                                welcomeTitle="RedClaw 自媒体AI工作台"
                                welcomeSubtitle=""
                                welcomeIconSrc={REDCLAW_WELCOME_ICON_SRC}
                                contentLayout={sidebarCollapsed ? 'wide' : 'default'}
                                contentWidthPreset="narrow"
                                allowFileUpload={true}
                                messageWorkflowPlacement="bottom"
                                messageWorkflowVariant="compact"
                                messageWorkflowEmphasis="default"
                            />
                            {sidebarCollapsed && (
                                <button
                                    type="button"
                                    onClick={() => {
                                        setSidebarCollapsed(false);
                                        setSidebarTab('skills');
                                    }}
                                    className="absolute right-2 top-1/2 -translate-y-1/2 z-20 h-14 w-6 rounded-l-lg border border-r-0 border-border bg-surface-primary/92 text-text-tertiary shadow-sm backdrop-blur transition-colors hover:text-accent-primary hover:border-accent-primary/40"
                                    title="展开 RedClaw 侧栏"
                                    aria-label="展开 RedClaw 侧栏"
                                >
                                    <ChevronLeft className="w-4 h-4 mx-auto" />
                                </button>
                            )}
                        </div>
                    </div>
                ) : (
                    <div className="h-full flex items-center justify-center text-text-tertiary text-sm">
                        RedClaw 会话初始化失败
                    </div>
                )}
            </div>

            <aside
                className={clsx(
                    'relative shrink-0 bg-surface-secondary/30 overflow-hidden',
                    sidebarCollapsed ? 'border-l-0' : 'border-l border-border',
                    !isSidebarResizing && 'transition-[width] duration-200 ease-out'
                )}
                style={{ width: sidebarCollapsed ? 0 : sidebarWidth }}
            >
                {!sidebarCollapsed && (
                    <div className="h-full flex flex-col">
                        <div
                            className="absolute left-0 top-0 z-20 h-full w-2 -translate-x-1/2 cursor-col-resize"
                            onMouseDown={startSidebarResize}
                            title="拖拽调整侧栏宽度"
                            aria-label="拖拽调整侧栏宽度"
                        />
                        <div className="px-4 py-3 border-b border-border">
                        <div className="flex items-center justify-between">
                            <div>
                                <div className="text-sm font-semibold text-text-primary">RedClaw 侧栏</div>
                                <div className="text-[11px] text-text-tertiary">空间：{activeSpaceName}</div>
                            </div>
                            <div className="flex items-center gap-1">
                                <button
                                    onClick={() => void compactRedClawContext()}
                                    disabled={chatActionLoading !== null}
                                    className="p-1.5 rounded-md text-text-tertiary hover:text-accent-primary hover:bg-surface-secondary disabled:opacity-60"
                                    title="压缩上下文"
                                >
                                    {chatActionLoading === 'compact' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Minimize2 className="w-4 h-4" />}
                                </button>
                                <button
                                    onClick={() => setSidebarCollapsed(true)}
                                    className="p-1.5 rounded-md text-text-tertiary hover:text-text-primary hover:bg-surface-secondary"
                                    title="收起 RedClaw 侧栏"
                                >
                                    <X className="w-4 h-4" />
                                </button>
                            </div>
                        </div>
                        <div className="mt-3 p-1 rounded-lg bg-surface-secondary border border-border flex gap-1">
                            <button
                                onClick={() => setSidebarTab('skills')}
                                className={clsx(
                                    'flex-1 px-2 py-1.5 rounded-md text-xs transition-colors flex items-center justify-center gap-1',
                                    sidebarTab === 'skills'
                                        ? 'bg-surface-primary text-text-primary border border-border'
                                        : 'text-text-secondary hover:text-text-primary'
                                )}
                            >
                                <Sparkles className="w-3.5 h-3.5" />
                                技能
                            </button>
                        </div>
                        {chatActionMessage && (
                            <div className="mt-3 text-xs px-3 py-2 rounded-lg border border-border bg-surface-primary text-text-secondary shadow-sm">
                                {chatActionMessage}
                            </div>
                        )}
                    </div>

                    <div className="flex-1 overflow-y-auto overflow-x-hidden p-4 space-y-3">
                            <div className="rounded-xl border border-border bg-surface-primary p-3 space-y-2">
                                <div className="text-xs text-text-secondary font-medium">安装技能</div>
                                <input
                                    type="text"
                                    value={installSource}
                                    onChange={(event) => setInstallSource(event.target.value)}
                                    onKeyDown={(event) => {
                                        if (event.key === 'Enter') {
                                            void installSkill();
                                        }
                                    }}
                                    placeholder="输入 skill slug 或 ClawHub 链接"
                                    className="w-full px-3 py-2 rounded-md border border-border bg-surface-secondary text-xs text-text-primary placeholder:text-text-tertiary focus:outline-none focus:ring-1 focus:ring-accent-primary"
                                />
                                <button
                                    onClick={() => void installSkill()}
                                    disabled={isInstallingSkill || !installSource.trim()}
                                    className="w-full px-3 py-2 rounded-md text-xs border border-border bg-surface-secondary text-text-secondary hover:text-accent-primary hover:border-accent-primary/40 transition-colors disabled:opacity-60 flex items-center justify-center gap-2"
                                >
                                    {isInstallingSkill ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Download className="w-3.5 h-3.5" />}
                                    <span>{isInstallingSkill ? '安装中...' : '安装技能'}</span>
                                </button>
                            </div>

                            <div className="text-[11px] text-text-tertiary">已启用 {enabledSkillCount} 个技能</div>

                            {isSkillsLoading ? (
                                <div className="text-xs text-text-tertiary flex items-center gap-2">
                                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                                    正在加载技能...
                                </div>
                            ) : skills.length === 0 ? (
                                <div className="text-xs text-text-tertiary border border-dashed border-border rounded-lg p-4">
                                    当前空间还没有技能。
                                </div>
                            ) : (
                                skills.map((skill) => (
                                    <div key={skill.location} className="rounded-xl border border-border bg-surface-primary p-3">
                                        <div className="flex items-start justify-between gap-2">
                                            <div className="min-w-0">
                                                <div className="text-sm text-text-primary font-medium truncate">{skill.name}</div>
                                                <div className="text-xs text-text-tertiary mt-1 line-clamp-2">{skill.description || '无描述'}</div>
                                                <div className="text-[11px] text-text-tertiary mt-2 truncate">{skill.location}</div>
                                            </div>
                                            <button
                                                onClick={() => void toggleSkill(skill)}
                                                className={clsx(
                                                    'px-2.5 py-1 rounded text-[11px] border transition-colors shrink-0',
                                                    skill.disabled
                                                        ? 'border-border text-text-tertiary hover:text-text-primary hover:border-text-tertiary'
                                                        : 'border-green-500/40 text-green-600 hover:bg-green-500/10'
                                                )}
                                            >
                                                {skill.disabled ? '已禁用' : '已启用'}
                                            </button>
                                        </div>
                                    </div>
                                ))
                            )}

                            {skillsMessage && (
                                <div className="text-xs px-3 py-2 rounded-lg border border-border bg-surface-primary text-text-secondary">
                                    {skillsMessage}
                                </div>
                            )}
                        </div>
                    </div>
                )}
            </aside>
        </div>
    );
}
