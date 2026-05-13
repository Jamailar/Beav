import { Bell, CheckCheck, ExternalLink, Trash2, X } from 'lucide-react';
import clsx from 'clsx';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { runNotificationAction } from '../notifications/actionRouter';
import { notificationClient } from '../notifications/notificationClient';
import { selectNotificationUnreadCount, useNotificationStore } from '../notifications/store';
import type { NotificationLevel } from '../notifications/types';

const NOTIFICATION_DRAWER_ANIMATION_MS = 220;
type NotificationDrawerPhase = 'opening' | 'open' | 'closing';

function levelTone(level: NotificationLevel): string {
  if (level === 'error') return 'bg-red-50 text-red-700 border-red-200';
  if (level === 'attention') return 'bg-amber-50 text-amber-700 border-amber-200';
  if (level === 'success') return 'bg-emerald-50 text-emerald-700 border-emerald-200';
  return 'bg-surface-secondary text-text-secondary border-border';
}

export function NotificationCenterDrawer() {
  const drawerOpen = useNotificationStore((state) => state.drawerOpen);
  const [isDrawerVisible, setIsDrawerVisible] = useState(drawerOpen);
  const [drawerPhase, setDrawerPhase] = useState<NotificationDrawerPhase>(drawerOpen ? 'open' : 'closing');
  const items = useNotificationStore((state) => state.items);
  const setDrawerOpen = useNotificationStore((state) => state.setDrawerOpen);
  const markRead = useNotificationStore((state) => state.markRead);
  const markAllRead = useNotificationStore((state) => state.markAllRead);
  const clearRead = useNotificationStore((state) => state.clearRead);
  const unreadCount = useNotificationStore(selectNotificationUnreadCount);
  const isSyncingRemote = useNotificationStore((state) => state.isSyncingRemote);
  const remoteLastError = useNotificationStore((state) => state.remoteLastError);
  const remoteLastSyncAt = useNotificationStore((state) => state.remoteLastSyncAt);
  const drawerAnimationTimerRef = useRef<number | null>(null);
  const drawerAnimationFrameRef = useRef<number | null>(null);

  const hasItems = items.length > 0;
  const title = useMemo(() => unreadCount > 0 ? `通知 (${unreadCount})` : '通知', [unreadCount]);

  useLayoutEffect(() => {
    if (drawerAnimationTimerRef.current !== null) {
      window.clearTimeout(drawerAnimationTimerRef.current);
      drawerAnimationTimerRef.current = null;
    }
    if (drawerAnimationFrameRef.current !== null) {
      window.cancelAnimationFrame(drawerAnimationFrameRef.current);
      drawerAnimationFrameRef.current = null;
    }

    if (drawerOpen) {
      setIsDrawerVisible(true);
      setDrawerPhase('opening');
      drawerAnimationFrameRef.current = window.requestAnimationFrame(() => {
        setDrawerPhase('open');
        drawerAnimationFrameRef.current = null;
      });
      return;
    }

    if (!isDrawerVisible) return;
    setDrawerPhase('closing');
    drawerAnimationTimerRef.current = window.setTimeout(() => {
      setIsDrawerVisible(false);
      setDrawerPhase('closing');
      drawerAnimationTimerRef.current = null;
    }, NOTIFICATION_DRAWER_ANIMATION_MS);
  }, [drawerOpen, isDrawerVisible]);

  useEffect(() => () => {
    if (drawerAnimationTimerRef.current !== null) {
      window.clearTimeout(drawerAnimationTimerRef.current);
    }
    if (drawerAnimationFrameRef.current !== null) {
      window.cancelAnimationFrame(drawerAnimationFrameRef.current);
    }
  }, []);

  useEffect(() => {
    if (!drawerOpen) return;
    void notificationClient.list(50);
  }, [drawerOpen]);

  if (!drawerOpen && !isDrawerVisible) return null;

  return (
    <div className="absolute inset-0 z-[115] pointer-events-none">
      <div
        className={clsx(
          'notification-center-backdrop absolute inset-0 pointer-events-auto',
          drawerPhase === 'open' ? 'notification-center-backdrop--open' : 'notification-center-backdrop--closed'
        )}
        onMouseDown={() => setDrawerOpen(false)}
      />
      <aside
        className={clsx(
          'notification-center-drawer absolute right-0 top-0 h-full w-[380px] max-w-[92vw] border-l border-border bg-surface-primary shadow-2xl pointer-events-auto flex flex-col',
          drawerPhase === 'open' ? 'notification-center-drawer--open' : 'notification-center-drawer--closed'
        )}
      >
        <div className="h-12 px-3 border-b border-border flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0">
            <Bell className="w-4 h-4 text-text-secondary" />
            <div className="text-sm font-medium text-text-primary truncate">{title}</div>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => {
                markAllRead();
                void notificationClient.markAllRead();
              }}
              className="h-7 px-2 rounded-md border border-border text-[11px] text-text-secondary hover:text-text-primary hover:bg-surface-secondary"
            >
              <span className="inline-flex items-center gap-1">
                <CheckCheck className="w-3.5 h-3.5" />
                全部已读
              </span>
            </button>
            <button
              type="button"
              onClick={() => setDrawerOpen(false)}
              className="h-7 w-7 rounded-md border border-border text-text-secondary hover:text-text-primary hover:bg-surface-secondary inline-flex items-center justify-center"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        <div className="px-3 py-2.5 border-b border-border flex items-center justify-between gap-2">
          <div className="text-xs text-text-tertiary">
            {isSyncingRemote
              ? '正在同步'
              : remoteLastError
                ? '同步失败'
                : remoteLastSyncAt
                  ? `已同步 ${new Date(remoteLastSyncAt).toLocaleTimeString()}`
                  : `最近保留 ${items.length} 条通知`}
          </div>
          <button
            type="button"
            onClick={clearRead}
            className="h-7 px-2 rounded-md border border-border text-[11px] text-text-secondary hover:text-text-primary hover:bg-surface-secondary"
          >
            <span className="inline-flex items-center gap-1">
              <Trash2 className="w-3.5 h-3.5" />
              清空已读
            </span>
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-3 py-3 space-y-2">
          {!hasItems && (
            <div className="rounded-lg border border-dashed border-border bg-surface-secondary/30 px-4 py-6 text-center text-sm text-text-tertiary">
              暂无通知
            </div>
          )}

          {items.map((item) => (
            <article
              key={item.id}
              className={clsx(
                'rounded-lg border px-3 py-2.5 space-y-2 transition-colors',
                item.read ? 'border-border bg-surface-secondary/20' : 'border-border bg-surface-primary shadow-sm'
              )}
            >
              <div className="flex items-start gap-2.5">
                <div className={clsx('mt-0.5 rounded-full border px-2 py-0.5 text-[10px] font-medium leading-none shrink-0', levelTone(item.level))}>
                  {item.level}
                </div>
                <div className="min-w-0 flex-1 space-y-1">
                  <div className="flex items-start justify-between gap-2">
                    <div className="text-[13px] leading-5 font-medium text-text-primary break-words">{item.title}</div>
                    {!item.read && <div className="mt-1 h-1.5 w-1.5 rounded-full bg-accent-primary shrink-0" />}
                  </div>
                  <div className="text-[11px] leading-4 text-text-secondary whitespace-pre-wrap break-words">
                    {item.body}
                  </div>
                  <div className="text-[10px] leading-4 text-text-tertiary">
                    {new Date(item.createdAt).toLocaleString()}
                  </div>
                </div>
              </div>

              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2 flex-wrap">
                  {item.actions.map((action) => (
                    <button
                      key={action.id}
                      type="button"
                      onClick={() => {
                        if (item.source === 'server') {
                          void notificationClient.open(item);
                        } else {
                          markRead(item.id);
                          void runNotificationAction(action);
                        }
                      }}
                      className="h-7 px-2 rounded-md border border-border text-[11px] text-text-secondary hover:text-text-primary hover:bg-surface-secondary inline-flex items-center gap-1"
                    >
                      <ExternalLink className="w-3.5 h-3.5" />
                      {action.label}
                    </button>
                  ))}
                </div>
                {!item.read && (
                  <button
                    type="button"
                    onClick={() => {
                      if (item.source === 'server') {
                        void notificationClient.markRead(item.id);
                      } else {
                        markRead(item.id);
                      }
                    }}
                    className="h-7 px-2 rounded-md border border-border text-[11px] text-text-secondary hover:text-text-primary hover:bg-surface-secondary"
                  >
                    标记已读
                  </button>
                )}
              </div>
            </article>
          ))}
        </div>
      </aside>
    </div>
  );
}
