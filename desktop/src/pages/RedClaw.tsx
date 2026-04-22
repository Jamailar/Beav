import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react';
import { Loader2, Sparkles, MessageSquarePlus, Heart } from 'lucide-react';
import { clsx } from 'clsx';
import { Chat } from './Chat';
import type { PendingChatMessage } from '../App';
import { uiMeasure, uiTraceInteraction } from '../utils/uiDebug';
import {
    HEARTBEAT_INTERVAL_OPTIONS,
    LONG_TEMPLATES,
    REDCLAW_CONTEXT_TYPE,
    REDCLAW_SHORTCUTS,
    REDCLAW_SIDEBAR_DEFAULT_WIDTH,
    REDCLAW_SIDEBAR_MAX_WIDTH,
    REDCLAW_SIDEBAR_MIN_WIDTH,
    REDCLAW_WELCOME_ICON_SRC,
    REDCLAW_WELCOME_SHORTCUTS,
    RUNNER_INTERVAL_OPTIONS,
    RUNNER_MAX_AUTOMATION_OPTIONS,
    SCHEDULE_TEMPLATES,
    longDraftFromTemplate,
    pickLongTemplate,
    pickScheduleTemplate,
    scheduleDraftFromTemplate,
} from './redclaw/config';
import {
    buildRedClawContextId,
    buildRedClawInitialContext,
    buildRedClawSessionTitle,
    createContextSessionListItem,
    normalizeClawHubSlug,
    sortContextSessionItems,
} from './redclaw/helpers';
import { RedClawHistoryDrawer } from './redclaw/RedClawHistoryDrawer';
import { RedClawSidebar } from './redclaw/RedClawSidebar';
import type {
    LongDraft,
    RunnerLongCycleTask,
    RunnerScheduledTask,
    RunnerStatus,
    ScheduleDraft,
    SidebarTab,
} from './redclaw/types';

interface RedClawProps {
    pendingMessage?: PendingChatMessage | null;
    onPendingMessageConsumed?: () => void;
    isActive?: boolean;
    onExecutionStateChange?: (active: boolean) => void;
}

interface RedClawSpaceListPayload {
    activeSpaceId: string;
    spaces: Array<{ id: string; name: string }>;
}

const normalizeRedClawSpaceListPayload = (value: unknown): RedClawSpaceListPayload => {
    const raw = (value && typeof value === 'object') ? value as {
        activeSpaceId?: unknown;
        spaces?: unknown;
    } : {};
    const spaces = Array.isArray(raw.spaces)
        ? raw.spaces
            .map((space) => {
                if (!space || typeof space !== 'object') return null;
                const record = space as Record<string, unknown>;
                const id = String(record.id || '').trim();
                if (!id) return null;
                const name = String(record.name || id).trim() || id;
                return { id, name };
            })
            .filter((space): space is { id: string; name: string } => Boolean(space))
        : [];
    const activeSpaceId = String(raw.activeSpaceId || spaces[0]?.id || 'default').trim() || 'default';
    return {
        activeSpaceId,
        spaces: spaces.length > 0 ? spaces : [{ id: 'default', name: '默认空间' }],
    };
};

function redClawLastSessionStorageKey(spaceId: string): string {
    const normalized = String(spaceId || 'default').trim() || 'default';
    return `redclaw:lastSession:${normalized}`;
}

function readRedClawLastSessionId(spaceId: string): string | null {
    if (typeof window === 'undefined') return null;
    const raw = localStorage.getItem(redClawLastSessionStorageKey(spaceId));
    const sessionId = String(raw || '').trim();
    return sessionId || null;
}

