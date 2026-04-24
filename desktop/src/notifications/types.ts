export type NotificationSource = 'runtime' | 'generation' | 'redclaw' | 'system';
export type NotificationLevel = 'success' | 'error' | 'attention' | 'info';
export type NotificationSound = 'success' | 'failure' | 'attention' | 'none';

export type NotificationAction =
  | {
      id: string;
      label: string;
      action: 'navigate';
      payload: { view: NotificationView };
    }
  | {
      id: string;
      label: string;
      action: 'open-path';
      payload: { path: string };
    }
  | {
      id: string;
      label: string;
      action: 'retry-generation';
      payload: { jobId: string };
    };

export type NotificationView =
  | 'chat'
  | 'redclaw'
  | 'generation-studio'
  | 'workboard'
  | 'manuscripts'
  | 'settings';

export interface NotificationEnvelope {
  id: string;
  source: NotificationSource;
  entityId: string;
  eventKey: string;
  level: NotificationLevel;
  title: string;
  body: string;
  sound: NotificationSound;
  sticky: boolean;
  createdAt: number;
  actions: NotificationAction[];
  showInCenter?: boolean;
  meta?: Record<string, unknown>;
}

export interface NotificationRecord extends NotificationEnvelope {
  read: boolean;
}

export type NotificationRuleMap = {
  runtimeBackgroundDone: boolean;
  runtimeFailed: boolean;
  runtimeNeedsApproval: boolean;
  generationCompleted: boolean;
  generationFailed: boolean;
  redclawCompleted: boolean;
  redclawFailed: boolean;
};

export interface NotificationSettings {
  enabled: boolean;
  inApp: {
    enabled: boolean;
    maxVisible: number;
    autoCloseMs: number;
  };
  sound: {
    enabled: boolean;
    volume: number;
    muteWhenFocused: boolean;
    success: boolean;
    failure: boolean;
    attention: boolean;
  };
  system: {
    enabled: boolean;
  };
  quietHours: {
    enabled: boolean;
    start: string;
    end: string;
  };
  rules: NotificationRuleMap;
}

export interface NotificationSystemPermissionSnapshot {
  state: 'granted' | 'denied' | 'prompt' | 'unknown';
}

export interface SystemNotificationPayload {
  title: string;
  body?: string;
  sound?: string;
}

export interface NotificationContextSnapshot {
  currentView: string;
  hasFocus: boolean;
  visibilityState: DocumentVisibilityState;
}

export const REDBOX_NAVIGATE_EVENT = 'redbox:navigate';

export const DEFAULT_NOTIFICATION_SETTINGS: NotificationSettings = {
  enabled: true,
  inApp: {
    enabled: true,
    maxVisible: 3,
    autoCloseMs: 5000,
  },
  sound: {
    enabled: true,
    volume: 0.7,
    muteWhenFocused: false,
    success: true,
    failure: true,
    attention: true,
  },
  system: {
    enabled: false,
  },
  quietHours: {
    enabled: false,
    start: '23:00',
    end: '08:00',
  },
  rules: {
    runtimeBackgroundDone: true,
    runtimeFailed: true,
    runtimeNeedsApproval: true,
    generationCompleted: true,
    generationFailed: true,
    redclawCompleted: true,
    redclawFailed: true,
  },
};

function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function normalizeText(value: unknown, fallback: string): string {
  const text = String(value || '').trim();
  return text || fallback;
}

export function parseNotificationSettings(value: unknown): NotificationSettings {
  let parsed = value;
  if (typeof parsed === 'string') {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      parsed = null;
    }
  }
  const record = parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {};
  const inApp = record.inApp && typeof record.inApp === 'object' ? record.inApp as Record<string, unknown> : {};
  const sound = record.sound && typeof record.sound === 'object' ? record.sound as Record<string, unknown> : {};
  const system = record.system && typeof record.system === 'object' ? record.system as Record<string, unknown> : {};
  const quietHours = record.quietHours && typeof record.quietHours === 'object' ? record.quietHours as Record<string, unknown> : {};
  const rules = record.rules && typeof record.rules === 'object' ? record.rules as Record<string, unknown> : {};

  return {
    enabled: record.enabled !== false,
    inApp: {
      enabled: inApp.enabled !== false,
      maxVisible: clampNumber(inApp.maxVisible, DEFAULT_NOTIFICATION_SETTINGS.inApp.maxVisible, 1, 5),
      autoCloseMs: clampNumber(inApp.autoCloseMs, DEFAULT_NOTIFICATION_SETTINGS.inApp.autoCloseMs, 2000, 15000),
    },
    sound: {
      enabled: sound.enabled !== false,
      volume: clampNumber(sound.volume, DEFAULT_NOTIFICATION_SETTINGS.sound.volume, 0, 1),
      muteWhenFocused: Boolean(sound.muteWhenFocused),
      success: sound.success !== false,
      failure: sound.failure !== false,
      attention: sound.attention !== false,
    },
    system: {
      enabled: Boolean(system.enabled),
    },
    quietHours: {
      enabled: Boolean(quietHours.enabled),
      start: normalizeText(quietHours.start, DEFAULT_NOTIFICATION_SETTINGS.quietHours.start),
      end: normalizeText(quietHours.end, DEFAULT_NOTIFICATION_SETTINGS.quietHours.end),
    },
    rules: {
      runtimeBackgroundDone: rules.runtimeBackgroundDone !== false,
      runtimeFailed: rules.runtimeFailed !== false,
      runtimeNeedsApproval: rules.runtimeNeedsApproval !== false,
      generationCompleted: rules.generationCompleted !== false,
      generationFailed: rules.generationFailed !== false,
      redclawCompleted: rules.redclawCompleted !== false,
      redclawFailed: rules.redclawFailed !== false,
    },
  };
}
