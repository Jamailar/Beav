import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { MessageSquare, Settings as SettingsIcon, FolderOpen, Dices, Plus, Pencil, ChevronDown, ChevronLeft, ChevronRight, Sun, Moon, AlertCircle, Bell, BookOpenText, Clock3, Download, Edit, Folder, MessageSquareWarning, ShieldCheck, Plug, Trash2 } from 'lucide-react';
import { clsx } from 'clsx';
import { NotificationCenterDrawer } from './NotificationCenterDrawer';
import { APP_BRAND } from '../config/brand';
import { selectNotificationUnreadCount, useNotificationStore } from '../notifications/store';
import { uiMeasure } from '../utils/uiDebug';
import { AppGlobalSearchOverlay } from '../features/app-shell/AppGlobalSearchOverlay';
import { AppSpaceRenameDialog } from '../features/app-shell/AppSpaceRenameDialog';
import { AppTitleBar, getAppTitleBarPlatform } from '../features/app-shell/AppTitleBar';
import { AppUpdateNoticeModal } from '../features/app-shell/AppUpdateNoticeModal';
import { dispatchAppIntent } from '../features/app-shell/appIntent';
import type { ImmersiveMode, ViewType } from '../features/app-shell/types';
import { useAppUpdateNotice } from '../features/app-shell/useAppUpdateNotice';
import { useGlobalKnowledgeSearch } from '../features/app-shell/useGlobalKnowledgeSearch';
import { useLayoutSidebar } from '../features/app-shell/useLayoutSidebar';
import { useLayoutSpaces } from '../features/app-shell/useLayoutSpaces';
import { useLayoutTheme } from '../features/app-shell/useLayoutTheme';
import { useI18n, type I18nKey } from '../i18n';

interface LayoutProps {
  children: ReactNode;
  currentView: ViewType;
  onNavigate: (view: ViewType) => void;
  immersiveMode?: ImmersiveMode;
  hideGlobalSidebar?: boolean;
  globalNotice?: string | null;
  globalSidebarContent?: ReactNode;
  activeModalView?: ViewType;
  onOpenFeedbackReport?: () => void;
  renderTitleBarContent?: (context: { currentView: ViewType }) => ReactNode;
  renderTitleBarActions?: (context: { currentView: ViewType }) => ReactNode;
}

type SidebarNavItem = {
  key: string;
  id: ViewType;
  labelKey: I18nKey;
  icon: typeof MessageSquare;
  primary?: boolean;
  redclawAction?: 'new';
};

const NAV_ITEMS: SidebarNavItem[] = [
  { key: 'new-chat', id: 'redclaw', labelKey: 'nav.newChat', icon: Edit, primary: true, redclawAction: 'new' },
  { key: 'search', id: 'knowledge', labelKey: 'nav.search', icon: BookOpenText, primary: true },
  { key: 'assets', id: 'subjects', labelKey: 'nav.assets', icon: Folder, primary: true },
  { key: 'automation', id: 'automation', labelKey: 'nav.automation', icon: Clock3, primary: true },
  { key: 'skills', id: 'skills', labelKey: 'nav.skills', icon: Plug, primary: true },
  { key: 'free-creation', id: 'generation-studio', labelKey: 'nav.home', icon: Pencil },
  { key: 'wander', id: 'wander', labelKey: 'nav.wander', icon: Dices },
];

const APPROVAL_POLL_INTERVAL_MS = 3500;

