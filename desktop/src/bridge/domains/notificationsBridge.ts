import type { BridgeCore } from '../types';

type RemoteNotificationsPayload = {
  cursor?: string | null;
  limit?: number;
  unreadOnly?: boolean;
};

const EMPTY_REMOTE_NOTIFICATIONS = {
  success: true,
  notifications: [],
  unreadCount: 0,
  cursor: null,
  remoteUnavailable: true,
};

export function createNotificationsBridge(core: BridgeCore) {
  void core;

  return {
    notifications: {
      getPermissionState: async () => ({ state: 'unknown' as const }),
      requestPermission: async () => ({ state: 'unknown' as const }),
      showSystem: async (_payload: { title: string; body?: string; sound?: string }) => ({
        success: false,
        error: 'System notifications unavailable in the Electron archive',
      }),
      syncRemote: async (_payload?: RemoteNotificationsPayload) => EMPTY_REMOTE_NOTIFICATIONS,
      listRemote: async (_payload?: Pick<RemoteNotificationsPayload, 'limit' | 'unreadOnly'>) => EMPTY_REMOTE_NOTIFICATIONS,
      markRemoteRead: async (_payload: { notificationId: string }) => EMPTY_REMOTE_NOTIFICATIONS,
      markAllRemoteRead: async () => EMPTY_REMOTE_NOTIFICATIONS,
    },
  };
}
