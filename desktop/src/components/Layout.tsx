import { ReactNode, useCallback, useEffect, useMemo, useState } from 'react';
import { MessageSquare, Settings as SettingsIcon, Folder, Dices, Pencil, ChevronDown, Sun, Moon, AlertCircle, Bell, Clock3, Edit, BookOpenText, Trash2, Crown, BadgeCheck, X, Loader2, ExternalLink, RefreshCw, Gift, Monitor, Box, ShieldCheck, Coins, Headphones, Sparkles, Plug } from 'lucide-react';
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
import { ENTITLEMENTS } from '../features/membership/entitlementKeys';
import { useMembership } from '../features/membership/useMembership';
import { asRecord, resolveFounderSponsorState, valueContainsFounder } from '../utils/membership';
import { getAppAcquisitionSource } from './AppOnboarding';

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
  { key: 'skills', view: 'skills', labelKey: 'nav.skills', icon: Plug, primary: true },
  { key: 'free-creation', view: 'generation-studio', labelKey: 'nav.home', icon: Pencil },
  { key: 'wander', view: 'wander', labelKey: 'nav.wander', icon: Dices },
  // { id: 'archives', label: '档案', icon: Archive },
  // { id: 'skills', label: '技能库', icon: Lightbulb },
];

const FOUNDER_SPONSOR_PRODUCT_ID = '827c5de5-c7b2-44df-b5c5-2b8b53eeb6ab';
const FOUNDER_SPONSOR_POLL_INTERVAL_MS = 3000;
const FOUNDER_SPONSOR_MAX_POLL_ATTEMPTS = 60;

type FounderSponsorProduct = {
  id: string;
  name?: string;
  amount?: string | number;
  currency?: string;
  membership_days?: number;
};

type FounderSponsorPaymentState =
  | 'idle'
  | 'loadingProduct'
  | 'creatingOrder'
  | 'waitingPayment'
  | 'refreshingMembership'
  | 'paid'
  | 'error';

function unwrapResponseItems(response: unknown): Record<string, unknown>[] {
  const root = asRecord(response);
  const candidates = [
    response,
    root?.products,
    root?.items,
    root?.data,
    asRecord(root?.data)?.products,
    asRecord(root?.data)?.items,
  ];
  for (const value of candidates) {
    if (Array.isArray(value)) {
      return value
        .map((item) => asRecord(item))
        .filter((item): item is Record<string, unknown> => Boolean(item));
    }
  }
  return [];
}

function founderProductFromResponse(response: unknown): FounderSponsorProduct | null {
  const items = unwrapResponseItems(response);
  const product = items.find((item) => String(item.id || '').trim() === FOUNDER_SPONSOR_PRODUCT_ID)
    || items.find((item) => [
      item.code,
      item.name,
      item.label,
      item.title,
    ].some(valueContainsFounder));
  return founderProductFromRecord(product || null);
}

function founderProductFromRecord(product: Record<string, unknown> | null): FounderSponsorProduct | null {
  if (!product) return null;
  return {
    id: String(product.id || ''),
    name: String(product.name || ''),
    amount: product.amount as string | number | undefined,
    currency: String(product.currency || 'CNY'),
    membership_days: Number(product.membership_days || product.membershipDays || 0),
  };
}

function fallbackFounderSponsorProduct(): FounderSponsorProduct {
  return {
    id: FOUNDER_SPONSOR_PRODUCT_ID,
    amount: 199,
    currency: 'CNY',
  };
}

function formatFounderProductPrice(product: FounderSponsorProduct | null): string {
  if (!product) return '';
  const amount = Number(product.amount);
  if (!Number.isFinite(amount) || amount <= 0) return '';
  const currency = String(product.currency || 'CNY').toUpperCase();
  const prefix = currency === 'CNY' || currency === 'RMB' ? '¥' : `${currency} `;
  const fractionDigits = Number.isInteger(amount) ? 0 : 2;
  return `${prefix}${amount.toLocaleString(undefined, { minimumFractionDigits: fractionDigits, maximumFractionDigits: 2 })}`;
}

function founderProductAmountValue(product: FounderSponsorProduct | null): number | null {
  const amount = Number(product?.amount);
  return Number.isFinite(amount) && amount > 0 ? amount : null;
}

function decodeHtmlEntities(value: string): string {
  if (typeof document === 'undefined') return value;
  const textarea = document.createElement('textarea');
  textarea.innerHTML = value;
  return textarea.value;
}

