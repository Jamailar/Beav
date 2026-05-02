import { Dispatch, MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent, ReactNode, SetStateAction, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { MessageSquare, Settings as SettingsIcon, Folder, FolderOpen, FileEdit, Dices, Plus, Pencil, ChevronDown, Users, Sun, Moon, X, Download, AlertCircle, Bell, Home, PanelLeft, Search, Clock3, Edit, BookOpenText } from 'lucide-react';
import { clsx } from 'clsx';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { ImmersiveMode, ViewType } from '../App';
import { NotificationCenterDrawer } from './NotificationCenterDrawer';
import { APP_BRAND } from '../config/brand';
import { applyAppTheme, CUSTOM_THEME_CHANGED_EVENT, readThemeMode, THEME_MODE_STORAGE_KEY, type ThemeMode } from '../config/theme';
import { useI18n, type I18nKey } from '../i18n';
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
  labelKey: I18nKey;
  icon: typeof MessageSquare;
  redclawAction?: 'new';
  settingsTab?: 'general' | 'ai' | 'tools' | 'profile' | 'remote' | 'experimental';
  primary?: boolean;
};

const NAV_ITEMS: SidebarNavItem[] = [
  { key: 'new-chat', view: 'redclaw', labelKey: 'nav.newChat', icon: Edit, redclawAction: 'new', primary: true },
  { key: 'search', view: 'knowledge', labelKey: 'nav.search', icon: BookOpenText, primary: true },
  { key: 'assets', view: 'subjects', labelKey: 'nav.assets', icon: Folder, primary: true },
  { key: 'automation', view: 'automation', labelKey: 'nav.automation', icon: Clock3, primary: true },
  { key: 'home', view: 'home', labelKey: 'nav.home', icon: Home },
  { key: 'wander', view: 'wander', labelKey: 'nav.wander', icon: Dices },
  { key: 'manuscripts', view: 'manuscripts', labelKey: 'nav.manuscripts', icon: FileEdit },
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
type GlobalKnowledgeSearchItem = {
  itemId?: string;
  kind?: 'redbook-note' | 'youtube-video' | 'document-source' | string;
  title?: string;
  author?: string;
  siteName?: string;
  previewText?: string;
  updatedAt?: string;
};
type GlobalKnowledgeSearchResponse = {
  items?: GlobalKnowledgeSearchItem[];
  total?: number;
};

const SIDEBAR_COLLAPSED_STORAGE_KEY = 'redbox:layout-sidebar-collapsed:v1';
const SIDEBAR_WIDTH_STORAGE_KEY = 'redbox:layout-sidebar-width:v1';
const SIDEBAR_DEFAULT_WIDTH = 320;
const SIDEBAR_MIN_WIDTH = 240;
const SIDEBAR_MAX_WIDTH = 460;
const SIDEBAR_CONTENT_ANIMATION_MS = 170;
const GLOBAL_KNOWLEDGE_SEARCH_EVENT = 'redbox:global-knowledge-search';
const GLOBAL_KNOWLEDGE_SEARCH_STORAGE_KEY = 'redbox:global-knowledge-search-query';

function readInitialThemeMode(): ThemeMode {
  if (typeof window === 'undefined') return 'light';
  return readThemeMode();
}

function readInitialSidebarCollapsed(): boolean {
  if (typeof window === 'undefined') return false;
  return window.localStorage.getItem(SIDEBAR_COLLAPSED_STORAGE_KEY) === 'true';
}

function clampSidebarWidth(width: number): number {
  return Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, Math.round(width)));
}

