import { normalizeMediaJobProjection, type MediaJobProjection } from '../features/media-jobs/types';
import type {
  NotificationContextSnapshot,
  NotificationEnvelope,
  NotificationSettings,
  NotificationSound,
} from './types';
import { APP_BRAND } from '../config/brand';

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
  escalationId?: string;
  executionId?: string;
  reviewDocketId?: string;
  requestId?: string;
  title: string;
  description: string;
  reason?: string;
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

function resolveSound(
  level: NotificationEnvelope['level'],
  _source: NotificationEnvelope['source'],
  _context: NotificationContextSnapshot,
  _settings: NotificationSettings,
): NotificationSound {
  if (level === 'error') return 'failure';
  if (level === 'attention') return 'attention';
  if (level === 'success') {
    return 'none';
  }
  return 'none';
}

export function buildNotificationFingerprint(notification: NotificationEnvelope): string {
  return `${notification.source}:${notification.entityId}:${notification.eventKey}`;
}

export function shouldShowInNotificationCenter(notification: NotificationEnvelope): boolean {
  return notification.showInCenter !== false
    && (notification.level === 'attention' || notification.level === 'error');
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
  _context: NotificationContextSnapshot,
  _settings: NotificationSettings,
): NotificationEnvelope | null {
  const normalizedStatus = String(payload.status || '').trim().toLowerCase();
  if (normalizedStatus !== 'completed' && normalizedStatus !== 'success') return null;
  return null;
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
        payload: { view: 'redclaw' },
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
        payload: { view: 'redclaw' },
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
  const approvalRequestId = payload.requestId || payload.reviewDocketId || payload.escalationId || '';
  const navigatePayload = approvalRequestId
    ? {
        view: 'approval' as const,
        requestId: approvalRequestId,
        docketId: payload.reviewDocketId,
        escalationId: payload.escalationId,
      }
    : { view: 'redclaw' as const };
  const notification: NotificationEnvelope = {
    id: makeNotificationId('runtime', payload.sessionId || 'runtime', 'cli-escalation', createdAt),
    source: 'runtime',
    entityId: payload.sessionId || 'runtime',
    eventKey: 'cli-escalation',
    level: 'attention',
    title: payload.title || 'CLI 任务需要额外权限',
    body: payload.reason || payload.description || '后台任务需要你确认权限。',
    sound: 'none',
    sticky: true,
    createdAt,
    actions: [
      {
        id: 'open-runtime',
        label: approvalRequestId ? '去审批' : '去处理',
        action: 'navigate',
        payload: navigatePayload,
      },
    ],
    meta: {
      sessionId: payload.sessionId,
      executionId: payload.executionId,
      escalationId: payload.escalationId,
      reviewDocketId: payload.reviewDocketId,
      requestId: approvalRequestId || undefined,
    },
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
  const titleText = String(payload.errorPayload.title || '').trim();
  const normalizedErrorText = `${titleText} ${errorText}`.replace(/\s+/g, '').toLowerCase();
  const shouldOpenRechargeSettings = normalizedErrorText.includes('余额不足');
  const shouldOpenLoginSettings = shouldOpenRechargeSettings
    || normalizedErrorText.includes('登陆失效')
    || normalizedErrorText.includes('登录失效');
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
        id: shouldOpenLoginSettings ? 'open-settings-login' : 'open-runtime',
        label: shouldOpenRechargeSettings ? '去充值' : shouldOpenLoginSettings ? '去登录页' : '查看',
        action: 'navigate',
        payload: shouldOpenLoginSettings
          ? { view: 'settings', settingsTab: 'ai', aiModelSubTab: 'login' }
          : { view: 'redclaw' },
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
  if (normalizedStatus === 'completed') return null;
  if ((normalizedStatus === 'failed' || normalizedStatus === 'dead_lettered') && !settings.rules.generationFailed) return null;
  if (normalizedStatus !== 'completed' && normalizedStatus !== 'failed' && normalizedStatus !== 'dead_lettered') return null;

  const firstArtifactPath = projection.artifacts.find((artifact) => artifact.absolutePath)?.absolutePath
    || projection.artifacts.find((artifact) => artifact.relativePath)?.relativePath
    || '';
  const createdAt = Date.now();
  const isSuccess = normalizedStatus === 'completed';
  const kindLabel = projection.kind === 'video'
    ? '视频'
    : projection.kind === 'audio'
      ? '语音合成'
      : projection.kind === 'voice_clone'
        ? '声音复刻'
        : '图片';
  const title = isSuccess
    ? `${kindLabel}任务已完成`
    : `${kindLabel}任务失败`;
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
    showInCenter: !isSuccess,
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

  if (isCompleted) return null;
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
      ? `${APP_BRAND.aiDisplayName} 任务已完成`
      : needsConfirmation
        ? `${APP_BRAND.aiDisplayName} 任务需要确认`
        : `${APP_BRAND.aiDisplayName} 任务失败`,
    body: event.summary || event.taskName || `${APP_BRAND.aiDisplayName} 后台任务状态发生变化。`,
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
