import { Bell, CheckCheck, ExternalLink, Trash2, X } from 'lucide-react';
import clsx from 'clsx';
import { useMemo } from 'react';
import { runNotificationAction } from '../notifications/actionRouter';
import { selectNotificationUnreadCount, useNotificationStore } from '../notifications/store';
import type { NotificationLevel } from '../notifications/types';

function levelTone(level: NotificationLevel): string {
  if (level === 'error') return 'bg-red-50 text-red-700 border-red-200';
  if (level === 'attention') return 'bg-amber-50 text-amber-700 border-amber-200';
  if (level === 'success') return 'bg-emerald-50 text-emerald-700 border-emerald-200';
  return 'bg-surface-secondary text-text-secondary border-border';
}

export function NotificationCenterDrawer() {
  const drawerOpen = useNotificationStore((state) => state.drawerOpen);
  const items = useNotificationStore((state) => state.items);
  const setDrawerOpen = useNotificationStore((state) => state.setDrawerOpen);
  const markRead = useNotificationStore((state) => state.markRead);
  const markAllRead = useNotificationStore((state) => state.markAllRead);
  const clearRead = useNotificationStore((state) => state.clearRead);
  const unreadCount = useNotificationStore(selectNotificationUnreadCount);

  const hasItems = items.length > 0;
  const title = useMemo(() => unreadCount > 0 ? `通知 (${unreadCount})` : '通知', [unreadCount]);

  if (!drawerOpen) return null;

  return (
    <div className="absolute inset-0 z-[115] pointer-events-none">
      <div
        className="absolute inset-0 bg-black/20 pointer-events-auto"
        onMouseDown={() => setDrawerOpen(false)}
      />
      <aside className="absolute right-0 top-0 h-full w-[380px] max-w-[92vw] border-l border-border bg-surface-primary shadow-2xl pointer-events-auto flex flex-col">
        <div className="h-14 px-4 border-b border-border flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 min-w-0">
            <Bell className="w-4 h-4 text-text-secondary" />
            <div className="text-sm font-medium text-text-primary truncate">{title}</div>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={markAllRead}
              className="h-8 px-2.5 rounded-md border border-border text-[11px] text-text-secondary hover:text-text-primary hover:bg-surface-secondary"
            >
              <span className="inline-flex items-center gap-1">
                <CheckCheck className="w-3.5 h-3.5" />
                全部已读
              </span>
            </button>
            <button
              type="button"
              onClick={() => setDrawerOpen(false)}
              className="h-8 w-8 rounded-md border border-border text-text-secondary hover:text-text-primary hover:bg-surface-secondary inline-flex items-center justify-center"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        <div className="px-4 py-3 border-b border-border flex items-center justify-between gap-3">
          <div className="text-xs text-text-tertiary">
            最近保留 {items.length} 条通知
          </div>
          <button
            type="button"
            onClick={clearRead}
            className="h-8 px-2.5 rounded-md border border-border text-[11px] text-text-secondary hover:text-text-primary hover:bg-surface-secondary"
          >
            <span className="inline-flex items-center gap-1">
              <Trash2 className="w-3.5 h-3.5" />
              清空已读
            </span>
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-4 py-4 space-y-3">
          {!hasItems && (
            <div className="rounded-xl border border-dashed border-border bg-surface-secondary/30 px-4 py-8 text-center text-sm text-text-tertiary">
              暂无通知
            </div>
          )}

          {items.map((item) => (
            <article
              key={item.id}
              className={clsx(
                'rounded-xl border p-3 space-y-3 transition-colors',
                item.read ? 'border-border bg-surface-secondary/20' : 'border-border bg-surface-primary shadow-sm'
              )}
            >
              <div className="flex items-start gap-3">
                <div className={clsx('mt-0.5 rounded-full border px-2 py-0.5 text-[10px] font-medium shrink-0', levelTone(item.level))}>
                  {item.level}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-start justify-between gap-2">
                    <div className="text-sm font-medium text-text-primary">{item.title}</div>
                    {!item.read && <div className="mt-1 h-2 w-2 rounded-full bg-accent-primary shrink-0" />}
                  </div>
                  <div className="mt-1 text-xs text-text-secondary whitespace-pre-wrap break-words">
                    {item.body}
                  </div>
                  <div className="mt-2 text-[11px] text-text-tertiary">
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
                        markRead(item.id);
                        void runNotificationAction(action);
                      }}
                      className="h-8 px-2.5 rounded-md border border-border text-[11px] text-text-secondary hover:text-text-primary hover:bg-surface-secondary inline-flex items-center gap-1"
                    >
                      <ExternalLink className="w-3.5 h-3.5" />
                      {action.label}
                    </button>
                  ))}
                </div>
                {!item.read && (
                  <button
                    type="button"
                    onClick={() => markRead(item.id)}
                    className="h-8 px-2.5 rounded-md border border-border text-[11px] text-text-secondary hover:text-text-primary hover:bg-surface-secondary"
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

