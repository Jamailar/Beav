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
  shouldShowInNotificationCenter,
  shouldShowSystemNotification,
} from './policy';
import { useNotificationStore } from './store';
import { showSystemNotification } from './systemAdapter';
import { showNotificationToast } from './toastAdapter';
import { notificationClient } from './notificationClient';
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
    window.ipcRenderer.onSettingsUpdated(handleSettingsUpdated);
    return () => {
      cancelled = true;
      window.ipcRenderer.offSettingsUpdated(handleSettingsUpdated);
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

      if (shouldShowInNotificationCenter(notification)) {
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
      eventTypes: [
        'runtime:done',
        'runtime:task-node-changed',
        'runtime:checkpoint',
        'runtime:cli-escalation-requested',
      ],
      checkpointTypes: [
        'chat.error',
        'chat.tool_confirm_request',
      ],
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
    window.ipcRenderer.redclawRunner.onTaskEvent(handleRedclawTaskEvent);

    return () => {
      runtimeDispose();
      window.ipcRenderer.generation.offJobUpdated(handleGenerationUpdated);
      window.ipcRenderer.redclawRunner.offTaskEvent(handleRedclawTaskEvent);
    };
  }, [currentView, openCenter, push]);

  useEffect(() => {
    let mounted = true;

    const syncIfForeground = (reason: 'login' | 'focus' | 'business_action') => {
      if (!mounted) return;
      if (document.visibilityState !== 'visible' || !document.hasFocus()) return;
      void notificationClient.sync(reason);
      notificationClient.startForegroundPolling();
    };

    void notificationClient.hydrate()
      .finally(() => {
        if (mounted) {
          syncIfForeground('login');
        }
      });

    const handleFocus = () => syncIfForeground('focus');
    const handleBlur = () => notificationClient.stopPolling();
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        syncIfForeground('focus');
      } else {
        notificationClient.stopPolling();
      }
    };
    const handleBusinessAction = () => syncIfForeground('business_action');
    const handleAuthStateChanged = (
      event:
        | { payload?: { status?: string; loggedIn?: boolean } | null }
        | { status?: string; loggedIn?: boolean }
        | null
        | undefined,
      payloadArg?: { status?: string; loggedIn?: boolean } | null,
    ) => {
      const payload = payloadArg !== undefined
        ? payloadArg
        : (event && typeof event === 'object' && 'payload' in event)
          ? event.payload
          : event;
      const snapshot = (payload || null) as { status?: string; loggedIn?: boolean } | null;
      const status = String(snapshot?.status || '');
      if (snapshot?.loggedIn && status !== 'anonymous' && status !== 'reauthRequired') {
        void notificationClient.hydrate().finally(() => syncIfForeground('login'));
        return;
      }
      notificationClient.stopPolling();
      notificationClient.clearLocalState();
    };

    window.addEventListener('focus', handleFocus);
    window.addEventListener('blur', handleBlur);
    document.addEventListener('visibilitychange', handleVisibilityChange);
    window.addEventListener('redbox:feedback-report-submitted', handleBusinessAction);
    window.ipcRenderer.auth.onStateChanged(handleAuthStateChanged);
    return () => {
      mounted = false;
      notificationClient.stopPolling();
      window.removeEventListener('focus', handleFocus);
      window.removeEventListener('blur', handleBlur);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      window.removeEventListener('redbox:feedback-report-submitted', handleBusinessAction);
      window.ipcRenderer.auth.offStateChanged(handleAuthStateChanged);
    };
  }, []);

  return <>{children}</>;
}
