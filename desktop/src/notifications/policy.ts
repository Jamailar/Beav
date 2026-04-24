import { normalizeMediaJobProjection, type MediaJobProjection } from '../features/media-jobs/types';
import type {
  NotificationContextSnapshot,
  NotificationEnvelope,
  NotificationSettings,
  NotificationSound,
} from './types';

type RuntimeDonePayload = {
  sessionId: string;
  status: string;
  runtimeMode: string;
  content: string;
  reason: string;
};

type RuntimeTaskNodePayload = {
  sessionId: string;
  taskId: string;
  nodeId: string;
  status: string;
  summary: string;
  error: string;
};

type RuntimeToolConfirmPayload = {
  sessionId: string;
  request: {
    name: string;
    details: {
      title: string;
      description: string;
    };
  };
};

type RuntimeCliEscalationPayload = {
  sessionId: string;
  title: string;
  description: string;
};

type RuntimeErrorPayload = {
  sessionId: string;
  errorPayload: Record<string, unknown>;
};

type RedclawTaskEventPayload = {
  eventType: string;
  taskId: string;
  taskName?: string;
  taskKind?: string;
  result?: string;
  summary?: string;
  createdAt?: string;
};

function makeNotificationId(source: string, entityId: string, eventKey: string, createdAt: number): string {
  return `${source}:${entityId}:${eventKey}:${createdAt}`;
}

function summarizeRuntimeMode(runtimeMode: string): string {
  if (runtimeMode === 'redclaw') return 'RedClaw';
  if (runtimeMode === 'chatroom') return '对话';
  if (runtimeMode === 'knowledge') return '知识库';
  if (runtimeMode === 'diagnostics') return '诊断';
  return runtimeMode || '运行时';
}

function shouldMuteSuccessForForeground(context: NotificationContextSnapshot, source: string): boolean {
  if (!context.hasFocus || context.visibilityState !== 'visible') return false;
  if (source === 'runtime' && (context.currentView === 'chat' || context.currentView === 'redclaw')) return true;
  if (source === 'generation' && context.currentView === 'generation-studio') return true;
  if (source === 'redclaw' && context.currentView === 'redclaw') return true;
  return false;
}

function withinQuietHours(settings: NotificationSettings, now: Date): boolean {
  if (!settings.quietHours.enabled) return false;
  const [startHour, startMinute] = settings.quietHours.start.split(':').map((value) => Number(value) || 0);
  const [endHour, endMinute] = settings.quietHours.end.split(':').map((value) => Number(value) || 0);
  const currentMinutes = now.getHours() * 60 + now.getMinutes();
  const startMinutes = startHour * 60 + startMinute;
  const endMinutes = endHour * 60 + endMinute;
  if (startMinutes === endMinutes) return false;
  if (startMinutes < endMinutes) {
    return currentMinutes >= startMinutes && currentMinutes < endMinutes;
  }
  return currentMinutes >= startMinutes || currentMinutes < endMinutes;
}

function resolveSound(
  level: NotificationEnvelope['level'],
  source: NotificationEnvelope['source'],
  context: NotificationContextSnapshot,
  settings: NotificationSettings,
): NotificationSound {
  const quiet = withinQuietHours(settings, new Date());
  if (level === 'error') return 'failure';
  if (level === 'attention') return 'attention';
  if (level === 'success') {
    if (quiet) return 'none';
    if (shouldMuteSuccessForForeground(context, source)) return 'none';
    return 'success';
  }
  return 'none';
}

export function buildNotificationFingerprint(notification: NotificationEnvelope): string {
  return `${notification.source}:${notification.entityId}:${notification.eventKey}`;
}

export function shouldShowSystemNotification(
  _notification: NotificationEnvelope,
  _context: NotificationContextSnapshot,
  _settings: NotificationSettings,
): boolean {
  return false;
}

export function mapRuntimeDoneToNotification(
  payload: RuntimeDonePayload,
  context: NotificationContextSnapshot,
  settings: NotificationSettings,
): NotificationEnvelope | null {
  const normalizedStatus = String(payload.status || '').trim().toLowerCase();
  if (normalizedStatus !== 'completed' && normalizedStatus !== 'success') return null;
  if (!settings.rules.runtimeBackgroundDone) return null;

  const createdAt = Date.now();
  const runtimeLabel = summarizeRuntimeMode(payload.runtimeMode);
  const notification: NotificationEnvelope = {
    id: makeNotificationId('runtime', payload.sessionId || 'runtime', 'done', createdAt),
    source: 'runtime',
    entityId: payload.sessionId || 'runtime',
    eventKey: 'done',
    level: 'success',
    title: `${runtimeLabel}任务已完成`,
    body: payload.reason || '后台任务已完成。',
    sound: 'none',
    sticky: false,
    createdAt,
    showInCenter: false,
    actions: [
      {
        id: 'open-runtime',
        label: '查看',
        action: 'navigate',
        payload: { view: payload.runtimeMode === 'redclaw' ? 'redclaw' : 'chat' },
      },
    ],
    meta: {
      sessionId: payload.sessionId,
      runtimeMode: payload.runtimeMode,
    },
  };
  return { ...notification, sound: resolveSound(notification.level, notification.source, context, settings) };
}

