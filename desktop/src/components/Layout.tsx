import { Dispatch, MouseEvent as ReactMouseEvent, ReactNode, SetStateAction, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { MessageSquare, Settings as SettingsIcon, Folder, FolderOpen, Dices, Pencil, ChevronDown, Users, Sun, Moon, X, Download, AlertCircle, Bell, PanelLeft, Search, Clock3, Edit, BookOpenText, Trash2, Minus, Square } from 'lucide-react';
import { clsx } from 'clsx';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { ImmersiveMode, ViewType } from '../features/app-shell/types';
import { NotificationCenterDrawer } from './NotificationCenterDrawer';
import { APP_BRAND } from '../config/brand';
import type { ThemeMode } from '../config/theme';
import { useI18n, type I18nKey } from '../i18n';
import { appAlert, appConfirm } from '../utils/appDialogs';
import { selectNotificationUnreadCount, useNotificationStore } from '../notifications/store';
import { dispatchAppIntent } from '../features/app-shell/appIntent';
import { useAppUpdateNotice } from '../features/app-shell/useAppUpdateNotice';
import { useGlobalKnowledgeSearch } from '../features/app-shell/useGlobalKnowledgeSearch';
import { useLayoutSidebar } from '../features/app-shell/useLayoutSidebar';
import { useLayoutTheme } from '../features/app-shell/useLayoutTheme';
import { uiMeasure } from '../utils/uiDebug';

interface LayoutProps {
  children: ReactNode;
  currentView: ViewType;
  onNavigate: (view: ViewType) => void;
  immersiveMode?: ImmersiveMode;
  hideGlobalSidebar?: boolean;
  globalNotice?: string | null;
  globalSidebarContent?: ReactNode;
  activeModalView?: ViewType;
  renderTitleBarContent?: (context: { currentView: ViewType }) => ReactNode;
  renderTitleBarActions?: (context: { currentView: ViewType }) => ReactNode;
}

type SidebarNavItem = {
  key: string;
  view: ViewType;
  labelKey: I18nKey;
  icon: typeof MessageSquare;
  redclawAction?: 'new';
  settingsTab?: 'general' | 'ai' | 'platforms' | 'tools' | 'profile' | 'remote' | 'experimental';
  primary?: boolean;
};

const NAV_ITEMS: SidebarNavItem[] = [
  { key: 'new-chat', view: 'redclaw', labelKey: 'nav.newChat', icon: Edit, redclawAction: 'new', primary: true },
  { key: 'search', view: 'knowledge', labelKey: 'nav.search', icon: BookOpenText, primary: true },
  { key: 'assets', view: 'subjects', labelKey: 'nav.assets', icon: Folder, primary: true },
  { key: 'automation', view: 'automation', labelKey: 'nav.automation', icon: Clock3, primary: true },
  { key: 'free-creation', view: 'generation-studio', labelKey: 'nav.home', icon: Pencil },
  { key: 'wander', view: 'wander', labelKey: 'nav.wander', icon: Dices },
  // { id: 'archives', label: '档案', icon: Archive },
  // { id: 'skills', label: '技能库', icon: Lightbulb },
];

interface WorkspaceSpace {
  id: string;
  name: string;
}

type AppTitleBarPlatform = 'mac' | 'windows' | null;

function getAppTitleBarPlatform(): AppTitleBarPlatform {
  if (typeof navigator === 'undefined') return null;
  const platform = navigator.platform || '';
  const userAgent = navigator.userAgent || '';
  if (/\bMac\b/i.test(platform) || /\bMac OS X\b/i.test(userAgent)) return 'mac';
  if (/\bWin/i.test(platform) || /\bWindows\b/i.test(userAgent)) return 'windows';
  return null;
}

function AppTitleBar({
  immersiveMode,
  enabled,
  platform,
  content,
  isSidebarCollapsed,
  toggleSidebarCollapsed,
  openGlobalSearch,
  notificationDrawerOpen,
  unreadNotificationCount,
  toggleNotificationDrawer,
  themeMode,
  setManualThemeMode,
  extraActions,
}: {
  immersiveMode: ImmersiveMode;
  enabled: boolean;
  platform: AppTitleBarPlatform;
  content: ReactNode;
  isSidebarCollapsed: boolean;
  toggleSidebarCollapsed: () => void;
  openGlobalSearch: () => void;
  notificationDrawerOpen: boolean;
  unreadNotificationCount: number;
  toggleNotificationDrawer: () => void;
  themeMode: ThemeMode;
  setManualThemeMode: Dispatch<SetStateAction<ThemeMode>>;
  extraActions: ReactNode;
}) {
  const { t } = useI18n();
  if (!enabled) return null;

  const startWindowDrag = (event: ReactMouseEvent<HTMLElement>) => {
    if (event.button !== 0) return;
    const target = event.target as HTMLElement | null;
    if (target?.closest('button,a,input,textarea,select,[role="button"],[data-no-window-drag]')) return;
    event.preventDefault();
    void window.ipcRenderer.windowControls.startDragging().catch((error) => {
      console.warn(`[${APP_BRAND.displayName}] failed to start window drag:`, error);
    });
  };

  const toggleWindowMaximize = () => {
    void window.ipcRenderer.windowControls.toggleMaximize().catch((error) => {
      console.warn(`[${APP_BRAND.displayName}] failed to toggle window maximize:`, error);
    });
  };

  const handleTitleBarDoubleClick = (event: ReactMouseEvent<HTMLElement>) => {
    if (platform !== 'windows' || event.button !== 0) return;
    const target = event.target as HTMLElement | null;
    if (target?.closest('button,a,input,textarea,select,[role="button"],[data-no-window-drag]')) return;
    toggleWindowMaximize();
  };

  return (
    <header
      data-tauri-drag-region
      data-platform={platform ?? undefined}
      onMouseDown={startWindowDrag}
      onDoubleClick={handleTitleBarDoubleClick}
      className={clsx(
        'app-titlebar shrink-0',
        platform === 'windows' && 'app-titlebar--windows',
        immersiveMode === 'dark' && 'app-titlebar--dark'
      )}
    >
      <div data-tauri-drag-region className="app-titlebar-controls">
        <button
          type="button"
          onClick={toggleSidebarCollapsed}
          className="app-titlebar-sidebar-toggle"
          title={isSidebarCollapsed ? t('layout.expandSidebar') : t('layout.collapseSidebar')}
          aria-label={isSidebarCollapsed ? t('layout.expandSidebar') : t('layout.collapseSidebar')}
          data-sidebar-state={isSidebarCollapsed ? 'collapsed' : 'expanded'}
          data-no-window-drag
        >
          <PanelLeft className="w-[15px] h-[15px]" strokeWidth={1.7} />
        </button>
        <button
          type="button"
          onClick={openGlobalSearch}
          className="app-titlebar-sidebar-toggle"
          title="搜索"
          aria-label="搜索"
          data-no-window-drag
        >
          <Search className="w-[15px] h-[15px]" strokeWidth={1.7} />
        </button>
      </div>
      <div data-tauri-drag-region className="app-titlebar-title">
        {content}
      </div>
      <div className="app-titlebar-actions">
        {extraActions}
        <button
          type="button"
          onClick={toggleNotificationDrawer}
          className="app-titlebar-button"
          title={notificationDrawerOpen ? t('layout.closeNotificationCenter') : t('layout.openNotificationCenter')}
          aria-label={notificationDrawerOpen ? t('layout.closeNotificationCenter') : t('layout.openNotificationCenter')}
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
          onClick={() => setManualThemeMode((prev) => prev === 'dark' ? 'light' : 'dark')}
          className="app-titlebar-button"
          title={themeMode === 'dark' ? t('layout.switchToLight') : t('layout.switchToDark')}
          aria-label={themeMode === 'dark' ? t('layout.switchToLight') : t('layout.switchToDark')}
        >
          {themeMode === 'dark'
            ? <Sun className="w-[13px] h-[13px]" strokeWidth={1.75} />
            : <Moon className="w-[13px] h-[13px]" strokeWidth={1.75} />}
        </button>
        {platform === 'windows' && (
          <div className="app-titlebar-window-controls" data-no-window-drag>
            <button
              type="button"
              onClick={() => {
                void window.ipcRenderer.windowControls.minimize();
              }}
              className="app-titlebar-window-button"
              title="最小化"
              aria-label="最小化"
              data-no-window-drag
            >
              <Minus className="h-[14px] w-[14px]" strokeWidth={1.8} />
            </button>
            <button
              type="button"
              onClick={toggleWindowMaximize}
              className="app-titlebar-window-button"
              title="最大化"
              aria-label="最大化"
              data-no-window-drag
            >
              <Square className="h-[11px] w-[11px]" strokeWidth={1.8} />
            </button>
            <button
              type="button"
              onClick={() => {
                void window.ipcRenderer.windowControls.close();
              }}
              className="app-titlebar-window-button app-titlebar-window-button--close"
              title="关闭"
              aria-label="关闭"
              data-no-window-drag
            >
              <X className="h-[14px] w-[14px]" strokeWidth={1.8} />
            </button>
          </div>
        )}
      </div>
    </header>
  );
}

export function Layout({ children, currentView, onNavigate, immersiveMode = false, hideGlobalSidebar = false, globalNotice = null, globalSidebarContent, activeModalView, renderTitleBarContent, renderTitleBarActions }: LayoutProps) {
  const { t } = useI18n();
  const [spaces, setSpaces] = useState<WorkspaceSpace[]>([]);
  const [activeSpaceId, setActiveSpaceId] = useState<string>('');
  const [isSwitchingSpace, setIsSwitchingSpace] = useState(false);
  const [isSpaceMenuOpen, setIsSpaceMenuOpen] = useState(false);
  const [hoveredSpaceId, setHoveredSpaceId] = useState<string | null>(null);
  const [isSpaceDialogOpen, setIsSpaceDialogOpen] = useState(false);
  const [spaceDialogName, setSpaceDialogName] = useState('');
  const [spaceDialogTargetId, setSpaceDialogTargetId] = useState<string | null>(null);
  const [isSpaceDialogSubmitting, setIsSpaceDialogSubmitting] = useState(false);
  const [deletingSpaceId, setDeletingSpaceId] = useState<string | null>(null);
  const notificationDrawerOpen = useNotificationStore((state) => state.drawerOpen);
  const toggleNotificationDrawer = useNotificationStore((state) => state.toggleDrawer);
  const unreadNotificationCount = useNotificationStore(selectNotificationUnreadCount);
  const spaceMenuRef = useRef<HTMLDivElement | null>(null);
  const isFixedViewportView = false;
  const titleBarPlatform = getAppTitleBarPlatform();
  const usesAppTitleBar = titleBarPlatform !== null;
  const hasGlobalSidebar = !immersiveMode && !hideGlobalSidebar;
  const { themeMode, setManualThemeMode } = useLayoutTheme(immersiveMode);
  const titleBarContent = renderTitleBarContent?.({ currentView }) ?? null;
  const titleBarActions = renderTitleBarActions?.({ currentView }) ?? null;
  const {
    isSidebarCollapsed,
    sidebarWidth,
    isSidebarAnimating,
    sidebarVisualCollapsed,
    toggleSidebarCollapsed,
    startSidebarResize,
  } = useLayoutSidebar(() => setIsSpaceMenuOpen(false));
  const visibleGlobalSidebarContent = !sidebarVisualCollapsed ? globalSidebarContent : null;
  const {
    updateNotice,
    updatePublishedDateLabel,
    isOpeningReleasePage,
    openReleasePage,
    closeUpdateNotice,
  } = useAppUpdateNotice(t('layout.openDownloadFailed'));
  const {
    globalSearchInputRef,
    globalSearchQuery,
    setGlobalSearchQuery,
    globalSearchResults,
    isGlobalSearchLoading,
    isGlobalSearchVisible,
    isGlobalSearchClosing,
    openGlobalSearch,
    closeGlobalSearch,
    submitGlobalSearch,
    navigateToGlobalSearch,
  } = useGlobalKnowledgeSearch(onNavigate);
  const activeSpaceName = useMemo(
    () => spaces.find((space) => space.id === activeSpaceId)?.name || t('layout.defaultSpaceName'),
    [activeSpaceId, spaces, t]
  );

  const loadSpaces = useCallback(async () => {
    try {
      const result = await uiMeasure('layout', 'load_spaces', async () => (
        window.ipcRenderer.spaces.list() as Promise<{ spaces?: WorkspaceSpace[]; activeSpaceId?: string } | null>
      )) as { spaces?: WorkspaceSpace[]; activeSpaceId?: string } | null;
      if (Array.isArray(result?.spaces)) {
        setSpaces(result.spaces);
      }
      if (typeof result?.activeSpaceId === 'string' && result.activeSpaceId.trim()) {
        setActiveSpaceId(result.activeSpaceId);
      }
    } catch (error) {
      console.error('Failed to load spaces:', error);
    }
  }, []);

  useEffect(() => {
    void loadSpaces();

    const handleSpaceChanged = () => {
      void loadSpaces();
    };
    window.ipcRenderer.spaces.onChanged(handleSpaceChanged);
    return () => {
      window.ipcRenderer.spaces.offChanged(handleSpaceChanged);
    };
  }, [loadSpaces]);

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
    if (sidebarVisualCollapsed) {
      setIsSpaceMenuOpen(false);
    }
  }, [sidebarVisualCollapsed]);

  const handleSwitchSpace = useCallback(async (nextSpaceId: string) => {
    if (!nextSpaceId) return;
    setIsSwitchingSpace(true);
    try {
      const result = await window.ipcRenderer.spaces.switch(nextSpaceId) as { success?: boolean; activeSpaceId?: string; error?: string } | null;
      if (!result?.success) {
        void appAlert(result?.error || t('layout.switchSpaceFailed'));
        return;
      }
      setActiveSpaceId(result.activeSpaceId || nextSpaceId);
      setIsSpaceMenuOpen(false);
      window.location.reload();
    } catch (error) {
      console.error('Failed to switch space:', error);
      void appAlert(t('layout.switchSpaceFailedRetry'));
    } finally {
      setIsSwitchingSpace(false);
    }
  }, [t]);

  const openRenameSpaceDialog = useCallback((space: WorkspaceSpace) => {
    setIsSpaceMenuOpen(false);
    setSpaceDialogTargetId(space.id);
    setSpaceDialogName(space.name);
    setIsSpaceDialogOpen(true);
  }, []);

  const handleDeleteSpace = useCallback(async (space: WorkspaceSpace) => {
    if (!space.id || space.id === 'default' || deletingSpaceId) return;
    const confirmed = await appConfirm(t('layout.deleteSpaceConfirm', { name: space.name || space.id }), {
      title: t('layout.deleteSpace'),
      confirmLabel: t('layout.deleteSpace'),
      tone: 'danger',
    });
    if (!confirmed) return;

    setDeletingSpaceId(space.id);
    try {
      const result = await window.ipcRenderer.spaces.delete(space.id) as {
        success?: boolean;
        activeSpaceId?: string;
        deletedActiveSpace?: boolean;
        error?: string;
      } | null;
      if (!result?.success) {
        void appAlert(result?.error || t('layout.deleteSpaceFailed'));
        return;
      }
      setIsSpaceMenuOpen(false);
      await loadSpaces();
      if (result.deletedActiveSpace) {
        window.location.reload();
      }
    } catch (error) {
      console.error('Failed to delete space:', error);
      void appAlert(t('layout.deleteSpaceFailedRetry'));
    } finally {
      setDeletingSpaceId(null);
    }
  }, [deletingSpaceId, loadSpaces, t]);

  const closeSpaceDialog = useCallback(() => {
    if (isSpaceDialogSubmitting) return;
    setIsSpaceDialogOpen(false);
    setSpaceDialogName('');
    setSpaceDialogTargetId(null);
  }, [isSpaceDialogSubmitting]);

  const submitSpaceDialog = useCallback(async () => {
    const trimmedName = spaceDialogName.trim();
    if (!trimmedName) {
      void appAlert(t('layout.spaceNameRequired'));
      return;
    }

    setIsSpaceDialogSubmitting(true);
    try {
      if (!spaceDialogTargetId) {
        void appAlert(t('layout.renameSpaceMissing'));
        return;
      }

      const result = await window.ipcRenderer.spaces.rename({ id: spaceDialogTargetId, name: trimmedName }) as { success?: boolean; error?: string } | null;
      if (!result?.success) {
        void appAlert(result?.error || t('layout.renameSpaceFailed'));
        return;
      }

      setIsSpaceDialogOpen(false);
      setSpaceDialogName('');
      setSpaceDialogTargetId(null);
      await loadSpaces();
    } catch (error) {
      console.error('Failed to submit space dialog:', error);
      void appAlert(t('layout.renameSpaceFailedRetry'));
    } finally {
      setIsSpaceDialogSubmitting(false);
    }
  }, [loadSpaces, spaceDialogName, spaceDialogTargetId, t]);

  const handleSidebarNavigate = useCallback((item: SidebarNavItem) => {
    if (item.settingsTab || item.redclawAction) {
      if (item.settingsTab) {
        dispatchAppIntent({
          type: 'settings.open',
          tab: item.settingsTab,
        });
        return;
      }
      dispatchAppIntent({
        type: 'redclaw.open',
        action: item.redclawAction,
      });
      return;
    }
    onNavigate(item.view);
  }, [onNavigate]);

  const renderSidebarNavItem = (item: SidebarNavItem) => {
    const { key, view, labelKey, icon: Icon, primary } = item;
    const label = t(labelKey);
    const isActive = !item.redclawAction && (currentView === view || activeModalView === view) && !item.settingsTab;
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
        {key === 'new-chat' ? (
          <img
            src={APP_BRAND.logoSrc}
            alt=""
            className="app-sidebar-nav-icon shrink-0 object-contain"
            aria-hidden="true"
          />
        ) : (
          <Icon className="app-sidebar-nav-icon shrink-0" strokeWidth={primary ? 1.6 : 1.65} />
        )}
        <span className={clsx(
          'app-sidebar-nav-label truncate whitespace-nowrap',
          sidebarVisualCollapsed
            ? 'app-sidebar-nav-label--collapsed'
            : 'app-sidebar-nav-label--expanded'
        )}>
          {label}
        </span>
      </button>
    );
  };

  return (
    <div
      className={clsx(
        'app-layout-shell relative flex h-screen w-full overflow-hidden text-text-primary',
        hasGlobalSidebar && 'app-layout-shell--layered',
        immersiveMode === 'dark' ? 'bg-[#0f0f0f]' : 'bg-background'
      )}
    >
      <AppTitleBar
        immersiveMode={immersiveMode}
        enabled={usesAppTitleBar}
        platform={titleBarPlatform}
        content={titleBarContent}
        isSidebarCollapsed={isSidebarCollapsed}
        toggleSidebarCollapsed={toggleSidebarCollapsed}
        openGlobalSearch={openGlobalSearch}
        notificationDrawerOpen={notificationDrawerOpen}
        unreadNotificationCount={unreadNotificationCount}
        toggleNotificationDrawer={toggleNotificationDrawer}
        themeMode={themeMode}
        setManualThemeMode={setManualThemeMode}
        extraActions={titleBarActions}
      />

      {globalNotice && (
        <div
          className={clsx(
            'pointer-events-none absolute left-1/2 z-[80] -translate-x-1/2',
            usesAppTitleBar ? 'top-[calc(var(--app-titlebar-height)+0.75rem)]' : 'top-3'
          )}
        >
          <div className="inline-flex items-center gap-2 rounded-full border border-red-200/80 bg-red-50/96 px-4 py-2 text-[12px] font-medium text-red-700 shadow-[0_12px_30px_-18px_rgba(220,38,38,0.55)] backdrop-blur">
            <AlertCircle className="h-3.5 w-3.5 shrink-0" strokeWidth={1.9} />
            <span className="whitespace-nowrap">{globalNotice}</span>
          </div>
        </div>
      )}

      {/* Sidebar */}
      {hasGlobalSidebar && (
        <aside
          className={clsx(
            'app-sidebar-shell bg-surface-secondary/85 border-r border-border flex flex-col shrink-0 overflow-hidden',
            usesAppTitleBar && 'pt-[var(--app-titlebar-height)]',
            isSidebarAnimating && 'app-sidebar-shell--animating',
            sidebarVisualCollapsed ? 'app-sidebar-shell--collapsed' : 'app-sidebar-shell--expanded'
          )}
          style={!sidebarVisualCollapsed ? { '--app-sidebar-expanded-width': `${sidebarWidth}px` } as React.CSSProperties : undefined}
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
          <div className={clsx('border-t border-border', sidebarVisualCollapsed ? 'px-2 py-2 flex flex-col items-center gap-2' : 'px-4 py-2 space-y-2')}>
            {sidebarVisualCollapsed && (
              <button
                type="button"
                onClick={() => onNavigate('settings')}
                className="h-8 w-8 rounded-md text-text-tertiary hover:text-text-primary transition-colors inline-flex items-center justify-center shrink-0"
                title={t('nav.settings')}
                aria-label={t('nav.settings')}
              >
                <SettingsIcon className="w-[17px] h-[17px]" strokeWidth={1.75} />
              </button>
            )}
            <div
              className={clsx(
                'app-sidebar-footer-meta flex items-center gap-2 text-[11px] text-text-tertiary/90 whitespace-nowrap transition-[max-height,opacity,transform]',
                sidebarVisualCollapsed ? 'max-h-0 overflow-hidden opacity-0 translate-y-1' : 'max-h-8 overflow-visible opacity-100 translate-y-0 justify-start'
              )}
            >
              <button
                type="button"
                onClick={() => onNavigate('settings')}
                className="h-8 rounded-md px-2 text-text-tertiary hover:text-text-primary hover:bg-surface-primary transition-colors inline-flex items-center justify-center gap-1.5 shrink-0"
                title={t('nav.settings')}
                aria-label={t('nav.settings')}
              >
                <SettingsIcon className="w-[19px] h-[19px]" strokeWidth={1.75} />
                <span className="text-xs font-medium">{t('nav.settings')}</span>
              </button>
              {!usesAppTitleBar && (
                <>
                  <button
                    type="button"
                    onClick={toggleNotificationDrawer}
                    className="relative h-5 w-5 rounded-md border border-border bg-surface-primary text-text-secondary hover:text-text-primary hover:bg-surface-secondary transition-colors inline-flex items-center justify-center shrink-0"
                    title={notificationDrawerOpen ? t('layout.closeNotificationCenter') : t('layout.openNotificationCenter')}
                    aria-label={notificationDrawerOpen ? t('layout.closeNotificationCenter') : t('layout.openNotificationCenter')}
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
                    onClick={() => setManualThemeMode((prev) => prev === 'dark' ? 'light' : 'dark')}
                    className="h-5 w-5 rounded-md border border-border bg-surface-primary text-text-secondary hover:text-text-primary hover:bg-surface-secondary transition-colors inline-flex items-center justify-center shrink-0"
                    title={themeMode === 'dark' ? t('layout.switchToLight') : t('layout.switchToDark')}
                    aria-label={themeMode === 'dark' ? t('layout.switchToLight') : t('layout.switchToDark')}
                  >
                    {themeMode === 'dark'
                      ? <Sun className="w-[11px] h-[11px]" strokeWidth={1.75} />
                      : <Moon className="w-[11px] h-[11px]" strokeWidth={1.75} />}
                  </button>
                </>
              )}
              <div ref={spaceMenuRef} className="relative min-w-0">
                <button
                  type="button"
                  onClick={() => setIsSpaceMenuOpen((prev) => !prev)}
                  disabled={isSwitchingSpace}
                  className="h-7 w-[118px] px-2.5 text-[12px] flex items-center justify-between gap-1 rounded-lg border border-border bg-surface-primary text-text-primary disabled:opacity-50"
                >
                  <span className="min-w-0 truncate">{activeSpaceName}</span>
                  <ChevronDown className={clsx('w-[13px] h-[13px] shrink-0 text-text-tertiary transition-transform', isSpaceMenuOpen && 'rotate-180')} strokeWidth={1.75} />
                </button>

                {isSpaceMenuOpen && (
                  <div
                    className="app-space-menu absolute right-0 bottom-full mb-1.5 w-[172px] rounded-lg border border-border shadow-lg z-50 overflow-hidden"
                  >
                    <div className="max-h-44 overflow-y-auto">
                      {spaces.length === 0 ? (
                        <div className="h-9 px-2.5 text-[12px] text-text-tertiary flex items-center">
                          {t('layout.noSpace')}
                        </div>
                      ) : (
                        spaces.map((space) => {
                          const isActive = space.id === activeSpaceId;
                          const showEdit = hoveredSpaceId === space.id;
                          const canDelete = space.id !== 'default';
                          const isDeleting = deletingSpaceId === space.id;
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
                                title={t('layout.renameSpace')}
                              >
                                <Pencil className="w-[12px] h-[12px]" strokeWidth={1.75} />
                              </button>
                              {canDelete && (
                                <button
                                  type="button"
                                  disabled={isDeleting}
                                  onMouseDown={(event) => {
                                    event.preventDefault();
                                    event.stopPropagation();
                                    void handleDeleteSpace(space);
                                  }}
                                  className={clsx(
                                    'w-5 h-5 inline-flex items-center justify-center rounded-md text-text-secondary hover:text-red-500 hover:bg-surface-primary disabled:opacity-50 transition-opacity',
                                    showEdit ? 'opacity-100' : 'opacity-0 pointer-events-none'
                                  )}
                                  title={t('layout.deleteSpace')}
                                >
                                  <Trash2 className="w-[12px] h-[12px]" strokeWidth={1.75} />
                                </button>
                              )}
                            </div>
                          );
                        })
                      )}
                    </div>

                  </div>
                )}
              </div>
            </div>
          </div>

          {!sidebarVisualCollapsed && (
            <div
              className="app-sidebar-resize-handle"
              role="separator"
              aria-orientation="vertical"
              aria-label="调整侧边栏宽度"
              title="调整侧边栏宽度"
              data-no-window-drag
              onPointerDown={startSidebarResize}
            />
          )}
        </aside>
      )}

      {/* Main Content */}
      <main
        className={clsx(
          'app-main-shell flex-1 flex flex-col min-w-0 relative',
          hasGlobalSidebar && 'app-main-shell--layered'
        )}
      >
        {/* Content */}
        <div
          className={clsx(
            'flex-1',
            usesAppTitleBar && 'pt-[var(--app-titlebar-height)]',
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
              {t('layout.renameSpace')}
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
              placeholder={t('layout.spaceNamePlaceholder')}
            />
            <div className="flex items-center justify-end gap-2">
              <button
                onClick={closeSpaceDialog}
                disabled={isSpaceDialogSubmitting}
                className="h-8 px-3 text-xs rounded-md border border-border text-text-secondary hover:text-text-primary hover:bg-surface-secondary disabled:opacity-50"
              >
                {t('app.cancel')}
              </button>
              <button
                onClick={() => {
                  void submitSpaceDialog();
                }}
                disabled={isSpaceDialogSubmitting}
                className="h-8 px-3 text-xs rounded-md bg-accent-primary text-white hover:bg-accent-hover disabled:opacity-50"
              >
                {isSpaceDialogSubmitting ? t('app.processing') : t('app.confirm')}
              </button>
            </div>
          </div>
        </div>
      )}

      {isGlobalSearchVisible && (
        <div
          className={clsx(
            'app-global-search-backdrop fixed inset-0 z-[125] flex items-center justify-center px-4',
            isGlobalSearchClosing ? 'app-global-search-backdrop--closing' : 'app-global-search-backdrop--open'
          )}
          onMouseDown={closeGlobalSearch}
        >
          <div
            className={clsx(
              'app-global-search-panel w-full max-w-xl space-y-2',
              isGlobalSearchClosing ? 'app-global-search-panel--closing' : 'app-global-search-panel--open'
            )}
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="app-global-search-box flex h-14 items-center gap-3 rounded-2xl bg-surface-primary px-4">
              <Search className="app-global-search-icon h-4 w-4 shrink-0" strokeWidth={1.8} />
              <input
                ref={globalSearchInputRef}
                value={globalSearchQuery}
                onChange={(event) => setGlobalSearchQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    submitGlobalSearch();
                  } else if (event.key === 'Escape') {
                    event.preventDefault();
                    closeGlobalSearch();
                  }
                }}
                className="app-global-search-input h-full min-w-0 flex-1 bg-transparent text-[15px] text-text-primary outline-none placeholder:text-text-tertiary"
                placeholder="搜索知识库"
              />
            </div>

            {globalSearchQuery.trim() && (
              <div className="app-global-search-results overflow-hidden rounded-2xl border border-border/80 bg-surface-primary/92 shadow-[0_22px_70px_-34px_rgba(0,0,0,0.58)] backdrop-blur-md">
                {isGlobalSearchLoading && globalSearchResults.length === 0 ? (
                  <div className="h-12 px-4 text-[13px] text-text-tertiary flex items-center">搜索中...</div>
                ) : globalSearchResults.length === 0 ? (
                  <div className="h-12 px-4 text-[13px] text-text-tertiary flex items-center">没有结果</div>
                ) : (
                  <div className="max-h-[360px] overflow-y-auto py-1">
                    {globalSearchResults.map((item, index) => {
                      const title = String(item.title || '').trim() || '未命名';
                      const preview = String(item.previewText || item.author || item.siteName || '').trim();
                      const kindLabel = item.kind === 'youtube-video'
                        ? '视频'
                        : item.kind === 'document-source' ? '文档' : '笔记';
                      return (
                        <button
                          key={`${item.kind || 'item'}-${item.itemId || index}`}
                          type="button"
                          onClick={() => navigateToGlobalSearch(globalSearchQuery)}
                          className="app-global-search-result-item group flex w-full items-start gap-3 px-4 py-3 text-left"
                        >
                          <span className="app-global-search-result-icon mt-0.5 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-surface-secondary">
                            <BookOpenText className="h-3.5 w-3.5" strokeWidth={1.8} />
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className="flex items-center gap-2">
                              <span className="truncate text-[14px] font-medium text-text-primary">{title}</span>
                              <span className="shrink-0 rounded-md bg-surface-secondary px-1.5 py-0.5 text-[10px] text-text-tertiary">
                                {kindLabel}
                              </span>
                            </span>
                            {preview && (
                              <span className="mt-1 block truncate text-[12px] text-text-tertiary">{preview}</span>
                            )}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {updateNotice && (
        <div
          className="fixed inset-0 z-[140] bg-black/45 flex items-center justify-center px-6 py-6"
          onMouseDown={closeUpdateNotice}
        >
          <div
            className="w-full max-w-5xl max-h-[86vh] bg-surface-primary border border-border rounded-3xl shadow-2xl flex flex-col"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="px-8 pt-6 pb-4 border-b border-border flex items-center justify-between gap-3">
              <h2 className="text-2xl font-semibold text-text-primary">{t('layout.softwareUpdate')}</h2>
              <button
                type="button"
                onClick={closeUpdateNotice}
                className="h-9 w-9 rounded-lg border border-border text-text-secondary hover:text-text-primary hover:bg-surface-secondary transition-colors inline-flex items-center justify-center"
                title={t('layout.close')}
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
                    <div className="text-3xl font-semibold text-text-primary leading-tight">
                      {updateNotice.mode === 'current' ? t('layout.currentReleaseNotes') : t('layout.newVersionFound')}
                    </div>
                    <div className="text-xl text-text-secondary mt-1">→ {updateNotice.latestVersion}</div>
                    <div className="text-xs text-text-tertiary mt-2">
                      {t('layout.currentVersion', { version: updateNotice.currentVersion })}
                      {updatePublishedDateLabel ? ` · ${t('layout.publishedAt', { date: updatePublishedDateLabel })}` : ''}
                    </div>
                  </div>
                </div>
                {updateNotice.mode !== 'current' && (
                  <button
                    type="button"
                    onClick={() => {
                      void openReleasePage();
                    }}
                    disabled={isOpeningReleasePage}
                    className="h-11 px-5 rounded-lg bg-accent-primary text-white text-sm font-medium hover:bg-accent-hover disabled:opacity-60 transition-colors whitespace-nowrap"
                  >
                    {isOpeningReleasePage ? t('layout.opening') : t('layout.downloadAndInstall')}
                  </button>
                )}
              </div>
            </div>

            <div className="px-8 py-6 overflow-y-auto min-h-0">
              <div className="text-3xl font-semibold text-text-primary mb-4">
                {updateNotice.name || t('layout.releaseNotes')}
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
                  {String(updateNotice.body || '').trim() || t('layout.noReleaseNotes')}
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