function extractUrlFromPaymentForm(paymentForm: string): string {
  const formMatch = paymentForm.match(/<form\b[^>]*\baction=(["'])(.*?)\1[^>]*>([\s\S]*?)<\/form>/i);
  if (!formMatch) return '';
  const action = decodeHtmlEntities(formMatch[2] || '').trim();
  const body = formMatch[3] || '';
  if (!action) return '';
  const params = new URLSearchParams();
  const inputRegex = /<input\b[^>]*>/gi;
  const attrRegex = /\b(name|value)=(["'])(.*?)\2/gi;
  let inputMatch: RegExpExecArray | null;
  while ((inputMatch = inputRegex.exec(body)) !== null) {
    const inputTag = inputMatch[0] || '';
    let name = '';
    let value = '';
    let attrMatch: RegExpExecArray | null;
    attrRegex.lastIndex = 0;
    while ((attrMatch = attrRegex.exec(inputTag)) !== null) {
      const key = String(attrMatch[1] || '').toLowerCase();
      const attrValue = decodeHtmlEntities(String(attrMatch[3] || ''));
      if (key === 'name') name = attrValue;
      if (key === 'value') value = attrValue;
    }
    if (name) params.append(name, value);
  }
  try {
    const url = new URL(action);
    params.forEach((value, key) => {
      url.searchParams.set(key, value);
    });
    return url.toString();
  } catch {
    return '';
  }
}

function extractPaymentTarget(order: Record<string, unknown>): string {
  const candidates = [
    order.payment_url,
    order.paymentUrl,
    order.payment_form,
    order.paymentForm,
    order.url,
    order.code_url,
    order.qr_code,
    order.qrCode,
  ];
  for (const value of candidates) {
    const normalized = String(value || '').trim();
    if (!normalized) continue;
    if (/^https?:\/\//i.test(normalized)) return normalized;
    if (/<form[\s>]/i.test(normalized)) {
      const parsed = extractUrlFromPaymentForm(normalized);
      if (parsed) return parsed;
      return normalized;
    }
  }
  return '';
}

function orderStatusIsPaid(order: Record<string, unknown> | null): boolean {
  if (!order) return false;
  return [order.status, order.trade_status, order.tradeStatus]
    .some((value) => ['paid', 'success', 'trade_success', 'trade_finished'].includes(String(value || '').trim().toLowerCase()));
}

function orderStatusIsFinalFailure(order: Record<string, unknown> | null): boolean {
  if (!order) return false;
  return [order.status, order.trade_status, order.tradeStatus]
    .some((value) => ['failed', 'closed', 'cancelled', 'canceled', 'refunded', 'trade_closed'].includes(String(value || '').trim().toLowerCase()));
}

function pointsRecordFromResponse(response: unknown): Record<string, unknown> | null {
  const root = asRecord(response);
  return asRecord(root?.points)
    || asRecord(root?.data)
    || root;
}

function pointsRecordFromAuthSnapshot(snapshot: unknown): Record<string, unknown> | null {
  const root = asRecord(snapshot);
  const session = asRecord(root?.session);
  const user = asRecord(root?.user) || asRecord(session?.user);
  const data = asRecord(root?.data);
  return asRecord(root?.points)
    || asRecord(session?.points)
    || asRecord(user?.points)
    || asRecord(data?.points)
    || null;
}

function pointsBalanceFromRecord(points: Record<string, unknown> | null): number | null {
  if (!points) return null;
  const candidates = [
    points.points,
    points.balance,
    points.pointsBalance,
    points.current_points,
    points.currentPoints,
    points.available_points,
    points.availablePoints,
  ];
  for (const candidate of candidates) {
    const value = Number(candidate);
    if (Number.isFinite(value)) return value;
  }
  return null;
}

function formatPointsBalance(points: number | null): string {
  if (points === null) return '';
  return points.toLocaleString(undefined, {
    minimumFractionDigits: Number.isInteger(points) ? 0 : 2,
    maximumFractionDigits: 2,
  });
}

export function Layout({ children, currentView, onNavigate, immersiveMode = false, hideGlobalSidebar = false, globalNotice = null, globalSidebarContent, activeModalView, renderTitleBarContent, renderTitleBarActions }: LayoutProps) {
  const { t } = useI18n();
  const { snapshot: officialAuthSnapshot, can: canUseMembershipEntitlement } = useMembership();
  const [founderSponsorOpen, setFounderSponsorOpen] = useState(false);
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
  const founderSponsorState = useMemo(
    () => resolveFounderSponsorState(officialAuthSnapshot),
    [officialAuthSnapshot],
  );
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
  } = useLayoutSpaces(sidebarVisualCollapsed, {
    canCreateSpace: canUseMembershipEntitlement(ENTITLEMENTS.spacesCreate),
    openMembershipModal: () => setFounderSponsorOpen(true),
  });
  const visibleGlobalSidebarContent = !sidebarVisualCollapsed ? globalSidebarContent : null;
  const {
    updateNotice,
    hasInstallableUpdate,
    updatePublishedDateLabel,
    isOpeningReleasePage,
    installState,
    isInstallingUpdate,
    openInstallableUpdateNotice,
    openReleasePage,
    installUpdate,
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
  const openFounderSponsorBilling = useCallback(() => {
    setFounderSponsorOpen(false);
    dispatchAppIntent({
      type: 'settings.open',
      tab: 'ai',
      aiModelSubTab: 'login',
    });
  }, []);
  const openFounderSponsorModalFromSidebar = useCallback(() => {
    setFounderSponsorOpen(true);
    void window.ipcRenderer.analytics.track('founder_sponsor_modal_opened', {
      surface: 'app-shell',
      origin: 'sidebar_footer',
      properties: {
        entry: 'sidebar_footer',
        active: founderSponsorState.active,
        sidebarCollapsed: sidebarVisualCollapsed,
      },
    });
  }, [founderSponsorState.active, sidebarVisualCollapsed]);
  const openCurrentReleaseNotesFromTitleBar = useCallback(async () => {
    await openInstallableUpdateNotice();
  }, [openInstallableUpdateNotice]);

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
          isActive
            ? 'app-sidebar-nav-item--active-special shadow-none'
            : 'app-sidebar-nav-item--plain'
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
          <Icon className="app-sidebar-nav-icon shrink-0" strokeWidth={1.35} />
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
        openCurrentReleaseNotes={openCurrentReleaseNotesFromTitleBar}
        showUpdateButton={hasInstallableUpdate}
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
            <button
              type="button"
              onClick={openFounderSponsorModalFromSidebar}
              className={clsx(
                'app-founder-sponsor-button group inline-flex shrink-0 items-center justify-center transition-all',
                sidebarVisualCollapsed
                  ? 'h-8 w-8 rounded-md'
                  : 'h-9 w-full rounded-lg px-2.5',
                isSpaceMenuOpen && 'z-0'
              )}
              title={t(founderSponsorState.labelKey)}
              aria-label={t(founderSponsorState.labelKey)}
              data-active={founderSponsorState.active ? 'true' : 'false'}
            >
              {founderSponsorState.active ? (
                <Crown className="h-[16px] w-[16px] shrink-0" strokeWidth={1.9} />
              ) : (
                <Crown className="h-[16px] w-[16px] shrink-0" strokeWidth={1.85} />
              )}
              {!sidebarVisualCollapsed && (
                <>
                  <span className="min-w-0 flex-1 truncate text-left text-[12px] font-semibold">
                    {t(founderSponsorState.labelKey)}
                  </span>
                </>
              )}
            </button>
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
                sidebarVisualCollapsed ? 'max-h-0 overflow-hidden opacity-0 translate-y-1' : 'max-h-8 overflow-visible opacity-100 translate-y-0 justify-start',
                isSpaceMenuOpen && 'relative z-[140]'
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
                    className="app-space-menu absolute right-0 bottom-full z-[1] mb-1.5 w-[172px] overflow-hidden rounded-lg border border-border bg-surface-primary shadow-lg"
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
                      onClick={() => {
                        openCreateSpaceDialog();
                      }}
                      className="h-9 w-full border-t border-border px-2.5 text-[12px] text-accent-primary hover:bg-surface-secondary flex items-center gap-1.5"
                    >
                      <span className="text-[15px] leading-none">+</span>
                      <span className="truncate">{t('layout.createSpace')}</span>
                    </button>

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
          title={t(spaceDialogMode === 'create' ? 'layout.createSpace' : 'layout.renameSpace')}
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
          installState={installState}
          isInstallingUpdate={isInstallingUpdate}
          openReleasePage={openReleasePage}
          installUpdate={installUpdate}
          closeNotice={closeUpdateNotice}
        />
      )}

      {founderSponsorOpen && (
        <FounderSponsorModal
          active={founderSponsorState.active}
          onClose={() => setFounderSponsorOpen(false)}
          onOpenBilling={openFounderSponsorBilling}
        />
      )}

      <NotificationCenterDrawer />
    </div>
  );
}

function FounderSponsorModal({ active, onClose, onOpenBilling }: {
  active: boolean;
  onClose: () => void;
  onOpenBilling: () => void;
}) {
  const { t } = useI18n();
  const { snapshot: officialAuthSnapshot } = useMembership();
  const [product, setProduct] = useState<FounderSponsorProduct | null>(null);
  const [paymentState, setPaymentState] = useState<FounderSponsorPaymentState>('loadingProduct');
  const [paymentMessage, setPaymentMessage] = useState('');
  const [orderNo, setOrderNo] = useState('');
  const [pollOrderNo, setPollOrderNo] = useState('');
  const [pointsSnapshot, setPointsSnapshot] = useState<Record<string, unknown> | null>(() => pointsRecordFromAuthSnapshot(officialAuthSnapshot));
  const [pointsLoading, setPointsLoading] = useState(false);
  const [pointsError, setPointsError] = useState('');
  const [developerWechatOpen, setDeveloperWechatOpen] = useState(false);
  const benefitCards = [
    { titleKey: 'layout.founderSponsor.benefitLifetimeTitle', descriptionKey: 'layout.founderSponsor.benefitLifetimeDesc', icon: Crown, tone: 'gold' },
    { titleKey: 'layout.founderSponsor.benefitPointsTitle', descriptionKey: 'layout.founderSponsor.benefitPointsDesc', icon: Coins, tone: 'gold' },
    { titleKey: 'layout.founderSponsor.benefitPrivilegesTitle', descriptionKey: 'layout.founderSponsor.benefitPrivilegesDesc', icon: Gift, tone: 'purple' },
    { titleKey: 'layout.founderSponsor.benefitUnlimitedDevicesTitle', descriptionKey: 'layout.founderSponsor.benefitUnlimitedDevicesDesc', icon: Monitor, tone: 'green' },
    { titleKey: 'layout.founderSponsor.benefitUnlimitedSpacesTitle', descriptionKey: 'layout.founderSponsor.benefitUnlimitedSpacesDesc', icon: Box, tone: 'blue' },
    { titleKey: 'layout.founderSponsor.benefitSupportTitle', descriptionKey: 'layout.founderSponsor.benefitSupportDesc', icon: Headphones, tone: 'cyan' },
  ] as const;
  const productPrice = formatFounderProductPrice(product);
  const displayPrice = productPrice || formatFounderProductPrice(fallbackFounderSponsorProduct());
  const purchaseButtonLabel = displayPrice
    ? t('layout.founderSponsor.unlockWithPrice', { price: displayPrice })
    : t('layout.founderSponsor.unlockLifetime');
  const controlsDisabled = paymentState === 'loadingProduct'
    || paymentState === 'creatingOrder'
    || paymentState === 'refreshingMembership';
  const isWaitingPayment = paymentState === 'waitingPayment';
  const pointsBalance = useMemo(() => pointsBalanceFromRecord(pointsSnapshot), [pointsSnapshot]);
  const pointsBalanceLabel = formatPointsBalance(pointsBalance);
  const developerWechatQrSrc = APP_BRAND.developerWechatQrSrc.trim();
  const founderXUrl = APP_BRAND.founderXUrl.trim();
  const showDeveloperSupport = Boolean(developerWechatQrSrc || founderXUrl);

  const refreshPointsBalance = useCallback(async () => {
    if (!active) return;
    setPointsLoading(true);
    setPointsError('');
    try {
      const result = await window.ipcRenderer.officialAuth.getPoints();
      const nextPoints = pointsRecordFromResponse(result);
      if (nextPoints) {
        setPointsSnapshot(nextPoints);
      } else {
        setPointsError(t('layout.founderSponsor.pointsBalancePending'));
      }
    } catch (error) {
      setPointsError(error instanceof Error ? error.message : t('layout.founderSponsor.pointsBalancePending'));
    } finally {
      setPointsLoading(false);
    }
  }, [active, t]);

  useEffect(() => {
    const nextPoints = pointsRecordFromAuthSnapshot(officialAuthSnapshot);
    if (nextPoints) {
      setPointsSnapshot(nextPoints);
    }
  }, [officialAuthSnapshot]);

  useEffect(() => {
    if (active) {
      void refreshPointsBalance();
    }
  }, [active, refreshPointsBalance]);

  const refreshMembershipState = useCallback(async () => {
    setPaymentState('refreshingMembership');
    setPaymentMessage(t('layout.founderSponsor.syncing'));
    await window.ipcRenderer.officialAuth.bootstrap({ reason: 'founder-sponsor-paid' });
    await window.ipcRenderer.auth.refreshNow().catch(() => null);
    setPaymentState('paid');
    setPaymentMessage(t('layout.founderSponsor.paid'));
  }, [t]);

  const refreshOrderStatus = useCallback(async (targetOrderNo: string) => {
    const result = await window.ipcRenderer.officialAuth.getOrderStatus({ outTradeNo: targetOrderNo }) as {
      success?: boolean;
      order?: Record<string, unknown>;
      error?: string;
    };
    const order = asRecord(result?.order);
    if (!result?.success || !order) {
      throw new Error(result?.error || t('layout.founderSponsor.orderStatusFailed'));
    }
    if (orderStatusIsPaid(order)) {
      await refreshMembershipState();
      return 'paid' as const;
    }
    if (orderStatusIsFinalFailure(order)) {
      setPaymentState('error');
      setPaymentMessage(t('layout.founderSponsor.orderClosed'));
      return 'failed' as const;
    }
    setPaymentMessage(t('layout.founderSponsor.waitingPayment'));
    return 'pending' as const;
  }, [refreshMembershipState, t]);

  useEffect(() => {
    if (active) {
      setPaymentState('idle');
      setPaymentMessage('');
      return;
    }
    let cancelled = false;
    const loadProduct = async () => {
      setPaymentState((current) => current === 'idle' || current === 'loadingProduct' ? 'loadingProduct' : current);
      let nextProduct: FounderSponsorProduct | null = null;
      try {
        const detail = await window.ipcRenderer.officialAuth.getProduct({ productId: FOUNDER_SPONSOR_PRODUCT_ID });
        nextProduct = founderProductFromRecord(asRecord(detail?.product));
      } catch (error) {
        console.warn('Failed to load founder sponsor product detail:', error);
      }
      if (!nextProduct) {
        try {
          const result = await window.ipcRenderer.officialAuth.getProducts();
          nextProduct = founderProductFromResponse(result);
        } catch (error) {
          console.warn('Failed to load founder sponsor product list:', error);
        }
      }
      if (cancelled) return;
      setProduct(nextProduct || fallbackFounderSponsorProduct());
      setPaymentMessage('');
      setPaymentState((current) => current === 'loadingProduct' ? 'idle' : current);
    };
    void loadProduct();
    return () => {
      cancelled = true;
    };
  }, [active, t]);

  useEffect(() => {
    if (!pollOrderNo || paymentState !== 'waitingPayment') return;
    let cancelled = false;
    let timer: number | null = null;
    let attempts = 0;

    const poll = async () => {
      if (cancelled) return;
      attempts += 1;
      try {
        const status = await refreshOrderStatus(pollOrderNo);
        if (cancelled || status !== 'pending') return;
      } catch (error) {
        if (cancelled) return;
        setPaymentMessage(error instanceof Error ? error.message : t('layout.founderSponsor.orderStatusFailed'));
      }
      if (!cancelled && attempts < FOUNDER_SPONSOR_MAX_POLL_ATTEMPTS) {
        timer = window.setTimeout(poll, FOUNDER_SPONSOR_POLL_INTERVAL_MS);
      }
    };

    timer = window.setTimeout(poll, 1200);
    return () => {
      cancelled = true;
      if (timer !== null) {
        window.clearTimeout(timer);
      }
    };
  }, [paymentState, pollOrderNo, refreshOrderStatus, t]);

  const startPurchase = useCallback(async () => {
    if (active) {
      onOpenBilling();
      return;
    }
    setPaymentState('creatingOrder');
    setPaymentMessage('');
    setOrderNo('');
    setPollOrderNo('');
    const productId = String(product?.id || FOUNDER_SPONSOR_PRODUCT_ID).trim() || FOUNDER_SPONSOR_PRODUCT_ID;
    const amount = founderProductAmountValue(product) ?? founderProductAmountValue(fallbackFounderSponsorProduct());
    let failedStage: 'create_order' | 'missing_payment_info' | 'open_payment' = 'create_order';
    let failedReason: 'create_order_failed' | 'missing_payment_info' | 'open_payment_failed' = 'create_order_failed';
    void window.ipcRenderer.analytics.track('founder_sponsor_purchase_clicked', {
      surface: 'billing',
      origin: 'founder_sponsor_modal',
      properties: {
        source: 'founder_sponsor_modal',
        productId,
        paymentKind: 'page_pay',
        amount,
      },
    });
    try {
      const orderResult = await window.ipcRenderer.officialAuth.createPagePayOrder({
        productId,
        product_id: productId,
        subject: t('layout.founderSponsor.title'),
        pointsToDeduct: 0,
        points_to_deduct: 0,
        acquisitionSource: getAppAcquisitionSource(),
      }) as {
        success?: boolean;
        order?: Record<string, unknown>;
        error?: string;
      };
      if (!orderResult?.success || !orderResult.order) {
        throw new Error(orderResult?.error || t('layout.founderSponsor.createOrderFailed'));
      }
      const order = orderResult.order;
      const nextOrderNo = String(order.out_trade_no || order.outTradeNo || '').trim();
      const paymentTarget = extractPaymentTarget(order);
      if (!nextOrderNo || !paymentTarget) {
        failedStage = 'missing_payment_info';
        failedReason = 'missing_payment_info';
        throw new Error(t('layout.founderSponsor.missingPaymentInfo'));
      }
      failedStage = 'open_payment';
      failedReason = 'open_payment_failed';
      const openResult = await window.ipcRenderer.officialAuth.openPaymentForm({ paymentForm: paymentTarget }) as {
        success?: boolean;
        error?: string;
      };
      if (!openResult?.success) {
        throw new Error(openResult?.error || t('layout.founderSponsor.openPaymentFailed'));
      }
      setOrderNo(nextOrderNo);
      setPollOrderNo(nextOrderNo);
      setPaymentState('waitingPayment');
      setPaymentMessage(t('layout.founderSponsor.waitingPayment'));
    } catch (error) {
      setPaymentState('error');
      setPaymentMessage(error instanceof Error ? error.message : t('layout.founderSponsor.createOrderFailed'));
      void window.ipcRenderer.analytics.track('checkout_failed', {
        surface: 'billing',
        origin: 'founder_sponsor_modal',
        properties: {
          source: 'founder_sponsor_modal',
          stage: failedStage,
          reason: failedReason,
          productId,
          paymentKind: 'page_pay',
          amount,
        },
      });
    }
  }, [active, onOpenBilling, product, t]);

  const openFounderXProfile = useCallback(async () => {
    if (!founderXUrl) return;
    const result = await window.ipcRenderer.openExternalUrl(founderXUrl);
    if (!result?.success) {
      console.warn('Failed to open founder X profile:', result?.error);
    }
  }, [founderXUrl]);

  return (
    <div
      className="app-founder-sponsor-backdrop fixed inset-0 z-[95] flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-label={t('layout.founderSponsor.title')}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <div className="app-founder-sponsor-panel w-[min(620px,calc(100vw-32px))] overflow-hidden">
        <div className="app-founder-sponsor-header relative px-6 py-4">
          <button
            type="button"
            onClick={onClose}
            className="absolute right-6 top-5 inline-flex h-8 w-8 items-center justify-center rounded-lg text-[#756b60] transition-colors hover:bg-[#f4eadb] hover:text-[#2b241d]"
            title={t('layout.close')}
            aria-label={t('layout.close')}
          >
            <X className="h-5 w-5" strokeWidth={1.8} />
          </button>
          <div className="flex items-center gap-3.5 pr-10">
            <div className="app-founder-sponsor-modal-icon flex h-12 w-12 shrink-0 items-center justify-center rounded-xl">
              {active ? (
                <BadgeCheck className="h-6 w-6" strokeWidth={1.9} />
              ) : (
                <Crown className="h-6 w-6" strokeWidth={1.85} />
              )}
            </div>
            <div className="min-w-0">
              <div className="flex min-w-0 items-center gap-2.5">
                <h2 className="truncate text-[22px] font-bold leading-tight tracking-normal text-[#201b16]">
                  {t('layout.founderSponsor.title')}
                </h2>
                <span className="app-founder-sponsor-lifetime-badge">{t('layout.founderSponsor.lifetimeBadge')}</span>
              </div>
              <div className="mt-1 text-[13px] font-medium text-[#7c746c]">
                {active ? t('layout.founderSponsor.activeStatus') : t('layout.founderSponsor.subtitle')}
              </div>
            </div>
          </div>
        </div>

        {active ? (
          <div className="app-founder-sponsor-body px-6 pb-5 pt-4">
            <div className="app-founder-member-overview">
              <div className="app-founder-member-card app-founder-member-card--identity">
                <span className="app-founder-member-card-icon">
                  <Crown className="h-5 w-5" strokeWidth={1.9} />
                </span>
                <div className="min-w-0">
                  <div className="text-[12px] font-bold text-[#8a6a35]">{t('layout.founderSponsor.planLabel')}</div>
                  <div className="mt-1 truncate text-[20px] font-black leading-tight text-[#2a2118]">{t('layout.founderSponsor.planName')}</div>
                  <div className="mt-1 inline-flex h-6 items-center rounded-md border border-[#e6c78e] bg-[#fff7e6] px-2 text-[12px] font-bold text-[#a86618]">
                    {t('layout.founderSponsor.lifetimeBadge')}
                  </div>
                </div>
              </div>

              <div className="app-founder-member-card app-founder-member-card--points">
                <button
                  type="button"
                  onClick={() => void refreshPointsBalance()}
                  disabled={pointsLoading}
                  className="app-founder-member-refresh"
                  title={t('layout.founderSponsor.refreshPoints')}
                  aria-label={t('layout.founderSponsor.refreshPoints')}
                >
                  <RefreshCw className={clsx('h-4 w-4', pointsLoading && 'animate-spin')} strokeWidth={1.9} />
                </button>
                <div className="text-[12px] font-bold text-[#8a6a35]">{t('layout.founderSponsor.pointsBalance')}</div>
                <div className="mt-2 flex min-w-0 items-end gap-2">
                  <div className={clsx(
                    'min-w-0 truncate font-black leading-none tracking-normal',
                    pointsBalance === null ? 'text-[24px] text-[#5f554b]' : 'text-[34px] text-[#b87519]'
                  )}>
                    {pointsBalance === null ? t('layout.founderSponsor.pointsBalancePending') : pointsBalanceLabel}
                  </div>
                  {pointsBalance !== null ? (
                    <span className="pb-1 text-[13px] font-bold text-[#7f7468]">{t('layout.founderSponsor.pointsUnit')}</span>
                  ) : null}
                </div>
                <div className="mt-2 text-[12px] font-semibold text-[#8a8178]">
                  {pointsError || t('layout.founderSponsor.pointsBalanceCaption')}
                </div>
              </div>
            </div>

            <div className="app-founder-sponsor-benefit-heading app-founder-sponsor-benefit-heading--member">
              <span className="app-founder-sponsor-heading-line" />
              <span className="app-founder-sponsor-heading-dot" />
              <h3>{t('layout.founderSponsor.memberBenefits')}</h3>
              <span className="app-founder-sponsor-heading-dot" />
              <span className="app-founder-sponsor-heading-line" />
            </div>

            <div className="app-founder-sponsor-benefit-grid">
              {benefitCards.map(({ titleKey, descriptionKey, icon: Icon, tone }) => (
                <div key={titleKey} className="app-founder-sponsor-benefit-tile">
                  <span className={`app-founder-sponsor-tile-icon app-founder-sponsor-tile-icon--${tone}`}>
                    <Icon className="h-5 w-5" strokeWidth={1.8} />
                  </span>
                  <div className="min-w-0">
                    <div className="truncate text-[13px] font-bold leading-snug text-[#211c17]">{t(titleKey)}</div>
                    <div className="mt-0.5 truncate text-[11px] font-medium text-[#80776f]">{t(descriptionKey)}</div>
                  </div>
                </div>
              ))}
            </div>

            {showDeveloperSupport ? (
              <div className="mt-4 rounded-xl border border-[#eadcc6] bg-white/66 px-4 py-3">
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="truncate text-[13px] font-bold text-[#211c17]">{t('layout.founderSponsor.developerSupportTitle')}</div>
                    <div className="mt-0.5 truncate text-[11px] font-medium text-[#80776f]">{t('layout.founderSponsor.developerSupportDesc')}</div>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    {developerWechatQrSrc ? (
                      <button
                        type="button"
                        onClick={() => setDeveloperWechatOpen(true)}
                        className="inline-flex h-8 items-center justify-center gap-1.5 rounded-lg border border-[#e4d5bd] bg-white/80 px-3 text-[12px] font-bold text-[#5f564d] transition-colors hover:bg-[#fffaf2] hover:text-[#27211b]"
                      >
                        <MessageSquare className="h-3.5 w-3.5" strokeWidth={1.8} />
                        {t('layout.founderSponsor.addDeveloper')}
                      </button>
                    ) : null}
                    {founderXUrl ? (
                      <button
                        type="button"
                        onClick={() => void openFounderXProfile()}
                        className="inline-flex h-8 items-center justify-center gap-1.5 rounded-lg border border-[#e4d5bd] bg-white/80 px-3 text-[12px] font-bold text-[#5f564d] transition-colors hover:bg-[#fffaf2] hover:text-[#27211b]"
                      >
                        <ExternalLink className="h-3.5 w-3.5" strokeWidth={1.8} />
                        {t('layout.founderSponsor.followDeveloper')}
                      </button>
                    ) : null}
                  </div>
                </div>
              </div>
            ) : null}

            <div className="mt-5 grid grid-cols-[1fr_96px] gap-3">
              <button
                type="button"
                onClick={onOpenBilling}
                className="app-founder-sponsor-primary-action inline-flex h-11 items-center justify-center rounded-xl px-4 text-[17px] font-bold text-white transition-all hover:brightness-105 active:scale-[0.99]"
              >
                <BadgeCheck className="mr-2 h-4 w-4" strokeWidth={1.8} />
                {t('layout.founderSponsor.manageButton')}
              </button>
              <button
                type="button"
                onClick={onClose}
                className="inline-flex h-11 items-center justify-center rounded-xl border border-[#e4d5bd] bg-white/78 px-3 text-[15px] font-bold text-[#5f564d] transition-colors hover:bg-[#fffaf2] hover:text-[#27211b]"
              >
                {t('app.cancel')}
              </button>
            </div>
          </div>
        ) : (
          <div className="app-founder-sponsor-body px-6 pb-4 pt-3.5">
          <div className="app-founder-sponsor-value-hero">
            <Sparkles className="app-founder-sponsor-sparkle app-founder-sponsor-sparkle--left" strokeWidth={1.7} />
            <Sparkles className="app-founder-sponsor-sparkle app-founder-sponsor-sparkle--right" strokeWidth={1.7} />
            <div className="app-founder-sponsor-price-block">
              <div className="app-founder-sponsor-price">
                {displayPrice}
              </div>
              <div className="mt-2 text-[16px] font-medium tracking-normal text-[#81786f]">
                {t('layout.founderSponsor.priceCaption')}
              </div>
            </div>

            <div className="app-founder-sponsor-points-card">
              <div className="app-founder-sponsor-points-ribbon">{t('layout.founderSponsor.pointsRibbon')}</div>
              <div className="flex items-center justify-center gap-3">
                <Gift className="h-7 w-7 text-[#f06a2f]" strokeWidth={1.9} />
                <div className="app-founder-sponsor-points-number">22,000</div>
                <span className="app-founder-sponsor-points-pill">P</span>
              </div>
              <div className="mt-1 text-center text-[18px] font-bold leading-tight text-[#5b4030]">
                {t('layout.founderSponsor.pointsTitle')}
              </div>
              <div className="mt-1 text-center text-[13px] font-semibold text-[#f05b2f]">
                {t('layout.founderSponsor.pointsValue')}
              </div>
              <span className="app-founder-sponsor-mini-laurel app-founder-sponsor-mini-laurel--left" aria-hidden="true" />
              <span className="app-founder-sponsor-mini-laurel app-founder-sponsor-mini-laurel--right" aria-hidden="true" />
            </div>
          </div>

          <div className="app-founder-sponsor-benefit-heading">
            <span className="app-founder-sponsor-heading-line" />
            <span className="app-founder-sponsor-heading-dot" />
            <h3>{t('layout.founderSponsor.memberBenefits')}</h3>
            <span className="app-founder-sponsor-heading-dot" />
            <span className="app-founder-sponsor-heading-line" />
          </div>

          <div className="app-founder-sponsor-benefit-grid">
            {benefitCards.map(({ titleKey, descriptionKey, icon: Icon, tone }) => (
              <div key={titleKey} className="app-founder-sponsor-benefit-tile">
                <span className={`app-founder-sponsor-tile-icon app-founder-sponsor-tile-icon--${tone}`}>
                  <Icon className="h-5 w-5" strokeWidth={1.8} />
                </span>
                <div className="min-w-0">
                  <div className="truncate text-[13px] font-bold leading-snug text-[#211c17]">{t(titleKey)}</div>
                  <div className="mt-0.5 truncate text-[11px] font-medium text-[#80776f]">{t(descriptionKey)}</div>
                </div>
              </div>
            ))}
          </div>

          <div className="min-h-[26px]">
            {paymentMessage || orderNo ? (
              <div className={clsx(
                'mt-4 rounded-xl border px-4 py-3 text-[13px] font-medium leading-relaxed',
                paymentState === 'error'
                  ? 'border-status-error/25 bg-status-error/10 text-status-error'
                  : paymentState === 'paid'
                    ? 'border-status-success/25 bg-status-success/10 text-status-success'
                    : 'border-border bg-surface-primary/72 text-text-secondary'
              )}>
                {paymentMessage ? <div>{paymentMessage}</div> : null}
                {orderNo ? <div className="mt-1 truncate text-[11px] opacity-80" title={orderNo}>{t('layout.founderSponsor.orderNo', { orderNo })}</div> : null}
              </div>
            ) : null}
          </div>

          <div className="mt-1 grid grid-cols-[1fr_96px] gap-3">
            <button
              type="button"
              onClick={() => void startPurchase()}
              disabled={controlsDisabled}
              className="app-founder-sponsor-primary-action inline-flex h-11 items-center justify-center rounded-xl px-4 text-[17px] font-bold text-white transition-all hover:brightness-105 active:scale-[0.99] disabled:opacity-60"
            >
              {paymentState === 'creatingOrder' || paymentState === 'refreshingMembership' ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" strokeWidth={1.8} />
              ) : active ? (
                <BadgeCheck className="mr-2 h-4 w-4" strokeWidth={1.8} />
              ) : (
                <ExternalLink className="mr-2 h-4 w-4" strokeWidth={1.8} />
              )}
              {active ? t('layout.founderSponsor.manageButton') : purchaseButtonLabel}
            </button>
            <button
              type="button"
              onClick={() => {
                if (isWaitingPayment && pollOrderNo) {
                  void refreshOrderStatus(pollOrderNo);
                  return;
                }
                onClose();
              }}
              className="inline-flex h-11 items-center justify-center rounded-xl border border-[#e4d5bd] bg-white/78 px-3 text-[15px] font-bold text-[#5f564d] transition-colors hover:bg-[#fffaf2] hover:text-[#27211b]"
            >
              {isWaitingPayment ? (
                <RefreshCw className="mr-2 h-5 w-5" strokeWidth={1.8} />
              ) : null}
              {isWaitingPayment ? t('layout.founderSponsor.refreshOrder') : t('app.cancel')}
            </button>
          </div>
          <div className="mt-2.5 flex items-center justify-center gap-2 text-[12px] font-medium text-[#9a9289]">
            <ShieldCheck className="h-4 w-4" strokeWidth={1.8} />
            <span>{t('layout.founderSponsor.securePayment')}</span>
          </div>
          </div>
        )}
        {developerWechatOpen && developerWechatQrSrc ? (
          <div
            className="fixed inset-0 z-[96] flex items-center justify-center bg-black/35 p-4"
            role="dialog"
            aria-modal="true"
            aria-label={t('layout.founderSponsor.wechatTitle')}
            onMouseDown={(event) => {
              if (event.target === event.currentTarget) {
                setDeveloperWechatOpen(false);
              }
            }}
          >
            <div className="w-[min(360px,calc(100vw-32px))] rounded-2xl border border-[#e4d5bd] bg-[#fffdfa] p-5 shadow-[0_24px_80px_rgba(47,35,22,0.24)]">
              <div className="mb-4 flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <h3 className="text-[18px] font-bold leading-tight text-[#201b16]">{t('layout.founderSponsor.wechatTitle')}</h3>
                  <p className="mt-1 text-[12px] font-medium leading-relaxed text-[#7c746c]">{t('layout.founderSponsor.wechatDesc')}</p>
                </div>
                <button
                  type="button"
                  onClick={() => setDeveloperWechatOpen(false)}
                  className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-[#756b60] transition-colors hover:bg-[#f4eadb] hover:text-[#2b241d]"
                  title={t('layout.close')}
                  aria-label={t('layout.close')}
                >
                  <X className="h-5 w-5" strokeWidth={1.8} />
                </button>
              </div>
              <div className="rounded-2xl border border-[#eadcc6] bg-white p-3">
                <img
                  src={developerWechatQrSrc}
                  alt={t('layout.founderSponsor.wechatQrAlt')}
                  className="mx-auto max-h-[320px] w-full rounded-xl object-contain"
                />
              </div>
              <div className="mt-3 rounded-xl border border-[#eadcc6] bg-[#fff7e6] px-3 py-2 text-center text-[13px] font-bold text-[#a86618]">
                {t('layout.founderSponsor.wechatRemark')}
              </div>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