export function mapRuntimeTaskNodeFailureToNotification(
  payload: RuntimeTaskNodePayload,
  context: NotificationContextSnapshot,
  settings: NotificationSettings,
): NotificationEnvelope | null {
  if (String(payload.status || '').trim().toLowerCase() !== 'failed') return null;
  if (!settings.rules.runtimeFailed) return null;
  const createdAt = Date.now();
  const notification: NotificationEnvelope = {
    id: makeNotificationId('runtime', payload.taskId || payload.sessionId || 'runtime', 'task-failed', createdAt),
    source: 'runtime',
    entityId: payload.taskId || payload.sessionId || 'runtime',
    eventKey: 'task-failed',
    level: 'error',
    title: 'AI 任务失败',
    body: payload.error || payload.summary || '后台 AI 任务执行失败。',
    sound: 'none',
    sticky: true,
    createdAt,
    actions: [
      {
        id: 'open-runtime',
        label: '查看',
        action: 'navigate',
        payload: { view: context.currentView === 'redclaw' ? 'redclaw' : 'chat' },
      },
    ],
    meta: {
      sessionId: payload.sessionId,
      taskId: payload.taskId,
      nodeId: payload.nodeId,
    },
  };
  return { ...notification, sound: resolveSound(notification.level, notification.source, context, settings) };
}

export function mapRuntimeToolConfirmToNotification(
  payload: RuntimeToolConfirmPayload,
  context: NotificationContextSnapshot,
  settings: NotificationSettings,
): NotificationEnvelope | null {
  if (!settings.rules.runtimeNeedsApproval) return null;
  const createdAt = Date.now();
  const notification: NotificationEnvelope = {
    id: makeNotificationId('runtime', payload.sessionId || 'runtime', 'tool-confirm', createdAt),
    source: 'runtime',
    entityId: payload.sessionId || 'runtime',
    eventKey: 'tool-confirm',
    level: 'attention',
    title: payload.request.details.title || '需要你确认一个操作',
    body: payload.request.details.description || `工具 ${payload.request.name} 需要确认。`,
    sound: 'none',
    sticky: true,
    createdAt,
    actions: [
      {
        id: 'open-runtime',
        label: '去处理',
        action: 'navigate',
        payload: { view: context.currentView === 'redclaw' ? 'redclaw' : 'chat' },
      },
    ],
    meta: {
      sessionId: payload.sessionId,
      toolName: payload.request.name,
    },
  };
  return { ...notification, sound: resolveSound(notification.level, notification.source, context, settings) };
}

export function mapRuntimeCliEscalationToNotification(
  payload: RuntimeCliEscalationPayload,
  context: NotificationContextSnapshot,
  settings: NotificationSettings,
): NotificationEnvelope | null {
  if (!settings.rules.runtimeNeedsApproval) return null;
  const createdAt = Date.now();
  const notification: NotificationEnvelope = {
    id: makeNotificationId('runtime', payload.sessionId || 'runtime', 'cli-escalation', createdAt),
    source: 'runtime',
    entityId: payload.sessionId || 'runtime',
    eventKey: 'cli-escalation',
    level: 'attention',
    title: payload.title || 'CLI 任务需要额外权限',
    body: payload.description || '后台任务需要你确认权限。',
    sound: 'none',
    sticky: true,
    createdAt,
    actions: [
      {
        id: 'open-runtime',
        label: '去处理',
        action: 'navigate',
        payload: { view: context.currentView === 'redclaw' ? 'redclaw' : 'chat' },
      },
    ],
  };
  return { ...notification, sound: resolveSound(notification.level, notification.source, context, settings) };
}

export function mapRuntimeErrorToNotification(
  payload: RuntimeErrorPayload,
  context: NotificationContextSnapshot,
  settings: NotificationSettings,
): NotificationEnvelope | null {
  if (!settings.rules.runtimeFailed) return null;
  const errorText = String(payload.errorPayload.error || payload.errorPayload.message || '').trim();
  const createdAt = Date.now();
  const notification: NotificationEnvelope = {
    id: makeNotificationId('runtime', payload.sessionId || 'runtime', 'chat-error', createdAt),
    source: 'runtime',
    entityId: payload.sessionId || 'runtime',
    eventKey: 'chat-error',
    level: 'error',
    title: 'AI 运行失败',
    body: errorText || '运行时返回错误，请检查上下文与日志。',
    sound: 'none',
    sticky: true,
    createdAt,
    actions: [
      {
        id: 'open-runtime',
        label: '查看',
        action: 'navigate',
        payload: { view: context.currentView === 'redclaw' ? 'redclaw' : 'chat' },
      },
    ],
  };
  return { ...notification, sound: resolveSound(notification.level, notification.source, context, settings) };
}

