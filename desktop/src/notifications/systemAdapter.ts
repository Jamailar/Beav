import type {
  NotificationEnvelope,
  NotificationSettings,
  NotificationSystemPermissionSnapshot,
} from './types';

function normalizePermissionState(value: unknown): NotificationSystemPermissionSnapshot {
  const state = typeof value === 'object' && value !== null && 'state' in value
    ? String((value as { state?: unknown }).state || '').trim().toLowerCase()
    : '';
  if (state === 'granted' || state === 'denied' || state === 'prompt') {
    return { state };
  }
  return { state: 'unknown' };
}

export async function showSystemNotification(
  notification: NotificationEnvelope,
  settings: NotificationSettings,
): Promise<void> {
  if (!settings.system.enabled) return;
  await window.ipcRenderer.notifications.showSystem({
    title: notification.title,
    body: notification.body,
  });
}

export async function requestSystemNotificationPermission(): Promise<NotificationSystemPermissionSnapshot> {
  const result = await window.ipcRenderer.notifications.requestPermission();
  return normalizePermissionState(result);
}

export async function getSystemNotificationPermissionState(): Promise<NotificationSystemPermissionSnapshot> {
  const result = await window.ipcRenderer.notifications.getPermissionState();
  return normalizePermissionState(result);
}
