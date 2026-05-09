import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type MouseEvent, type ReactNode } from 'react';
import { ChevronRight, Clock3, Edit3, FilePlus2, FileText, Folder, FolderOpen, FolderPlus, History, Loader2, MoreHorizontal, Pin, Plus, RefreshCw, Trash2, Users, X } from 'lucide-react';
import { clsx } from 'clsx';
import { REDCLAW_DISPLAY_NAME } from './config';
import { appAlert, appConfirm } from '../../utils/appDialogs';

interface RedClawTeamRoom {
    id: string;
    name: string;
    advisorIds?: string[];
    isSystem?: boolean;
}

export type RedClawHistorySurface = 'redclaw' | 'advisor' | 'room';

export interface RedClawHistoryListItem extends ContextChatSessionListItem {
    surface: RedClawHistorySurface;
    speakerLabel: string;
    advisorId?: string;
    roomId?: string;
}

export type RedClawHistorySessionActivity = 'running' | 'unread-complete';

type RedClawSidebarTab = 'chat' | 'manuscripts';

type RedClawManuscriptNode = {
    name: string;
    path: string;
    isDirectory: boolean;
    children?: RedClawManuscriptNode[];
    title?: string;
    draftType?: string;
    updatedAt?: number;
};

function displaySessionTitle(title: string, surface: RedClawHistorySurface): string {
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
    const contextId = String(context.contextId || context.context_id || context.id || '').toLowerCase();
    const contextType = String(context.contextType || context.context_type || context.type || '').toLowerCase();
    const sourceKind = String(context.sourceKind || context.source_kind || '').toLowerCase();
    return contextId.includes('automation') || contextType === 'automation' || sourceKind === 'scheduled';
}

interface RedClawHistorySidebarSectionProps {
    historyLoading: boolean;
    sessionList: RedClawHistoryListItem[];
    activeSessionId: string | null;
    teamRooms?: RedClawTeamRoom[];
    activeRoomId?: string | null;
    activeSurface?: 'redclaw' | 'advisor' | 'room';
    sessionActivityById?: Record<string, RedClawHistorySessionActivity>;
    onCreateRoom?: () => void;
    onSwitchRoom?: (roomId: string) => void;
    onDeleteRoom?: (room: RedClawTeamRoom) => void | Promise<void>;
    onSwitchSession: (session: RedClawHistoryListItem) => void;
    onDeleteSession: (session: RedClawHistoryListItem) => void | Promise<void>;
    onRenameSession?: (session: RedClawHistoryListItem, title: string) => void | Promise<void>;
    onOpenManuscript?: (filePath: string) => void;
    activeManuscriptPath?: string | null;
}

const PINNED_ROOM_IDS_STORAGE_KEY = 'redbox:redclaw:pinned-room-ids:v1';
const PINNED_SESSION_IDS_STORAGE_KEY = 'redbox:redclaw:pinned-session-ids:v1';

type HistoryItemMenuTarget =
    | { type: 'room'; id: string }
    | { type: 'session'; id: string }
    | { type: 'manuscript'; path: string };

type ManuscriptDraftKind = 'longform' | 'post' | 'video' | 'audio';

type ManuscriptDialogState =
    | { mode: 'create-folder'; parentPath: string }
    | { mode: 'create-file'; parentPath: string }
    | { mode: 'rename'; node: RedClawManuscriptNode };

type ManuscriptContextMenuState = {
    x: number;
    y: number;
    parentPath: string;
    node?: RedClawManuscriptNode;
};

const MANUSCRIPT_DRAFT_KIND_OPTIONS: Array<{ id: ManuscriptDraftKind; label: string; extension: string; kind?: string; disabled?: boolean }> = [
    { id: 'longform', label: '长文', extension: '', kind: 'longform' },
    { id: 'post', label: '图文稿', extension: '', kind: 'post' },
    { id: 'video', label: '视频脚本', extension: '', kind: 'video', disabled: true },
    { id: 'audio', label: '音频脚本', extension: '', kind: 'audio', disabled: true },
];

function buildDefaultManuscriptTitle(label: string): string {
    const now = new Date();
    const pad = (value: number) => String(value).padStart(2, '0');
    const date = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
    const time = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
    return `${label}-${date}-${time}`;
}

function readPinnedIds(storageKey: string): string[] {
    if (typeof window === 'undefined') return [];
    try {
        const raw = window.localStorage.getItem(storageKey);
        const parsed = raw ? JSON.parse(raw) : [];
        return Array.isArray(parsed) ? parsed.filter((item) => typeof item === 'string') : [];
    } catch {
        return [];
    }
}

function writePinnedIds(storageKey: string, ids: string[]): void {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem(storageKey, JSON.stringify(ids));
}

function manuscriptNodeLabel(node: RedClawManuscriptNode): string {
    return String(node.title || node.name || '未命名稿件').trim();
}

function normalizeManuscriptPath(path: string | null | undefined): string {
    return String(path || '').trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '').replace(/\/+/g, '/');
}

function getManuscriptAncestorPaths(path: string): string[] {
    const normalized = normalizeManuscriptPath(path);
    if (!normalized.includes('/')) return [];
    const parts = normalized.split('/').filter(Boolean);
    return parts.slice(0, -1).reduce<string[]>((paths, part, index) => {
        const previous = index === 0 ? '' : `${paths[index - 1]}/`;
        paths.push(`${previous}${part}`);
        return paths;
    }, []);
}

function manuscriptResultError(result: unknown): string {
    if (result && typeof result === 'object' && 'error' in result) {
        const error = (result as { error?: unknown }).error;
        if (typeof error === 'string' && error.trim()) return error;
    }
    if (result && typeof result === 'object' && 'success' in result && (result as { success?: unknown }).success === false) {
        return '操作失败';
    }
    return '';
}

function manuscriptResultPath(result: unknown): string {
    if (!result || typeof result !== 'object') return '';
    const value = (result as { path?: unknown; newPath?: unknown }).path || (result as { path?: unknown; newPath?: unknown }).newPath;
    return typeof value === 'string' ? value : '';
}

function parentManuscriptPath(path: string): string {
    const normalized = path.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
    const index = normalized.lastIndexOf('/');
    return index > 0 ? normalized.slice(0, index) : '';
}