export function mapGenerationEventToNotification(
  payload: unknown,
  context: NotificationContextSnapshot,
  settings: NotificationSettings,
): NotificationEnvelope | null {
  const projection = normalizeMediaJobProjection(payload);
  if (!projection) return null;
  return mapGenerationProjectionToNotification(projection, context, settings);
}

export function mapGenerationProjectionToNotification(
  projection: MediaJobProjection,
  context: NotificationContextSnapshot,
  settings: NotificationSettings,
): NotificationEnvelope | null {
  const normalizedStatus = String(projection.status || '').trim().toLowerCase();
  if (normalizedStatus === 'completed' && !settings.rules.generationCompleted) return null;
  if ((normalizedStatus === 'failed' || normalizedStatus === 'dead_lettered') && !settings.rules.generationFailed) return null;
  if (normalizedStatus !== 'completed' && normalizedStatus !== 'failed' && normalizedStatus !== 'dead_lettered') return null;

  const firstArtifactPath = projection.artifacts.find((artifact) => artifact.absolutePath)?.absolutePath
    || projection.artifacts.find((artifact) => artifact.relativePath)?.relativePath
    || '';
  const createdAt = Date.now();
  const isSuccess = normalizedStatus === 'completed';
  const title = isSuccess
    ? `${projection.kind === 'video' ? '视频' : '图片'}任务已完成`
    : `${projection.kind === 'video' ? '视频' : '图片'}任务失败`;
  const body = isSuccess
    ? (projection.recentEvents.at(-1)?.message || '生成结果已准备好。')
    : (projection.attempt?.lastError || projection.recentEvents.at(-1)?.message || '生成任务失败。');

  const actions = [];
  if (firstArtifactPath) {
    actions.push({
      id: 'open-path',
      label: '打开结果',
      action: 'open-path' as const,
      payload: { path: firstArtifactPath },
    });
  } else {
    actions.push({
      id: 'open-generation',
      label: '查看',
      action: 'navigate' as const,
      payload: { view: 'generation-studio' as const },
    });
  }
  if (!isSuccess) {
    actions.push({
      id: 'retry-generation',
      label: '重试',
      action: 'retry-generation' as const,
      payload: { jobId: projection.jobId },
    });
  }

  const notification: NotificationEnvelope = {
    id: makeNotificationId('generation', projection.jobId, normalizedStatus, createdAt),
    source: 'generation',
    entityId: projection.jobId,
    eventKey: normalizedStatus,
    level: isSuccess ? 'success' : 'error',
    title,
    body,
    sound: 'none',
    sticky: !isSuccess,
    createdAt,
    actions,
    meta: {
      kind: projection.kind,
      status: projection.status,
      jobId: projection.jobId,
    },
  };
  return { ...notification, sound: resolveSound(notification.level, notification.source, context, settings) };
}

export function mapRedclawTaskEventToNotification(
  payload: unknown,
  context: NotificationContextSnapshot,
  settings: NotificationSettings,
): NotificationEnvelope | null {
  const event = payload && typeof payload === 'object' ? payload as RedclawTaskEventPayload : null;
  if (!event || !event.eventType || !event.taskId) return null;

  const normalizedEventType = String(event.eventType || '').trim().toLowerCase();
  const isCompleted = normalizedEventType === 'task_completed';
  const isFailed = normalizedEventType === 'task_failed';
  const needsConfirmation = normalizedEventType === 'task_waiting_confirmation';

  if (isCompleted && !settings.rules.redclawCompleted) return null;
  if (isFailed && !settings.rules.redclawFailed) return null;
  if (!isCompleted && !isFailed && !needsConfirmation) return null;

  const createdAt = event.createdAt ? Date.parse(event.createdAt) || Date.now() : Date.now();
  const level = needsConfirmation ? 'attention' : isFailed ? 'error' : 'success';
  const eventKey = needsConfirmation ? 'task-waiting-confirmation' : isFailed ? 'task-failed' : 'task-completed';
  const notification: NotificationEnvelope = {
    id: makeNotificationId('redclaw', event.taskId, eventKey, createdAt),
    source: 'redclaw',
    entityId: event.taskId,
    eventKey,
    level,
    title: isCompleted
      ? `RedClaw 任务已完成`
      : needsConfirmation
        ? `RedClaw 任务需要确认`
        : `RedClaw 任务失败`,
    body: event.summary || event.taskName || 'RedClaw 后台任务状态发生变化。',
    sound: 'none',
    sticky: level !== 'success',
    createdAt,
    showInCenter: !isCompleted,
    actions: [
      {
        id: 'open-redclaw',
        label: level === 'attention' ? '去处理' : '查看',
        action: 'navigate',
        payload: { view: 'redclaw' },
      },
    ],
    meta: {
      taskKind: event.taskKind,
      result: event.result,
      taskName: event.taskName,
    },
  };
  return { ...notification, sound: resolveSound(notification.level, notification.source, context, settings) };
}
