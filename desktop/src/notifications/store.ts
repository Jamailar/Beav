import { create } from 'zustand';
import type { NotificationEnvelope, NotificationRecord } from './types';

type NotificationStoreState = {
  items: NotificationRecord[];
  drawerOpen: boolean;
  remoteUnreadCount: number;
  isSyncingRemote: boolean;
  remoteLastError: string | null;
  remoteLastSyncAt: string | null;
  push: (notification: NotificationEnvelope) => void;
  upsertRemoteItems: (notifications: NotificationRecord[], unreadCount: number, lastSyncAt?: string | null) => void;
  replaceRemoteItems: (notifications: NotificationRecord[], unreadCount: number, lastSyncAt?: string | null) => void;
  setRemoteSyncing: (syncing: boolean) => void;
  setRemoteError: (error: string | null) => void;
  clearRemote: () => void;
  markRead: (id: string) => void;
  markAllRead: () => void;
  clearRead: () => void;
  remove: (id: string) => void;
  setDrawerOpen: (open: boolean) => void;
  toggleDrawer: () => void;
};

const NOTIFICATION_HISTORY_LIMIT = 100;

export const useNotificationStore = create<NotificationStoreState>((set) => ({
  items: [],
  drawerOpen: false,
  remoteUnreadCount: 0,
  isSyncingRemote: false,
  remoteLastError: null,
  remoteLastSyncAt: null,
  push: (notification) =>
    set((state) => ({
      items: [
        {
          ...notification,
          read: false,
        },
        ...state.items,
      ].slice(0, NOTIFICATION_HISTORY_LIMIT),
    })),
  upsertRemoteItems: (notifications, unreadCount, lastSyncAt = null) =>
    set((state) => {
      const remoteIds = new Set(notifications.map((item) => item.id));
      const nextItems = [
        ...notifications,
        ...state.items.filter((item) => item.source !== 'server' || !remoteIds.has(item.id)),
      ].sort((left, right) => right.createdAt - left.createdAt).slice(0, NOTIFICATION_HISTORY_LIMIT);
      return {
        items: nextItems,
        remoteUnreadCount: unreadCount,
        remoteLastSyncAt: lastSyncAt || state.remoteLastSyncAt,
        remoteLastError: null,
      };
    }),
  replaceRemoteItems: (notifications, unreadCount, lastSyncAt = null) =>
    set((state) => ({
      items: [
        ...notifications,
        ...state.items.filter((item) => item.source !== 'server'),
      ].sort((left, right) => right.createdAt - left.createdAt).slice(0, NOTIFICATION_HISTORY_LIMIT),
      remoteUnreadCount: unreadCount,
      remoteLastSyncAt: lastSyncAt || state.remoteLastSyncAt,
      remoteLastError: null,
    })),
  setRemoteSyncing: (syncing) => set({ isSyncingRemote: syncing }),
  setRemoteError: (error) => set({ remoteLastError: error }),
  clearRemote: () =>
    set((state) => ({
      items: state.items.filter((item) => item.source !== 'server'),
      remoteUnreadCount: 0,
      remoteLastError: null,
      remoteLastSyncAt: null,
      isSyncingRemote: false,
    })),
  markRead: (id) =>
    set((state) => ({
      items: state.items.map((item) => (item.id === id ? { ...item, read: true } : item)),
      remoteUnreadCount: state.items.some((item) => item.id === id && item.source === 'server' && !item.read)
        ? Math.max(0, state.remoteUnreadCount - 1)
        : state.remoteUnreadCount,
    })),
  markAllRead: () =>
    set((state) => ({
      items: state.items.map((item) => ({ ...item, read: true })),
      remoteUnreadCount: 0,
    })),
  clearRead: () =>
    set((state) => ({
      items: state.items.filter((item) => !item.read),
    })),
  remove: (id) =>
    set((state) => ({
      items: state.items.filter((item) => item.id !== id),
    })),
  setDrawerOpen: (open) => set({ drawerOpen: open }),
  toggleDrawer: () => set((state) => ({ drawerOpen: !state.drawerOpen })),
}));

export const selectNotificationUnreadCount = (state: NotificationStoreState): number =>
  state.remoteUnreadCount
  + state.items.reduce((count, item) => count + (item.source === 'server' || item.read ? 0 : 1), 0);