function canMoveManuscriptPath(sourcePath: string, targetDir: string): boolean {
    const source = sourcePath.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
    const target = targetDir.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
    if (!source) return false;
    if (parentManuscriptPath(source) === target) return false;
    if (!target) return true;
    if (source === target) return false;
    return !target.startsWith(`${source}/`);
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

export function RedClawHistorySidebarSection({
    historyLoading,
    sessionList,
    activeSessionId,
    teamRooms = [],
    activeRoomId,
    activeSurface = 'redclaw',
    sessionActivityById = {},
    onCreateRoom,
    onSwitchRoom,
    onDeleteRoom,
    onSwitchSession,
    onDeleteSession,
    onRenameSession,
    onOpenManuscript,
    activeManuscriptPath,
}: RedClawHistorySidebarSectionProps) {
    const [activeTab, setActiveTab] = useState<RedClawSidebarTab>('chat');
    const [renameTarget, setRenameTarget] = useState<RedClawHistoryListItem | null>(null);
    const [renameTitle, setRenameTitle] = useState('');
    const [renameError, setRenameError] = useState('');
    const [isRenaming, setIsRenaming] = useState(false);
    const [menuTarget, setMenuTarget] = useState<HistoryItemMenuTarget | null>(null);
    const [pinnedRoomIds, setPinnedRoomIds] = useState<string[]>(() => readPinnedIds(PINNED_ROOM_IDS_STORAGE_KEY));
    const [pinnedSessionIds, setPinnedSessionIds] = useState<string[]>(() => readPinnedIds(PINNED_SESSION_IDS_STORAGE_KEY));
    const [manuscriptTree, setManuscriptTree] = useState<RedClawManuscriptNode[]>([]);
    const [manuscriptsLoading, setManuscriptsLoading] = useState(false);
    const [manuscriptsError, setManuscriptsError] = useState('');
    const [expandedManuscriptPaths, setExpandedManuscriptPaths] = useState<Set<string>>(() => new Set());
    const [manuscriptDialog, setManuscriptDialog] = useState<ManuscriptDialogState | null>(null);
    const [manuscriptDialogName, setManuscriptDialogName] = useState('');
    const [manuscriptDraftKind, setManuscriptDraftKind] = useState<ManuscriptDraftKind>('longform');
    const [manuscriptDialogError, setManuscriptDialogError] = useState('');
    const [manuscriptContextMenu, setManuscriptContextMenu] = useState<ManuscriptContextMenuState | null>(null);
    const [isSubmittingManuscriptDialog, setIsSubmittingManuscriptDialog] = useState(false);
    const [draggedManuscriptPath, setDraggedManuscriptPath] = useState('');
    const [manuscriptDropTargetPath, setManuscriptDropTargetPath] = useState<string | null>(null);
    const [movingManuscriptPath, setMovingManuscriptPath] = useState('');
    const renameInputRef = useRef<HTMLInputElement | null>(null);
    const manuscriptDialogInputRef = useRef<HTMLInputElement | null>(null);
    const manuscriptRequestIdRef = useRef(0);
    const manuscriptClickTimerRef = useRef<number | null>(null);

    const pinnedRoomIdSet = useMemo(() => new Set(pinnedRoomIds), [pinnedRoomIds]);
    const pinnedSessionIdSet = useMemo(() => new Set(pinnedSessionIds), [pinnedSessionIds]);
    const sortedTeamRooms = useMemo(() => {
        return [...teamRooms].sort((left, right) => {
            const leftPinned = pinnedRoomIdSet.has(left.id);
            const rightPinned = pinnedRoomIdSet.has(right.id);
            if (leftPinned !== rightPinned) return leftPinned ? -1 : 1;
            return 0;
        });
    }, [pinnedRoomIdSet, teamRooms]);
    const sortedSessionList = useMemo(() => {
        return [...sessionList].sort((left, right) => {
            const leftPinned = pinnedSessionIdSet.has(left.id);
            const rightPinned = pinnedSessionIdSet.has(right.id);
            if (leftPinned !== rightPinned) return leftPinned ? -1 : 1;
            return 0;
        });
    }, [pinnedSessionIdSet, sessionList]);
    const normalizedActiveManuscriptPath = useMemo(
        () => normalizeManuscriptPath(activeManuscriptPath),
        [activeManuscriptPath]
    );

    useEffect(() => {
        if (!renameTarget) return;
        const timer = window.setTimeout(() => {
            renameInputRef.current?.focus();
            renameInputRef.current?.select();
        }, 0);
        return () => window.clearTimeout(timer);
    }, [renameTarget]);

    useEffect(() => {
        if (!manuscriptDialog) return;
        if (manuscriptDialog.mode === 'create-file') return;
        const timer = window.setTimeout(() => {
            manuscriptDialogInputRef.current?.focus();
            manuscriptDialogInputRef.current?.select();
        }, 0);
        return () => window.clearTimeout(timer);
    }, [manuscriptDialog]);

    useEffect(() => {
        if (!normalizedActiveManuscriptPath) return;
        setActiveTab('manuscripts');
        setExpandedManuscriptPaths((prev) => {
            const next = new Set(prev);
            for (const path of getManuscriptAncestorPaths(normalizedActiveManuscriptPath)) {
                next.add(path);
            }
            return next;
        });
    }, [normalizedActiveManuscriptPath]);

    useEffect(() => {
        if (!menuTarget) return;
        const closeMenu = () => setMenuTarget(null);
        window.addEventListener('click', closeMenu);
        window.addEventListener('keydown', closeMenu);
        return () => {
            window.removeEventListener('click', closeMenu);
            window.removeEventListener('keydown', closeMenu);
        };
    }, [menuTarget]);

    useEffect(() => {
        if (!manuscriptContextMenu) return;
        const closeMenu = () => setManuscriptContextMenu(null);
        window.addEventListener('click', closeMenu);
        window.addEventListener('keydown', closeMenu);
        return () => {
            window.removeEventListener('click', closeMenu);
            window.removeEventListener('keydown', closeMenu);
        };
    }, [manuscriptContextMenu]);

    useEffect(() => {
        return () => {
            if (manuscriptClickTimerRef.current !== null) {
                window.clearTimeout(manuscriptClickTimerRef.current);
            }
        };
    }, []);

    const loadManuscripts = useCallback(async () => {
        const requestId = ++manuscriptRequestIdRef.current;
        setManuscriptsLoading(true);
        setManuscriptsError('');
        try {
            const tree = await window.ipcRenderer.invoke('manuscripts:list') as RedClawManuscriptNode[];
            if (requestId !== manuscriptRequestIdRef.current) return;
            const items = Array.isArray(tree) ? tree : [];
            setManuscriptTree(items);
            setExpandedManuscriptPaths((current) => {
                if (current.size > 0) return current;
                const next = new Set<string>();
                items.filter((item) => item.isDirectory).slice(0, 8).forEach((item) => next.add(item.path));
                return next;
            });
        } catch (error) {
            if (requestId !== manuscriptRequestIdRef.current) return;
            console.error('Failed to load RedClaw manuscript tree:', error);
            setManuscriptsError(error instanceof Error ? error.message : '稿件加载失败');
        } finally {
            if (requestId === manuscriptRequestIdRef.current) {
                setManuscriptsLoading(false);
            }
        }
    }, []);

    useEffect(() => {
        if (activeTab !== 'manuscripts') return;
        void loadManuscripts();
        const timer = window.setInterval(() => {
            void loadManuscripts();
        }, 5000);
        return () => window.clearInterval(timer);
    }, [activeTab, loadManuscripts]);

    const toggleManuscriptFolder = (path: string) => {
        setExpandedManuscriptPaths((current) => {
            const next = new Set(current);
            if (next.has(path)) {
                next.delete(path);
            } else {
                next.add(path);
            }
            return next;
        });
    };

    const cancelPendingManuscriptClick = () => {
        if (manuscriptClickTimerRef.current === null) return;
        window.clearTimeout(manuscriptClickTimerRef.current);
        manuscriptClickTimerRef.current = null;
    };

    const scheduleManuscriptClick = (action: () => void) => {
        cancelPendingManuscriptClick();
        manuscriptClickTimerRef.current = window.setTimeout(() => {
            manuscriptClickTimerRef.current = null;
            action();
        }, 180);
    };

    const openManuscriptDialog = (dialog: ManuscriptDialogState) => {
        setMenuTarget(null);
        setManuscriptContextMenu(null);
        setManuscriptDialog(dialog);
        setManuscriptDialogError('');
        if (dialog.mode === 'rename') {
            setManuscriptDialogName(manuscriptNodeLabel(dialog.node));
        } else {
            setManuscriptDialogName('');
            setManuscriptDraftKind('longform');
        }
    };

    const closeManuscriptDialog = () => {
        if (isSubmittingManuscriptDialog) return;
        setManuscriptDialog(null);
        setManuscriptDialogName('');
        setManuscriptDialogError('');
    };

    const expandManuscriptPath = (path: string) => {
        if (!path) return;
        setExpandedManuscriptPaths((current) => {
            const next = new Set(current);
            next.add(path);
            return next;
        });
    };

    const openManuscriptContextMenu = (
        event: MouseEvent<HTMLElement>,
        parentPath: string,
        node?: RedClawManuscriptNode,
    ) => {
        event.preventDefault();
        event.stopPropagation();
        setMenuTarget(null);
        setManuscriptContextMenu({
            x: event.clientX,
            y: event.clientY,
            parentPath,
            node,
        });
    };

    const submitManuscriptDialog = async (selectedDraftKind?: ManuscriptDraftKind) => {
        if (!manuscriptDialog || isSubmittingManuscriptDialog) return;
        const draftKind = MANUSCRIPT_DRAFT_KIND_OPTIONS.find((option) => option.id === (selectedDraftKind || manuscriptDraftKind)) || MANUSCRIPT_DRAFT_KIND_OPTIONS[0];
        if (draftKind.disabled) return;
        const name = manuscriptDialog.mode === 'create-file'
            ? buildDefaultManuscriptTitle(draftKind.label)
            : manuscriptDialogName.trim();
        if (!name && manuscriptDialog.mode !== 'create-file') {
            setManuscriptDialogError('请输入名称');
            return;
        }
        setIsSubmittingManuscriptDialog(true);
        setManuscriptDialogError('');
        try {
            let result: unknown;
            if (manuscriptDialog.mode === 'create-folder') {
                result = await window.ipcRenderer.invoke('manuscripts:create-folder', {
                    parentPath: manuscriptDialog.parentPath,
                    name,
                });
                expandManuscriptPath(manuscriptDialog.parentPath);
            } else if (manuscriptDialog.mode === 'create-file') {
                const fileName = draftKind.extension && !name.endsWith(draftKind.extension)
                    ? `${name}${draftKind.extension}`
                    : name;
                result = await window.ipcRenderer.invoke('manuscripts:create-file', {
                    parentPath: manuscriptDialog.parentPath,
                    name: fileName,
                    kind: draftKind.kind,
                    title: name,
                    content: '',
                });
                expandManuscriptPath(manuscriptDialog.parentPath);
            } else {
                result = await window.ipcRenderer.invoke('manuscripts:rename', {
                    oldPath: manuscriptDialog.node.path,
                    newName: name,
                });
            }

            const error = manuscriptResultError(result);
            if (error) {
                setManuscriptDialogError(error);
                return;
            }

            const nextPath = manuscriptResultPath(result);
            setManuscriptDialog(null);
            setManuscriptDialogName('');
            await loadManuscripts();
            if (manuscriptDialog.mode === 'create-file' && nextPath) {
                onOpenManuscript?.(nextPath);
            }
        } catch (error) {
            setManuscriptDialogError(error instanceof Error ? error.message : '操作失败');
        } finally {
            setIsSubmittingManuscriptDialog(false);
        }
    };

    const deleteManuscriptNode = async (node: RedClawManuscriptNode) => {
        setMenuTarget(null);
        setManuscriptContextMenu(null);
        const label = manuscriptNodeLabel(node);
        const confirmed = await appConfirm(
            node.isDirectory ? `删除文件夹“${label}”及其中全部稿件？` : `删除稿件“${label}”？`,
            { title: node.isDirectory ? '删除文件夹' : '删除稿件', confirmLabel: '删除', tone: 'danger' }
        );
        if (!confirmed) return;
        try {
            const result = await window.ipcRenderer.invoke('manuscripts:delete', node.path);
            const error = manuscriptResultError(result);
            if (error) {
                void appAlert(error);
                return;
            }
            await loadManuscripts();
        } catch (error) {
            void appAlert(error instanceof Error ? error.message : '删除失败');
        }
    };

    const moveManuscriptNode = async (sourcePath: string, targetDir: string) => {
        if (!canMoveManuscriptPath(sourcePath, targetDir) || movingManuscriptPath) return;
        setMenuTarget(null);
        setMovingManuscriptPath(sourcePath);
        try {
            const result = await window.ipcRenderer.invoke('manuscripts:move', {
                sourcePath,
                targetDir,
            });
            const error = manuscriptResultError(result);
            if (error) {
                void appAlert(error);
                return;
            }
            expandManuscriptPath(targetDir);
            await loadManuscripts();
        } catch (error) {
            void appAlert(error instanceof Error ? error.message : '移动失败');
        } finally {
            setMovingManuscriptPath('');
            setDraggedManuscriptPath('');
            setManuscriptDropTargetPath(null);
        }
    };

    const handleManuscriptDragStart = (event: DragEvent<HTMLElement>, node: RedClawManuscriptNode) => {
        event.stopPropagation();
        setMenuTarget(null);
        setManuscriptContextMenu(null);
        setDraggedManuscriptPath(node.path);
        setManuscriptDropTargetPath(null);
        event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setData('text/plain', node.path);
        event.dataTransfer.setData('application/x-redbox-manuscript-path', node.path);
    };

    const handleManuscriptDragOver = (event: DragEvent<HTMLElement>, targetDir: string) => {
        const sourcePath = draggedManuscriptPath || event.dataTransfer.getData('application/x-redbox-manuscript-path') || event.dataTransfer.getData('text/plain');
        if (!canMoveManuscriptPath(sourcePath, targetDir)) return;
        event.preventDefault();
        event.stopPropagation();
        event.dataTransfer.dropEffect = 'move';
        setManuscriptDropTargetPath(targetDir);
    };

    const handleManuscriptDrop = (event: DragEvent<HTMLElement>, targetDir: string) => {
        const sourcePath = draggedManuscriptPath || event.dataTransfer.getData('application/x-redbox-manuscript-path') || event.dataTransfer.getData('text/plain');
        if (!canMoveManuscriptPath(sourcePath, targetDir)) return;
        event.preventDefault();
        event.stopPropagation();
        void moveManuscriptNode(sourcePath, targetDir);
    };

    const handleManuscriptDragEnd = () => {
        setMenuTarget(null);
        setManuscriptContextMenu(null);
        setDraggedManuscriptPath('');
        setManuscriptDropTargetPath(null);
    };

    const renderManuscriptNode = (node: RedClawManuscriptNode, depth = 0): ReactNode => {
        const label = manuscriptNodeLabel(node);
        const childNodes = sortManuscriptNodes(node.children || []);
        const expanded = expandedManuscriptPaths.has(node.path);
        const indentation = Math.min(depth, 4) * 12;
        const isDragging = draggedManuscriptPath === node.path || movingManuscriptPath === node.path;
        const normalizedNodePath = normalizeManuscriptPath(node.path);

        if (node.isDirectory) {
            const menuOpen = menuTarget?.type === 'manuscript' && menuTarget.path === node.path;
            const isDropTarget = manuscriptDropTargetPath === node.path;
            const containsActiveManuscript = Boolean(
                normalizedActiveManuscriptPath
                && normalizedNodePath
                && normalizedActiveManuscriptPath.startsWith(`${normalizedNodePath}/`)
            );
            return (
                <div
                    key={node.path || label}
                    className={clsx('group/node relative rounded-lg', isDropTarget && 'bg-accent-primary/10 ring-1 ring-accent-primary/25')}
                    draggable
                    onContextMenu={(event) => openManuscriptContextMenu(event, node.path, node)}
                    onDragStart={(event) => handleManuscriptDragStart(event, node)}
                    onDragOver={(event) => handleManuscriptDragOver(event, node.path)}
                    onDrop={(event) => handleManuscriptDrop(event, node.path)}
                    onDragEnd={handleManuscriptDragEnd}
                    onDragLeave={() => {
                        if (manuscriptDropTargetPath === node.path) setManuscriptDropTargetPath(null);
                    }}
                >
                    <button
                        type="button"
                        onClick={() => scheduleManuscriptClick(() => toggleManuscriptFolder(node.path))}
                        onDoubleClick={(event) => {
                            event.preventDefault();
                            event.stopPropagation();
                            cancelPendingManuscriptClick();
                            openManuscriptDialog({ mode: 'rename', node });
                        }}
                        className={clsx(
                            'group flex h-9 w-full items-center gap-2 rounded-lg px-2 pr-10 text-left text-[13px] font-bold text-text-secondary transition-colors hover:bg-surface-secondary/70 hover:text-text-primary',
                            containsActiveManuscript && 'bg-surface-secondary/70 text-text-primary',
                            isDragging && 'opacity-45'
                        )}
                        style={{ paddingLeft: 8 + indentation }}
                    >
                        <ChevronRight className={clsx('h-3.5 w-3.5 shrink-0 text-text-tertiary transition-transform', expanded && 'rotate-90')} />
                        {expanded ? (
                            <FolderOpen className="h-4 w-4 shrink-0 text-text-tertiary group-hover:text-text-secondary" />
                        ) : (
                            <Folder className="h-4 w-4 shrink-0 text-text-tertiary group-hover:text-text-secondary" />
                        )}
                        <span className="min-w-0 flex-1 truncate">{label}</span>
                    </button>
                    <div
                        className={clsx(
                            'absolute right-1 top-1.5 flex items-center gap-0.5 opacity-0 transition group-hover/node:opacity-100',
                            menuOpen && 'opacity-100'
                        )}
                        onClick={(event) => event.stopPropagation()}
                    >
                        {menuOpen ? (
                            <>
                                <button type="button" onClick={() => openManuscriptDialog({ mode: 'create-file', parentPath: node.path })} className="flex h-6 w-6 items-center justify-center rounded-md text-text-tertiary hover:bg-surface-secondary hover:text-text-primary" title="新建稿件" aria-label="新建稿件">
                                    <FilePlus2 className="h-3.5 w-3.5" />
                                </button>
                                <button type="button" onClick={() => openManuscriptDialog({ mode: 'create-folder', parentPath: node.path })} className="flex h-6 w-6 items-center justify-center rounded-md text-text-tertiary hover:bg-surface-secondary hover:text-text-primary" title="新建文件夹" aria-label="新建文件夹">
                                    <FolderPlus className="h-3.5 w-3.5" />
                                </button>
                                <button type="button" onClick={() => openManuscriptDialog({ mode: 'rename', node })} className="flex h-6 w-6 items-center justify-center rounded-md text-text-tertiary hover:bg-surface-secondary hover:text-text-primary" title="重命名" aria-label="重命名">
                                    <Edit3 className="h-3.5 w-3.5" />
                                </button>
                                <button type="button" onClick={() => void deleteManuscriptNode(node)} className="flex h-6 w-6 items-center justify-center rounded-md text-red-500 hover:bg-red-500/10" title="删除" aria-label="删除">
                                    <Trash2 className="h-3.5 w-3.5" />
                                </button>
                            </>
                        ) : (
                            <button
                                type="button"
                                onClick={(event) => {
                                    event.preventDefault();
                                    event.stopPropagation();
                                    setMenuTarget({ type: 'manuscript', path: node.path });
                                }}
                                className="flex h-6 w-6 items-center justify-center rounded-md text-text-tertiary hover:bg-surface-secondary hover:text-text-primary"
                                title="更多"
                                aria-label="更多"
                            >
                                <MoreHorizontal className="h-3.5 w-3.5" />
                            </button>
                        )}
                    </div>
                    {expanded && childNodes.length > 0 && (
                        <div className="mt-0.5 space-y-0.5">
                            {childNodes.map((child) => renderManuscriptNode(child, depth + 1))}
                        </div>
                    )}
                </div>
            );
        }

        const menuOpen = menuTarget?.type === 'manuscript' && menuTarget.path === node.path;
        const isActiveManuscript = Boolean(normalizedActiveManuscriptPath && normalizedNodePath === normalizedActiveManuscriptPath);
        return (
            <div
                key={node.path || label}
                className="group/node relative"
                draggable
                onDragStart={(event) => handleManuscriptDragStart(event, node)}
                onDragEnd={handleManuscriptDragEnd}
            >
            <button
                type="button"
                onClick={() => scheduleManuscriptClick(() => onOpenManuscript?.(node.path))}
                onDoubleClick={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    cancelPendingManuscriptClick();
                    openManuscriptDialog({ mode: 'rename', node });
                }}
                className={clsx(
                    'group flex h-9 w-full items-center gap-2 rounded-lg px-2 pr-10 text-left text-[13px] font-bold text-text-secondary transition-colors hover:bg-surface-secondary/70 hover:text-text-primary',
                    isActiveManuscript && 'bg-accent-primary/12 text-accent-primary ring-1 ring-inset ring-accent-primary/18',
                    isDragging && 'opacity-45'
                )}
                style={{ paddingLeft: 28 + indentation }}
                title={label}
            >
                <FileText className={clsx('h-4 w-4 shrink-0 text-text-tertiary group-hover:text-text-secondary', isActiveManuscript && 'text-accent-primary group-hover:text-accent-primary')} />
                <span className="min-w-0 flex-1 truncate">{label}</span>
            </button>
            <div
                className={clsx(
                    'absolute right-1 top-1.5 flex items-center gap-0.5 opacity-0 transition group-hover/node:opacity-100',
                    menuOpen && 'opacity-100'
                )}
                onClick={(event) => event.stopPropagation()}
            >
                {menuOpen ? (
                    <>
                        <button type="button" onClick={() => openManuscriptDialog({ mode: 'rename', node })} className="flex h-6 w-6 items-center justify-center rounded-md text-text-tertiary hover:bg-surface-secondary hover:text-text-primary" title="重命名" aria-label="重命名">
                            <Edit3 className="h-3.5 w-3.5" />
                        </button>
                        <button type="button" onClick={() => void deleteManuscriptNode(node)} className="flex h-6 w-6 items-center justify-center rounded-md text-red-500 hover:bg-red-500/10" title="删除" aria-label="删除">
                            <Trash2 className="h-3.5 w-3.5" />
                        </button>
                    </>
                ) : (
                    <button
                        type="button"
                        onClick={(event) => {
                            event.preventDefault();
                            event.stopPropagation();
                            setMenuTarget({ type: 'manuscript', path: node.path });
                        }}
                        className="flex h-6 w-6 items-center justify-center rounded-md text-text-tertiary hover:bg-surface-secondary hover:text-text-primary"
                        title="更多"
                        aria-label="更多"
                    >
                        <MoreHorizontal className="h-3.5 w-3.5" />
                    </button>
                )}
            </div>
            </div>
        );
    };

    const togglePinnedRoom = (roomId: string) => {
        setPinnedRoomIds((current) => {
            const next = current.includes(roomId)
                ? current.filter((id) => id !== roomId)
                : [roomId, ...current];
            writePinnedIds(PINNED_ROOM_IDS_STORAGE_KEY, next);
            return next;
        });
        setMenuTarget(null);
    };

    const togglePinnedSession = (sessionId: string) => {
        setPinnedSessionIds((current) => {
            const next = current.includes(sessionId)
                ? current.filter((id) => id !== sessionId)
                : [sessionId, ...current];
            writePinnedIds(PINNED_SESSION_IDS_STORAGE_KEY, next);
            return next;
        });
        setMenuTarget(null);
    };

    const openRenameDialog = (session: RedClawHistoryListItem) => {
        if (!onRenameSession) return;
        const title = displaySessionTitle(session.chatSession?.title?.trim() || '未命名会话', session.surface);
        setRenameTarget(session);
        setRenameTitle(title);
        setRenameError('');
    };

    const closeRenameDialog = () => {
        if (isRenaming) return;
        setRenameTarget(null);
        setRenameTitle('');
        setRenameError('');
    };

    const submitRenameDialog = async () => {
        if (!renameTarget || !onRenameSession || isRenaming) return;
        const nextTitle = renameTitle.trim();
        if (!nextTitle) {
            setRenameError('请输入名称');
            return;
        }
        setIsRenaming(true);
        setRenameError('');
        try {
            await onRenameSession(renameTarget, nextTitle);
            setRenameTarget(null);
            setRenameTitle('');
        } catch (error) {
            setRenameError(error instanceof Error ? error.message : '重命名失败');
        } finally {
            setIsRenaming(false);
        }
    };

    return (
        <div className="flex h-full min-h-0 flex-col overflow-hidden border-t border-border/70 pt-3">
            <div className="mb-3 flex items-end gap-0.5 border-b border-border/70 px-3">
                {[
                    { id: 'chat' as const, label: '对话' },
                    { id: 'manuscripts' as const, label: '稿件' },
                ].map((tab) => (
                    <button
                        key={tab.id}
                        type="button"
                        onClick={() => {
                            setMenuTarget(null);
                            setActiveTab(tab.id);
                        }}
                        aria-pressed={activeTab === tab.id}
                        className={clsx(
                            'relative -mb-px h-8 px-3 text-[12px] font-bold transition-[background-color,border-color,color,box-shadow,transform]',
                            activeTab === tab.id
                                ? 'rounded-t-lg border border-border/70 border-b-surface-primary bg-surface-primary text-text-primary shadow-[0_-1px_0_rgba(255,255,255,0.7),0_2px_8px_rgba(15,23,42,0.04)]'
                                : 'rounded-t-lg border border-transparent text-text-tertiary hover:bg-surface-secondary/60 hover:text-text-secondary'
                        )}
                    >
                        {tab.label}
                    </button>
                ))}
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto px-2 custom-scrollbar">
                {activeTab === 'manuscripts' ? (
                    <div
                        className={clsx(
                            'min-h-full space-y-0.5 rounded-lg pb-6 transition-colors',
                            manuscriptDropTargetPath === '' && 'bg-accent-primary/8 ring-1 ring-inset ring-accent-primary/20'
                        )}
                        onContextMenu={(event) => openManuscriptContextMenu(event, '')}
                        onDragOver={(event) => handleManuscriptDragOver(event, '')}
                        onDrop={(event) => handleManuscriptDrop(event, '')}
                        onDragLeave={() => {
                            if (manuscriptDropTargetPath === '') setManuscriptDropTargetPath(null);
                        }}
                    >
                        <div className="mb-2 flex items-center justify-between px-1">
                            <div className="text-[11px] font-bold text-text-tertiary">稿件库</div>
                            <div className="flex items-center gap-0.5">
                                <button
                                    type="button"
                                    onClick={() => openManuscriptDialog({ mode: 'create-file', parentPath: '' })}
                                    className="flex h-6 w-6 items-center justify-center rounded-md text-text-tertiary transition-colors hover:bg-surface-secondary hover:text-text-primary"
                                    title="新建稿件"
                                    aria-label="新建稿件"
                                >
                                    <FilePlus2 className="h-3.5 w-3.5" />
                                </button>
                                <button
                                    type="button"
                                    onClick={() => openManuscriptDialog({ mode: 'create-folder', parentPath: '' })}
                                    className="flex h-6 w-6 items-center justify-center rounded-md text-text-tertiary transition-colors hover:bg-surface-secondary hover:text-text-primary"
                                    title="新建文件夹"
                                    aria-label="新建文件夹"
                                >
                                    <FolderPlus className="h-3.5 w-3.5" />
                                </button>
                                <button
                                    type="button"
                                    onClick={() => void loadManuscripts()}
                                    className="flex h-6 w-6 items-center justify-center rounded-md text-text-tertiary transition-colors hover:bg-surface-secondary hover:text-text-primary disabled:opacity-50"
                                    title="刷新"
                                    aria-label="刷新"
                                    disabled={manuscriptsLoading}
                                >
                                    <RefreshCw className={clsx('h-3.5 w-3.5', manuscriptsLoading && 'animate-spin')} />
                                </button>
                            </div>
                        </div>
                        {manuscriptsLoading && manuscriptTree.length === 0 ? (
                            <div className="flex h-full items-center justify-center py-10">
                                <Loader2 className="w-5 h-5 animate-spin text-accent-primary/50" />
                            </div>
                        ) : manuscriptsError && manuscriptTree.length === 0 ? (
                            <div className="mx-3 rounded-lg border border-dashed border-border/80 px-3 py-3 text-center text-[11px] text-text-tertiary">
                                稿件加载失败
                            </div>
                        ) : manuscriptTree.length === 0 ? (
                            <div className="mx-3 rounded-lg border border-dashed border-border/80 px-3 py-3 text-center text-[11px] text-text-tertiary">
                                暂无稿件
                            </div>
                        ) : (
                            sortManuscriptNodes(manuscriptTree).map((node) => renderManuscriptNode(node))
                        )}
                    </div>
                ) : (
                    <>
                <div className="mb-3 border-b border-border/70 pb-3">
                    <div className="mb-1.5 flex items-center justify-between px-3">
                        <span className="text-[11px] font-bold text-text-tertiary">团队</span>
                        {onCreateRoom && (
                            <button
                                type="button"
                                onClick={() => void onCreateRoom()}
                                className="flex h-6 w-6 items-center justify-center rounded-md text-text-tertiary transition-colors hover:bg-surface-secondary hover:text-text-primary"
                                title="创建团队"
                                aria-label="创建团队"
                            >
                                <Plus className="h-3.5 w-3.5" />
                            </button>
                        )}
                    </div>
                    {teamRooms.length === 0 ? (
                        <div className="mx-3 rounded-lg border border-dashed border-border/80 px-3 py-3 text-center text-[11px] text-text-tertiary">
                            暂无团队
                        </div>
                    ) : (
                        <div className="space-y-0.5">
                            {sortedTeamRooms.map((room) => {
                                const isActiveRoom = activeSurface === 'room' && room.id === activeRoomId;
                                const memberCount = Array.isArray(room.advisorIds) ? room.advisorIds.length : 0;
                                const isPinned = pinnedRoomIdSet.has(room.id);
                                const menuOpen = menuTarget?.type === 'room' && menuTarget.id === room.id;
                                return (
                                    <div
                                        key={room.id}
                                        role="button"
                                        tabIndex={0}
                                        onClick={() => {
                                            setMenuTarget(null);
                                            onSwitchRoom?.(room.id);
                                        }}
                                        onKeyDown={(event) => {
                                            if (event.key !== 'Enter' && event.key !== ' ') return;
                                            setMenuTarget(null);
                                            onSwitchRoom?.(room.id);
                                        }}
                                        className={clsx(
                                            'group relative flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left transition-all active:scale-[0.98]',
                                            isActiveRoom
                                                ? 'bg-surface-elevated shadow-sm ring-1 ring-accent-primary/20'
                                                : 'hover:bg-surface-secondary/70'
                                        )}
                                    >
                                        {isActiveRoom && (
                                            <div className="absolute left-0 top-1/2 h-5 w-0.5 -translate-y-1/2 rounded-r-full bg-accent-primary" />
                                        )}
                                        <Users className={clsx('h-4 w-4 shrink-0', isActiveRoom ? 'text-accent-primary' : 'text-text-tertiary')} />
                                        <div className="min-w-0 flex-1">
                                            <div className={clsx(
                                                'truncate pr-14 text-[13px] font-bold leading-tight',
                                                isActiveRoom ? 'text-text-primary' : 'text-text-secondary group-hover:text-text-primary'
                                            )}>
                                                {room.name || '未命名团队'}
                                            </div>
                                            <div className="mt-0.5 text-[9px] font-bold uppercase tracking-tighter text-text-tertiary/60">
                                                {`${memberCount} 位成员`}
                                            </div>
                                        </div>
                                        <div
                                            className={clsx(
                                                'absolute right-2 top-1/2 flex -translate-y-1/2 items-center gap-0.5 opacity-0 transition-all group-hover:opacity-100',
                                                menuOpen && 'opacity-100'
                                            )}
                                            onClick={(event) => event.stopPropagation()}
                                        >
                                            {menuOpen ? (
                                                <>
                                                    <button
                                                        type="button"
                                                        onClick={() => togglePinnedRoom(room.id)}
                                                        className="flex h-6 w-6 items-center justify-center rounded-md text-text-tertiary hover:bg-surface-secondary hover:text-text-primary"
                                                        title={isPinned ? '取消置顶' : '置顶'}
                                                        aria-label={isPinned ? '取消置顶' : '置顶'}
                                                    >
                                                        <Pin className="h-3.5 w-3.5" />
                                                    </button>
                                                    {onDeleteRoom && (
                                                        <button
                                                            type="button"
                                                            onClick={() => {
                                                                setMenuTarget(null);
                                                                void onDeleteRoom(room);
                                                            }}
                                                            className="flex h-6 w-6 items-center justify-center rounded-md text-red-500 hover:bg-red-500/10"
                                                            title="删除"
                                                            aria-label="删除"
                                                        >
                                                            <Trash2 className="h-3.5 w-3.5" />
                                                        </button>
                                                    )}
                                                </>
                                            ) : (
                                                <>
                                                    <button
                                                        type="button"
                                                        onClick={() => togglePinnedRoom(room.id)}
                                                        className={clsx(
                                                            'flex h-6 w-6 items-center justify-center rounded-md hover:bg-surface-secondary hover:text-text-primary',
                                                            isPinned ? 'text-accent-primary opacity-100' : 'text-text-tertiary'
                                                        )}
                                                        title={isPinned ? '取消置顶' : '置顶'}
                                                        aria-label={isPinned ? '取消置顶' : '置顶'}
                                                    >
                                                        <Pin className="h-3.5 w-3.5" />
                                                    </button>
                                                    <button
                                                        type="button"
                                                        onClick={(event) => {
                                                            event.preventDefault();
                                                            event.stopPropagation();
                                                            setMenuTarget({ type: 'room', id: room.id });
                                                        }}
                                                        className="flex h-6 w-6 items-center justify-center rounded-md text-text-tertiary hover:bg-surface-secondary hover:text-text-primary"
                                                        title="更多"
                                                        aria-label="更多"
                                                    >
                                                        <MoreHorizontal className="h-3.5 w-3.5" />
                                                    </button>
                                                </>
                                            )}
                                        </div>
                                    </div>
                                );
                            })}
                        </div>
                    )}
                </div>

                <div className="mb-1.5 px-3 text-[11px] font-bold text-text-tertiary">最近</div>
                {historyLoading && sessionList.length === 0 ? (
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
                            const title = displaySessionTitle(session.chatSession?.title?.trim() || '未命名会话', session.surface);
                            const isPinned = pinnedSessionIdSet.has(session.id);
                            const menuOpen = menuTarget?.type === 'session' && menuTarget.id === session.id;
                            const activity = sessionActivityById[session.id];
                            const isAutomationSession = isAutomationHistorySession(session);

                            return (
                                <div
                                    key={session.id}
                                    role="button"
                                    tabIndex={0}
                                    onClick={() => {
                                        setMenuTarget(null);
                                        onSwitchSession(session);
                                    }}
                                    onDoubleClick={(e) => {
                                        e.preventDefault();
                                        e.stopPropagation();
                                        openRenameDialog(session);
                                    }}
                                    onKeyDown={(e) => {
                                        if (e.key !== 'Enter' && e.key !== ' ') return;
                                        setMenuTarget(null);
                                        onSwitchSession(session);
                                    }}
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

                                    <div className="flex items-center justify-between gap-2">
                                        <button
                                            type="button"
                                            onClick={(event) => {
                                                event.preventDefault();
                                                event.stopPropagation();
                                                togglePinnedSession(session.id);
                                            }}
                                            className={clsx(
                                                'flex h-6 w-6 shrink-0 items-center justify-center rounded-md transition hover:bg-surface-secondary hover:text-text-primary',
                                                isPinned
                                                    ? 'text-accent-primary opacity-100'
                                                    : 'text-text-tertiary opacity-0 group-hover:opacity-100'
                                            )}
                                            title={isPinned ? '取消置顶' : '置顶'}
                                            aria-label={isPinned ? '取消置顶' : '置顶'}
                                        >
                                            <Pin className="h-3.5 w-3.5" />
                                        </button>
                                        <div className="min-w-0 flex flex-1 items-center gap-1.5 pr-8">
                                            <h4 className={clsx(
                                                'min-w-0 truncate text-[13px] font-bold leading-tight transition-colors',
                                                isActive ? 'text-text-primary' : 'text-text-secondary group-hover:text-text-primary'
                                            )}>
                                                {title}
                                            </h4>
                                            {isAutomationSession && (
                                                <Clock3
                                                    className="h-3.5 w-3.5 shrink-0 text-text-tertiary/80"
                                                    strokeWidth={1.75}
                                                    aria-label="定时任务"
                                                />
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
                                        {activity === 'unread-complete' && (
                                            <span
                                                className="absolute right-4 top-1/2 h-2.5 w-2.5 -translate-y-1/2 rounded-full bg-emerald-500 shadow-[0_0_0_3px_rgba(16,185,129,0.14)] transition-opacity group-hover:opacity-0"
                                                aria-label="执行完成"
                                            />
                                        )}

                                        <div
                                            className={clsx(
                                                'absolute right-2 top-1/2 flex -translate-y-1/2 items-center gap-0.5 opacity-0 transition-all group-hover:opacity-100',
                                                menuOpen && 'opacity-100'
                                            )}
                                            onClick={(event) => event.stopPropagation()}
                                        >
                                            {menuOpen ? (
                                                <>
                                                    <button
                                                        type="button"
                                                        onClick={() => {
                                                            setMenuTarget(null);
                                                            void onDeleteSession(session);
                                                        }}
                                                        className="flex h-6 w-6 items-center justify-center rounded-md text-red-500 hover:bg-red-500/10"
                                                        title="删除"
                                                        aria-label="删除"
                                                    >
                                                        <Trash2 className="h-3.5 w-3.5" />
                                                    </button>
                                                </>
                                            ) : (
                                                <>
                                                    <button
                                                        type="button"
                                                        onClick={(e) => {
                                                            e.preventDefault();
                                                            e.stopPropagation();
                                                            setMenuTarget({ type: 'session', id: session.id });
                                                        }}
                                                        className="flex h-6 w-6 items-center justify-center rounded-md text-text-tertiary hover:bg-surface-secondary hover:text-text-primary"
                                                        title="更多"
                                                        aria-label="更多"
                                                    >
                                                        <MoreHorizontal className="h-3.5 w-3.5" />
                                                    </button>
                                                </>
                                            )}
                                        </div>
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                )}
                    </>
                )}
            </div>
            {manuscriptContextMenu && (
                <div
                    className="fixed z-[140] min-w-[168px] rounded-xl border border-border bg-surface-primary p-1.5 shadow-2xl"
                    style={{
                        left: Math.min(manuscriptContextMenu.x, window.innerWidth - 184),
                        top: Math.min(manuscriptContextMenu.y, window.innerHeight - (manuscriptContextMenu.node ? 188 : 94)),
                    }}
                    onClick={(event) => event.stopPropagation()}
                    onContextMenu={(event) => event.preventDefault()}
                >
                    <button
                        type="button"
                        onClick={() => openManuscriptDialog({ mode: 'create-file', parentPath: manuscriptContextMenu.parentPath })}
                        className="flex h-8 w-full items-center gap-2 rounded-lg px-2 text-left text-[12px] font-medium text-text-secondary transition-colors hover:bg-surface-secondary hover:text-text-primary"
                    >
                        <FilePlus2 className="h-3.5 w-3.5" />
                        <span>新建稿件</span>
                    </button>
                    <button
                        type="button"
                        onClick={() => openManuscriptDialog({ mode: 'create-folder', parentPath: manuscriptContextMenu.parentPath })}
                        className="flex h-8 w-full items-center gap-2 rounded-lg px-2 text-left text-[12px] font-medium text-text-secondary transition-colors hover:bg-surface-secondary hover:text-text-primary"
                    >
                        <FolderPlus className="h-3.5 w-3.5" />
                        <span>新建文件夹</span>
                    </button>
                    {manuscriptContextMenu.node ? (
                        <>
                            <div className="my-1 h-px bg-border/70" />
                            <button
                                type="button"
                                onClick={() => {
                                    const node = manuscriptContextMenu.node;
                                    if (node) openManuscriptDialog({ mode: 'rename', node });
                                }}
                                className="flex h-8 w-full items-center gap-2 rounded-lg px-2 text-left text-[12px] font-medium text-text-secondary transition-colors hover:bg-surface-secondary hover:text-text-primary"
                            >
                                <Edit3 className="h-3.5 w-3.5" />
                                <span>重命名</span>
                            </button>
                            <button
                                type="button"
                                onClick={() => {
                                    const node = manuscriptContextMenu.node;
                                    if (node) void deleteManuscriptNode(node);
                                }}
                                className="flex h-8 w-full items-center gap-2 rounded-lg px-2 text-left text-[12px] font-medium text-red-500 transition-colors hover:bg-red-500/10"
                            >
                                <Trash2 className="h-3.5 w-3.5" />
                                <span>删除</span>
                            </button>
                        </>
                    ) : null}
                </div>
            )}
            {renameTarget && (
                <div
                    className="fixed inset-0 z-[130] flex items-center justify-center bg-black/30 px-4"
                    onMouseDown={closeRenameDialog}
                >
                    <div
                        className="w-full max-w-[420px] rounded-2xl border border-border bg-surface-primary p-5 shadow-2xl"
                        onMouseDown={(event) => event.stopPropagation()}
                    >
                        <div className="flex items-start justify-between gap-3">
                            <div className="min-w-0">
                                <h3 className="text-lg font-bold text-text-primary">重命名对话</h3>
                                <p className="mt-1 text-sm text-text-tertiary">保持简短且易识别</p>
                            </div>
                            <button
                                type="button"
                                onClick={closeRenameDialog}
                                disabled={isRenaming}
                                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-text-tertiary transition-colors hover:bg-surface-secondary hover:text-text-primary disabled:opacity-50"
                                title="关闭"
                                aria-label="关闭"
                            >
                                <X className="h-4 w-4" />
                            </button>
                        </div>
                        <input
                            ref={renameInputRef}
                            value={renameTitle}
                            onChange={(event) => {
                                setRenameTitle(event.target.value);
                                if (renameError) setRenameError('');
                            }}
                            onKeyDown={(event) => {
                                if (event.key === 'Enter') {
                                    event.preventDefault();
                                    void submitRenameDialog();
                                } else if (event.key === 'Escape') {
                                    closeRenameDialog();
                                }
                            }}
                            disabled={isRenaming}
                            className="mt-5 h-11 w-full rounded-xl border border-border bg-surface-secondary px-3 text-sm text-text-primary outline-none transition focus:border-accent-primary focus:ring-2 focus:ring-accent-primary/15 disabled:opacity-60"
                            maxLength={80}
                        />
                        {renameError && (
                            <div className="mt-2 text-xs text-red-500">{renameError}</div>
                        )}
                        <div className="mt-5 flex items-center justify-end gap-2">
                            <button
                                type="button"
                                onClick={closeRenameDialog}
                                disabled={isRenaming}
                                className="h-9 rounded-xl border border-border px-4 text-sm text-text-secondary transition-colors hover:bg-surface-secondary hover:text-text-primary disabled:opacity-50"
                            >
                                取消
                            </button>
                            <button
                                type="button"
                                onClick={() => void submitRenameDialog()}
                                disabled={isRenaming || !renameTitle.trim()}
                                className="inline-flex h-9 items-center gap-2 rounded-xl bg-text-primary px-4 text-sm font-medium text-white transition-colors hover:bg-text-primary/90 disabled:opacity-50"
                            >
                                {isRenaming && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                                保存
                            </button>
                        </div>
                    </div>
                </div>
            )}
            {manuscriptDialog && (
                <div
                    className="fixed inset-0 z-[130] flex items-center justify-center bg-black/30 px-4"
                    onMouseDown={closeManuscriptDialog}
                >
                    <div
                        className="w-full max-w-[420px] rounded-2xl border border-border bg-surface-primary p-5 shadow-2xl"
                        onMouseDown={(event) => event.stopPropagation()}
                    >
                        <div className="flex items-start justify-between gap-3">
                            <div className="min-w-0">
                                <h3 className="text-lg font-bold text-text-primary">
                                    {manuscriptDialog.mode === 'create-folder'
                                        ? '新建文件夹'
                                        : manuscriptDialog.mode === 'create-file'
                                            ? '新建稿件'
                                            : '重命名'}
                                </h3>
                            </div>
                            <button
                                type="button"
                                onClick={closeManuscriptDialog}
                                disabled={isSubmittingManuscriptDialog}
                                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-text-tertiary transition-colors hover:bg-surface-secondary hover:text-text-primary disabled:opacity-50"
                                title="关闭"
                                aria-label="关闭"
                            >
                                <X className="h-4 w-4" />
                            </button>
                        </div>

                        {manuscriptDialog.mode === 'create-file' && (
                            <div className="mt-5 grid grid-cols-2 gap-2">
                                {MANUSCRIPT_DRAFT_KIND_OPTIONS.map((option) => (
                                    <button
                                        key={option.id}
                                        type="button"
                                        onClick={() => {
                                            if (option.disabled) return;
                                            setManuscriptDraftKind(option.id);
                                            void submitManuscriptDialog(option.id);
                                        }}
                                        disabled={isSubmittingManuscriptDialog || option.disabled}
                                        className={clsx(
                                            'flex h-20 items-center justify-between rounded-xl border px-4 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-50',
                                            manuscriptDraftKind === option.id
                                                ? 'border-accent-primary/30 bg-accent-primary/8 text-text-primary'
                                                : 'border-border bg-surface-secondary text-text-secondary hover:border-accent-primary/25 hover:bg-surface-elevated hover:text-text-primary'
                                        )}
                                    >
                                        <span className="text-sm font-bold">{option.label}</span>
                                        {isSubmittingManuscriptDialog && manuscriptDraftKind === option.id ? (
                                            <Loader2 className="h-4 w-4 animate-spin text-accent-primary" />
                                        ) : (
                                            <FileText className="h-4 w-4 text-text-tertiary" />
                                        )}
                                    </button>
                                ))}
                            </div>
                        )}

                        {manuscriptDialog.mode !== 'create-file' && (
                            <input
                                ref={manuscriptDialogInputRef}
                                value={manuscriptDialogName}
                                onChange={(event) => {
                                    setManuscriptDialogName(event.target.value);
                                    if (manuscriptDialogError) setManuscriptDialogError('');
                                }}
                                onKeyDown={(event) => {
                                    if (event.key === 'Enter') {
                                        event.preventDefault();
                                        void submitManuscriptDialog();
                                    } else if (event.key === 'Escape') {
                                        closeManuscriptDialog();
                                    }
                                }}
                                disabled={isSubmittingManuscriptDialog}
                                className="mt-5 h-11 w-full rounded-xl border border-border bg-surface-secondary px-3 text-sm text-text-primary outline-none transition focus:border-accent-primary focus:ring-2 focus:ring-accent-primary/15 disabled:opacity-60"
                                placeholder={manuscriptDialog.mode === 'create-folder' ? '文件夹名称' : '新名称'}
                                maxLength={100}
                            />
                        )}
                        {manuscriptDialogError && (
                            <div className="mt-2 text-xs text-red-500">{manuscriptDialogError}</div>
                        )}
                        {manuscriptDialog.mode !== 'create-file' && (
                            <div className="mt-5 flex items-center justify-end gap-2">
                                <button
                                    type="button"
                                    onClick={closeManuscriptDialog}
                                    disabled={isSubmittingManuscriptDialog}
                                    className="h-9 rounded-xl border border-border px-4 text-sm text-text-secondary transition-colors hover:bg-surface-secondary hover:text-text-primary disabled:opacity-50"
                                >
                                    取消
                                </button>
                                <button
                                    type="button"
                                    onClick={() => void submitManuscriptDialog()}
                                    disabled={isSubmittingManuscriptDialog || !manuscriptDialogName.trim()}
                                    className="inline-flex h-9 items-center gap-2 rounded-xl bg-text-primary px-4 text-sm font-medium text-white transition-colors hover:bg-text-primary/90 disabled:opacity-50"
                                >
                                    {isSubmittingManuscriptDialog && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                                    保存
                                </button>
                            </div>
                        )}
                    </div>
                </div>
            )}
        </div>
    );
}
