import { APP_BRAND } from '../config/brand';
import { runNotificationAction } from './actionRouter';
import { useNotificationStore } from './store';
import type {
  NotificationAction,
  NotificationRecord,
  ServerNotificationItem,
  ServerNotificationState,
} from './types';

type SyncReason = 'login' | 'focus' | 'poll' | 'business_action' | 'open_center';
type RemoteResponse = {
  success: boolean;
  status?: number;
  data?: Record<string, unknown>;
  raw?: Record<string, unknown>;
  context?: { appSlug?: string; userId?: string; realm?: string; baseUrl?: string };
  error?: string;
};

const APP_SLUG = APP_BRAND.variant;
const DEFAULT_POLL_SECONDS = 300;
const BACKOFF_SECONDS = [60, 120, 300, 600];
const STORAGE_PREFIX = 'redbox:notifications:server:v1';

function text(value: unknown, fallback = ''): string {
  const normalized = String(value || '').trim();
  return normalized || fallback;
}

function bool(value: unknown): boolean {
  return value === true || value === 1 || value === '1' || value === 'true';
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function numberValue(value: unknown, fallback: number): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function dateMs(value: unknown): number {
  const raw = text(value);
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : Date.now();
}

function responseData(response: RemoteResponse): Record<string, unknown> {
  return object(response?.data || response?.raw || {});
}

function responseItems(data: Record<string, unknown>): ServerNotificationItem[] {
  const rawItems = Array.isArray(data.items)
    ? data.items
    : Array.isArray(data.notifications)
      ? data.notifications
      : [];
  return rawItems.map((item) => normalizeServerItem(item)).filter(Boolean) as ServerNotificationItem[];
}

function normalizeServerItem(item: unknown): ServerNotificationItem | null {
  const record = object(item);
  const id = text(record.id || record.notification_id || record.notificationId);
  if (!id) return null;
  const createdAt = text(record.created_at || record.createdAt, new Date().toISOString());
  return {
    id,
    type: text(record.type, 'notification'),
    title: text(record.title, '通知'),
    message: text(record.message || record.body || record.content),
    payload: object(record.payload),
    is_read: bool(record.is_read ?? record.isRead ?? record.read),
    read_at: text(record.read_at || record.readAt) || null,
    created_at: createdAt,
  };
}

function contextKey(context: RemoteResponse['context'] | undefined): string {
  const userId = text(context?.userId, 'anonymous');
  return `${STORAGE_PREFIX}:${APP_SLUG}:${userId}`;
}

function userIdFromAuthState(authState: unknown): string {
  const session = object(object(authState).session);
  const user = object(session.user);
  return text(user.id || user.userId || user.user_id || session.userId || session.user_id, 'anonymous');
}

function readStoredState(key: string): ServerNotificationState | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<ServerNotificationState>;
    return {
      appSlug: APP_SLUG,
      userId: text(parsed.userId, 'anonymous'),
      cursor: text(parsed.cursor) || null,
      unreadCount: numberValue(parsed.unreadCount, 0),
      items: Array.isArray(parsed.items) ? parsed.items.map((item) => normalizeServerItem(item)).filter(Boolean) as ServerNotificationItem[] : [],
      lastSyncAt: text(parsed.lastSyncAt) || null,
    };
  } catch {
    return null;
  }
}

function writeStoredState(key: string, state: ServerNotificationState): void {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(key, JSON.stringify(state));
}

function actionForServerItem(item: ServerNotificationItem): NotificationAction | null {
  const feedbackId = text(item.payload.feedback_id || item.payload.feedbackId);
  if (item.type === 'feedback.comment' || item.type === 'feedback.reviewed') {
    return {
      id: 'open-feedback',
      label: '查看反馈',
      action: 'open-feedback-report',
      payload: { feedbackId },
    };
  }
  if (item.type === 'membership.updated') {
    return {
      id: 'open-membership',
      label: '查看账号',
      action: 'navigate',
      payload: { view: 'settings', settingsTab: 'ai', aiModelSubTab: 'login' },
    };
  }
  return null;
}

export function serverItemToRecord(item: ServerNotificationItem): NotificationRecord {
  const action = actionForServerItem(item);
  return {
    id: `server:${item.id}`,
    source: 'server',
    entityId: item.id,
    eventKey: item.type,
    level: item.is_read ? 'info' : 'attention',
    title: item.title,
    body: item.message,
    sound: 'none',
    sticky: false,
    createdAt: dateMs(item.created_at),
    actions: action ? [action] : [],
    read: item.is_read,
    meta: {
      serverNotification: item,
      serverNotificationId: item.id,
    },
  };
}

export class NotificationClient {
  private cursor: string | null = null;
  private storageKey: string | null = null;
  private pollTimer: number | null = null;
  private failureCount = 0;
  private stopped = true;

  async hydrate(): Promise<void> {
    const authState = await window.ipcRenderer.auth.getState().catch(() => null);
    const key = `${STORAGE_PREFIX}:${APP_SLUG}:${userIdFromAuthState(authState)}`;
    this.storageKey = key;
    const stored = readStoredState(key);
    if (!stored) {
      this.cursor = null;
      useNotificationStore.getState().clearRemote();
      return;
    }
    this.cursor = stored.cursor;
    useNotificationStore.getState().replaceRemoteItems(
      stored.items.map(serverItemToRecord),
      stored.unreadCount,
      stored.lastSyncAt,
    );
  }

