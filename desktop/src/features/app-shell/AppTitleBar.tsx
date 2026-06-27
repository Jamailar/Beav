import {
  type Dispatch,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  type SetStateAction,
} from 'react';
import { Bell, Minus, Moon, PanelLeft, Search, Square, Sun, X } from 'lucide-react';
import { clsx } from 'clsx';
import { APP_BRAND } from '../../config/brand';
import type { ThemeMode } from '../../config/theme';
import { useI18n } from '../../i18n';
import type { ImmersiveMode } from './types';

export type AppTitleBarPlatform = 'mac' | 'windows' | null;

export function getAppTitleBarPlatform(): AppTitleBarPlatform {
  if (typeof navigator === 'undefined') return null;
  const platform = navigator.platform || '';
  const userAgent = navigator.userAgent || '';
  if (/\bMac\b/i.test(platform) || /\bMac OS X\b/i.test(userAgent)) return 'mac';
  if (/\bWin/i.test(platform) || /\bWindows\b/i.test(userAgent)) return 'windows';
  return null;
}

type AppTitleBarProps = {
  immersiveMode: ImmersiveMode;
  enabled: boolean;
  platform: AppTitleBarPlatform;
  content: ReactNode;
  isSidebarCollapsed: boolean;
  toggleSidebarCollapsed: () => void;
  openGlobalSearch: () => void;
  openCurrentReleaseNotes: () => void;
  showUpdateButton: boolean;
  notificationDrawerOpen: boolean;
  unreadNotificationCount: number;
  toggleNotificationDrawer: () => void;
  themeMode: ThemeMode;
  setManualThemeMode: Dispatch<SetStateAction<ThemeMode>>;
  extraActions: ReactNode;
};

export function AppTitleBar({
  immersiveMode,
  enabled,
  platform,
  content,
  isSidebarCollapsed,
  toggleSidebarCollapsed,
  openGlobalSearch,
  openCurrentReleaseNotes,
  showUpdateButton,
  notificationDrawerOpen,
  unreadNotificationCount,
  toggleNotificationDrawer,
  themeMode,
  setManualThemeMode,
  extraActions,
}: AppTitleBarProps) {
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
        immersiveMode === 'dark' && 'app-titlebar--dark',
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
        {showUpdateButton && (
          <button
            type="button"
            onClick={openCurrentReleaseNotes}
            className="app-titlebar-update-button"
            title={t('layout.softwareUpdate')}
            aria-label={t('layout.softwareUpdate')}
            data-no-window-drag
          >
            {t('layout.installUpdate')}
          </button>
        )}
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
