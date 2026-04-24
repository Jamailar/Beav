import type { NotificationEnvelope, NotificationSettings } from './types';

export function showNotificationToast(
  _notification: NotificationEnvelope,
  _settings: NotificationSettings,
  _onOpenCenter?: () => void,
): void {
  // Notification toasts are intentionally disabled.
}
