import { Dispatch, MouseEvent as ReactMouseEvent, ReactNode, SetStateAction, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { MessageSquare, Settings as SettingsIcon, Folder, FolderOpen, FileEdit, Dices, Plus, Pencil, ChevronDown, Users, ImagePlus, Sun, Moon, X, Download, AlertCircle, Sparkles, Bell, BookOpenText, Home, PanelLeft, Search, Clock3, Edit } from 'lucide-react';
import { clsx } from 'clsx';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { ImmersiveMode, ViewType } from '../App';
import { NotificationCenterDrawer } from './NotificationCenterDrawer';
import { appAlert } from '../utils/appDialogs';
import { selectNotificationUnreadCount, useNotificationStore } from '../notifications/store';
import { REDBOX_NAVIGATE_EVENT } from '../notifications/types';
import { uiMeasure } from '../utils/uiDebug';

interface LayoutProps {
  children: ReactNode;
  currentView: ViewType;
  onNavigate: (view: ViewType) => void;
  immersiveMode?: ImmersiveMode;
  globalNotice?: string | null;
  globalSidebarContent?: ReactNode;
  renderTitleBarContent?: (context: { currentView: ViewType }) => ReactNode;
}

type SidebarNavItem = {
  key: string;
  view: ViewType;
  label: string;
  icon: typeof MessageSquare;
  redclawAction?: 'new';
  settingsTab?: 'general' | 'ai' | 'tools' | 'profile' | 'remote' | 'experimental';
  primary?: boolean;
};

const NAV_ITEMS: SidebarNavItem[] = [
  { key: 'new-chat', view: 'redclaw', label: '新对话', icon: Edit, redclawAction: 'new', primary: true },
  { key: 'search', view: 'knowledge', label: '搜索', icon: Search, primary: true },
  { key: 'assets', view: 'subjects', label: '资产库', icon: Folder, primary: true },
  { key: 'automation', view: 'automation', label: '自动化', icon: Clock3, primary: true },
  { key: 'home', view: 'home', label: '主页', icon: Home },
  { key: 'wander', view: 'wander', label: '漫步', icon: Dices },
  { key: 'manuscripts', view: 'manuscripts', label: '稿件', icon: FileEdit },
  { key: 'creator-profiles', view: 'creator-profiles', label: '创作档案', icon: BookOpenText },
  { key: 'cover-studio', view: 'cover-studio', label: '封面', icon: ImagePlus },
  { key: 'generation-studio', view: 'generation-studio', label: '创作', icon: Sparkles },
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

function shouldUseMacOverlayTitleBar(): boolean {
  if (typeof navigator === 'undefined') return false;
  return /\bMac\b/i.test(navigator.platform || '') || /\bMac OS X\b/i.test(navigator.userAgent || '');
}

function AppTitleBar({
  immersiveMode,
  enabled,
  content,
  isSidebarCollapsed,
  toggleSidebarCollapsed,
  notificationDrawerOpen,
  unreadNotificationCount,
  toggleNotificationDrawer,
  themeMode,
  setThemeMode,
}: {
  immersiveMode: ImmersiveMode;
  enabled: boolean;
  content: ReactNode;
  isSidebarCollapsed: boolean;
  toggleSidebarCollapsed: () => void;
  notificationDrawerOpen: boolean;
  unreadNotificationCount: number;
  toggleNotificationDrawer: () => void;
  themeMode: ThemeMode;
  setThemeMode: Dispatch<SetStateAction<ThemeMode>>;
}) {
  if (!enabled) return null;

  const startWindowDrag = (event: ReactMouseEvent<HTMLElement>) => {
    if (event.button !== 0) return;
    const target = event.target as HTMLElement | null;
    if (target?.closest('button,a,input,textarea,select,[role="button"],[data-no-window-drag]')) return;
    event.preventDefault();
    void window.ipcRenderer.windowControls.startDragging().catch((error) => {
      console.warn('[RedBox] failed to start window drag:', error);
    });
  };

  return (
    <header
      data-tauri-drag-region
      onMouseDown={startWindowDrag}
      className={clsx(
        'app-titlebar shrink-0',
        immersiveMode === 'dark' && 'app-titlebar--dark'
      )}
    >
      <div data-tauri-drag-region className="app-titlebar-controls">
        <button
          type="button"
          onClick={toggleSidebarCollapsed}
          className="app-titlebar-sidebar-toggle"
          title={isSidebarCollapsed ? '展开侧边栏' : '收起侧边栏'}
          aria-label={isSidebarCollapsed ? '展开侧边栏' : '收起侧边栏'}
          data-no-window-drag
        >
          <PanelLeft className="w-[15px] h-[15px]" strokeWidth={1.7} />
        </button>
      </div>
      <div data-tauri-drag-region className="app-titlebar-title">
        {content}
      </div>
      <div className="app-titlebar-actions">
        <button
          type="button"
          onClick={toggleNotificationDrawer}
          className="app-titlebar-button"
          title={notificationDrawerOpen ? '关闭通知中心' : '打开通知中心'}
          aria-label={notificationDrawerOpen ? '关闭通知中心' : '打开通知中心'}
        >
          <Bell className="w-[13px] h-[13px]" strokeWidth={1.75} />
          {unreadNotificationCount > 0 && (
            <span className="app-titlebar-badge">
              {unreadNotificationCount > 9 ? '9+' : unreadNotificationCount}
            </span>
          )}
        </button>
        <button
          type="button"
          onClick={() => setThemeMode((prev) => prev === 'dark' ? 'light' : 'dark')}
          className="app-titlebar-button"
          title={themeMode === 'dark' ? '切换到白天模式' : '切换到黑夜模式'}
          aria-label={themeMode === 'dark' ? '切换到白天模式' : '切换到黑夜模式'}
        >
          {themeMode === 'dark'
            ? <Sun className="w-[13px] h-[13px]" strokeWidth={1.75} />
            : <Moon className="w-[13px] h-[13px]" strokeWidth={1.75} />}
        </button>
      </div>
    </header>
  );
}

export function Layout({ children, currentView, onNavigate, immersiveMode = false, globalNotice = null, globalSidebarContent, renderTitleBarContent }: LayoutProps) {
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
  const usesMacOverlayTitleBar = shouldUseMacOverlayTitleBar();
  const titleBarContent = renderTitleBarContent?.({ currentView }) ?? null;
  const sidebarVisualCollapsed = isSidebarCollapsed || sidebarAnimationDirection === 'collapsing';
  const visibleGlobalSidebarContent = !sidebarVisualCollapsed ? globalSidebarContent : null;
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

  useEffect(() => {
    if (sidebarVisualCollapsed) {
      setIsSpaceMenuOpen(false);
    }
  }, [sidebarVisualCollapsed]);

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
    const updateCheckTimer = window.setTimeout(() => {
      void window.ipcRenderer.checkAppUpdate(false).then((result) => {
        if (result?.hasUpdate && result.notice) {
          setUpdateNotice(result.notice);
        }
      }).catch((error) => {
        console.warn('[AppUpdate] check failed:', error);
      });
    }, 1800);
    window.ipcRenderer.on('app:update-available', handleUpdateNotice);
    return () => {
      window.clearTimeout(updateCheckTimer);
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

  const handleSidebarNavigate = useCallback((item: SidebarNavItem) => {
    if (item.settingsTab || item.redclawAction) {
      window.dispatchEvent(new CustomEvent(REDBOX_NAVIGATE_EVENT, {
        detail: {
          view: item.view,
          settingsTab: item.settingsTab,
          redclawAction: item.redclawAction,
        },
      }));
      return;
    }
    onNavigate(item.view);
  }, [onNavigate]);

  const renderSidebarNavItem = (item: SidebarNavItem) => {
    const { key, view, label, icon: Icon, primary } = item;
    const isActive = !item.redclawAction && currentView === view && !item.settingsTab;
    return (
      <button
        key={key}
        type="button"
        data-guide-id={`nav-${key}`}
        onClick={() => handleSidebarNavigate(item)}
        title={label}
        aria-label={label}
        className={clsx(
          'app-sidebar-nav-item relative w-full rounded-xl transition-all font-normal inline-flex items-center',
          sidebarVisualCollapsed ? 'app-sidebar-nav-item--collapsed justify-center' : 'app-sidebar-nav-item--expanded',
          primary && 'app-sidebar-nav-item--primary',
          view === 'subjects'
            ? (
              isActive
                ? 'app-sidebar-nav-item--active-special shadow-none'
                : 'app-sidebar-nav-item--plain'
            )
            : (
              isActive
                ? 'app-sidebar-nav-item--active shadow-sm'
                : 'app-sidebar-nav-item--plain'
            )
        )}
      >
        <Icon className="app-sidebar-nav-icon shrink-0" strokeWidth={primary ? 1.6 : 1.65} />
        {!sidebarVisualCollapsed && (
          <span className="app-sidebar-nav-label truncate whitespace-nowrap opacity-100 translate-x-0">
            {label}
          </span>
        )}
      </button>
    );
  };

  return (
    <div
      className={clsx(
        'relative flex h-screen w-full overflow-hidden text-text-primary',
        immersiveMode === 'dark' ? 'bg-[#0f0f0f]' : 'bg-background'
      )}
    >
      <AppTitleBar
        immersiveMode={immersiveMode}
        enabled={usesMacOverlayTitleBar}
        content={titleBarContent}
        isSidebarCollapsed={isSidebarCollapsed}
        toggleSidebarCollapsed={toggleSidebarCollapsed}
        notificationDrawerOpen={notificationDrawerOpen}
        unreadNotificationCount={unreadNotificationCount}
        toggleNotificationDrawer={toggleNotificationDrawer}
        themeMode={themeMode}
        setThemeMode={setThemeMode}
      />

      {globalNotice && (
        <div
          className={clsx(
            'pointer-events-none absolute left-1/2 z-[80] -translate-x-1/2',
            usesMacOverlayTitleBar ? 'top-[calc(var(--app-titlebar-height)+0.75rem)]' : 'top-3'
          )}
        >
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
            usesMacOverlayTitleBar && 'pt-[var(--app-titlebar-height)]',
            isSidebarAnimating && 'app-sidebar-shell--animating',
            sidebarVisualCollapsed ? 'app-sidebar-shell--collapsed' : 'app-sidebar-shell--expanded'
          )}
        >
          {/* Navigation */}
          <nav className={clsx('app-sidebar-nav', visibleGlobalSidebarContent ? 'shrink-0' : 'flex-1', sidebarVisualCollapsed ? 'app-sidebar-nav--collapsed' : 'app-sidebar-nav--expanded')}>
            {NAV_ITEMS.map(renderSidebarNavItem)}
          </nav>

          {visibleGlobalSidebarContent && (
            <div className="min-h-0 flex-1 overflow-hidden px-2 pb-3 flex flex-col">
              {visibleGlobalSidebarContent}
            </div>
          )}

          {/* Footer */}
          <div className={clsx('border-t border-border', sidebarVisualCollapsed ? 'px-2 py-3 flex flex-col items-center gap-2.5' : 'px-4 py-3 space-y-2.5')}>
            {!sidebarVisualCollapsed && (
              <div className="space-y-1.5">
                <div
                  className="max-h-4 text-[10px] tracking-[0.04em] text-text-tertiary overflow-hidden whitespace-nowrap opacity-100 translate-y-0"
                >
                  空间
                </div>
                <div ref={spaceMenuRef} className="relative">
                  <button
                    type="button"
                    onClick={() => setIsSpaceMenuOpen((prev) => !prev)}
                    disabled={isSwitchingSpace}
                    className="w-full h-8 px-2.5 text-[12px] flex items-center justify-between rounded-lg border border-border bg-surface-primary text-text-primary disabled:opacity-50"
                  >
                    <span className="truncate">{activeSpaceName}</span>
                    <ChevronDown className={clsx('w-[13px] h-[13px] text-text-tertiary transition-transform', isSpaceMenuOpen && 'rotate-180')} strokeWidth={1.75} />
                  </button>

                  {isSpaceMenuOpen && (
                    <div
                      className="absolute left-0 right-0 bottom-full mb-1.5 rounded-lg border border-border bg-surface-primary shadow-lg z-50 overflow-hidden"
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
            )}
            {sidebarVisualCollapsed && (
              <button
                type="button"
                onClick={() => onNavigate('settings')}
                className="h-8 w-8 rounded-md text-text-tertiary hover:text-text-primary transition-colors inline-flex items-center justify-center shrink-0"
                title="设置"
                aria-label="设置"
              >
                <SettingsIcon className="w-[14px] h-[14px]" strokeWidth={1.75} />
              </button>
            )}
            <div
              className={clsx(
                'flex items-center justify-center gap-2 text-[11px] text-text-tertiary/90 overflow-hidden whitespace-nowrap transition-[max-height,opacity,transform] duration-150 ease-out',
                usesMacOverlayTitleBar
                  ? 'max-h-4 opacity-100 translate-y-0'
                  : sidebarVisualCollapsed ? 'max-h-0 opacity-0 translate-y-1' : 'max-h-4 opacity-100 translate-y-0'
              )}
            >
              <button
                type="button"
                onClick={() => onNavigate('settings')}
                className="h-5 w-5 rounded-md text-text-tertiary hover:text-text-primary transition-colors inline-flex items-center justify-center shrink-0"
                title="设置"
                aria-label="设置"
              >
                <SettingsIcon className="w-[11px] h-[11px]" strokeWidth={1.75} />
              </button>
              {!usesMacOverlayTitleBar && (
                <>
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
                </>
              )}
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
            usesMacOverlayTitleBar && 'pt-[var(--app-titlebar-height)]',
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
                {updateNotice.name || '更新说明'}
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