export function Layout({ children, currentView, onNavigate, immersiveMode = false, hideGlobalSidebar = false, globalNotice = null, globalSidebarContent, activeModalView, onOpenFeedbackReport, renderTitleBarContent, renderTitleBarActions }: LayoutProps) {
  const [appVersion, setAppVersion] = useState('');
  const { t } = useI18n();
  const { themeMode, setManualThemeMode } = useLayoutTheme(immersiveMode);
  const titleBarPlatform = getAppTitleBarPlatform();
  const usesAppTitleBar = titleBarPlatform !== null;
  const titleBarContent = renderTitleBarContent?.({ currentView }) ?? null;
  const titleBarActions = renderTitleBarActions?.({ currentView }) ?? null;
  const [pendingApprovalCount, setPendingApprovalCount] = useState(0);
  const [firstPendingApprovalRequestId, setFirstPendingApprovalRequestId] = useState('');
  const notificationDrawerOpen = useNotificationStore((state) => state.drawerOpen);
  const toggleNotificationDrawer = useNotificationStore((state) => state.toggleDrawer);
  const unreadNotificationCount = useNotificationStore(selectNotificationUnreadCount);
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
  const {
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
    spaceDialogMode,
    spaceDialogName,
    setSpaceDialogName,
    isSpaceDialogSubmitting,
    deletingSpaceId,
    spaceMenuRef,
    handleSwitchSpace,
    openCreateSpaceDialog,
    openRenameSpaceDialog,
    handleDeleteSpace,
    closeSpaceDialog,
    submitSpaceDialog,
  } = useLayoutSpaces(sidebarVisualCollapsed);
  const {
    updateNotice,
    hasInstallableUpdate,
    closeUpdateNotice,
    updatePublishedDateLabel,
    isOpeningReleasePage,
    installState,
    isInstallingUpdate,
    openInstallableUpdateNotice,
    openReleasePage,
    installUpdate,
  } = useAppUpdateNotice();
  const visibleGlobalSidebarContent = !sidebarVisualCollapsed ? globalSidebarContent : null;

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
    if (immersiveMode) return;
    let disposed = false;
    const loadPendingApprovals = async () => {
      try {
        const requests = await window.ipcRenderer.sessionBridge.listPermissions();
        if (disposed) return;
        const pending = Array.isArray(requests)
          ? requests.filter((item) => item?.status === 'pending')
          : [];
        setPendingApprovalCount(pending.length);
        setFirstPendingApprovalRequestId(String(pending[0]?.id || ''));
      } catch {
        if (!disposed) {
          setPendingApprovalCount(0);
          setFirstPendingApprovalRequestId('');
        }
      }
    };
    void loadPendingApprovals();
    const timer = window.setInterval(() => {
      void loadPendingApprovals();
    }, APPROVAL_POLL_INTERVAL_MS);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [immersiveMode]);

  const handleSidebarNavigate = useCallback((item: SidebarNavItem) => {
    if (item.key === 'search') {
      openGlobalSearch();
      return;
    }
    if (item.redclawAction) {
      dispatchAppIntent({
        type: 'redclaw.open',
        action: item.redclawAction,
      });
      return;
    }
    onNavigate(item.id);
  }, [onNavigate, openGlobalSearch]);

  return (
    <div
      className={clsx(
        'app-layout-shell relative flex h-screen w-full overflow-hidden text-text-primary',
        !immersiveMode && !hideGlobalSidebar && 'app-layout-shell--layered',
        immersiveMode === 'dark' ? 'bg-[#0f0f0f]' : 'bg-background'
      )}
    >
      <AppTitleBar
        immersiveMode={immersiveMode}
        enabled={usesAppTitleBar}
        platform={titleBarPlatform}
        content={titleBarContent}
        isSidebarCollapsed={sidebarVisualCollapsed}
        toggleSidebarCollapsed={toggleSidebarCollapsed}
        openGlobalSearch={openGlobalSearch}
        openCurrentReleaseNotes={() => void openInstallableUpdateNotice()}
        showUpdateButton={hasInstallableUpdate}
        notificationDrawerOpen={notificationDrawerOpen}
        unreadNotificationCount={unreadNotificationCount}
        toggleNotificationDrawer={toggleNotificationDrawer}
        themeMode={themeMode}
        setManualThemeMode={setManualThemeMode}
        extraActions={(
          <>
            {titleBarActions}
            {onOpenFeedbackReport && (
              <button
                type="button"
                onClick={onOpenFeedbackReport}
                className="app-titlebar-button"
                title="反馈问题"
                aria-label="反馈问题"
                data-no-window-drag
              >
                <MessageSquareWarning className="w-[13px] h-[13px]" strokeWidth={1.75} />
              </button>
            )}
          </>
        )}
      />

      {globalNotice && (
        <div className={clsx('pointer-events-none absolute left-1/2 z-[80] -translate-x-1/2', usesAppTitleBar ? 'top-[calc(var(--app-titlebar-height)+0.75rem)]' : 'top-3')}>
          <div className="inline-flex items-center gap-2 rounded-full border border-red-200/80 bg-red-50/96 px-4 py-2 text-[12px] font-medium text-red-700 shadow-[0_12px_30px_-18px_rgba(220,38,38,0.55)] backdrop-blur">
            <AlertCircle className="h-3.5 w-3.5 shrink-0" strokeWidth={1.9} />
            <span className="whitespace-nowrap">{globalNotice}</span>
          </div>
        </div>
      )}

      {/* Sidebar */}
      {!immersiveMode && !hideGlobalSidebar && (
        <aside
          className={clsx(
            'app-sidebar-shell bg-surface-secondary/85 border-r border-border flex flex-col shrink-0 overflow-hidden',
            usesAppTitleBar && 'pt-[var(--app-titlebar-height)]',
            isSidebarAnimating && 'app-sidebar-shell--animating',
            sidebarVisualCollapsed ? 'app-sidebar-shell--collapsed' : 'app-sidebar-shell--expanded'
          )}
          style={!sidebarVisualCollapsed ? { '--app-sidebar-expanded-width': `${sidebarWidth}px` } as React.CSSProperties : undefined}
        >
          {!usesAppTitleBar && (
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
                  title={sidebarVisualCollapsed ? t('layout.expandSidebar') : t('layout.collapseSidebar')}
                  aria-label={sidebarVisualCollapsed ? t('layout.expandSidebar') : t('layout.collapseSidebar')}
                >
                  {sidebarVisualCollapsed
                    ? <ChevronRight className="w-[14px] h-[14px]" strokeWidth={1.75} />
                    : <ChevronLeft className="w-[14px] h-[14px]" strokeWidth={1.75} />}
                </button>
              </div>
            </div>
          )}

          {/* Navigation */}
          <nav className={clsx('app-sidebar-nav', visibleGlobalSidebarContent ? 'shrink-0' : 'flex-1', sidebarVisualCollapsed ? 'app-sidebar-nav--collapsed' : 'app-sidebar-nav--expanded')}>
            {NAV_ITEMS.map((item) => {
              const { key, id, labelKey, icon: Icon, primary, redclawAction } = item;
              const label = t(labelKey);
              const isActive = !redclawAction && (currentView === id || activeModalView === id);
              return (
              <button
                key={key}
                type="button"
                data-guide-id={`nav-${key}`}
                onClick={() => {
                  handleSidebarNavigate(item);
                }}
                title={label}
                aria-label={label}
                className={clsx(
                  'app-sidebar-nav-item relative w-full rounded-xl transition-all font-normal inline-flex items-center',
                  sidebarVisualCollapsed ? 'app-sidebar-nav-item--collapsed justify-center' : 'app-sidebar-nav-item--expanded',
                  primary && 'app-sidebar-nav-item--primary',
                  isActive
                    ? 'app-sidebar-nav-item--active-special shadow-none'
                    : 'app-sidebar-nav-item--plain'
                )}
              >
                {key === 'new-chat' ? (
                  <img src={APP_BRAND.logoSrc} alt="" className="app-sidebar-nav-icon shrink-0 object-contain" aria-hidden="true" />
                ) : (
                  <Icon className="app-sidebar-nav-icon shrink-0" strokeWidth={1.35} />
                )}
                <span
                  className={clsx(
                    'app-sidebar-nav-label truncate whitespace-nowrap',
                    sidebarVisualCollapsed ? 'app-sidebar-nav-label--collapsed' : 'app-sidebar-nav-label--expanded'
                  )}
                >
                  {label}
                </span>
              </button>
              );
            })}
          </nav>

          {visibleGlobalSidebarContent && (
            <div className="min-h-0 flex-1 overflow-hidden px-2 pb-3 flex flex-col">
              {visibleGlobalSidebarContent}
            </div>
          )}

          {/* Footer */}
          <div className={clsx('border-t border-border', sidebarVisualCollapsed ? 'px-2 py-3 flex flex-col items-center gap-2.5' : 'px-4 py-3 space-y-2.5')}>
            <div className={clsx(sidebarVisualCollapsed ? 'w-full flex justify-center' : 'space-y-1.5')}>
              <div
                className={clsx(
                  'text-[10px] tracking-[0.04em] text-text-tertiary overflow-hidden whitespace-nowrap transition-[max-height,opacity,transform] duration-150 ease-out',
                  sidebarVisualCollapsed ? 'max-h-0 opacity-0 -translate-y-1' : 'max-h-4 opacity-100 translate-y-0'
                )}
              >
                {t('layout.space')}
              </div>
              <div ref={spaceMenuRef} className="relative">
                <button
                  type="button"
                  onClick={() => setIsSpaceMenuOpen((prev) => !prev)}
                  disabled={isSwitchingSpace}
                  title={sidebarVisualCollapsed ? `${t('layout.space')}: ${activeSpaceName}` : undefined}
                  aria-label={sidebarVisualCollapsed ? `${t('layout.space')}: ${activeSpaceName}` : undefined}
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
                      'app-space-menu absolute rounded-lg border border-border bg-surface-primary shadow-lg z-50 overflow-hidden',
                      sidebarVisualCollapsed ? 'bottom-0 left-full ml-2 w-56' : 'left-0 right-0 bottom-full mb-1.5'
                    )}
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
                      {t('layout.createSpace')}
                    </button>
                  </div>
                )}
              </div>
            </div>
            {sidebarVisualCollapsed && (
              <div className="flex flex-col items-center gap-2">
                <button
                  type="button"
                  onClick={() => onNavigate('settings')}
                  className={clsx(
                    'h-8 w-8 rounded-lg border border-border bg-surface-primary transition-colors inline-flex items-center justify-center shrink-0',
                    currentView === 'settings'
                      ? 'text-accent-primary'
                      : 'text-text-secondary hover:text-text-primary hover:bg-surface-secondary'
                  )}
                  title={t('nav.settings')}
                  aria-label={t('nav.settings')}
                >
                  <SettingsIcon className="w-[14px] h-[14px]" strokeWidth={1.75} />
                </button>
                {onOpenFeedbackReport && (
                  <button
                    type="button"
                    onClick={onOpenFeedbackReport}
                    className="h-8 w-8 rounded-lg border border-border bg-surface-primary text-text-secondary hover:text-text-primary hover:bg-surface-secondary transition-colors inline-flex items-center justify-center shrink-0"
                    title="反馈问题"
                    aria-label="反馈问题"
                  >
                    <MessageSquareWarning className="w-[14px] h-[14px]" strokeWidth={1.75} />
                  </button>
                )}
                {!usesAppTitleBar && (
                  <button
                    type="button"
                    onClick={toggleNotificationDrawer}
                    className="relative h-8 w-8 rounded-lg border border-border bg-surface-primary text-text-secondary hover:text-text-primary hover:bg-surface-secondary transition-colors inline-flex items-center justify-center shrink-0"
                    title={notificationDrawerOpen ? t('layout.closeNotificationCenter') : t('layout.openNotificationCenter')}
                    aria-label={notificationDrawerOpen ? t('layout.closeNotificationCenter') : t('layout.openNotificationCenter')}
                  >
                    <Bell className="w-[14px] h-[14px]" strokeWidth={1.75} />
                    {unreadNotificationCount > 0 && (
                      <span className="absolute -right-1 -top-1 min-w-[14px] h-[14px] rounded-full bg-accent-primary px-1 text-[9px] leading-[14px] text-white">
                        {unreadNotificationCount > 9 ? '9+' : unreadNotificationCount}
                      </span>
                    )}
                  </button>
                )}
                {!usesAppTitleBar && hasInstallableUpdate && (
                  <button
                    type="button"
                    onClick={() => void openInstallableUpdateNotice()}
                    className="h-8 w-8 rounded-lg border border-border bg-surface-primary text-text-secondary hover:text-text-primary hover:bg-surface-secondary transition-colors inline-flex items-center justify-center shrink-0"
                    title={t('layout.softwareUpdate')}
                    aria-label={t('layout.softwareUpdate')}
                  >
                    <Download className="w-[14px] h-[14px]" strokeWidth={1.75} />
                  </button>
                )}
                {(pendingApprovalCount > 0 || currentView === 'approval') && (
                  <button
                    type="button"
                    onClick={() => {
                      if (firstPendingApprovalRequestId) {
                        dispatchAppIntent({
                          type: 'approval.open',
                          requestId: firstPendingApprovalRequestId,
                        });
                        return;
                      }
                      onNavigate('approval');
                    }}
                    className={clsx(
                      'relative h-8 w-8 rounded-lg border border-border bg-surface-primary transition-colors inline-flex items-center justify-center shrink-0',
                      currentView === 'approval'
                        ? 'text-accent-primary'
                        : 'text-text-secondary hover:text-text-primary hover:bg-surface-secondary'
                    )}
                    title="待审批"
                    aria-label="待审批"
                  >
                    <ShieldCheck className="w-[14px] h-[14px]" strokeWidth={1.75} />
                    {pendingApprovalCount > 0 && (
                      <span className="absolute -right-1 -top-1 min-w-[14px] h-[14px] rounded-full bg-accent-primary px-1 text-[9px] leading-[14px] text-white">
                        {pendingApprovalCount > 9 ? '9+' : pendingApprovalCount}
                      </span>
                    )}
                  </button>
                )}
                {!usesAppTitleBar && (
                  <button
                    type="button"
                    onClick={() => setManualThemeMode((prev) => prev === 'dark' ? 'light' : 'dark')}
                    className="h-8 w-8 rounded-lg border border-border bg-surface-primary text-text-secondary hover:text-text-primary hover:bg-surface-secondary transition-colors inline-flex items-center justify-center shrink-0"
                    title={themeMode === 'dark' ? t('layout.switchToLight') : t('layout.switchToDark')}
                    aria-label={themeMode === 'dark' ? t('layout.switchToLight') : t('layout.switchToDark')}
                  >
                    {themeMode === 'dark'
                      ? <Sun className="w-[14px] h-[14px]" strokeWidth={1.75} />
                      : <Moon className="w-[14px] h-[14px]" strokeWidth={1.75} />}
                  </button>
                )}
              </div>
            )}
            <div
              className={clsx(
                'app-sidebar-footer-meta flex items-center justify-center gap-2 text-[11px] text-text-tertiary/90 overflow-hidden whitespace-nowrap transition-[max-height,opacity,transform] duration-150 ease-out',
                sidebarVisualCollapsed ? 'max-h-0 opacity-0 translate-y-1' : 'max-h-4 opacity-100 translate-y-0'
              )}
            >
              <button
                type="button"
                onClick={() => onNavigate('settings')}
                className={clsx(
                  'h-5 w-5 rounded-md border border-border bg-surface-primary transition-colors inline-flex items-center justify-center shrink-0',
                  currentView === 'settings'
                    ? 'text-accent-primary'
                    : 'text-text-secondary hover:text-text-primary hover:bg-surface-secondary'
                )}
                title={t('nav.settings')}
                aria-label={t('nav.settings')}
              >
                <SettingsIcon className="w-[11px] h-[11px]" strokeWidth={1.75} />
              </button>
              {onOpenFeedbackReport && (
                <button
                  type="button"
                  onClick={onOpenFeedbackReport}
                  className="h-5 w-5 rounded-md border border-border bg-surface-primary text-text-secondary hover:text-text-primary hover:bg-surface-secondary transition-colors inline-flex items-center justify-center shrink-0"
                  title="反馈问题"
                  aria-label="反馈问题"
                >
                  <MessageSquareWarning className="w-[11px] h-[11px]" strokeWidth={1.75} />
                </button>
              )}
              {!usesAppTitleBar && (
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
              )}
              {!usesAppTitleBar && hasInstallableUpdate && (
                <button
                  type="button"
                  onClick={() => void openInstallableUpdateNotice()}
                  className="h-5 w-5 rounded-md border border-border bg-surface-primary text-text-secondary hover:text-text-primary hover:bg-surface-secondary transition-colors inline-flex items-center justify-center shrink-0"
                  title={t('layout.softwareUpdate')}
                  aria-label={t('layout.softwareUpdate')}
                >
                  <Download className="w-[11px] h-[11px]" strokeWidth={1.75} />
                </button>
              )}
              {(pendingApprovalCount > 0 || currentView === 'approval') && (
                <button
                  type="button"
                  onClick={() => {
                    if (firstPendingApprovalRequestId) {
                      dispatchAppIntent({
                        type: 'approval.open',
                        requestId: firstPendingApprovalRequestId,
                      });
                      return;
                    }
                    onNavigate('approval');
                  }}
                  className={clsx(
                    'relative h-5 w-5 rounded-md border border-border bg-surface-primary transition-colors inline-flex items-center justify-center shrink-0',
                    currentView === 'approval'
                      ? 'text-accent-primary'
                      : 'text-text-secondary hover:text-text-primary hover:bg-surface-secondary'
                  )}
                  title="待审批"
                  aria-label="待审批"
                >
                  <ShieldCheck className="w-[11px] h-[11px]" strokeWidth={1.75} />
                  {pendingApprovalCount > 0 && (
                    <span className="absolute -right-1.5 -top-1.5 min-w-[14px] h-[14px] rounded-full bg-accent-primary px-1 text-[9px] leading-[14px] text-white">
                      {pendingApprovalCount > 9 ? '9+' : pendingApprovalCount}
                    </span>
                  )}
                </button>
              )}
              {!usesAppTitleBar && (
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
              )}
              <span>{appVersion ? `v${appVersion}` : 'v--'}</span>
            </div>
          </div>
          {!sidebarVisualCollapsed && (
            <div
              className="app-sidebar-resize-handle"
              role="separator"
              aria-orientation="vertical"
              aria-label="调整侧边栏宽度"
              title="调整侧边栏宽度"
              onPointerDown={startSidebarResize}
            />
          )}
        </aside>
      )}

      {/* Main Content */}
      <main
        className={clsx(
          'app-main-shell flex-1 flex flex-col min-w-0 relative',
          usesAppTitleBar && 'pt-[var(--app-titlebar-height)]',
          !immersiveMode && !hideGlobalSidebar && 'app-main-shell--layered',
          immersiveMode === 'dark' ? 'bg-[#0f0f0f]' : 'bg-surface-primary'
        )}
      >
        {/* Content */}
        <div
          className={clsx(
            'flex-1',
            'overflow-auto'
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
          title={t(spaceDialogMode === 'create' ? 'layout.createSpace' : 'layout.renameSpace')}
          submit={submitSpaceDialog}
          close={closeSpaceDialog}
        />
      )}

      {updateNotice && (
        <AppUpdateNoticeModal
          notice={updateNotice}
          publishedDateLabel={updatePublishedDateLabel}
          isOpeningReleasePage={isOpeningReleasePage}
          isInstallingUpdate={isInstallingUpdate}
          installState={installState}
          openReleasePage={openReleasePage}
          installUpdate={installUpdate}
          closeNotice={closeUpdateNotice}
        />
      )}

      <NotificationCenterDrawer />

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
    </div>
  );
}
