import { ReactNode, useCallback } from 'react';
import { MessageSquare, Settings as SettingsIcon, Folder, FolderOpen, Dices, Pencil, ChevronDown, Users, Sun, Moon, AlertCircle, Bell, Clock3, Edit, BookOpenText, Trash2 } from 'lucide-react';
import { clsx } from 'clsx';
import type { ImmersiveMode, ViewType } from '../features/app-shell/types';
import { NotificationCenterDrawer } from './NotificationCenterDrawer';
import { APP_BRAND } from '../config/brand';
import { useI18n, type I18nKey } from '../i18n';
import { selectNotificationUnreadCount, useNotificationStore } from '../notifications/store';
import { AppGlobalSearchOverlay } from '../features/app-shell/AppGlobalSearchOverlay';
import { AppSpaceRenameDialog } from '../features/app-shell/AppSpaceRenameDialog';
import { AppTitleBar, getAppTitleBarPlatform } from '../features/app-shell/AppTitleBar';
import { AppUpdateNoticeModal } from '../features/app-shell/AppUpdateNoticeModal';
import { dispatchAppIntent } from '../features/app-shell/appIntent';
import { useAppUpdateNotice } from '../features/app-shell/useAppUpdateNotice';
import { useGlobalKnowledgeSearch } from '../features/app-shell/useGlobalKnowledgeSearch';
import { useLayoutSidebar } from '../features/app-shell/useLayoutSidebar';
import { useLayoutSpaces } from '../features/app-shell/useLayoutSpaces';
import { useLayoutTheme } from '../features/app-shell/useLayoutTheme';

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

export function Layout({ children, currentView, onNavigate, immersiveMode = false, hideGlobalSidebar = false, globalNotice = null, globalSidebarContent, activeModalView, renderTitleBarContent, renderTitleBarActions }: LayoutProps) {
  const { t } = useI18n();
  const notificationDrawerOpen = useNotificationStore((state) => state.drawerOpen);
  const toggleNotificationDrawer = useNotificationStore((state) => state.toggleDrawer);
  const unreadNotificationCount = useNotificationStore(selectNotificationUnreadCount);
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
  } = useLayoutSidebar();
  const {
    spaces,
    activeSpaceId,
    activeSpaceName,
    isSwitchingSpace,
    isSpaceMenuOpen,
    setIsSpaceMenuOpen,
    hoveredSpaceId,
    setHoveredSpaceId,
    isSpaceDialogOpen,
    spaceDialogName,
    setSpaceDialogName,
    isSpaceDialogSubmitting,
    deletingSpaceId,
    spaceMenuRef,
    handleSwitchSpace,
    openRenameSpaceDialog,
    handleDeleteSpace,
    closeSpaceDialog,
    submitSpaceDialog,
  } = useLayoutSpaces(sidebarVisualCollapsed);
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
        <AppSpaceRenameDialog
          name={spaceDialogName}
          setName={setSpaceDialogName}
          isSubmitting={isSpaceDialogSubmitting}
          submit={submitSpaceDialog}
          close={closeSpaceDialog}
        />
      )}

      {isGlobalSearchVisible && (
        <AppGlobalSearchOverlay
          inputRef={globalSearchInputRef}
          query={globalSearchQuery}
          setQuery={setGlobalSearchQuery}
          results={globalSearchResults}
          isLoading={isGlobalSearchLoading}
          isClosing={isGlobalSearchClosing}
          closeSearch={closeGlobalSearch}
          submitSearch={submitGlobalSearch}
          navigateToSearch={navigateToGlobalSearch}
        />
      )}

      {updateNotice && (
        <AppUpdateNoticeModal
          notice={updateNotice}
          publishedDateLabel={updatePublishedDateLabel}
          isOpeningReleasePage={isOpeningReleasePage}
          openReleasePage={openReleasePage}
          closeNotice={closeUpdateNotice}
        />
      )}

      <NotificationCenterDrawer />
    </div>
  );
}
