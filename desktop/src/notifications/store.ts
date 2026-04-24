import { create } from 'zustand';
import type { NotificationEnvelope, NotificationRecord } from './types';

type NotificationStoreState = {
  items: NotificationRecord[];
  drawerOpen: boolean;
  push: (notification: NotificationEnvelope) => void;
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
  markRead: (id) =>
    set((state) => ({
      items: state.items.map((item) => (item.id === id ? { ...item, read: true } : item)),
    })),
  markAllRead: () =>
    set((state) => ({
      items: state.items.map((item) => ({ ...item, read: true })),
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
  state.items.reduce((count, item) => count + (item.read ? 0 : 1), 0);

