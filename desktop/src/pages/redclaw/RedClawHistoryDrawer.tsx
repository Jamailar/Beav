import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react';
import { Archive, ChevronRight, Clock3, Edit3, FilePlus2, FileText, Folder, FolderOpen, FolderPlus, History, Loader2, MoreHorizontal, Pin, Plus, RefreshCw, Trash2, X } from 'lucide-react';
import { clsx } from 'clsx';
import { REDCLAW_DISPLAY_NAME } from './config';
import { formatDateTime } from './helpers';
import { appAlert, appConfirm } from '../../utils/appDialogs';

type RedClawSidebarTab = 'sessions' | 'manuscripts';

export interface RedClawHistoryListItem extends ContextChatSessionListItem {
    surface?: 'redclaw' | 'external';
    speakerLabel?: string;
}

export type RedClawHistorySessionActivity = 'running' | 'unread-complete';

interface RedClawManuscriptNode {
    name: string;
    path: string;
    isDirectory: boolean;
    children?: RedClawManuscriptNode[];
    updatedAt?: number | string;
}

interface RedClawHistoryDrawerProps {
    open: boolean;
    initialTab?: RedClawSidebarTab;
    activeSpaceName: string;
    historyLoading: boolean;
    sessionList: RedClawHistoryListItem[];
    activeSessionId: string | null;
    sessionActivityById?: Record<string, RedClawHistorySessionActivity>;
    onToggleOpen: () => void;
    onClose: () => void;
    onCreateSession: () => void | Promise<void>;
    onSwitchSession: (sessionId: string) => void;
    onDeleteSession: (sessionId: string) => void | Promise<void>;
    onArchiveSession?: (session: RedClawHistoryListItem) => void | Promise<void>;
    onSetSessionUnread?: (sessionId: string, unread: boolean) => void;
    onRenameSession?: (session: RedClawHistoryListItem) => void;
    onOpenManuscript?: (filePath: string) => void;
    activeManuscriptPath?: string | null;
}

type ManuscriptDialogState =
    | { mode: 'create-folder'; parentPath: string }
    | { mode: 'rename'; node: RedClawManuscriptNode };

type SessionMenuTarget = {
    sessionId: string;
    x: number;
    y: number;
};

type ManuscriptMenuTarget = {
    path: string;
    node?: RedClawManuscriptNode;
    x: number;
    y: number;
};

function displaySessionTitle(title: string, surface?: RedClawHistoryListItem['surface']): string {
    if (surface !== 'redclaw') return title;
    const legacyAiPrefix = new RegExp(`^${['Red', 'Claw'].join('')}(\\s*·\\s*)`);
    return title.replace(legacyAiPrefix, `${REDCLAW_DISPLAY_NAME}$1`);
}

function recordFromUnknown(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : {};
}

function isAutomationHistorySession(session: RedClawHistoryListItem): boolean {
    if (session.surface !== 'redclaw') return false;
    const sessionId = String(session.id || session.chatSession?.id || '').toLowerCase();
    if (sessionId.includes('automation')) return true;
    const context = recordFromUnknown(session.context);
    const metadata = recordFromUnknown(session.metadata);
    const contextId = String(
        context.contextId || context.context_id || context.id || metadata.contextId || metadata.context_id || ''
    ).toLowerCase();
    const contextType = String(
        context.contextType || context.context_type || context.type || metadata.contextType || metadata.context_type || ''
    ).toLowerCase();
    const sourceKind = String(context.sourceKind || context.source_kind || metadata.sourceKind || metadata.source_kind || '').toLowerCase();
    return contextId.includes('automation') || contextType === 'automation' || sourceKind === 'scheduled';
}

const PINNED_SESSION_IDS_STORAGE_KEY = 'redbox:redclaw:pinned-session-ids:v1';
const SESSION_CONTEXT_MENU_PANEL_CLASS = 'fixed z-[70] min-w-[168px] rounded-xl border border-border bg-surface-primary p-1.5 shadow-2xl';
const SESSION_CONTEXT_MENU_ITEM_CLASS = 'flex h-8 w-full items-center rounded-lg px-2.5 text-left text-[12px] font-medium text-text-primary transition-colors hover:bg-surface-secondary disabled:cursor-not-allowed disabled:opacity-45';
const SESSION_CONTEXT_MENU_DANGER_ITEM_CLASS = 'flex h-8 w-full items-center rounded-lg px-2.5 text-left text-[12px] font-medium text-red-500 transition-colors hover:bg-red-500/10';
const MANUSCRIPT_CONTEXT_MENU_PANEL_CLASS = 'fixed z-[70] min-w-[176px] rounded-xl border border-border bg-surface-primary p-1.5 shadow-2xl';
const MANUSCRIPT_CONTEXT_MENU_ITEM_CLASS = 'flex h-8 w-full items-center gap-2 rounded-lg px-2.5 text-left text-[12px] font-medium text-text-primary transition-colors hover:bg-surface-secondary disabled:cursor-not-allowed disabled:opacity-45';
const MANUSCRIPT_CONTEXT_MENU_DANGER_ITEM_CLASS = 'flex h-8 w-full items-center gap-2 rounded-lg px-2.5 text-left text-[12px] font-medium text-red-500 transition-colors hover:bg-red-500/10';

function readPinnedSessionIds(): string[] {
    if (typeof window === 'undefined') return [];
    try {
        const raw = window.localStorage.getItem(PINNED_SESSION_IDS_STORAGE_KEY);
        const parsed = raw ? JSON.parse(raw) : [];
        return Array.isArray(parsed) ? parsed.filter((item) => typeof item === 'string') : [];
    } catch {
        return [];
    }
}

function writePinnedSessionIds(ids: string[]): void {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem(PINNED_SESSION_IDS_STORAGE_KEY, JSON.stringify(ids));
}

function manuscriptNodeLabel(node: RedClawManuscriptNode): string {
    return String(node.name || node.path || '未命名').trim();
}

function sanitizeManuscriptName(value: string): string {
    return String(value || '').trim().replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, ' ');
}