function readInitialSidebarWidth(): number {
  if (typeof window === 'undefined') return SIDEBAR_DEFAULT_WIDTH;
  const storedWidth = Number(window.localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY));
  return Number.isFinite(storedWidth) ? clampSidebarWidth(storedWidth) : SIDEBAR_DEFAULT_WIDTH;
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
  openGlobalSearch,
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
  openGlobalSearch: () => void;
  notificationDrawerOpen: boolean;
  unreadNotificationCount: number;
  toggleNotificationDrawer: () => void;
  themeMode: ThemeMode;
  setThemeMode: Dispatch<SetStateAction<ThemeMode>>;
}) {
  const { t } = useI18n();
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
          title={isSidebarCollapsed ? t('layout.expandSidebar') : t('layout.collapseSidebar')}
          aria-label={isSidebarCollapsed ? t('layout.expandSidebar') : t('layout.collapseSidebar')}
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
          onClick={() => setThemeMode((prev) => prev === 'dark' ? 'light' : 'dark')}
          className="app-titlebar-button"
          title={themeMode === 'dark' ? t('layout.switchToLight') : t('layout.switchToDark')}
          aria-label={themeMode === 'dark' ? t('layout.switchToLight') : t('layout.switchToDark')}
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
  const { t } = useI18n();
  const [spaces, setSpaces] = useState<WorkspaceSpace[]>([]);
  const [appVersion, setAppVersion] = useState('');
  const [themeMode, setThemeMode] = useState<ThemeMode>(readInitialThemeMode);
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(readInitialSidebarCollapsed);
  const [sidebarWidth, setSidebarWidth] = useState(readInitialSidebarWidth);
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
  const [isGlobalSearchOpen, setIsGlobalSearchOpen] = useState(false);
  const [globalSearchQuery, setGlobalSearchQuery] = useState('');
  const [globalSearchResults, setGlobalSearchResults] = useState<GlobalKnowledgeSearchItem[]>([]);
  const [isGlobalSearchLoading, setIsGlobalSearchLoading] = useState(false);
  const notificationDrawerOpen = useNotificationStore((state) => state.drawerOpen);
  const toggleNotificationDrawer = useNotificationStore((state) => state.toggleDrawer);
  const unreadNotificationCount = useNotificationStore(selectNotificationUnreadCount);
  const spaceMenuRef = useRef<HTMLDivElement | null>(null);
  const sidebarAnimationTimerRef = useRef<number | null>(null);
  const sidebarResizeStateRef = useRef<{ startX: number; startWidth: number } | null>(null);
  const globalSearchInputRef = useRef<HTMLInputElement | null>(null);
  const globalSearchRequestRef = useRef(0);
  const isFixedViewportView = currentView === 'manuscripts';
  const usesMacOverlayTitleBar = shouldUseMacOverlayTitleBar();
  const titleBarContent = renderTitleBarContent?.({ currentView }) ?? null;
  const sidebarVisualCollapsed = isSidebarCollapsed || sidebarAnimationDirection === 'collapsing';
  const visibleGlobalSidebarContent = !sidebarVisualCollapsed ? globalSidebarContent : null;
  const activeSpaceName = useMemo(
    () => spaces.find((space) => space.id === activeSpaceId)?.name || t('layout.defaultSpaceName'),
    [activeSpaceId, spaces, t]
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
    applyAppTheme(effectiveTheme);
    window.localStorage.setItem(THEME_MODE_STORAGE_KEY, themeMode);
  }, [immersiveMode, themeMode]);

  useEffect(() => {
    const handleCustomThemeChanged = () => {
      applyAppTheme(immersiveMode === 'dark' ? 'dark' : themeMode);
    };
    window.addEventListener(CUSTOM_THEME_CHANGED_EVENT, handleCustomThemeChanged);
    return () => window.removeEventListener(CUSTOM_THEME_CHANGED_EVENT, handleCustomThemeChanged);
  }, [immersiveMode, themeMode]);

  useEffect(() => {
    window.localStorage.setItem(SIDEBAR_COLLAPSED_STORAGE_KEY, String(isSidebarCollapsed));
  }, [isSidebarCollapsed]);

  useEffect(() => {
    window.localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, String(sidebarWidth));
  }, [sidebarWidth]);

  useEffect(() => {
    if (!isGlobalSearchOpen) return;
    const focusTimer = window.setTimeout(() => globalSearchInputRef.current?.focus(), 0);
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        setIsGlobalSearchOpen(false);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.clearTimeout(focusTimer);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [isGlobalSearchOpen]);

  useEffect(() => {
    if (!isGlobalSearchOpen) {
      setGlobalSearchResults([]);
      setIsGlobalSearchLoading(false);
      return;
    }

    const query = globalSearchQuery.trim();
    if (!query) {
      setGlobalSearchResults([]);
      setIsGlobalSearchLoading(false);
      return;
    }

    const requestId = globalSearchRequestRef.current + 1;
    globalSearchRequestRef.current = requestId;
    setIsGlobalSearchLoading(true);
    const timer = window.setTimeout(() => {
      void window.ipcRenderer.knowledge.listPage<GlobalKnowledgeSearchResponse>({
        limit: 6,
        query,
        sort: 'updated-desc',
      }).then((response) => {
        if (requestId !== globalSearchRequestRef.current) return;
        setGlobalSearchResults(Array.isArray(response?.items) ? response.items : []);
      }).catch((error) => {
        if (requestId !== globalSearchRequestRef.current) return;
        console.warn('[RedBox] global knowledge search failed:', error);
        setGlobalSearchResults([]);
      }).finally(() => {
        if (requestId === globalSearchRequestRef.current) {
          setIsGlobalSearchLoading(false);
        }
      });
    }, 160);

    return () => window.clearTimeout(timer);
  }, [globalSearchQuery, isGlobalSearchOpen]);

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
        void appAlert(result?.error || t('layout.openDownloadFailed'));
      }
    } catch (error) {
      console.error('Failed to open release page:', error);
      void appAlert(t('layout.openDownloadFailed'));
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
        void appAlert(result?.error || t('layout.switchSpaceFailed'));
        return;
      }
      setIsSpaceMenuOpen(false);
      window.location.reload();
    } catch (error) {
      console.error('Failed to switch space:', error);
      void appAlert(t('layout.switchSpaceFailedRetry'));
    } finally {
      setIsSwitchingSpace(false);
    }
  }, [activeSpaceId, t]);

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

  const openGlobalSearch = useCallback(() => {
    setIsGlobalSearchOpen(true);
  }, []);

  const closeGlobalSearch = useCallback(() => {
    setIsGlobalSearchOpen(false);
  }, []);

  const submitGlobalSearch = useCallback(() => {
    const query = globalSearchQuery.trim();
    if (query) {
      window.sessionStorage.setItem(GLOBAL_KNOWLEDGE_SEARCH_STORAGE_KEY, query);
    } else {
      window.sessionStorage.removeItem(GLOBAL_KNOWLEDGE_SEARCH_STORAGE_KEY);
    }
    onNavigate('knowledge');
    window.setTimeout(() => {
      window.dispatchEvent(new CustomEvent(GLOBAL_KNOWLEDGE_SEARCH_EVENT, { detail: { query } }));
    }, 0);
    setIsGlobalSearchOpen(false);
  }, [globalSearchQuery, onNavigate]);

  const navigateToGlobalSearch = useCallback((queryOverride?: string) => {
    const query = (queryOverride ?? globalSearchQuery).trim();
    if (query) {
      window.sessionStorage.setItem(GLOBAL_KNOWLEDGE_SEARCH_STORAGE_KEY, query);
    } else {
      window.sessionStorage.removeItem(GLOBAL_KNOWLEDGE_SEARCH_STORAGE_KEY);
    }
    onNavigate('knowledge');
    window.setTimeout(() => {
      window.dispatchEvent(new CustomEvent(GLOBAL_KNOWLEDGE_SEARCH_EVENT, { detail: { query } }));
    }, 0);
    setIsGlobalSearchOpen(false);
  }, [globalSearchQuery, onNavigate]);

  const startSidebarResize = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (sidebarVisualCollapsed || isSidebarAnimating) return;
    event.preventDefault();
    event.stopPropagation();
    sidebarResizeStateRef.current = {
      startX: event.clientX,
      startWidth: sidebarWidth,
    };
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';

    const handlePointerMove = (moveEvent: PointerEvent) => {
      const resizeState = sidebarResizeStateRef.current;
      if (!resizeState) return;
      setSidebarWidth(clampSidebarWidth(resizeState.startWidth + moveEvent.clientX - resizeState.startX));
    };

    const stopResize = () => {
      sidebarResizeStateRef.current = null;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', stopResize);
      window.removeEventListener('pointercancel', stopResize);
    };

    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', stopResize);
    window.addEventListener('pointercancel', stopResize);
  }, [isSidebarAnimating, sidebarVisualCollapsed, sidebarWidth]);

  const submitSpaceDialog = useCallback(async () => {
    const trimmedName = spaceDialogName.trim();
    if (!trimmedName) {
      void appAlert(t('layout.spaceNameRequired'));
      return;
    }

    setIsSpaceDialogSubmitting(true);
    try {
      if (spaceDialogMode === 'create') {
        const result = await window.ipcRenderer.spaces.create(trimmedName) as { success?: boolean; space?: WorkspaceSpace; error?: string } | null;
        if (!result?.success || !result.space) {
          void appAlert(result?.error || t('layout.createSpaceFailed'));
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
      void appAlert(spaceDialogMode === 'create' ? t('layout.createSpaceFailedRetry') : t('layout.renameSpaceFailedRetry'));
    } finally {
      setIsSpaceDialogSubmitting(false);
    }
  }, [handleSwitchSpace, loadSpaces, spaceDialogMode, spaceDialogName, spaceDialogTargetId, t]);

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
    const { key, view, labelKey, icon: Icon, primary } = item;
    const label = t(labelKey);
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
        openGlobalSearch={openGlobalSearch}
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
          <div className={clsx('border-t border-border', sidebarVisualCollapsed ? 'px-2 py-3 flex flex-col items-center gap-2.5' : 'px-4 py-3 space-y-2.5')}>
            {!sidebarVisualCollapsed && (
              <div className="space-y-1.5">
                <div
                  className="max-h-4 text-[10px] tracking-[0.04em] text-text-tertiary overflow-hidden whitespace-nowrap opacity-100 translate-y-0"
                >
                  {t('layout.space')}
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
                            {t('layout.noSpace')}
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
                                  title={t('layout.renameSpace')}
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
                        {t('layout.createSpace')}
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
                title={t('nav.settings')}
                aria-label={t('nav.settings')}
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
                title={t('nav.settings')}
                aria-label={t('nav.settings')}
              >
                <SettingsIcon className="w-[11px] h-[11px]" strokeWidth={1.75} />
              </button>
              {!usesMacOverlayTitleBar && (
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
                    onClick={() => setThemeMode((prev) => prev === 'dark' ? 'light' : 'dark')}
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
              data-no-window-drag
              onPointerDown={startSidebarResize}
            />
          )}
        </aside>
      )}

      {/* Main Content */}
      <main
        className={clsx(
          'app-main-shell flex-1 flex flex-col min-w-0 relative'
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
              {spaceDialogMode === 'create' ? t('layout.createSpace') : t('layout.renameSpace')}
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

      {isGlobalSearchOpen && (
        <div
          className="fixed inset-0 z-[125] flex items-center justify-center bg-black/18 px-4"
          style={{ backdropFilter: 'blur(18px) saturate(1.25)', WebkitBackdropFilter: 'blur(18px) saturate(1.25)' }}
          onMouseDown={closeGlobalSearch}
        >
          <div
            className="w-full max-w-xl space-y-2"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="flex h-14 items-center gap-3 rounded-2xl border border-accent-primary/70 bg-surface-primary px-4 shadow-[0_0_0_1px_rgba(52,211,153,0.24),0_0_34px_rgba(52,211,153,0.34),0_22px_70px_-32px_rgba(0,0,0,0.55)]">
              <Search className="h-4 w-4 shrink-0 text-accent-primary" strokeWidth={1.8} />
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
                className="h-full min-w-0 flex-1 bg-transparent text-[15px] text-text-primary caret-accent-primary outline-none placeholder:text-text-tertiary"
                placeholder="搜索知识库"
              />
            </div>

            {globalSearchQuery.trim() && (
              <div className="overflow-hidden rounded-2xl border border-border/80 bg-surface-primary/92 shadow-[0_22px_70px_-34px_rgba(0,0,0,0.58)] backdrop-blur-md">
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
                          className="group flex w-full items-start gap-3 px-4 py-3 text-left hover:bg-accent-primary/8"
                        >
                          <span className="mt-0.5 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-surface-secondary text-accent-primary group-hover:bg-accent-primary/12">
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
          onMouseDown={() => setUpdateNotice(null)}
        >
          <div
            className="w-full max-w-5xl max-h-[86vh] bg-surface-primary border border-border rounded-3xl shadow-2xl flex flex-col"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="px-8 pt-6 pb-4 border-b border-border flex items-center justify-between gap-3">
              <h2 className="text-2xl font-semibold text-text-primary">{t('layout.softwareUpdate')}</h2>
              <button
                type="button"
                onClick={() => setUpdateNotice(null)}
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
                    <div className="text-3xl font-semibold text-text-primary leading-tight">{t('layout.newVersionFound')}</div>
                    <div className="text-xl text-text-secondary mt-1">→ {updateNotice.latestVersion}</div>
                    <div className="text-xs text-text-tertiary mt-2">
                      {t('layout.currentVersion', { version: updateNotice.currentVersion })}
                      {updatePublishedDateLabel ? ` · ${t('layout.publishedAt', { date: updatePublishedDateLabel })}` : ''}
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
                  {isOpeningReleasePage ? t('layout.opening') : t('layout.downloadAndInstall')}
                </button>
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
