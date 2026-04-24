import { useEffect, useMemo, useRef, type ReactNode } from 'react';
import { subscribeRuntimeEventStream } from '../runtime/runtimeEventStream';
import { playNotificationSound, RUNTIME_SUCCESS_SOUND_ASSET_URL } from './audio';
import {
  buildNotificationFingerprint,
  mapGenerationEventToNotification,
  mapRedclawTaskEventToNotification,
  mapRuntimeCliEscalationToNotification,
  mapRuntimeDoneToNotification,
  mapRuntimeErrorToNotification,
  mapRuntimeTaskNodeFailureToNotification,
  mapRuntimeToolConfirmToNotification,
  shouldShowSystemNotification,
} from './policy';
import { useNotificationStore } from './store';
import { showSystemNotification } from './systemAdapter';
import { showNotificationToast } from './toastAdapter';
import {
  DEFAULT_NOTIFICATION_SETTINGS,
  parseNotificationSettings,
  type NotificationContextSnapshot,
  type NotificationEnvelope,
  type NotificationSettings,
} from './types';

type NotificationsHostProps = {
  currentView: string;
  children?: ReactNode;
};

function currentContextSnapshot(currentView: string): NotificationContextSnapshot {
  return {
    currentView,
    hasFocus: typeof document !== 'undefined' ? document.hasFocus() : true,
    visibilityState: typeof document !== 'undefined' ? document.visibilityState : 'visible',
  };
}

function resolveNotificationSoundAsset(notification: NotificationEnvelope): string | undefined {
  if (notification.source === 'runtime' && notification.level === 'success') {
    return RUNTIME_SUCCESS_SOUND_ASSET_URL;
  }
  return undefined;
}

export function NotificationsHost({ currentView, children = null }: NotificationsHostProps) {
  const push = useNotificationStore((state) => state.push);
  const setDrawerOpen = useNotificationStore((state) => state.setDrawerOpen);
  const settingsRef = useRef<NotificationSettings>(DEFAULT_NOTIFICATION_SETTINGS);
  const fingerprintsRef = useRef<Map<string, number>>(new Map());

  const openCenter = useMemo(() => () => setDrawerOpen(true), [setDrawerOpen]);

  useEffect(() => {
    let cancelled = false;

    const loadSettings = async () => {
      try {
        const settings = await window.ipcRenderer.getSettings();
        if (cancelled) return;
        settingsRef.current = parseNotificationSettings(settings?.notifications_json);
      } catch (error) {
        console.warn('[notifications] failed to load settings', error);
        settingsRef.current = DEFAULT_NOTIFICATION_SETTINGS;
      }
    };

    void loadSettings();
    const handleSettingsUpdated = () => {
      void loadSettings();
    };
    window.ipcRenderer.on('settings:updated', handleSettingsUpdated);
    return () => {
      cancelled = true;
      window.ipcRenderer.off('settings:updated', handleSettingsUpdated);
    };
  }, []);

  useEffect(() => {
    const deliver = async (notification: NotificationEnvelope | null) => {
      if (!notification) return;
      const settings = settingsRef.current;
      if (!settings.enabled) return;

      const fingerprint = buildNotificationFingerprint(notification);
      const now = Date.now();
      const lastAt = fingerprintsRef.current.get(fingerprint) || 0;
      if ((now - lastAt) < 3000) {
        return;
      }
      fingerprintsRef.current.set(fingerprint, now);

      if (notification.showInCenter !== false) {
        push(notification);
      }
      showNotificationToast(notification, settings, openCenter);
      await playNotificationSound(notification.sound, settings, {
        assetUrl: resolveNotificationSoundAsset(notification),
      });

      if (shouldShowSystemNotification(notification, currentContextSnapshot(currentView), settings)) {
        await showSystemNotification(notification, settings).catch((error) => {
          console.warn('[notifications] failed to show system notification', error);
        });
      }
    };

    const runtimeDispose = subscribeRuntimeEventStream({
      onChatDone: (payload) => {
        void deliver(mapRuntimeDoneToNotification(payload, currentContextSnapshot(currentView), settingsRef.current));
      },
      onTaskNodeChanged: (payload) => {
        void deliver(mapRuntimeTaskNodeFailureToNotification(payload, currentContextSnapshot(currentView), settingsRef.current));
      },
      onChatToolConfirmRequest: (payload) => {
        void deliver(mapRuntimeToolConfirmToNotification(payload, currentContextSnapshot(currentView), settingsRef.current));
      },
      onCliEscalationRequested: (payload) => {
        void deliver(mapRuntimeCliEscalationToNotification(payload, currentContextSnapshot(currentView), settingsRef.current));
      },
      onChatError: (payload) => {
        void deliver(mapRuntimeErrorToNotification(payload, currentContextSnapshot(currentView), settingsRef.current));
      },
    });

    const handleGenerationUpdated = (_event: unknown, payload: unknown) => {
      void deliver(mapGenerationEventToNotification(payload, currentContextSnapshot(currentView), settingsRef.current));
    };
    const handleRedclawTaskEvent = (_event: unknown, payload: unknown) => {
      void deliver(mapRedclawTaskEventToNotification(payload, currentContextSnapshot(currentView), settingsRef.current));
    };

    window.ipcRenderer.generation.onJobUpdated(handleGenerationUpdated);
    window.ipcRenderer.on('redclaw:task-event', handleRedclawTaskEvent);

    return () => {
      runtimeDispose();
      window.ipcRenderer.generation.offJobUpdated(handleGenerationUpdated);
      window.ipcRenderer.off('redclaw:task-event', handleRedclawTaskEvent);
    };
  }, [currentView, openCenter, push]);

  return <>{children}</>;
}