  async sync(reason: SyncReason): Promise<void> {
    const store = useNotificationStore.getState();
    if (reason !== 'poll') {
      store.setRemoteSyncing(true);
    }
    try {
      const response = await window.ipcRenderer.notifications.syncRemote({
        cursor: this.cursor,
        limit: 20,
      });
      this.applyResponse(response, false);
      const data = responseData(response);
      this.scheduleNext(numberValue(data.next_poll_after_seconds ?? data.nextPollAfterSeconds, DEFAULT_POLL_SECONDS));
    } catch (error) {
      this.handleFailure(error);
    } finally {
      useNotificationStore.getState().setRemoteSyncing(false);
    }
  }

  async list(limit = 50): Promise<void> {
    const store = useNotificationStore.getState();
    store.setRemoteSyncing(true);
    try {
      const response = await window.ipcRenderer.notifications.listRemote({ limit });
      this.applyResponse(response, true);
    } catch (error) {
      this.handleFailure(error);
    } finally {
      useNotificationStore.getState().setRemoteSyncing(false);
    }
  }

  async markRead(recordId: string): Promise<void> {
    const serverId = recordId.startsWith('server:') ? recordId.slice('server:'.length) : recordId;
    useNotificationStore.getState().markRead(`server:${serverId}`);
    try {
      const response = await window.ipcRenderer.notifications.markRemoteRead({ notificationId: serverId });
      this.applyResponse(response, false);
    } catch (error) {
      this.handleFailure(error);
    }
  }

  async markAllRead(): Promise<void> {
    useNotificationStore.getState().markAllRead();
    try {
      const response = await window.ipcRenderer.notifications.markAllRemoteRead();
      this.applyResponse(response, false);
    } catch (error) {
      this.handleFailure(error);
    }
  }

  startForegroundPolling(): void {
    this.stopped = false;
    this.scheduleNext(DEFAULT_POLL_SECONDS);
  }

  stopPolling(): void {
    this.stopped = true;
    if (this.pollTimer !== null) {
      window.clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
  }

  clearLocalState(): void {
    this.cursor = null;
    if (this.storageKey && typeof window !== 'undefined') {
      window.localStorage.removeItem(this.storageKey);
    }
    this.storageKey = null;
    useNotificationStore.getState().clearRemote();
  }

  async open(record: NotificationRecord): Promise<void> {
    if (record.source === 'server') {
      await this.markRead(record.id);
    } else {
      useNotificationStore.getState().markRead(record.id);
    }
    const action = record.actions[0];
    if (action) {
      await runNotificationAction(action);
    }
  }

  private applyResponse(response: RemoteResponse, replace: boolean): void {
    if (!response?.success) {
      if (response?.status === 401) {
        this.stopPolling();
      }
      throw new Error(text(response?.error, 'Notification request failed'));
    }

    const data = responseData(response);
    const items = responseItems(data);
    const nextCursor = text(data.cursor || data.next_cursor || data.nextCursor);
    if (nextCursor) {
      this.cursor = nextCursor;
    }
    const unreadCount = numberValue(data.unread_count ?? data.unreadCount, useNotificationStore.getState().remoteUnreadCount);
    const lastSyncAt = new Date().toISOString();
    const records = items.map(serverItemToRecord);
    if (replace) {
      useNotificationStore.getState().replaceRemoteItems(records, unreadCount, lastSyncAt);
    } else {
      useNotificationStore.getState().upsertRemoteItems(records, unreadCount, lastSyncAt);
    }

    const key = contextKey(response.context);
    this.storageKey = key;
    const stored = readStoredState(key);
    writeStoredState(key, {
      appSlug: APP_SLUG,
      userId: text(response.context?.userId, stored?.userId || 'anonymous'),
      cursor: this.cursor,
      unreadCount,
      items: replace ? items : mergeServerItems(items, stored?.items || []),
      lastSyncAt,
    });
    this.failureCount = 0;
  }

  private handleFailure(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error || 'Notification sync failed');
    useNotificationStore.getState().setRemoteError(message);
    const backoff = BACKOFF_SECONDS[Math.min(this.failureCount, BACKOFF_SECONDS.length - 1)];
    this.failureCount += 1;
    this.scheduleNext(backoff);
  }

  private scheduleNext(seconds: number): void {
    if (this.stopped || typeof window === 'undefined') return;
    if (document.visibilityState !== 'visible' || !document.hasFocus()) return;
    if (this.pollTimer !== null) {
      window.clearTimeout(this.pollTimer);
    }
    this.pollTimer = window.setTimeout(() => {
      this.pollTimer = null;
      void this.sync('poll');
    }, Math.max(60, seconds) * 1000);
  }
}

function mergeServerItems(next: ServerNotificationItem[], previous: ServerNotificationItem[]): ServerNotificationItem[] {
  const seen = new Set<string>();
  return [...next, ...previous]
    .filter((item) => {
      if (seen.has(item.id)) return false;
      seen.add(item.id);
      return true;
    })
    .sort((left, right) => dateMs(right.created_at) - dateMs(left.created_at))
    .slice(0, 100);
}

export const notificationClient = new NotificationClient();
