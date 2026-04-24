import { ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { MessageSquare, Settings as SettingsIcon, FolderOpen, FileEdit, Dices, Plus, Pencil, ChevronDown, ChevronLeft, ChevronRight, Bot, Image, Users, ImagePlus, Sun, Moon, X, Download, Package, AlertCircle, Sparkles, ListTodo, Bell } from 'lucide-react';
import { clsx } from 'clsx';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { ImmersiveMode, ViewType } from '../App';
import { NotificationCenterDrawer } from './NotificationCenterDrawer';
import { appAlert } from '../utils/appDialogs';
import { selectNotificationUnreadCount, useNotificationStore } from '../notifications/store';
import { uiMeasure } from '../utils/uiDebug';

const appLogo = '/Box.png';

interface LayoutProps {
  children: ReactNode;
  currentView: ViewType;
  onNavigate: (view: ViewType) => void;
  immersiveMode?: ImmersiveMode;
  globalNotice?: string | null;
}

const NAV_ITEMS: { id: ViewType; label: string; icon: typeof MessageSquare; group?: string }[] = [
  // { id: 'chat', label: 'AI 对话', icon: MessageSquare },
  { id: 'knowledge', label: '知识库', icon: FolderOpen },
  { id: 'wander', label: '漫步', icon: Dices },
  { id: 'manuscripts', label: '稿件', icon: FileEdit },
  { id: 'redclaw', label: 'RedClaw', icon: Bot },
  { id: 'workboard', label: '任务', icon: ListTodo },
  { id: 'subjects', label: '主体', icon: Package },
  { id: 'team', label: '团队', icon: Users },
  { id: 'cover-studio', label: '封面', icon: ImagePlus },
  { id: 'generation-studio', label: '创作', icon: Sparkles },
  { id: 'media-library', label: '媒体', icon: Image },
  { id: 'settings', label: '设置', icon: SettingsIcon },
  // { id: 'archives', label: '档案', icon: Archive },
  // { id: 'skills', label: '技能库', icon: Lightbulb },
];

interface WorkspaceSpace {
  id: string;
  name: string;
}

interface AppUpdateNoticePayload {
  currentVersion: string;
  latestVersion: string;
  htmlUrl: string;
  name: string;
  publishedAt: string;
  body: string;
}

type SpaceDialogMode = 'create' | 'rename';
type ThemeMode = 'light' | 'dark';

const THEME_STORAGE_KEY = 'redbox:theme-mode:v1';
const SIDEBAR_COLLAPSED_STORAGE_KEY = 'redbox:layout-sidebar-collapsed:v1';
const SIDEBAR_CONTENT_ANIMATION_MS = 170;

function readInitialThemeMode(): ThemeMode {
  if (typeof window === 'undefined') return 'light';
  const saved = String(window.localStorage.getItem(THEME_STORAGE_KEY) || '').trim().toLowerCase();
  if (saved === 'light' || saved === 'dark') {
    return saved;
  }
  return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function readInitialSidebarCollapsed(): boolean {
  if (typeof window === 'undefined') return false;
  return window.localStorage.getItem(SIDEBAR_COLLAPSED_STORAGE_KEY) === 'true';
}

export function Layout({ children, currentView, onNavigate, immersiveMode = false, globalNotice = null }: LayoutProps) {
  const [spaces, setSpaces] = useState<WorkspaceSpace[]>([]);
  const [appVersion, setAppVersion] = useState('');
  const [themeMode, setThemeMode] = useState<ThemeMode>(readInitialThemeMode);
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(readInitialSidebarCollapsed);
  const [isSidebarAnimating, setIsSidebarAnimating] = useState(false);
  const [sidebarAnimationDirection, setSidebarAnimationDirection] = useState<'collapsing' | 'expanding' | null>(null);
  const [activeSpaceId, setActiveSpaceId] = useState<string>('');
  const [isSwitchingSpace, setIsSwitchingSpace] = useState(false);
  const [isSpaceMenuOpen, setIsSpaceMenuOpen] = useState(false);
  const [hoveredSpaceId, setHoveredSpaceId] = useState<string | null>(null);
  const [isSpaceDialogOpen, setIsSpaceDialogOpen] = useState(false);
  const [spaceDialogMode, setSpaceDialogMode] = useState<SpaceDialogMode>('create');
  const [spaceDialogName, setSpaceDialogName] = useState('');
  const [spaceDialogTargetId, setSpaceDialogTargetId] = useState<string | null>(null);
  const [isSpaceDialogSubmitting, setIsSpaceDialogSubmitting] = useState(false);
  const [updateNotice, setUpdateNotice] = useState<AppUpdateNoticePayload | null>(null);
  const [isOpeningReleasePage, setIsOpeningReleasePage] = useState(false);
  const notificationDrawerOpen = useNotificationStore((state) => state.drawerOpen);
  const toggleNotificationDrawer = useNotificationStore((state) => state.toggleDrawer);
  const unreadNotificationCount = useNotificationStore(selectNotificationUnreadCount);
  const spaceMenuRef = useRef<HTMLDivElement | null>(null);
  const sidebarAnimationTimerRef = useRef<number | null>(null);
  const isFixedViewportView = currentView === 'manuscripts';
  const sidebarVisualCollapsed = isSidebarCollapsed || sidebarAnimationDirection === 'collapsing';
  const activeSpaceName = useMemo(
    () => spaces.find((space) => space.id === activeSpaceId)?.name || '暂无空间',
    [activeSpaceId, spaces]
  );

  const loadSpaces = useCallback(async () => {
    try {
      const result = await uiMeasure('layout', 'load_spaces', async () => (
        window.ipcRenderer.spaces.list() as Promise<{ spaces?: WorkspaceSpace[]; activeSpaceId?: string } | null>
      )) as { spaces?: WorkspaceSpace[]; activeSpaceId?: string } | null;
      setSpaces(result?.spaces || []);
      setActiveSpaceId(result?.activeSpaceId || '');
    } catch (error) {
      console.error('Failed to load spaces:', error);
      setSpaces([]);
      setActiveSpaceId('');
    }
  }, []);

  useEffect(() => {
    void loadSpaces();

    const handleSpaceChanged = () => {
      void loadSpaces();
    };
    window.ipcRenderer.on('space:changed', handleSpaceChanged);
    return () => {
      window.ipcRenderer.off('space:changed', handleSpaceChanged);
    };
  }, [loadSpaces]);

  useEffect(() => {
    const loadVersion = async () => {
      try {
        const version = await uiMeasure('layout', 'load_version', async () => (
          window.ipcRenderer.getAppVersion()
        ));
        setAppVersion(String(version || '').trim());
      } catch (error) {
        console.error('Failed to load app version:', error);
      }
    };
    void loadVersion();
  }, []);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (!spaceMenuRef.current) return;
      if (!spaceMenuRef.current.contains(event.target as Node)) {
        setIsSpaceMenuOpen(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, []);

  useEffect(() => {
    if (!isSpaceMenuOpen) {
      setHoveredSpaceId(null);
    }
  }, [isSpaceMenuOpen]);

  useEffect(() => {
    const effectiveTheme = immersiveMode === 'dark' ? 'dark' : themeMode;
    const root = document.documentElement;
    root.setAttribute('data-theme', effectiveTheme);
    root.classList.toggle('dark', effectiveTheme === 'dark');
    window.localStorage.setItem(THEME_STORAGE_KEY, themeMode);
  }, [immersiveMode, themeMode]);

  useEffect(() => {
    window.localStorage.setItem(SIDEBAR_COLLAPSED_STORAGE_KEY, String(isSidebarCollapsed));
  }, [isSidebarCollapsed]);

  useEffect(() => () => {
    if (sidebarAnimationTimerRef.current !== null) {
      window.clearTimeout(sidebarAnimationTimerRef.current);
    }
  }, []);

  useEffect(() => {
    const handleUpdateNotice = (_event: unknown, payload: AppUpdateNoticePayload) => {
      if (!payload || !payload.latestVersion) return;
      setUpdateNotice(payload);
    };
    window.ipcRenderer.on('app:update-available', handleUpdateNotice);
    return () => {
      window.ipcRenderer.off('app:update-available', handleUpdateNotice);
    };
  }, []);

  useEffect(() => {
    if (!updateNotice) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setUpdateNotice(null);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [updateNotice]);

  const updatePublishedDateLabel = useMemo(() => {
    if (!updateNotice?.publishedAt) return '';
    const ts = Date.parse(updateNotice.publishedAt);
    if (!Number.isFinite(ts)) return '';
    return new Date(ts).toLocaleDateString();
  }, [updateNotice?.publishedAt]);

  const openReleasePage = useCallback(async () => {
    if (!updateNotice?.htmlUrl || isOpeningReleasePage) return;
    setIsOpeningReleasePage(true);
    try {
      const result = await window.ipcRenderer.openAppReleasePage(updateNotice.htmlUrl);
      if (!result?.success) {
        void appAlert(result?.error || '打开下载页面失败');
      }
    } catch (error) {
      console.error('Failed to open release page:', error);
      void appAlert('打开下载页面失败');
    } finally {
      setIsOpeningReleasePage(false);
    }
  }, [isOpeningReleasePage, updateNotice?.htmlUrl]);

  const handleSwitchSpace = useCallback(async (nextSpaceId: string) => {
    if (!nextSpaceId || nextSpaceId === activeSpaceId) return;
    setIsSwitchingSpace(true);
    try {
      const result = await window.ipcRenderer.spaces.switch(nextSpaceId) as { success?: boolean; error?: string } | null;
      if (!result?.success) {
        void appAlert(result?.error || '切换空间失败');
        return;
      }
      setIsSpaceMenuOpen(false);
      window.location.reload();
    } catch (error) {
      console.error('Failed to switch space:', error);
      void appAlert('切换空间失败，请重试');
    } finally {
      setIsSwitchingSpace(false);
    }
  }, [activeSpaceId]);

  const openCreateSpaceDialog = useCallback(() => {
    setIsSpaceMenuOpen(false);
    setSpaceDialogMode('create');
    setSpaceDialogTargetId(null);
    setSpaceDialogName('');
    setIsSpaceDialogOpen(true);
  }, []);

  const openRenameSpaceDialog = useCallback((space: WorkspaceSpace) => {
    setIsSpaceMenuOpen(false);
    setSpaceDialogMode('rename');
    setSpaceDialogTargetId(space.id);
    setSpaceDialogName(space.name);
    setIsSpaceDialogOpen(true);
  }, []);

  const closeSpaceDialog = useCallback(() => {
    if (isSpaceDialogSubmitting) return;
    setIsSpaceDialogOpen(false);
    setSpaceDialogName('');
    setSpaceDialogTargetId(null);
  }, [isSpaceDialogSubmitting]);

  const toggleSidebarCollapsed = useCallback(() => {
    setIsSpaceMenuOpen(false);
    if (isSidebarAnimating) return;

    if (sidebarAnimationTimerRef.current !== null) {
      window.clearTimeout(sidebarAnimationTimerRef.current);
      sidebarAnimationTimerRef.current = null;
    }

    setIsSidebarAnimating(true);

    if (isSidebarCollapsed) {
      setSidebarAnimationDirection('expanding');
      setIsSidebarCollapsed(false);
      sidebarAnimationTimerRef.current = window.setTimeout(() => {
        setIsSidebarAnimating(false);
        setSidebarAnimationDirection(null);
        sidebarAnimationTimerRef.current = null;
      }, SIDEBAR_CONTENT_ANIMATION_MS);
      return;
    }

    setSidebarAnimationDirection('collapsing');
    sidebarAnimationTimerRef.current = window.setTimeout(() => {
      setIsSidebarCollapsed(true);
      setIsSidebarAnimating(false);
      setSidebarAnimationDirection(null);
      sidebarAnimationTimerRef.current = null;
    }, SIDEBAR_CONTENT_ANIMATION_MS);
  }, [isSidebarAnimating, isSidebarCollapsed]);

  const submitSpaceDialog = useCallback(async () => {
    const trimmedName = spaceDialogName.trim();
    if (!trimmedName) {
      void appAlert('空间名称不能为空');
      return;
    }

    setIsSpaceDialogSubmitting(true);
    try {
      if (spaceDialogMode === 'create') {
        const result = await window.ipcRenderer.spaces.create(trimmedName) as { success?: boolean; space?: WorkspaceSpace; error?: string } | null;
        if (!result?.success || !result.space) {
          void appAlert(result?.error || '创建空间失败');
          return;
        }
        setIsSpaceDialogOpen(false);
        setSpaceDialogName('');
        setSpaceDialogTargetId(null);
        await loadSpaces();
        await handleSwitchSpace(result.space.id);
        return;
      }

      if (!spaceDialogTargetId) {
        void appAlert('未找到要重命名的空间');
        return;
      }

      const result = await window.ipcRenderer.spaces.rename({ id: spaceDialogTargetId, name: trimmedName }) as { success?: boolean; error?: string } | null;
      if (!result?.success) {
        void appAlert(result?.error || '重命名失败');
        return;
      }

      setIsSpaceDialogOpen(false);
      setSpaceDialogName('');
      setSpaceDialogTargetId(null);
      await loadSpaces();
    } catch (error) {
      console.error('Failed to submit space dialog:', error);
      void appAlert(spaceDialogMode === 'create' ? '创建空间失败，请重试' : '重命名空间失败，请重试');
    } finally {
      setIsSpaceDialogSubmitting(false);
    }
  }, [handleSwitchSpace, loadSpaces, spaceDialogMode, spaceDialogName, spaceDialogTargetId]);

  return (
    <div
      className={clsx(
        'relative flex h-screen w-full overflow-hidden text-text-primary',
        immersiveMode === 'dark' ? 'bg-[#0f0f0f]' : 'bg-background'
      )}
    >
      {globalNotice && (
        <div className="pointer-events-none absolute left-1/2 top-3 z-[80] -translate-x-1/2">
          <div className="inline-flex items-center gap-2 rounded-full border border-red-200/80 bg-red-50/96 px-4 py-2 text-[12px] font-medium text-red-700 shadow-[0_12px_30px_-18px_rgba(220,38,38,0.55)] backdrop-blur">
            <AlertCircle className="h-3.5 w-3.5 shrink-0" strokeWidth={1.9} />
            <span className="whitespace-nowrap">{globalNotice}</span>
          </div>
        </div>
      )}

      {/* Sidebar */}
      {!immersiveMode && (
        <aside
          className={clsx(
            'app-sidebar-shell bg-surface-secondary/85 border-r border-border flex flex-col shrink-0 overflow-hidden',
            isSidebarAnimating && 'app-sidebar-shell--animating',
            isSidebarCollapsed ? 'w-[4.5rem]' : 'w-[9rem]'
          )}
        >
          {/* App Title */}
          <div
            className={clsx(
              'border-b border-border/50',
              sidebarVisualCollapsed
                ? 'px-2 py-3 flex flex-col items-center gap-2'
                : 'h-11 px-4 flex items-center'
            )}
          >
            <div
              className={clsx('flex items-center min-w-0', sidebarVisualCollapsed ? 'justify-center' : 'gap-2')}
              title={appVersion ? `红盒子 v${appVersion}` : '红盒子'}
            >
              <img src={appLogo} alt="RedBox" className="w-[18px] h-[18px] shrink-0" />
              <span
                className={clsx(
                  'font-medium text-[14px] tracking-[0.01em] truncate whitespace-nowrap transition-[max-width,opacity,transform] duration-150 ease-out',
                  sidebarVisualCollapsed ? 'max-w-0 opacity-0 -translate-x-1' : 'max-w-[7rem] opacity-100 translate-x-0'
                )}
              >
                红盒子
              </span>
            </div>
            <div className={clsx('flex items-center gap-2', sidebarVisualCollapsed ? 'flex-col' : 'ml-auto')}>
              <button
                type="button"
                onClick={toggleSidebarCollapsed}
                className="h-7 w-7 rounded-lg text-text-secondary hover:text-text-primary transition-colors inline-flex items-center justify-center"
                title={isSidebarCollapsed ? '展开侧边栏' : '折叠为仅图标'}
                aria-label={isSidebarCollapsed ? '展开侧边栏' : '折叠为仅图标'}
              >
                {isSidebarCollapsed
                  ? <ChevronRight className="w-[14px] h-[14px]" strokeWidth={1.75} />
                  : <ChevronLeft className="w-[14px] h-[14px]" strokeWidth={1.75} />}
              </button>
            </div>
          </div>

          {/* Navigation */}
          <nav className={clsx('flex-1 py-3 space-y-1.5', sidebarVisualCollapsed ? 'px-2' : 'px-2.5')}>
            {NAV_ITEMS.map(({ id, label, icon: Icon }) => (
              <button
                key={id}
                type="button"
                data-guide-id={`nav-${id}`}
                onClick={() => {
                  onNavigate(id);
                }}
                title={label}
                aria-label={label}
                className={clsx(
                  'w-full rounded-xl transition-all tracking-[0.01em] font-normal inline-flex items-center',
                  sidebarVisualCollapsed ? 'h-11 justify-center px-0' : 'gap-3 px-3.5 py-2.5 text-[13px]',
                  id === 'subjects'
                    ? (
                      currentView === id
                        ? 'bg-transparent text-accent-primary shadow-none'
                        : 'bg-transparent text-text-secondary/90 hover:bg-transparent hover:text-text-primary'
                    )
                    : (
                      currentView === id
                        ? 'bg-surface-primary text-accent-primary shadow-sm'
                        : 'text-text-secondary/90 hover:bg-surface-primary/55 hover:text-text-primary'
                    )
                )}
              >
                <Icon className="w-[15px] h-[15px] shrink-0" strokeWidth={1.75} />
                <span
                  className={clsx(
                    'truncate whitespace-nowrap transition-[max-width,opacity,transform] duration-150 ease-out',
                    sidebarVisualCollapsed ? 'max-w-0 opacity-0 translate-x-1' : 'max-w-[7rem] opacity-100 translate-x-0'
                  )}
                >
                  {label}
                </span>
              </button>
            ))}
          </nav>

          {/* Footer */}
          <div className={clsx('border-t border-border', sidebarVisualCollapsed ? 'px-2 py-3 flex flex-col items-center gap-2.5' : 'px-4 py-3 space-y-2.5')}>
            <div className={clsx(sidebarVisualCollapsed ? 'w-full flex justify-center' : 'space-y-1.5')}>
              <div
                className={clsx(
                  'text-[10px] tracking-[0.04em] text-text-tertiary overflow-hidden whitespace-nowrap transition-[max-height,opacity,transform] duration-150 ease-out',
                  sidebarVisualCollapsed ? 'max-h-0 opacity-0 -translate-y-1' : 'max-h-4 opacity-100 translate-y-0'
                )}
              >
                空间
              </div>
              <div ref={spaceMenuRef} className="relative">
                <button
                  type="button"
                  onClick={() => setIsSpaceMenuOpen((prev) => !prev)}
                  disabled={isSwitchingSpace}
                  title={sidebarVisualCollapsed ? `当前空间：${activeSpaceName}` : undefined}
                  aria-label={sidebarVisualCollapsed ? `当前空间：${activeSpaceName}` : undefined}
                  className={clsx(
                    'rounded-lg border border-border bg-surface-primary text-text-primary disabled:opacity-50',
                    sidebarVisualCollapsed
                      ? 'w-10 h-10 inline-flex items-center justify-center'
                      : 'w-full h-8 px-2.5 text-[12px] flex items-center justify-between'
                  )}
                >
                  {sidebarVisualCollapsed ? (
                    <FolderOpen className="w-[16px] h-[16px] text-text-secondary" strokeWidth={1.75} />
                  ) : (
                    <>
                      <span className="truncate">{activeSpaceName}</span>
                      <ChevronDown className={clsx('w-[13px] h-[13px] text-text-tertiary transition-transform', isSpaceMenuOpen && 'rotate-180')} strokeWidth={1.75} />
                    </>
                  )}
                </button>

                {isSpaceMenuOpen && (
                  <div
                    className={clsx(
                      'absolute rounded-lg border border-border bg-surface-primary shadow-lg z-50 overflow-hidden',
                      sidebarVisualCollapsed ? 'bottom-0 left-full ml-2 w-56' : 'left-0 right-0 bottom-full mb-1.5'
                    )}
                  >
                    <div className="max-h-44 overflow-y-auto">
                      {spaces.length === 0 ? (
                        <div className="h-9 px-2.5 text-[12px] text-text-tertiary flex items-center">
                          暂无空间
                        </div>
                      ) : (
                        spaces.map((space) => {
                          const isActive = space.id === activeSpaceId;
                          const showEdit = hoveredSpaceId === space.id;
                          return (
                            <div
                              key={space.id}
                              className={clsx(
                                'h-9 px-2.5 flex items-center gap-1.5',
                                isActive ? 'bg-accent-primary/10' : 'hover:bg-surface-secondary'
                              )}
                              onMouseEnter={() => setHoveredSpaceId(space.id)}
                              onMouseLeave={() => setHoveredSpaceId((prev) => (prev === space.id ? null : prev))}
                            >
                              <button
                                type="button"
                                onClick={() => {
                                  void handleSwitchSpace(space.id);
                                }}
                                className={clsx('flex-1 text-left text-[12px] truncate', isActive ? 'text-accent-primary' : 'text-text-primary')}
                              >
                                {space.name}
                              </button>
                              <button
                                type="button"
                                onMouseDown={(event) => {
                                  event.preventDefault();
                                  event.stopPropagation();
                                  openRenameSpaceDialog(space);
                                }}
                                className={clsx(
                                  'w-5 h-5 inline-flex items-center justify-center rounded-md text-text-secondary hover:text-text-primary hover:bg-surface-primary transition-opacity',
                                  showEdit ? 'opacity-100' : 'opacity-0 pointer-events-none'
                                )}
                                title="重命名空间"
                              >
                                <Pencil className="w-[12px] h-[12px]" strokeWidth={1.75} />
                              </button>
                            </div>
                          );
                        })
                      )}
                    </div>

                    <button
                      type="button"
                      onMouseDown={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        openCreateSpaceDialog();
                      }}
                      className="w-full h-9 px-2.5 border-t border-border text-[12px] text-text-secondary hover:text-text-primary hover:bg-surface-secondary flex items-center gap-1.5"
                    >
                      <Plus className="w-[12px] h-[12px]" strokeWidth={1.75} />
                      新建空间
                    </button>
                  </div>
                )}
              </div>
            </div>
            <div
              className={clsx(
                'flex items-center justify-center gap-2 text-[11px] text-text-tertiary/90 overflow-hidden whitespace-nowrap transition-[max-height,opacity,transform] duration-150 ease-out',
                sidebarVisualCollapsed ? 'max-h-0 opacity-0 translate-y-1' : 'max-h-4 opacity-100 translate-y-0'
              )}
            >
              <button
                type="button"
                onClick={toggleNotificationDrawer}
                className="relative h-5 w-5 rounded-md border border-border bg-surface-primary text-text-secondary hover:text-text-primary hover:bg-surface-secondary transition-colors inline-flex items-center justify-center shrink-0"
                title={notificationDrawerOpen ? '关闭通知中心' : '打开通知中心'}
                aria-label={notificationDrawerOpen ? '关闭通知中心' : '打开通知中心'}
              >
                <Bell className="w-[11px] h-[11px]" strokeWidth={1.75} />
                {unreadNotificationCount > 0 && (
                  <span className="absolute -right-1.5 -top-1.5 min-w-[14px] h-[14px] rounded-full bg-accent-primary px-1 text-[9px] leading-[14px] text-white">
                    {unreadNotificationCount > 9 ? '9+' : unreadNotificationCount}
                  </span>
                )}
              </button>
              <button
                type="button"
                onClick={() => setThemeMode((prev) => prev === 'dark' ? 'light' : 'dark')}
                className="h-5 w-5 rounded-md border border-border bg-surface-primary text-text-secondary hover:text-text-primary hover:bg-surface-secondary transition-colors inline-flex items-center justify-center shrink-0"
                title={themeMode === 'dark' ? '切换到白天模式' : '切换到黑夜模式'}
                aria-label={themeMode === 'dark' ? '切换到白天模式' : '切换到黑夜模式'}
              >
                {themeMode === 'dark'
                  ? <Sun className="w-[11px] h-[11px]" strokeWidth={1.75} />
                  : <Moon className="w-[11px] h-[11px]" strokeWidth={1.75} />}
              </button>
              <span>{appVersion ? `v${appVersion}` : 'v--'}</span>
            </div>
          </div>
        </aside>
      )}

      {/* Main Content */}
      <main
        className={clsx(
          'app-main-shell flex-1 flex flex-col min-w-0 relative',
          immersiveMode === 'dark' ? 'bg-[#0f0f0f]' : 'bg-surface-primary'
        )}
      >
        {/* Content */}
        <div
          className={clsx(
            'flex-1',
            isFixedViewportView ? 'min-h-0 flex flex-col overflow-hidden' : 'overflow-auto'
          )}
        >
          {children}
        </div>
      </main>

      {isSpaceDialogOpen && (
        <div
          className="fixed inset-0 z-[120] bg-black/30 flex items-center justify-center"
          onMouseDown={closeSpaceDialog}
        >
          <div
            className="w-80 rounded-lg border border-border bg-surface-primary shadow-xl p-4 space-y-3"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="text-sm font-medium text-text-primary">
              {spaceDialogMode === 'create' ? '新建空间' : '重命名空间'}
            </div>
            <input
              autoFocus
              value={spaceDialogName}
              onChange={(event) => setSpaceDialogName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  void submitSpaceDialog();
                } else if (event.key === 'Escape') {
                  closeSpaceDialog();
                }
              }}
              className="w-full h-9 rounded-md border border-border bg-surface-secondary px-3 text-sm text-text-primary focus:outline-none focus:ring-1 focus:ring-accent-primary"
              placeholder="请输入空间名称"
            />
            <div className="flex items-center justify-end gap-2">
              <button
                onClick={closeSpaceDialog}
                disabled={isSpaceDialogSubmitting}
                className="h-8 px-3 text-xs rounded-md border border-border text-text-secondary hover:text-text-primary hover:bg-surface-secondary disabled:opacity-50"
              >
                取消
              </button>
              <button
                onClick={() => {
                  void submitSpaceDialog();
                }}
                disabled={isSpaceDialogSubmitting}
                className="h-8 px-3 text-xs rounded-md bg-accent-primary text-white hover:bg-accent-hover disabled:opacity-50"
              >
                {isSpaceDialogSubmitting ? '处理中...' : '确定'}
              </button>
            </div>
          </div>
        </div>
      )}

      {updateNotice && (
        <div
          className="fixed inset-0 z-[140] bg-black/45 flex items-center justify-center px-6 py-6"
          onMouseDown={() => setUpdateNotice(null)}
        >
          <div
            className="w-full max-w-5xl max-h-[86vh] bg-surface-primary border border-border rounded-3xl shadow-2xl flex flex-col"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="px-8 pt-6 pb-4 border-b border-border flex items-center justify-between gap-3">
              <h2 className="text-2xl font-semibold text-text-primary">软件更新</h2>
              <button
                type="button"
                onClick={() => setUpdateNotice(null)}
                className="h-9 w-9 rounded-lg border border-border text-text-secondary hover:text-text-primary hover:bg-surface-secondary transition-colors inline-flex items-center justify-center"
                title="关闭"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="px-8 py-6 border-b border-border">
              <div className="flex items-center justify-between gap-6">
                <div className="flex items-center gap-4">
                  <div className="h-12 w-12 rounded-xl bg-surface-secondary text-text-secondary inline-flex items-center justify-center">
                    <Download className="w-6 h-6" />
                  </div>
                  <div>
                    <div className="text-3xl font-semibold text-text-primary leading-tight">发现新版本</div>
                    <div className="text-xl text-text-secondary mt-1">→ {updateNotice.latestVersion}</div>
                    <div className="text-xs text-text-tertiary mt-2">
                      当前版本 {updateNotice.currentVersion}
                      {updatePublishedDateLabel ? ` · 发布于 ${updatePublishedDateLabel}` : ''}
                    </div>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    void openReleasePage();
                  }}
                  disabled={isOpeningReleasePage}
                  className="h-11 px-5 rounded-lg bg-accent-primary text-white text-sm font-medium hover:bg-accent-hover disabled:opacity-60 transition-colors whitespace-nowrap"
                >
                  {isOpeningReleasePage ? '打开中...' : '下载并安装'}
                </button>
              </div>
            </div>

            <div className="px-8 py-6 overflow-y-auto min-h-0">
              <div className="text-3xl font-semibold text-text-primary mb-4">
                {updateNotice.name || 'Release Notes'}
              </div>
              <div
                className={clsx(
                  'text-base leading-7 text-text-secondary',
                  '[&_h1]:text-3xl [&_h1]:font-semibold [&_h1]:text-text-primary [&_h1]:mt-8 [&_h1]:mb-4',
                  '[&_h2]:text-2xl [&_h2]:font-semibold [&_h2]:text-text-primary [&_h2]:mt-7 [&_h2]:mb-3',
                  '[&_h3]:text-xl [&_h3]:font-semibold [&_h3]:text-text-primary [&_h3]:mt-6 [&_h3]:mb-3',
                  '[&_p]:my-3',
                  '[&_ul]:list-disc [&_ul]:pl-6 [&_ul]:my-3',
                  '[&_ol]:list-decimal [&_ol]:pl-6 [&_ol]:my-3',
                  '[&_li]:my-1.5',
                  '[&_a]:text-accent-primary [&_a]:underline',
                  '[&_img]:rounded-xl [&_img]:border [&_img]:border-border [&_img]:my-4 [&_img]:max-w-full',
                  '[&_code]:bg-surface-secondary [&_code]:px-1.5 [&_code]:py-0.5 [&_code]:rounded [&_code]:text-sm',
                  '[&_pre]:bg-surface-secondary [&_pre]:border [&_pre]:border-border [&_pre]:rounded-lg [&_pre]:p-4 [&_pre]:overflow-x-auto [&_pre]:my-4'
                )}
              >
                <ReactMarkdown remarkPlugins={[remarkGfm]}>
                  {String(updateNotice.body || '').trim() || '暂无更新说明。'}
                </ReactMarkdown>
              </div>
            </div>
          </div>
        </div>
      )}

      <NotificationCenterDrawer />
    </div>
  );
}