export function RedClaw({
    pendingMessage,
    onPendingMessageConsumed,
    isActive = true,
    onExecutionStateChange,
}: RedClawProps) {
    const debugUi = useCallback((event: string, extra?: Record<string, unknown>) => {
        if (!import.meta.env.DEV) return;
        console.debug(`[ui][redclaw] ${event}`, extra || {});
    }, []);
    const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
    const [sessionList, setSessionList] = useState<ContextChatSessionListItem[]>([]);
    const [isSessionLoading, setIsSessionLoading] = useState(true);
    const [historyLoading, setHistoryLoading] = useState(false);
    const [historyDrawerOpen, setHistoryDrawerOpen] = useState(false);
    const [activeSpaceName, setActiveSpaceName] = useState<string>('默认空间');
    const [activeSpaceId, setActiveSpaceId] = useState<string>('default');
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
    const sessionRequestIdRef = useRef(0);
    const activeSessionIdRef = useRef<string | null>(null);
    const sessionListRef = useRef<ContextChatSessionListItem[]>([]);
    const runnerStatusRequestIdRef = useRef(0);
    const skillsRequestIdRef = useRef(0);
    const hasSessionSnapshotRef = useRef(false);
    const hasRunnerSnapshotRef = useRef(false);
    const hasSkillsSnapshotRef = useRef(false);

    useEffect(() => {
        activeSessionIdRef.current = activeSessionId;
    }, [activeSessionId]);

    useEffect(() => {
        if (typeof window === 'undefined') return;
        if (!activeSpaceId || !activeSessionId) return;
        localStorage.setItem(redClawLastSessionStorageKey(activeSpaceId), activeSessionId);
    }, [activeSessionId, activeSpaceId]);

    useEffect(() => {
        sessionListRef.current = sessionList;
    }, [sessionList]);

    const loadContextSessions = useCallback(async (
        nextActiveSpaceId: string,
        nextSpaceName: string,
        options?: {
            preferredSessionId?: string | null;
            createIfEmpty?: boolean;
            silent?: boolean;
        },
    ) => {
        const requestId = ++sessionRequestIdRef.current;
        const shouldCreateIfEmpty = options?.createIfEmpty !== false;
        if (!hasSessionSnapshotRef.current && !options?.silent) {
            setIsSessionLoading(true);
        }
        if (!options?.silent) {
            setHistoryLoading(true);
        }

        try {
            const contextId = buildRedClawContextId(nextActiveSpaceId);
            const listResult = await uiMeasure('redclaw', 'sessions:list_context', async () => (
                window.ipcRenderer.invokeGuarded<ContextChatSessionListItem[] | null>('chat:list-context-sessions', {
                    contextId,
                    contextType: REDCLAW_CONTEXT_TYPE,
                }, {
                    timeoutMs: 3200,
                    fallback: null,
                    normalize: (value) => Array.isArray(value) ? value as ContextChatSessionListItem[] : [],
                })
            ), { activeSpaceId: nextActiveSpaceId, spaceName: nextSpaceName }) as ContextChatSessionListItem[];

            if (requestId !== sessionRequestIdRef.current) return;
            if (listResult == null) {
                if (!hasSessionSnapshotRef.current) {
                    setActiveSpaceId(nextActiveSpaceId);
                    setActiveSpaceName(nextSpaceName);
                    setSessionList([]);
                    setActiveSessionId(null);
                }
                return;
            }

            let items = sortContextSessionItems(listResult);
            const rememberedSessionId = readRedClawLastSessionId(nextActiveSpaceId);

            let nextActiveSessionId =
                options?.preferredSessionId && items.some((item) => item.id === options.preferredSessionId)
                    ? options.preferredSessionId
                    : activeSessionIdRef.current && items.some((item) => item.id === activeSessionIdRef.current)
                        ? activeSessionIdRef.current
                        : rememberedSessionId && items.some((item) => item.id === rememberedSessionId)
                            ? rememberedSessionId
                        : items[0]?.id || null;

            if (items.length === 0 && shouldCreateIfEmpty) {
                const created = await uiMeasure('redclaw', 'sessions:create_context', async () => (
                    window.ipcRenderer.invokeGuarded<ChatSession | null>('chat:create-context-session', {
                        contextId,
                        contextType: REDCLAW_CONTEXT_TYPE,
                        title: buildRedClawSessionTitle(nextSpaceName),
                        initialContext: buildRedClawInitialContext(nextSpaceName, nextActiveSpaceId),
                    }, {
                        timeoutMs: 3200,
                        fallback: null,
                    })
                ), { activeSpaceId: nextActiveSpaceId, spaceName: nextSpaceName });
                if (!created) {
                    if (!hasSessionSnapshotRef.current) {
                        setSessionList([]);
                        setActiveSessionId(null);
                    }
                    return;
                }
                items = [createContextSessionListItem(created)];
                nextActiveSessionId = created.id;
            }

            if (requestId !== sessionRequestIdRef.current) return;

            setActiveSpaceId(nextActiveSpaceId);
            setActiveSpaceName(nextSpaceName);
            setSessionList(items);
            setActiveSessionId(nextActiveSessionId);
            hasSessionSnapshotRef.current = true;
            debugUi('sessions:loaded', {
                activeSessionId: nextActiveSessionId,
                count: items.length,
                activeSpaceId: nextActiveSpaceId,
                spaceName: nextSpaceName,
            });
        } catch (error) {
            console.error('Failed to load RedClaw context sessions:', error);
            if (!hasSessionSnapshotRef.current) {
                setSessionList([]);
                setActiveSessionId(null);
            }
        } finally {
            if (requestId === sessionRequestIdRef.current) {
                setIsSessionLoading(false);
                setHistoryLoading(false);
            }
        }
    }, [debugUi]);

    const initSession = useCallback(async () => {
        if (!hasSessionSnapshotRef.current) {
            setIsSessionLoading(true);
        }
        try {
            const spaceInfo = await uiMeasure('redclaw', 'init_session:spaces', async () => (
                window.ipcRenderer.spaces.list()
            )) as RedClawSpaceListPayload;
            const normalizedSpaceInfo = normalizeRedClawSpaceListPayload(spaceInfo);
            const nextActiveSpaceId = normalizedSpaceInfo.activeSpaceId || 'default';
            const nextSpaceName = normalizedSpaceInfo.spaces.find((space) => space.id === nextActiveSpaceId)?.name || nextActiveSpaceId;
            await loadContextSessions(nextActiveSpaceId, nextSpaceName, { createIfEmpty: true });
        } catch (error) {
            console.error('Failed to initialize RedClaw session list:', error);
            if (!hasSessionSnapshotRef.current) {
                setSessionList([]);
                setActiveSessionId(null);
                setIsSessionLoading(false);
            }
        }
    }, [loadContextSessions]);

    const applyRunnerForm = useCallback((status: RunnerStatus) => {
        setRunnerIntervalMinutes(status.intervalMinutes || 20);
        setRunnerMaxAutomationPerTick(status.maxAutomationPerTick || 2);
        setHeartbeatEnabled(status.heartbeat?.enabled !== false);
        setHeartbeatIntervalMinutes(status.heartbeat?.intervalMinutes || 30);
        setHeartbeatSuppressEmpty(status.heartbeat?.suppressEmptyReport !== false);
        setHeartbeatReportToMainSession(status.heartbeat?.reportToMainSession !== false);
    }, []);

    const loadRunnerStatus = useCallback(async (syncForm = false) => {
        const requestId = ++runnerStatusRequestIdRef.current;
        if (!hasRunnerSnapshotRef.current) {
            setAutomationLoading(true);
        }
        try {
            const status = await uiMeasure('redclaw', 'load_runner_status', async () => (
                window.ipcRenderer.invokeGuarded<RunnerStatus | null>('redclaw:runner-status', undefined, {
                    timeoutMs: 2800,
                    fallback: null,
                })
            ), { syncForm }) as RunnerStatus | null;
            if (requestId !== runnerStatusRequestIdRef.current) return;
            if (!status) {
                if (!hasRunnerSnapshotRef.current) {
                    setRunnerStatus(null);
                }
                return;
            }
            setRunnerStatus(status);
            hasRunnerSnapshotRef.current = true;
            if (syncForm) {
                applyRunnerForm(status);
            }
        } catch (error) {
            console.error('Failed to load runner status:', error);
            setAutomationMessage('加载自动化状态失败');
        } finally {
            if (requestId === runnerStatusRequestIdRef.current) {
                setAutomationLoading(false);
            }
        }
    }, [applyRunnerForm]);

    const loadSkills = useCallback(async () => {
        const requestId = ++skillsRequestIdRef.current;
        if (!hasSkillsSnapshotRef.current) {
            setIsSkillsLoading(true);
        }
        try {
            const list = await uiMeasure('redclaw', 'load_skills', async () => (
                window.ipcRenderer.invokeGuarded<SkillDefinition[] | null>('skills:list', undefined, {
                    timeoutMs: 2800,
                    fallback: null,
                    normalize: (value) => Array.isArray(value) ? value as SkillDefinition[] : [],
                })
            ));
            if (requestId !== skillsRequestIdRef.current) return;
            if (list == null) {
                if (!hasSkillsSnapshotRef.current) {
                    setSkills([]);
                }
                return;
            }
            setSkills(list as SkillDefinition[]);
            hasSkillsSnapshotRef.current = true;
        } catch (error) {
            console.error('Failed to load skills:', error);
        } finally {
            if (requestId === skillsRequestIdRef.current) {
                setIsSkillsLoading(false);
            }
        }
    }, []);

    useEffect(() => {
        debugUi(isActive ? 'view_activate' : 'view_deactivate', { sessionId: activeSessionId });
        if (!isActive) {
            return;
        }
    }, [activeSessionId, debugUi, isActive]);

    useEffect(() => {
        if (!import.meta.env.DEV) return;
        debugUi('view_mount');
        return () => {
            debugUi('view_unmount');
        };
    }, [debugUi]);

    useEffect(() => {
        if (!isActive) return;
        void initSession();
        void loadRunnerStatus(true);
    }, [initSession, isActive, loadRunnerStatus]);

    useEffect(() => {
        if (!isActive) return;
        const onSpaceChanged = () => {
            void initSession();
            void loadRunnerStatus(true);
            void loadSkills();
        };
        window.ipcRenderer.on('space:changed', onSpaceChanged);
        return () => {
            window.ipcRenderer.off('space:changed', onSpaceChanged);
        };
    }, [initSession, isActive, loadRunnerStatus, loadSkills]);

    useEffect(() => {
        if (!isActive) return;
        if (sidebarTab !== 'skills') return;
        void loadSkills();
    }, [sidebarTab, loadSkills, isActive]);

    useEffect(() => {
        if (!isActive) return;
        const onRunnerStatus = (_event: unknown, status: RunnerStatus) => {
            if (!status || typeof status !== 'object') return;
            setRunnerStatus(status);
        };
        window.ipcRenderer.on('redclaw:runner-status', onRunnerStatus);
        return () => {
            window.ipcRenderer.off('redclaw:runner-status', onRunnerStatus);
        };
    }, [isActive]);

    useEffect(() => {
        if (!isActive) return;
        const onSessionTitleUpdated = (_event: unknown, payload: { sessionId?: string; title?: string }) => {
            const nextSessionId = String(payload?.sessionId || '').trim();
            const nextTitle = String(payload?.title || '').trim();
            if (!nextSessionId || !nextTitle) return;
            setSessionList((prev) => sortContextSessionItems(prev.map((item) => (
                item.id !== nextSessionId
                    ? item
                    : {
                        ...item,
                        chatSession: {
                            id: item.chatSession?.id || item.id,
                            title: nextTitle,
                            updatedAt: new Date().toISOString(),
                        },
                    }
            ))));
        };
        window.ipcRenderer.on('chat:session-title-updated', onSessionTitleUpdated);
        return () => {
            window.ipcRenderer.off('chat:session-title-updated', onSessionTitleUpdated);
        };
    }, [isActive]);

    useEffect(() => {
        if (!isActive || !historyDrawerOpen) return;
        void loadContextSessions(activeSpaceId || 'default', activeSpaceName || '默认空间', {
            preferredSessionId: activeSessionIdRef.current,
            createIfEmpty: true,
            silent: false,
        });
    }, [activeSpaceId, activeSpaceName, historyDrawerOpen, isActive, loadContextSessions]);

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

    const createNewSession = useCallback(async () => {
        const nextActiveSpaceId = activeSpaceId || 'default';
        const nextSpaceName = activeSpaceName || nextActiveSpaceId;
        const contextId = buildRedClawContextId(nextActiveSpaceId);
        setHistoryLoading(true);
        try {
            const session = await uiMeasure('redclaw', 'sessions:create_manual', async () => (
                window.ipcRenderer.invokeGuarded<ChatSession | null>('chat:create-context-session', {
                    contextId,
                    contextType: REDCLAW_CONTEXT_TYPE,
                    title: buildRedClawSessionTitle(nextSpaceName),
                    initialContext: buildRedClawInitialContext(nextSpaceName, nextActiveSpaceId),
                }, {
                    timeoutMs: 3200,
                    fallback: null,
                })
            ), { activeSpaceId: nextActiveSpaceId, spaceName: nextSpaceName });
            if (!session) {
                throw new Error('create context session timed out');
            }
            const nextItem = createContextSessionListItem(session);
            setSessionList((prev) => sortContextSessionItems([nextItem, ...prev.filter((item) => item.id !== session.id)]));
            setActiveSessionId(session.id);
            hasSessionSnapshotRef.current = true;
            debugUi('sessions:create_done', { sessionId: session.id, activeSpaceId: nextActiveSpaceId });
        } catch (error) {
            console.error('Failed to create RedClaw context session:', error);
            setChatActionMessage('新建对话失败，请稍后重试');
        } finally {
            setHistoryLoading(false);
        }
    }, [activeSpaceId, activeSpaceName, debugUi]);

    const switchSession = useCallback((nextSessionId: string) => {
        if (!nextSessionId || nextSessionId === activeSessionIdRef.current) return;
        setActiveSessionId(nextSessionId);
        debugUi('sessions:switch', { sessionId: nextSessionId, activeSpaceId });
    }, [activeSpaceId, debugUi]);

    const deleteHistorySession = useCallback(async (targetSessionId: string) => {
        if (!targetSessionId) return;
        const nextActiveSpaceId = activeSpaceId || 'default';
        const nextSpaceName = activeSpaceName || nextActiveSpaceId;
        setHistoryLoading(true);
        try {
            await window.ipcRenderer.chat.deleteSession(targetSessionId);
            if (typeof window !== 'undefined' && readRedClawLastSessionId(nextActiveSpaceId) === targetSessionId) {
                localStorage.removeItem(redClawLastSessionStorageKey(nextActiveSpaceId));
            }
            const remaining = sessionListRef.current.filter((item) => item.id !== targetSessionId);
            setSessionList(remaining);

            if (activeSessionIdRef.current !== targetSessionId) {
                return;
            }

            if (remaining.length > 0) {
                setActiveSessionId(remaining[0].id);
                return;
            }

            const created = await uiMeasure('redclaw', 'sessions:create_after_delete', async () => (
                window.ipcRenderer.invokeGuarded<ChatSession | null>('chat:create-context-session', {
                    contextId: buildRedClawContextId(nextActiveSpaceId),
                    contextType: REDCLAW_CONTEXT_TYPE,
                    title: buildRedClawSessionTitle(nextSpaceName),
                    initialContext: buildRedClawInitialContext(nextSpaceName, nextActiveSpaceId),
                }, {
                    timeoutMs: 3200,
                    fallback: null,
                })
            ), { activeSpaceId: nextActiveSpaceId, spaceName: nextSpaceName });
            if (!created) {
                throw new Error('create context session timed out');
            }
            const nextItem = createContextSessionListItem(created);
            setSessionList([nextItem]);
            setActiveSessionId(created.id);
        } catch (error) {
            console.error('Failed to delete RedClaw session:', error);
            setChatActionMessage('删除对话失败，请稍后重试');
            void loadContextSessions(nextActiveSpaceId, nextSpaceName, { createIfEmpty: true, silent: true });
        } finally {
            setHistoryLoading(false);
        }
    }, [activeSpaceId, activeSpaceName, loadContextSessions]);

    const compactRedClawContext = useCallback(async () => {
        if (!activeSessionId || chatActionLoading) return;
        uiTraceInteraction('redclaw', 'compact_context', { sessionId: activeSessionId });
        setChatActionLoading('compact');
        try {
            const result = await uiMeasure('redclaw', 'compact_context:invoke', async () => (
                window.ipcRenderer.chat.compactContext(activeSessionId)
            ), { sessionId: activeSessionId });
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
    }, [activeSessionId, chatActionLoading]);

    const toggleSkill = useCallback(async (skill: SkillDefinition) => {
        try {
            const res = (
                skill.disabled
                    ? await window.ipcRenderer.skills.enable({ name: skill.name })
                    : await window.ipcRenderer.skills.disable({ name: skill.name })
            ) as { success?: boolean; error?: string };
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
            const result = await window.ipcRenderer.skills.marketInstall({ slug, tag: 'latest' }) as {
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
        setScheduleDraft(scheduleDraftFromTemplate(template));
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
        setLongDraft(longDraftFromTemplate(template));
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

    const welcomeActions = useMemo(() => [
        {
            label: '想吐槽或提建议?',
            url: 'https://github.com/Jamailar/RedBox/issues',
            icon: <MessageSquarePlus className="w-5 h-5" />,
        },
        {
            label: '喜欢我就点个 Star 吧',
            url: 'https://github.com/Jamailar/RedBox',
            icon: <Heart className="w-5 h-5 fill-current" />,
            color: 'text-rose-500'
        }
    ], []);


    return (
        <div className="h-full min-h-0 flex overflow-hidden bg-surface-primary">
            <div className="relative flex-1 min-w-0 overflow-hidden">
                {isSessionLoading && !activeSessionId ? (
                    <div className="h-full flex items-center justify-center">
                        <div className="flex flex-col items-center gap-3 text-text-tertiary">
                            <Loader2 className="w-6 h-6 animate-spin" />
                            <span className="text-xs">正在初始化 RedClaw...</span>
                        </div>
                    </div>
                ) : activeSessionId ? (
                    <div className="h-full min-h-0 flex flex-col">
                        <div className="relative min-h-0 flex-1 overflow-hidden">
                            <Chat
                                isActive={isActive}
                                onExecutionStateChange={onExecutionStateChange}
                                key={`redclaw:${chatRefreshKey}`}
                                fixedSessionId={activeSessionId}
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
                                embeddedTheme="auto"
                                welcomeTitle="RedClaw 自媒体AI工作台"
                                welcomeSubtitle=""
                                welcomeIconSrc={REDCLAW_WELCOME_ICON_SRC}
                                welcomeActions={welcomeActions}
                                contentLayout={sidebarCollapsed ? 'wide' : 'default'}
                                contentWidthPreset="narrow"
                                allowFileUpload={true}
                                messageWorkflowPlacement="bottom"
                                messageWorkflowVariant="compact"
                                messageWorkflowEmphasis="default"
                            />
                            <RedClawHistoryDrawer
                                open={historyDrawerOpen}
                                activeSpaceName={activeSpaceName}
                                historyLoading={historyLoading}
                                sessionList={sessionList}
                                activeSessionId={activeSessionId}
                                onToggleOpen={() => setHistoryDrawerOpen((value) => !value)}
                                onClose={() => setHistoryDrawerOpen(false)}
                                onCreateSession={() => void createNewSession()}
                                onSwitchSession={switchSession}
                                onDeleteSession={(sessionId) => void deleteHistorySession(sessionId)}
                            />
                            <div className="absolute top-4 right-4 z-30 flex items-center gap-2">
                                <button
                                    type="button"
                                    onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
                                    className={clsx(
                                        'flex items-center gap-2 rounded-full border px-4 py-2 text-xs font-medium shadow-sm backdrop-blur-md transition-all active:scale-95',
                                        !sidebarCollapsed
                                            ? 'border-accent-primary/40 bg-accent-primary/10 text-accent-primary'
                                            : 'border-border bg-surface-primary/80 text-text-secondary hover:border-accent-primary/30 hover:bg-surface-primary hover:text-text-primary'
                                    )}
                                    title={sidebarCollapsed ? "展开技能面板" : "收起技能面板"}
                                    aria-label="切换技能面板"
                                >
                                    <Sparkles className="w-4 h-4" />
                                    <span className="hidden sm:inline">技能</span>
                                </button>
                            </div>
                        </div>
                    </div>
                ) : (
                    <div className="h-full flex items-center justify-center text-text-tertiary text-sm">
                        RedClaw 会话初始化失败
                    </div>
                )}
            </div>
            <RedClawSidebar
                collapsed={sidebarCollapsed}
                sidebarWidth={sidebarWidth}
                isSidebarResizing={isSidebarResizing}
                activeSpaceName={activeSpaceName}
                sidebarTab={sidebarTab}
                chatActionLoading={chatActionLoading}
                chatActionMessage={chatActionMessage}
                skills={skills}
                isSkillsLoading={isSkillsLoading}
                skillsMessage={skillsMessage}
                enabledSkillCount={enabledSkillCount}
                installSource={installSource}
                isInstallingSkill={isInstallingSkill}
                onSidebarResizeStart={startSidebarResize}
                onCollapse={() => setSidebarCollapsed(true)}
                onSelectTab={setSidebarTab}
                onCompactContext={() => void compactRedClawContext()}
                onInstallSourceChange={setInstallSource}
                onInstallSkill={() => void installSkill()}
                onToggleSkill={(skill) => void toggleSkill(skill)}
            />
        </div>
    );
}