function parentManuscriptPath(path: string): string {
    const normalized = String(path || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
    const index = normalized.lastIndexOf('/');
    return index > 0 ? normalized.slice(0, index) : '';
}

function normalizeManuscriptPath(path: string): string {
    return String(path || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '').replace(/\/+/g, '/');
}

function canMoveManuscriptPath(sourcePath: string, targetDir: string): boolean {
    const source = normalizeManuscriptPath(sourcePath);
    const target = normalizeManuscriptPath(targetDir);
    if (!source) return false;
    if (parentManuscriptPath(source) === target) return false;
    if (!target) return true;
    if (source === target) return false;
    return !target.startsWith(`${source}/`);
}

function filenameExtension(name: string): string {
    const match = String(name || '').match(/(\.[^./\\]+)$/);
    return match ? match[1] : '';
}

function sortManuscriptNodes(nodes: RedClawManuscriptNode[]): RedClawManuscriptNode[] {
    return [...nodes].sort((left, right) => {
        if (left.isDirectory !== right.isDirectory) return left.isDirectory ? -1 : 1;
        const leftUpdated = Number(left.updatedAt || 0);
        const rightUpdated = Number(right.updatedAt || 0);
        if (!left.isDirectory && rightUpdated !== leftUpdated) return rightUpdated - leftUpdated;
        return manuscriptNodeLabel(left).localeCompare(manuscriptNodeLabel(right), 'zh-Hans-CN');
    });
}

export function RedClawHistoryDrawer({
    open,
    initialTab,
    activeSpaceName,
    historyLoading,
    sessionList,
    activeSessionId,
    sessionActivityById = {},
    onToggleOpen,
    onClose,
    onCreateSession,
    onSwitchSession,
    onDeleteSession,
    onArchiveSession,
    onSetSessionUnread,
    onRenameSession,
    onOpenManuscript,
    activeManuscriptPath = null,
}: RedClawHistoryDrawerProps) {
    const [activeTab, setActiveTab] = useState<RedClawSidebarTab>('sessions');
    const [manuscriptTree, setManuscriptTree] = useState<RedClawManuscriptNode[]>([]);
    const [manuscriptsLoading, setManuscriptsLoading] = useState(false);
    const [manuscriptsError, setManuscriptsError] = useState('');
    const [isCreatingManuscript, setIsCreatingManuscript] = useState(false);
    const [expandedFolders, setExpandedFolders] = useState<Set<string>>(() => new Set(['']));
    const [manuscriptDialog, setManuscriptDialog] = useState<ManuscriptDialogState | null>(null);
    const [manuscriptDialogName, setManuscriptDialogName] = useState('');
    const [isSubmittingManuscriptDialog, setIsSubmittingManuscriptDialog] = useState(false);
    const [draggedManuscriptPath, setDraggedManuscriptPath] = useState<string | null>(null);
    const [manuscriptDropTargetPath, setManuscriptDropTargetPath] = useState<string | null>(null);
    const [pinnedSessionIds, setPinnedSessionIds] = useState<string[]>(() => readPinnedSessionIds());
    const [sessionMenuTarget, setSessionMenuTarget] = useState<SessionMenuTarget | null>(null);
    const [manuscriptMenuTarget, setManuscriptMenuTarget] = useState<ManuscriptMenuTarget | null>(null);
    const manuscriptClickTimerRef = useRef<number | null>(null);
    const manuscriptRequestIdRef = useRef(0);
    const pinnedSessionIdSet = useMemo(() => new Set(pinnedSessionIds), [pinnedSessionIds]);
    const normalizedActiveManuscriptPath = useMemo(() => (
        normalizeManuscriptPath(activeManuscriptPath || '')
    ), [activeManuscriptPath]);
    const sortedSessionList = useMemo(() => (
        sessionList
            .map((session, index) => ({ session, index }))
            .sort((left, right) => {
                const leftPinned = left.session.surface !== 'external' && pinnedSessionIdSet.has(left.session.id);
                const rightPinned = right.session.surface !== 'external' && pinnedSessionIdSet.has(right.session.id);
                if (leftPinned !== rightPinned) return leftPinned ? -1 : 1;
                return left.index - right.index;
            })
            .map(({ session }) => session)
    ), [pinnedSessionIdSet, sessionList]);

    const manuscriptCount = useMemo(() => {
        let count = 0;
        const walk = (nodes: RedClawManuscriptNode[]) => {
            for (const node of nodes) {
                if (node.isDirectory) {
                    walk(node.children || []);
                } else {
                    count += 1;
                }
            }
        };
        walk(manuscriptTree);
        return count;
    }, [manuscriptTree]);

    const loadManuscripts = useCallback(async () => {
        const requestId = ++manuscriptRequestIdRef.current;
        setManuscriptsLoading(true);
        setManuscriptsError('');
        try {
            const tree = await window.ipcRenderer.manuscripts.list<RedClawManuscriptNode[]>();
            if (requestId !== manuscriptRequestIdRef.current) return;
            const items = Array.isArray(tree) ? sortManuscriptNodes(tree) : [];
            setManuscriptTree(items);
            setExpandedFolders((current) => {
                if (current.size > 0 && !(current.size === 1 && current.has(''))) return current;
                const next = new Set<string>(current);
                items.filter((item) => item.isDirectory).slice(0, 8).forEach((item) => next.add(item.path));
                return next;
            });
        } catch (error) {
            if (requestId !== manuscriptRequestIdRef.current) return;
            console.error('Failed to load RedClaw manuscripts:', error);
            setManuscriptsError('加载稿件失败');
        } finally {
            if (requestId === manuscriptRequestIdRef.current) {
                setManuscriptsLoading(false);
            }
        }
    }, []);

    useEffect(() => {
        if (!open || !initialTab) return;
        setActiveTab(initialTab);
    }, [initialTab, open]);

    useEffect(() => {
        if (!open || activeTab !== 'manuscripts') return;
        void loadManuscripts();
        const timer = window.setInterval(() => {
            void loadManuscripts();
        }, 5000);
        return () => window.clearInterval(timer);
    }, [activeTab, loadManuscripts, open]);

    useEffect(() => {
        if (!sessionMenuTarget) return;
        const closeMenu = () => setSessionMenuTarget(null);
        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.key === 'Escape') closeMenu();
        };
        window.addEventListener('mousedown', closeMenu);
        window.addEventListener('keydown', handleKeyDown);
        return () => {
            window.removeEventListener('mousedown', closeMenu);
            window.removeEventListener('keydown', handleKeyDown);
        };
    }, [sessionMenuTarget]);

    useEffect(() => {
        if (!manuscriptMenuTarget) return;
        const closeMenu = () => setManuscriptMenuTarget(null);
        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.key === 'Escape') closeMenu();
        };
        window.addEventListener('mousedown', closeMenu);
        window.addEventListener('keydown', handleKeyDown);
        return () => {
            window.removeEventListener('mousedown', closeMenu);
            window.removeEventListener('keydown', handleKeyDown);
        };
    }, [manuscriptMenuTarget]);

    const cancelPendingManuscriptClick = useCallback(() => {
        if (manuscriptClickTimerRef.current === null) return;
        window.clearTimeout(manuscriptClickTimerRef.current);
        manuscriptClickTimerRef.current = null;
    }, []);

    const scheduleManuscriptClick = useCallback((action: () => void) => {
        cancelPendingManuscriptClick();
        manuscriptClickTimerRef.current = window.setTimeout(() => {
            manuscriptClickTimerRef.current = null;
            action();
        }, 180);
    }, [cancelPendingManuscriptClick]);

    useEffect(() => () => {
        cancelPendingManuscriptClick();
    }, [cancelPendingManuscriptClick]);

    const toggleFolder = useCallback((path: string) => {
        setExpandedFolders((prev) => {
            const next = new Set(prev);
            if (next.has(path)) {
                next.delete(path);
            } else {
                next.add(path);
            }
            return next;
        });
    }, []);

    const openManuscript = useCallback((path: string) => {
        if (!path || !onOpenManuscript) return;
        onOpenManuscript(path);
        onClose();
    }, [onClose, onOpenManuscript]);

    const togglePinnedSession = useCallback((sessionId: string) => {
        if (!sessionId) return;
        setPinnedSessionIds((current) => {
            const next = current.includes(sessionId)
                ? current.filter((id) => id !== sessionId)
                : [sessionId, ...current.filter((id) => id !== sessionId)];
            writePinnedSessionIds(next);
            return next;
        });
    }, []);

    const setSessionUnread = useCallback((sessionId: string, unread: boolean) => {
        if (!sessionId) return;
        if (onSetSessionUnread) {
            onSetSessionUnread(sessionId, unread);
        } else {
            void window.ipcRenderer.chat.setSessionUnread({ sessionId, unread }).catch((error) => {
                void appAlert(error instanceof Error ? error.message : '更新未读状态失败');
            });
        }
        setSessionMenuTarget(null);
    }, [onSetSessionUnread]);

    const copyText = useCallback(async (text: string, fallbackMessage = '复制失败') => {
        const value = text.trim();
        if (!value) return;
        try {
            await window.ipcRenderer.clipboardWriteText(value);
        } catch (error) {
            void appAlert(error instanceof Error ? error.message : fallbackMessage);
        }
    }, []);

    const sessionWorkingDirectory = useCallback((session: RedClawHistoryListItem): string => {
        const direct = String(session.workingDirectory || '').trim();
        if (direct) return direct;
        const metadata = session.metadata && typeof session.metadata === 'object' && !Array.isArray(session.metadata)
            ? session.metadata as Record<string, unknown>
            : null;
        return String(metadata?.workingDirectory || '').trim();
    }, []);

    const sessionAcpLabel = useCallback((session: RedClawHistoryListItem): string => {
        const metadata = session.metadata && typeof session.metadata === 'object' && !Array.isArray(session.metadata)
            ? session.metadata as Record<string, unknown>
            : null;
        if (String(metadata?.source || '').trim() !== 'acp') return '';
        return String(metadata?.sourceLabel || metadata?.externalClientName || session.speakerLabel || 'External Agent')
            .replace(/^ACP\s*:\s*/i, '')
            .trim();
    }, []);

    const deleteSession = useCallback(async (sessionId: string) => {
        if (!sessionId) return;
        await onDeleteSession(sessionId);
        setPinnedSessionIds((current) => {
            if (!current.includes(sessionId)) return current;
            const next = current.filter((id) => id !== sessionId);
            writePinnedSessionIds(next);
            return next;
        });
    }, [onDeleteSession]);

    const openSessionContextMenu = useCallback((event: ReactMouseEvent, sessionId: string) => {
        event.preventDefault();
        event.stopPropagation();
        if (!sessionId) return;
        setSessionMenuTarget({
            sessionId,
            x: event.clientX,
            y: event.clientY,
        });
    }, []);

    const runSessionMenuAction = useCallback((event: ReactMouseEvent, action: () => void) => {
        event.preventDefault();
        event.stopPropagation();
        setSessionMenuTarget(null);
        action();
    }, []);

    const openManuscriptContextMenu = useCallback((event: ReactMouseEvent, path: string, node?: RedClawManuscriptNode) => {
        event.preventDefault();
        event.stopPropagation();
        setSessionMenuTarget(null);
        setManuscriptMenuTarget({
            path: normalizeManuscriptPath(path),
            node,
            x: event.clientX,
            y: event.clientY,
        });
    }, []);

    const openManuscriptOptionsMenu = useCallback((event: ReactMouseEvent<HTMLButtonElement>, path: string, node?: RedClawManuscriptNode) => {
        event.preventDefault();
        event.stopPropagation();
        const rect = event.currentTarget.getBoundingClientRect();
        setSessionMenuTarget(null);
        setManuscriptMenuTarget({
            path: normalizeManuscriptPath(path),
            node,
            x: rect.right,
            y: rect.bottom + 4,
        });
    }, []);

    const runManuscriptMenuAction = useCallback((event: ReactMouseEvent, action: () => void) => {
        event.preventDefault();
        event.stopPropagation();
        setManuscriptMenuTarget(null);
        action();
    }, []);

    const createManuscriptInFolder = useCallback(async (parentPath: string) => {
        if (!onOpenManuscript || isCreatingManuscript) return;
        const normalizedParentPath = normalizeManuscriptPath(parentPath);
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const title = '未命名稿件';
        setIsCreatingManuscript(true);
        setManuscriptsError('');
        try {
            const result = await window.ipcRenderer.manuscripts.createFile<{ success?: boolean; error?: string; path?: string }>({
                parentPath: normalizedParentPath,
                name: `redclaw-${timestamp}.md`,
                title,
                content: `# ${title}\n\n`,
            });
            if (!result?.success || !result.path) {
                setManuscriptsError(result?.error || '创建稿件失败');
                return;
            }
            if (normalizedParentPath) {
                setExpandedFolders((prev) => new Set([...prev, normalizedParentPath]));
            }
            await loadManuscripts();
            openManuscript(result.path);
        } catch (error) {
            console.error('Failed to create RedClaw manuscript:', error);
            setManuscriptsError('创建稿件失败');
        } finally {
            setIsCreatingManuscript(false);
        }
    }, [isCreatingManuscript, loadManuscripts, onOpenManuscript, openManuscript]);

    const createManuscript = useCallback(async () => {
        await createManuscriptInFolder('');
    }, [createManuscriptInFolder]);

    const openCreateFolderDialog = useCallback((parentPath: string) => {
        setManuscriptDialog({ mode: 'create-folder', parentPath });
        setManuscriptDialogName('');
        setManuscriptsError('');
    }, []);

    const openRenameDialog = useCallback((node: RedClawManuscriptNode) => {
        setManuscriptDialog({ mode: 'rename', node });
        setManuscriptDialogName(manuscriptNodeLabel(node));
        setManuscriptsError('');
    }, []);

    const closeManuscriptDialog = useCallback(() => {
        if (isSubmittingManuscriptDialog) return;
        setManuscriptDialog(null);
        setManuscriptDialogName('');
    }, [isSubmittingManuscriptDialog]);

    const submitManuscriptDialog = useCallback(async () => {
        if (!manuscriptDialog || isSubmittingManuscriptDialog) return;
        const normalizedName = sanitizeManuscriptName(manuscriptDialogName);
        if (!normalizedName) {
            setManuscriptsError('名称不能为空');
            return;
        }

        setIsSubmittingManuscriptDialog(true);
        setManuscriptsError('');
        try {
            if (manuscriptDialog.mode === 'create-folder') {
                const result = await window.ipcRenderer.manuscripts.createFolder<{ success?: boolean; error?: string }>({
                    parentPath: manuscriptDialog.parentPath,
                    name: normalizedName,
                });
                if (!result?.success) throw new Error(result?.error || '创建文件夹失败');
                const createdPath = manuscriptDialog.parentPath ? `${manuscriptDialog.parentPath}/${normalizedName}` : normalizedName;
                setExpandedFolders((prev) => new Set([...prev, manuscriptDialog.parentPath, createdPath]));
            } else {
                const node = manuscriptDialog.node;
                const currentExt = node.isDirectory ? '' : filenameExtension(node.name || node.path);
                const nextName = (!node.isDirectory && currentExt && !filenameExtension(normalizedName))
                    ? `${normalizedName}${currentExt}`
                    : normalizedName;
                const result = await window.ipcRenderer.manuscripts.rename<{ success?: boolean; error?: string; newPath?: string }>({
                    oldPath: node.path,
                    newName: nextName,
                });
                if (!result?.success) throw new Error(result?.error || '重命名失败');
                const nextPath = String(result.newPath || '').trim();
                if (node.isDirectory && nextPath) {
                    setExpandedFolders((prev) => {
                        const next = new Set<string>();
                        prev.forEach((path) => {
                            if (path === node.path) {
                                next.add(nextPath);
                            } else if (path.startsWith(`${node.path}/`)) {
                                next.add(`${nextPath}${path.slice(node.path.length)}`);
                            } else {
                                next.add(path);
                            }
                        });
                        next.add(parentManuscriptPath(nextPath));
                        return next;
                    });
                }
            }
            setManuscriptDialog(null);
            setManuscriptDialogName('');
            await loadManuscripts();
        } catch (error) {
            const message = error instanceof Error ? error.message : '操作失败';
            setManuscriptsError(message);
            void appAlert(message);
        } finally {
            setIsSubmittingManuscriptDialog(false);
        }
    }, [isSubmittingManuscriptDialog, loadManuscripts, manuscriptDialog, manuscriptDialogName]);

    const deleteManuscriptNode = useCallback(async (node: RedClawManuscriptNode) => {
        const label = manuscriptNodeLabel(node);
        const confirmed = await appConfirm(
            node.isDirectory ? `确认删除文件夹“${label}”吗？里面的稿件也会一起删除。` : `确认删除稿件“${label}”吗？`,
            {
                title: node.isDirectory ? '删除文件夹' : '删除稿件',
                confirmLabel: '删除',
                tone: 'danger',
            },
        );
        if (!confirmed) return;

        setManuscriptsError('');
        try {
            const result = await window.ipcRenderer.manuscripts.delete<{ success?: boolean; error?: string }>(node.path);
            if (!result?.success) throw new Error(result?.error || '删除失败');
            setExpandedFolders((prev) => {
                const next = new Set<string>();
                prev.forEach((path) => {
                    if (path !== node.path && !path.startsWith(`${node.path}/`)) {
                        next.add(path);
                    }
                });
                return next;
            });
            await loadManuscripts();
        } catch (error) {
            const message = error instanceof Error ? error.message : '删除失败';
            setManuscriptsError(message);
            void appAlert(message);
        }
    }, [loadManuscripts]);

    const moveManuscript = useCallback(async (sourcePath: string, targetDir: string) => {
        const source = normalizeManuscriptPath(sourcePath);
        const target = normalizeManuscriptPath(targetDir);
        if (!canMoveManuscriptPath(source, target)) return;

        setManuscriptsError('');
        try {
            const result = await window.ipcRenderer.manuscripts.move<{ success?: boolean; error?: string; newPath?: string }>({
                sourcePath: source,
                targetDir: target,
            });
            if (!result?.success) throw new Error(result?.error || '移动失败');
            setExpandedFolders((prev) => {
                const next = new Set(prev);
                next.add(target);
                if (result.newPath) {
                    next.add(parentManuscriptPath(result.newPath));
                }
                return next;
            });
            await loadManuscripts();
        } catch (error) {
            const message = error instanceof Error ? error.message : '移动失败';
            setManuscriptsError(message);
            void appAlert(message);
        }
    }, [loadManuscripts]);

    const handleManuscriptDragStart = useCallback((event: DragEvent<HTMLElement>, node: RedClawManuscriptNode) => {
        if (!node.path) return;
        const source = normalizeManuscriptPath(node.path);
        setDraggedManuscriptPath(source);
        setManuscriptDropTargetPath(null);
        event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setData('application/x-redbox-manuscript-path', source);
        event.dataTransfer.setData('text/plain', source);
    }, []);

    const handleManuscriptDragEnd = useCallback(() => {
        setDraggedManuscriptPath(null);
        setManuscriptDropTargetPath(null);
    }, []);

    const handleManuscriptDragOver = useCallback((event: DragEvent<HTMLElement>, targetDir: string) => {
        const source = draggedManuscriptPath || event.dataTransfer.getData('application/x-redbox-manuscript-path') || event.dataTransfer.getData('text/plain');
        if (!canMoveManuscriptPath(source, targetDir)) return;
        event.preventDefault();
        event.stopPropagation();
        event.dataTransfer.dropEffect = 'move';
        setManuscriptDropTargetPath(normalizeManuscriptPath(targetDir));
    }, [draggedManuscriptPath]);

    const handleManuscriptDragLeave = useCallback((event: DragEvent<HTMLElement>, targetDir: string) => {
        event.preventDefault();
        event.stopPropagation();
        const normalizedTarget = normalizeManuscriptPath(targetDir);
        setManuscriptDropTargetPath((current) => current === normalizedTarget ? null : current);
    }, []);

    const handleManuscriptDrop = useCallback((event: DragEvent<HTMLElement>, targetDir: string) => {
        const source = draggedManuscriptPath || event.dataTransfer.getData('application/x-redbox-manuscript-path') || event.dataTransfer.getData('text/plain');
        if (!canMoveManuscriptPath(source, targetDir)) return;
        event.preventDefault();
        event.stopPropagation();
        setDraggedManuscriptPath(null);
        setManuscriptDropTargetPath(null);
        void moveManuscript(source, targetDir);
    }, [draggedManuscriptPath, moveManuscript]);

    const renderManuscriptNode = useCallback((node: RedClawManuscriptNode, depth = 0): ReactNode => {
        const isExpanded = expandedFolders.has(node.path);
        const isDropTarget = manuscriptDropTargetPath === normalizeManuscriptPath(node.path);
        const normalizedNodePath = normalizeManuscriptPath(node.path);
        const containsActiveManuscript = Boolean(
            node.isDirectory
            && normalizedActiveManuscriptPath
            && normalizedNodePath
            && normalizedActiveManuscriptPath.startsWith(`${normalizedNodePath}/`)
        );
        const label = manuscriptNodeLabel(node);
        if (node.isDirectory) {
            return (
                <div
                    key={`folder:${node.path || label}`}
                    className="space-y-0.5"
                    draggable={Boolean(node.path)}
                    onContextMenu={(event) => openManuscriptContextMenu(event, node.path, node)}
                    onDragStart={(event) => handleManuscriptDragStart(event, node)}
                    onDragEnd={handleManuscriptDragEnd}
                    onDragOver={(event) => handleManuscriptDragOver(event, node.path)}
                    onDragLeave={(event) => handleManuscriptDragLeave(event, node.path)}
                    onDrop={(event) => handleManuscriptDrop(event, node.path)}
                >
                    <div
                        className={clsx(
                            'group flex w-full items-center gap-1 rounded-lg text-text-secondary transition hover:bg-surface-secondary/70 hover:text-text-primary',
                            containsActiveManuscript && 'bg-surface-secondary/55 text-text-primary',
                            isDropTarget && 'bg-accent-primary/8 ring-1 ring-inset ring-accent-primary/20'
                        )}
                        style={{ paddingLeft: `${10 + depth * 14}px` }}
                    >
                        <button
                            type="button"
                            onClick={() => scheduleManuscriptClick(() => toggleFolder(node.path))}
                            onDoubleClick={(event) => {
                                event.preventDefault();
                                event.stopPropagation();
                                cancelPendingManuscriptClick();
                                openRenameDialog(node);
                            }}
                            className="flex min-w-0 flex-1 items-center gap-2 py-1.5 pr-1 text-left text-[12px] font-semibold"
                        >
                            <ChevronRight className={clsx('h-3.5 w-3.5 shrink-0 text-text-tertiary transition-transform', isExpanded && 'rotate-90')} />
                            {isExpanded ? (
                                <FolderOpen className="h-3.5 w-3.5 shrink-0 text-accent-primary/70" />
                            ) : (
                                <Folder className="h-3.5 w-3.5 shrink-0 text-accent-primary/70" />
                            )}
                            <span className="min-w-0 flex-1 truncate">{label}</span>
                        </button>
                        <button
                            type="button"
                            onClick={(event) => openManuscriptOptionsMenu(event, node.path, node)}
                            className="mr-1 flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-text-tertiary opacity-0 transition hover:bg-surface-tertiary hover:text-text-primary group-hover:opacity-100"
                            title="更多"
                            aria-label="更多"
                        >
                            <MoreHorizontal className="h-3 w-3" />
                        </button>
                    </div>
                    {isExpanded && (node.children || []).length > 0 && (
                        <div className="space-y-0.5">
                            {sortManuscriptNodes(node.children || []).map((child) => renderManuscriptNode(child, depth + 1))}
                        </div>
                    )}
                </div>
            );
        }

        return (
            <div
                key={`file:${node.path || label}`}
                className={clsx(
                    'group flex w-full items-center gap-1 rounded-lg text-text-secondary transition hover:bg-surface-secondary/70 hover:text-text-primary',
                    normalizedActiveManuscriptPath && normalizedNodePath === normalizedActiveManuscriptPath && 'bg-surface-elevated text-text-primary ring-1 ring-accent-primary/20'
                )}
                style={{ paddingLeft: `${28 + depth * 14}px` }}
                draggable={Boolean(node.path)}
                onContextMenu={(event) => openManuscriptContextMenu(event, node.path, node)}
                onDragStart={(event) => handleManuscriptDragStart(event, node)}
                onDragEnd={handleManuscriptDragEnd}
            >
                <button
                    type="button"
                    onClick={() => scheduleManuscriptClick(() => openManuscript(node.path))}
                    onDoubleClick={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        cancelPendingManuscriptClick();
                        openRenameDialog(node);
                    }}
                    disabled={!onOpenManuscript}
                    className="flex min-w-0 flex-1 items-center gap-2 py-1.5 pr-1 text-left text-[12px] font-medium disabled:cursor-default disabled:opacity-60"
                    title={node.path}
                >
                    <FileText className="h-3.5 w-3.5 shrink-0 text-text-tertiary group-hover:text-accent-primary" />
                    <span className="min-w-0 flex-1 truncate">{label}</span>
                </button>
                <button
                    type="button"
                    onClick={(event) => openManuscriptOptionsMenu(event, node.path, node)}
                    className="mr-1 flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-text-tertiary opacity-0 transition hover:bg-surface-tertiary hover:text-text-primary group-hover:opacity-100"
                    title="更多"
                    aria-label="更多"
                >
                    <MoreHorizontal className="h-3 w-3" />
                </button>
            </div>
        );
    }, [
        handleManuscriptDragEnd,
        handleManuscriptDragLeave,
        handleManuscriptDragOver,
        handleManuscriptDragStart,
        handleManuscriptDrop,
        expandedFolders,
        manuscriptDropTargetPath,
        normalizedActiveManuscriptPath,
        onOpenManuscript,
        cancelPendingManuscriptClick,
        openManuscriptContextMenu,
        openManuscriptOptionsMenu,
        openManuscript,
        openRenameDialog,
        scheduleManuscriptClick,
        toggleFolder,
    ]);

    return (
        <>
            <div className="absolute top-4 left-5 z-30 flex items-center gap-2">
                <button
                    type="button"
                    onClick={onToggleOpen}
                    className={clsx(
                        'flex items-center gap-2 rounded-xl border px-3.5 py-1.5 text-[12px] font-bold shadow-sm backdrop-blur-xl transition-all active:scale-95',
                        open
                            ? 'border-transparent bg-accent-primary text-white'
                            : 'border-border/80 bg-surface-elevated/92 text-text-secondary hover:bg-surface-primary hover:text-text-primary'
                    )}
                    title="查看历史对话"
                    aria-label="查看历史对话"
                >
                    <History className="w-3.5 h-3.5" />
                    <span>历史</span>
                </button>
            </div>

            {open && (
                <div className="absolute inset-0 z-40">
                    <button
                        type="button"
                        className="absolute inset-0 bg-black/25 backdrop-blur-[2px] transition-opacity"
                        aria-label="关闭历史对话抽屉"
                        onClick={onClose}
                    />
                    
                    <div className="absolute left-4 top-4 bottom-4 flex w-[320px] max-w-[calc(100%-2rem)] flex-col overflow-hidden rounded-2xl border border-border bg-surface-primary shadow-[0_24px_64px_-16px_rgba(15,23,42,0.16)] animate-slide-in-left-refined">
                        <div className="relative flex h-full flex-col">
                            {/* Header - 移除空间名，更紧凑 */}
                            <div className="px-5 pt-5 pb-2">
                                <div className="flex items-center justify-between">
                                    <h2 className="text-[15px] font-extrabold tracking-tight text-text-primary">RedClaw 资源</h2>
                                    <div className="flex items-center gap-1.5">
                                        {activeTab === 'sessions' ? (
                                            <button
                                                type="button"
                                                onClick={() => void onCreateSession()}
                                                disabled={historyLoading}
                                                className="flex h-7 items-center gap-1 rounded-lg bg-accent-primary px-2.5 text-[11px] font-bold text-white transition-all hover:bg-accent-hover active:scale-95 disabled:opacity-40"
                                            >
                                                <Plus className="w-3.5 h-3.5" />
                                                新会话
                                            </button>
                                        ) : (
                                            <>
                                                <button
                                                    type="button"
                                                    onClick={() => openCreateFolderDialog('')}
                                                    disabled={manuscriptsLoading}
                                                    className="flex h-7 w-7 items-center justify-center rounded-lg border border-border bg-surface-secondary/80 text-text-secondary transition-all hover:bg-surface-tertiary hover:text-text-primary active:scale-95 disabled:opacity-40"
                                                    title="新建文件夹"
                                                >
                                                    <FolderPlus className="w-3.5 h-3.5" />
                                                </button>
                                                <button
                                                    type="button"
                                                    onClick={() => void createManuscript()}
                                                    disabled={isCreatingManuscript || !onOpenManuscript}
                                                    className="flex h-7 items-center gap-1 rounded-lg bg-accent-primary px-2.5 text-[11px] font-bold text-white transition-all hover:bg-accent-hover active:scale-95 disabled:opacity-40"
                                                >
                                                    {isCreatingManuscript ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />}
                                                    新稿件
                                                </button>
                                                <button
                                                    type="button"
                                                    onClick={() => void loadManuscripts()}
                                                    disabled={manuscriptsLoading}
                                                    className="flex h-7 w-7 items-center justify-center rounded-lg border border-border bg-surface-secondary/80 text-text-secondary transition-all hover:bg-surface-tertiary hover:text-text-primary active:scale-95 disabled:opacity-40"
                                                    title="刷新稿件"
                                                >
                                                    <RefreshCw className={clsx('w-3.5 h-3.5', manuscriptsLoading && 'animate-spin')} />
                                                </button>
                                            </>
                                        )}
                                        <button
                                            type="button"
                                            onClick={onClose}
                                            className="flex h-7 w-7 items-center justify-center rounded-lg bg-surface-secondary/80 text-text-tertiary transition-all hover:bg-surface-tertiary hover:text-text-primary"
                                        >
                                            <X className="w-3.5 h-3.5" />
                                        </button>
                                    </div>
                                </div>
                                <div className="mt-3 grid grid-cols-2 rounded-xl bg-surface-secondary/70 p-1">
                                    {[
                                        { id: 'sessions' as const, label: '会话', count: sessionList.length },
                                        { id: 'manuscripts' as const, label: '稿件', count: manuscriptCount },
                                    ].map((tab) => (
                                        <button
                                            key={tab.id}
                                            type="button"
                                            onClick={() => setActiveTab(tab.id)}
                                            className={clsx(
                                                'flex h-8 items-center justify-center gap-1.5 rounded-lg text-[11px] font-bold transition',
                                                activeTab === tab.id
                                                    ? 'bg-surface-primary text-text-primary shadow-sm'
                                                    : 'text-text-tertiary hover:text-text-primary'
                                            )}
                                        >
                                            <span>{tab.label}</span>
                                            <span className="text-[9px] opacity-60">{tab.count}</span>
                                        </button>
                                    ))}
                                </div>
                            </div>

                            {/* Content Section - 高密度列表 */}
                            <div className="redclaw-history-scroll flex-1 overflow-y-auto px-2 custom-scrollbar">
                                {activeTab === 'manuscripts' ? (
                                    manuscriptsLoading && manuscriptTree.length === 0 ? (
                                        <div className="flex h-full items-center justify-center py-10">
                                            <Loader2 className="w-5 h-5 animate-spin text-accent-primary/50" />
                                        </div>
                                    ) : manuscriptsError && manuscriptTree.length === 0 ? (
                                        <div className="flex h-full flex-col items-center justify-center px-8 text-center">
                                            <FileText className="mb-3 h-8 w-8 text-red-400/30" />
                                            <h3 className="text-[13px] font-bold text-text-primary">{manuscriptsError}</h3>
                                        </div>
                                    ) : manuscriptTree.length === 0 ? (
                                        <div className="flex h-full flex-col items-center justify-center px-8 text-center">
                                            <FileText className="mb-3 h-8 w-8 text-accent-primary/20" />
                                            <h3 className="text-[13px] font-bold text-text-primary">暂无稿件</h3>
                                        </div>
                                    ) : (
                                        <div
                                            className={clsx(
                                                'min-h-full space-y-0.5 rounded-xl pb-6 transition-colors',
                                                manuscriptDropTargetPath === '' && 'bg-accent-primary/8 ring-1 ring-inset ring-accent-primary/20'
                                            )}
                                            onDragOver={(event) => handleManuscriptDragOver(event, '')}
                                            onDragLeave={(event) => handleManuscriptDragLeave(event, '')}
                                            onDrop={(event) => handleManuscriptDrop(event, '')}
                                            onContextMenu={(event) => openManuscriptContextMenu(event, '')}
                                        >
                                            {sortManuscriptNodes(manuscriptTree).map((node) => renderManuscriptNode(node))}
                                        </div>
                                    )
                                ) : historyLoading && sessionList.length === 0 ? (
                                    <div className="flex h-full items-center justify-center py-10">
                                        <Loader2 className="w-5 h-5 animate-spin text-accent-primary/50" />
                                    </div>
                                ) : sessionList.length === 0 ? (
                                    <div className="flex h-full flex-col items-center justify-center px-8 text-center">
                                        <History className="w-8 h-8 text-accent-primary/20 mb-3" />
                                        <h3 className="text-[13px] font-bold text-text-primary">暂无记录</h3>
                                    </div>
                                ) : (
                                    <div className="space-y-0.5 pb-6">
                                        {sortedSessionList.map((session) => {
                                            const isActive = session.id === activeSessionId;
                                            const isExternalSession = session.surface === 'external';
                                            const isPinned = !isExternalSession && pinnedSessionIdSet.has(session.id);
                                            const menuOpen = sessionMenuTarget?.sessionId === session.id;
                                            const title = displaySessionTitle(session.chatSession?.title?.trim() || '未命名会话', session.surface);
                                            const time = formatDateTime(session.chatSession?.updatedAt || null);
                                            const summary = session.summary?.trim();
                                            const speakerLabel = String(session.speakerLabel || '').trim();
                                            const activity = sessionActivityById[session.id];
                                            const isUnread = Boolean(session.unread)
                                                || Boolean(session.metadata && typeof session.metadata === 'object' && !Array.isArray(session.metadata) && (session.metadata as Record<string, unknown>).unread);
                                            const hasUnreadMarker = activity === 'unread-complete' || isUnread;
                                            const workingDirectory = sessionWorkingDirectory(session);
                                            const canUseWorkingDirectory = Boolean(workingDirectory);
                                            const acpLabel = sessionAcpLabel(session);
                                            const isAutomationSession = isAutomationHistorySession(session);
                                            const platformLabel = /mac/i.test(navigator.platform || '') ? '在 Finder 中显示' : '在文件资源管理器中显示';
                                            
                                            return (
                                                <div
                                                    key={session.id}
                                                    role="button"
                                                    tabIndex={0}
                                                    onClick={() => {
                                                        setSessionMenuTarget(null);
                                                        onSwitchSession(session.id);
                                                    }}
                                                    onContextMenu={(event) => openSessionContextMenu(event, session.id)}
                                                    onDoubleClick={(event) => {
                                                        if (!onRenameSession || isExternalSession) return;
                                                        event.preventDefault();
                                                        event.stopPropagation();
                                                        setSessionMenuTarget(null);
                                                        onRenameSession(session);
                                                    }}
                                                    onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && onSwitchSession(session.id)}
                                                    className={clsx(
                                                        'group relative w-full rounded-lg px-3 py-2.5 text-left transition-all duration-200 active:scale-[0.98]',
                                                        isActive
                                                            ? 'bg-surface-elevated shadow-sm ring-1 ring-accent-primary/20'
                                                            : 'hover:bg-surface-secondary/70'
                                                    )}
                                                >
                                                    {isActive && (
                                                        <div className="absolute left-0 top-1/2 -translate-y-1/2 w-0.5 h-5 bg-accent-primary rounded-r-full" />
                                                    )}
                                                    
                                                    <div className="flex items-start justify-between gap-3">
                                                        <div className="min-w-0 flex-1 pr-20">
                                                            <h4 className={clsx(
                                                                'flex min-w-0 items-center gap-1.5 text-[13px] font-bold leading-tight transition-colors',
                                                                isActive ? 'text-text-primary' : 'text-text-secondary group-hover:text-text-primary'
                                                            )}>
                                                                {isAutomationSession ? (
                                                                    <Clock3
                                                                        className="h-3.5 w-3.5 shrink-0 text-text-tertiary/80"
                                                                        strokeWidth={1.75}
                                                                        aria-label="定时任务"
                                                                    />
                                                                ) : null}
                                                                {acpLabel ? (
                                                                    <span className="shrink-0 rounded border border-accent-primary/45 bg-accent-primary/10 px-1.5 py-0.5 text-[9px] font-semibold leading-none text-accent-primary">
                                                                        {acpLabel}
                                                                    </span>
                                                                ) : null}
                                                                <span className="min-w-0 truncate">{title}</span>
                                                                {isPinned ? (
                                                                    <Pin className="h-3.5 w-3.5 shrink-0 text-accent-primary" />
                                                                ) : null}
                                                            </h4>
                                                            
                                                            <div className="mt-0.5 flex items-center gap-1.5 text-[9px] font-bold text-text-tertiary/60 uppercase tracking-tighter">
                                                                {speakerLabel ? (
                                                                    <>
                                                                        <span>{speakerLabel}</span>
                                                                        <span>·</span>
                                                                    </>
                                                                ) : null}
                                                                <span>{time}</span>
                                                                {isActive && (
                                                                    <span className="text-accent-primary uppercase tracking-normal">● Online</span>
                                                                )}
                                                            </div>
                                                            
                                                            {summary && (
                                                                <p className="mt-1.5 line-clamp-1 text-[11px] leading-normal text-text-secondary/70 font-medium">
                                                                    {summary}
                                                                </p>
                                                            )}
                                                        </div>
                                                        
                                                        {activity === 'running' && (
                                                            <span
                                                                className="absolute right-3 top-1/2 flex h-4 w-4 -translate-y-1/2 items-center justify-center transition-opacity group-hover:opacity-0"
                                                                aria-label="正在执行"
                                                            >
                                                                <span className="h-4 w-4 rounded-full border-2 border-text-tertiary/30 border-t-text-tertiary/80 animate-spin" />
                                                            </span>
                                                        )}
                                                        {hasUnreadMarker && (
                                                            <span
                                                                className="absolute right-4 top-1/2 h-2.5 w-2.5 -translate-y-1/2 rounded-full bg-emerald-500 shadow-[0_0_0_3px_rgba(16,185,129,0.14)] transition-opacity group-hover:opacity-0"
                                                                aria-label={isUnread ? '未读' : '执行完成'}
                                                            />
                                                        )}

                                                        <div className={clsx(
                                                            'absolute right-3 top-2 flex items-center gap-0.5 opacity-0 transition-all group-hover:opacity-100',
                                                            menuOpen && 'opacity-100'
                                                        )}>
                                                            {!isExternalSession && (
                                                                <button
                                                                    type="button"
                                                                    onClick={(e) => {
                                                                        e.stopPropagation();
                                                                        togglePinnedSession(session.id);
                                                                    }}
                                                                    className={clsx(
                                                                        'flex h-6 w-6 shrink-0 items-center justify-center rounded-md transition-all hover:bg-surface-secondary hover:text-text-primary',
                                                                        isPinned ? 'text-accent-primary opacity-100' : 'text-text-tertiary'
                                                                    )}
                                                                    title={isPinned ? '取消置顶' : '置顶'}
                                                                    aria-label={isPinned ? '取消置顶' : '置顶'}
                                                                >
                                                                    <Pin className="h-3 w-3" />
                                                                </button>
                                                            )}
                                                            {onRenameSession && !isExternalSession && (
                                                                <button
                                                                    type="button"
                                                                    onClick={(e) => {
                                                                        e.stopPropagation();
                                                                        onRenameSession(session);
                                                                    }}
                                                                    className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-text-tertiary transition-all hover:bg-surface-secondary hover:text-text-primary"
                                                                    title="重命名"
                                                                    aria-label="重命名"
                                                                >
                                                                    <Edit3 className="h-3 w-3" />
                                                                </button>
                                                            )}
                                                            <button
                                                                type="button"
                                                                onClick={(e) => {
                                                                    e.stopPropagation();
                                                                    if (onArchiveSession) {
                                                                        void onArchiveSession(session);
                                                                    } else {
                                                                        void deleteSession(session.id);
                                                                    }
                                                                }}
                                                                className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-text-tertiary transition-all hover:bg-red-500/12 hover:text-red-400"
                                                                title={onArchiveSession ? '归档' : '移除'}
                                                                aria-label={onArchiveSession ? '归档' : '移除'}
                                                            >
                                                                {onArchiveSession ? <Archive className="w-3 h-3" /> : <Trash2 className="w-3 h-3" />}
                                                            </button>
                                                        </div>
                                                    </div>
                                                    {menuOpen && (
                                                        <div
                                                            className={SESSION_CONTEXT_MENU_PANEL_CLASS}
                                                            style={{
                                                                left: Math.min(sessionMenuTarget?.x ?? 0, window.innerWidth - 184),
                                                                top: Math.min(sessionMenuTarget?.y ?? 0, window.innerHeight - 240),
                                                            }}
                                                            onMouseDown={(event) => event.stopPropagation()}
                                                            onClick={(event) => event.stopPropagation()}
                                                            onContextMenu={(event) => event.preventDefault()}
                                                        >
                                                            {!isExternalSession && (
                                                                <button
                                                                    type="button"
                                                                    onMouseDown={(event) => runSessionMenuAction(event, () => togglePinnedSession(session.id))}
                                                                    className={SESSION_CONTEXT_MENU_ITEM_CLASS}
                                                                >
                                                                    {isPinned ? '取消置顶' : '置顶对话'}
                                                                </button>
                                                            )}
                                                            {!isExternalSession && (
                                                                <button
                                                                    type="button"
                                                                    onMouseDown={(event) => runSessionMenuAction(event, () => onRenameSession?.(session))}
                                                                    disabled={!onRenameSession}
                                                                    className={SESSION_CONTEXT_MENU_ITEM_CLASS}
                                                                >
                                                                    重命名对话
                                                                </button>
                                                            )}
                                                            <button
                                                                type="button"
                                                                onMouseDown={(event) => runSessionMenuAction(event, () => {
                                                                    if (onArchiveSession) {
                                                                        void onArchiveSession(session);
                                                                    } else {
                                                                        void deleteSession(session.id);
                                                                    }
                                                                })}
                                                                className={SESSION_CONTEXT_MENU_DANGER_ITEM_CLASS}
                                                            >
                                                                {onArchiveSession ? '归档对话' : '删除对话'}
                                                            </button>
                                                            <button
                                                                type="button"
                                                                onMouseDown={(event) => runSessionMenuAction(event, () => setSessionUnread(session.id, !hasUnreadMarker))}
                                                                className={SESSION_CONTEXT_MENU_ITEM_CLASS}
                                                            >
                                                                {hasUnreadMarker ? '标记为已读' : '标记为未读'}
                                                            </button>
                                                            {canUseWorkingDirectory && (
                                                                <>
                                                                    <div className="my-1 h-px bg-[rgb(var(--color-border))]" />
                                                                    <button
                                                                        type="button"
                                                                        onMouseDown={(event) => runSessionMenuAction(event, () => {
                                                                            setSessionMenuTarget(null);
                                                                            void window.ipcRenderer.files.showInFolder({ source: workingDirectory }).catch((error) => {
                                                                                void appAlert(error instanceof Error ? error.message : '打开目录失败');
                                                                            });
                                                                        })}
                                                                        className={SESSION_CONTEXT_MENU_ITEM_CLASS}
                                                                    >
                                                                        {platformLabel}
                                                                    </button>
                                                                    <button
                                                                        type="button"
                                                                        onMouseDown={(event) => runSessionMenuAction(event, () => {
                                                                            setSessionMenuTarget(null);
                                                                            void copyText(workingDirectory, '复制工作目录失败');
                                                                        })}
                                                                        className={SESSION_CONTEXT_MENU_ITEM_CLASS}
                                                                    >
                                                                        复制工作目录
                                                                    </button>
                                                                </>
                                                            )}
                                                            <div className="my-1 h-px bg-[rgb(var(--color-border))]" />
                                                            <button
                                                                type="button"
                                                                onMouseDown={(event) => runSessionMenuAction(event, () => {
                                                                    setSessionMenuTarget(null);
                                                                    void copyText(session.id, '复制会话 ID 失败');
                                                                })}
                                                                className={SESSION_CONTEXT_MENU_ITEM_CLASS}
                                                            >
                                                                复制会话 ID
                                                            </button>
                                                        </div>
                                                    )}
                                                </div>
                                            );
                                        })}
                                    </div>
                                )}
                            </div>
                            
                            {/* Footer hint */}
                            <div className="border-t border-border/70 px-5 py-3">
                                <p className="text-[8px] text-center font-bold text-text-tertiary/40 uppercase tracking-[0.3em]">
                                    RedBox Engine
                                </p>
                            </div>
                        </div>
                    </div>

                    {manuscriptMenuTarget && activeTab === 'manuscripts' && (
                        <div
                            className={MANUSCRIPT_CONTEXT_MENU_PANEL_CLASS}
                            style={{
                                left: Math.min(manuscriptMenuTarget.x, window.innerWidth - 192),
                                top: Math.min(manuscriptMenuTarget.y, window.innerHeight - 176),
                            }}
                            onMouseDown={(event) => event.stopPropagation()}
                            onClick={(event) => event.stopPropagation()}
                            onContextMenu={(event) => event.preventDefault()}
                        >
                            {(!manuscriptMenuTarget.node || manuscriptMenuTarget.node.isDirectory) && (
                                <button
                                    type="button"
                                    onMouseDown={(event) => runManuscriptMenuAction(event, () => void createManuscriptInFolder(manuscriptMenuTarget.path))}
                                    disabled={isCreatingManuscript || !onOpenManuscript}
                                    className={MANUSCRIPT_CONTEXT_MENU_ITEM_CLASS}
                                >
                                    <FilePlus2 className="h-3.5 w-3.5 text-text-tertiary" />
                                    新建稿件
                                </button>
                            )}
                            {(!manuscriptMenuTarget.node || manuscriptMenuTarget.node.isDirectory) && (
                                <button
                                    type="button"
                                    onMouseDown={(event) => runManuscriptMenuAction(event, () => openCreateFolderDialog(manuscriptMenuTarget.path))}
                                    className={MANUSCRIPT_CONTEXT_MENU_ITEM_CLASS}
                                >
                                    <FolderPlus className="h-3.5 w-3.5 text-text-tertiary" />
                                    新建文件夹
                                </button>
                            )}
                            {manuscriptMenuTarget.node && !manuscriptMenuTarget.node.isDirectory && (
                                <button
                                    type="button"
                                    onMouseDown={(event) => runManuscriptMenuAction(event, () => openManuscript(manuscriptMenuTarget.path))}
                                    disabled={!onOpenManuscript}
                                    className={MANUSCRIPT_CONTEXT_MENU_ITEM_CLASS}
                                >
                                    <FileText className="h-3.5 w-3.5 text-text-tertiary" />
                                    打开稿件
                                </button>
                            )}
                            {manuscriptMenuTarget.node && (
                                <button
                                    type="button"
                                    onMouseDown={(event) => runManuscriptMenuAction(event, () => openRenameDialog(manuscriptMenuTarget.node as RedClawManuscriptNode))}
                                    className={MANUSCRIPT_CONTEXT_MENU_ITEM_CLASS}
                                >
                                    <Edit3 className="h-3.5 w-3.5 text-text-tertiary" />
                                    重命名
                                </button>
                            )}
                            {manuscriptMenuTarget.node && (
                                <button
                                    type="button"
                                    onMouseDown={(event) => runManuscriptMenuAction(event, () => void deleteManuscriptNode(manuscriptMenuTarget.node as RedClawManuscriptNode))}
                                    className={MANUSCRIPT_CONTEXT_MENU_DANGER_ITEM_CLASS}
                                >
                                    <Trash2 className="h-3.5 w-3.5" />
                                    删除
                                </button>
                            )}
                        </div>
                    )}

                    {manuscriptDialog && (
                        <div
                            className="fixed inset-0 z-[60] flex items-center justify-center bg-black/25 px-4 backdrop-blur-[2px]"
                            onMouseDown={closeManuscriptDialog}
                        >
                            <div
                                className="w-full max-w-[360px] rounded-2xl border border-border bg-surface-primary p-4 shadow-2xl"
                                onMouseDown={(event) => event.stopPropagation()}
                            >
                                <div className="flex items-center justify-between gap-3">
                                    <div className="text-[14px] font-bold text-text-primary">
                                        {manuscriptDialog.mode === 'create-folder' ? '新建文件夹' : '重命名'}
                                    </div>
                                    <button
                                        type="button"
                                        onClick={closeManuscriptDialog}
                                        disabled={isSubmittingManuscriptDialog}
                                        className="flex h-7 w-7 items-center justify-center rounded-lg text-text-tertiary transition hover:bg-surface-secondary hover:text-text-primary disabled:opacity-50"
                                    >
                                        <X className="h-3.5 w-3.5" />
                                    </button>
                                </div>

                                <input
                                    autoFocus
                                    value={manuscriptDialogName}
                                    onChange={(event) => {
                                        setManuscriptDialogName(event.target.value);
                                        if (manuscriptsError) setManuscriptsError('');
                                    }}
                                    onKeyDown={(event) => {
                                        if (event.key === 'Enter') {
                                            event.preventDefault();
                                            void submitManuscriptDialog();
                                        } else if (event.key === 'Escape') {
                                            event.preventDefault();
                                            closeManuscriptDialog();
                                        }
                                    }}
                                    className="mt-4 h-10 w-full rounded-xl border border-border bg-surface-secondary/50 px-3 text-sm text-text-primary outline-none transition placeholder:text-text-tertiary focus:border-accent-primary/50 focus:bg-surface-primary focus:ring-2 focus:ring-accent-primary/10"
                                    placeholder={manuscriptDialog.mode === 'create-folder' ? '文件夹名称' : '新名称'}
                                    disabled={isSubmittingManuscriptDialog}
                                />

                                {manuscriptsError && (
                                    <div className="mt-2 text-xs text-red-500">{manuscriptsError}</div>
                                )}

                                <div className="mt-4 flex justify-end gap-2">
                                    <button
                                        type="button"
                                        onClick={closeManuscriptDialog}
                                        disabled={isSubmittingManuscriptDialog}
                                        className="h-9 rounded-xl border border-border px-4 text-sm font-medium text-text-secondary transition hover:bg-surface-secondary hover:text-text-primary disabled:opacity-50"
                                    >
                                        取消
                                    </button>
                                    <button
                                        type="button"
                                        onClick={() => void submitManuscriptDialog()}
                                        disabled={isSubmittingManuscriptDialog || !manuscriptDialogName.trim()}
                                        className="inline-flex h-9 items-center gap-2 rounded-xl bg-accent-primary px-4 text-sm font-medium text-white transition hover:bg-accent-hover disabled:opacity-50"
                                    >
                                        {isSubmittingManuscriptDialog && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                                        确认
                                    </button>
                                </div>
                            </div>
                        </div>
                    )}
                </div>
            )}
        </>
    );
}
