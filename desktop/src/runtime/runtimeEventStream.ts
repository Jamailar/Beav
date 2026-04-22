import type { RuntimeUnifiedEvent } from '../types';

type UnknownRecord = Record<string, unknown>;

type RuntimeEnvelopeMeta = {
  runtimeId?: string;
  parentRuntimeId?: string;
};

type RuntimeScopedPayload = {
  sessionId: string;
  runtimeId?: string;
  parentRuntimeId?: string;
};

type TaskScopedPayload = RuntimeScopedPayload & {
  taskId: string;
};

export type ToolConfirmationType = 'edit' | 'exec' | 'info';

export interface ToolConfirmationDetails {
  type: ToolConfirmationType;
  title: string;
  description: string;
  impact?: string;
}

export interface ToolConfirmRequestPayload {
  callId: string;
  name: string;
  details: ToolConfirmationDetails;
}

export interface RuntimeEventStreamHandlers {
  getActiveSessionId?: () => string | null | undefined;
  onPhaseStart?: (payload: RuntimeScopedPayload & { phase: string; runtimeMode: string }) => void;
  onThoughtStart?: (payload: RuntimeScopedPayload) => void;
  onThoughtDelta?: (payload: RuntimeScopedPayload & { content: string }) => void;
  onResponseDelta?: (payload: RuntimeScopedPayload & { content: string }) => void;
  onChatDone?: (payload: RuntimeScopedPayload & {
    status: string;
    content: string;
    runtimeMode: string;
    reason: string;
  }) => void;
  onToolRequest?: (payload: RuntimeScopedPayload & { callId: string; name: string; input: unknown; description: string }) => void;
  onToolResult?: (payload: RuntimeScopedPayload & { callId: string; name: string; output: UnknownRecord }) => void;
  onTaskNodeChanged?: (payload: TaskScopedPayload & {
    nodeId: string;
    status: string;
    summary: string;
    error: string;
    parentTaskId?: string;
    sourceTaskId?: string;
  }) => void;
  onSubagentSpawned?: (payload: TaskScopedPayload & {
    roleId: string;
    runtimeMode: string;
    childRuntimeId?: string;
    childTaskId?: string;
    childSessionId?: string;
    parentTaskId?: string;
  }) => void;
  onSubagentFinished?: (payload: TaskScopedPayload & {
    roleId: string;
    runtimeMode: string;
    status: string;
    summary: string;
    error: string;
    childRuntimeId?: string;
    childTaskId?: string;
    childSessionId?: string;
    parentTaskId?: string;
  }) => void;
  onTaskCheckpointSaved?: (payload: TaskScopedPayload & {
    checkpointType: string;
    summary: string;
    checkpointPayload: UnknownRecord;
  }) => void;
  onChatPlanUpdated?: (payload: RuntimeScopedPayload & { steps: unknown[] }) => void;
  onChatThoughtEnd?: (payload: RuntimeScopedPayload) => void;
  onChatResponseEnd?: (payload: RuntimeScopedPayload & { content: string }) => void;
  onChatCancelled?: (payload: RuntimeScopedPayload) => void;
  onChatError?: (payload: RuntimeScopedPayload & { errorPayload: UnknownRecord }) => void;
  onChatSessionTitleUpdated?: (payload: RuntimeScopedPayload & { title: string }) => void;
  onChatSkillActivated?: (payload: RuntimeScopedPayload & { name: string; description: string }) => void;
  onChatToolConfirmRequest?: (payload: RuntimeScopedPayload & { request: ToolConfirmRequestPayload }) => void;
  onCliInstallStarted?: (payload: RuntimeScopedPayload & {
    installId?: string;
    toolId?: string;
    toolName: string;
    environmentId?: string;
    installMethod?: string;
    spec?: string;
    raw: UnknownRecord;
  }) => void;
  onCliInstallFinished?: (payload: RuntimeScopedPayload & {
    installId?: string;
    toolId?: string;
    toolName: string;
    environmentId?: string;
    status: string;
    summary: string;
    raw: UnknownRecord;
  }) => void;
  onCliExecutionStarted?: (payload: RuntimeScopedPayload & {
    executionId: string;
    environmentId?: string;
    toolId?: string;
    toolName: string;
    argv: string[];
    cwd?: string;
    raw: UnknownRecord;
  }) => void;
  onCliExecutionLog?: (payload: RuntimeScopedPayload & {
    executionId: string;
    stream?: string;
    chunk: string;
    raw: UnknownRecord;
  }) => void;
  onCliExecutionStatus?: (payload: RuntimeScopedPayload & {
    executionId: string;
    status: string;
    summary: string;
    exitCode?: number;
    raw: UnknownRecord;
  }) => void;
  onCliEscalationRequested?: (payload: RuntimeScopedPayload & {
    escalationId: string;
    executionId?: string;
    title: string;
    description: string;
    reason?: string;
    commandPreview?: string;
    permissionSummary: string[];
    scopeOptions: Array<'once' | 'session' | 'always'>;
    raw: UnknownRecord;
  }) => void;
  onCliEscalationResolved?: (payload: RuntimeScopedPayload & {
    escalationId: string;
    executionId?: string;
    status: string;
    scope?: string;
    summary: string;
    raw: UnknownRecord;
  }) => void;
  onCliVerificationFinished?: (payload: RuntimeScopedPayload & {
    executionId: string;
    status: string;
    summary: string;
    raw: UnknownRecord;
  }) => void;
  onCreativeChatUserMessage?: (payload: { roomId: string; message: UnknownRecord }) => void;
  onCreativeChatAdvisorStart?: (payload: {
    roomId: string;
    advisorId: string;
    advisorName: string;
    advisorAvatar: string;
    phase: string;
  }) => void;
  onCreativeChatThinking?: (payload: {
    roomId: string;
    advisorId: string;
    thinkingType: string;
    content: string;
  }) => void;
  onCreativeChatRag?: (payload: {
    roomId: string;
    advisorId: string;
    ragType: string;
    content: string;
    sources: string[];
  }) => void;
  onCreativeChatTool?: (payload: {
    roomId: string;
    advisorId: string;
    toolType: string;
    tool: UnknownRecord;
  }) => void;
  onCreativeChatStream?: (payload: {
    roomId: string;
    advisorId: string;
    advisorName: string;
    advisorAvatar: string;
    content: string;
    done: boolean;
  }) => void;
  onCreativeChatDone?: (payload: { roomId: string }) => void;
  onCreativeChatError?: (payload: { roomId: string; error: UnknownRecord }) => void;
}

function toRecord(value: unknown): UnknownRecord {
  if (!value || typeof value !== 'object') return {};
  return value as UnknownRecord;
}

function toText(value: unknown): string {
  return String(value || '').trim();
}

function toOptionalText(value: unknown): string | undefined {
  const text = toText(value);
  return text || undefined;
}

function toTextArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => toText(item)).filter((item) => Boolean(item));
}

function toOptionalNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function normalizeToolConfirmRequest(value: unknown): ToolConfirmRequestPayload | null {
  const record = toRecord(value);
  const detailsRecord = toRecord(record.details);
  const detailType = toText(detailsRecord.type);
  if (detailType !== 'edit' && detailType !== 'exec' && detailType !== 'info') {
    return null;
  }
  const callId = toText(record.callId);
  const name = toText(record.name);
  const title = toText(detailsRecord.title);
  const description = String(detailsRecord.description || '');
  if (!callId || !name || !title || !description.trim()) {
    return null;
  }
  return {
    callId,
    name,
    details: {
      type: detailType,
      title,
      description,
      impact: toOptionalText(detailsRecord.impact),
    },
  };
}

function shouldSkipBySession(handlers: RuntimeEventStreamHandlers, sessionId: string): boolean {
  if (!handlers.getActiveSessionId) return false;
  const activeSessionId = toText(handlers.getActiveSessionId());
  if (!activeSessionId || !sessionId) return false;
  return activeSessionId !== sessionId;
}

function normalizeRuntimeEventType(value: unknown): RuntimeUnifiedEvent['eventType'] | null {
  const eventType = toText(value);
  switch (eventType) {
    case 'stream_start':
      return 'runtime:stream-start';
    case 'text_delta':
      return 'runtime:text-delta';
    case 'tool_request':
      return 'runtime:tool-start';
    case 'tool_result':
      return 'runtime:tool-end';
    case 'task_node_changed':
      return 'runtime:task-node-changed';
    case 'subagent_spawned':
      return 'runtime:subagent-started';
    case 'subagent_finished':
      return 'runtime:subagent-finished';
    case 'task_checkpoint_saved':
      return 'runtime:checkpoint';
    case 'runtime:stream-start':
    case 'runtime:text-delta':
    case 'runtime:done':
    case 'runtime:tool-start':
    case 'runtime:tool-update':
    case 'runtime:tool-end':
    case 'runtime:task-node-changed':
    case 'runtime:subagent-started':
    case 'runtime:subagent-finished':
    case 'runtime:checkpoint':
    case 'runtime:cli-tool-detected':
    case 'runtime:cli-install-started':
    case 'runtime:cli-install-finished':
    case 'runtime:cli-execution-started':
    case 'runtime:cli-execution-log':
    case 'runtime:cli-execution-status':
    case 'runtime:cli-escalation-requested':
    case 'runtime:cli-escalation-resolved':
    case 'runtime:cli-verification-finished':
      return eventType;
    default:
      return null;
  }
}

function parseRuntimeEnvelope(envelope: unknown): RuntimeUnifiedEvent | null {
  const record = toRecord(envelope);
  const eventType = normalizeRuntimeEventType(record.eventType);
  if (!eventType) return null;
  return {
    eventType,
    sessionId: toText(record.sessionId) || null,
    taskId: toText(record.taskId) || null,
    runtimeId: toOptionalText(record.runtimeId) || null,
    parentRuntimeId: toOptionalText(record.parentRuntimeId) || null,
    payload: toRecord(record.payload),
    timestamp: Number(record.timestamp || Date.now()),
  };
}

function dispatchRuntimeEnvelope(handlers: RuntimeEventStreamHandlers, envelope: RuntimeUnifiedEvent): void {
  const sessionId = toText(envelope.sessionId);
  if (shouldSkipBySession(handlers, sessionId)) return;
  const taskId = toText(envelope.taskId);
  const payload = toRecord(envelope.payload);
  const runtimeMeta: RuntimeEnvelopeMeta = {
    runtimeId: toOptionalText(envelope.runtimeId),
    parentRuntimeId: toOptionalText(envelope.parentRuntimeId),
  };

  if (envelope.eventType === 'runtime:stream-start') {
    const phase = toText(payload.phase);
    if (!phase) return;
    handlers.onPhaseStart?.({
      sessionId,
      ...runtimeMeta,
      phase,
      runtimeMode: toText(payload.runtimeMode),
    });
    if (phase === 'thinking') {
      handlers.onThoughtStart?.({ sessionId, ...runtimeMeta });
    }
    return;
  }

  if (envelope.eventType === 'runtime:text-delta') {
    const content = String(payload.content || '');
    if (!content) return;
    const stream = toText(payload.stream || 'response');
    if (stream === 'thought') {
      handlers.onThoughtDelta?.({ sessionId, ...runtimeMeta, content });
      return;
    }
    handlers.onResponseDelta?.({ sessionId, ...runtimeMeta, content });
    return;
  }

  if (envelope.eventType === 'runtime:done') {
    handlers.onChatDone?.({
      sessionId,
      ...runtimeMeta,
      status: toText(payload.status) || 'completed',
      content: String(payload.content || ''),
      runtimeMode: toText(payload.runtimeMode),
      reason: toText(payload.reason),
    });
    return;
  }

  if (envelope.eventType === 'runtime:tool-start') {
    handlers.onToolRequest?.({
      sessionId,
      ...runtimeMeta,
      callId: toText(payload.callId),
      name: toText(payload.name),
      input: payload.input,
      description: toText(payload.description),
    });
    return;
  }

  if (envelope.eventType === 'runtime:tool-update' || envelope.eventType === 'runtime:tool-end') {
    handlers.onToolResult?.({
      sessionId,
      ...runtimeMeta,
      callId: toText(payload.callId),
      name: toText(payload.name),
      output: toRecord(payload.output),
    });
    return;
  }

  if (envelope.eventType === 'runtime:cli-install-started') {
    handlers.onCliInstallStarted?.({
      sessionId,
      ...runtimeMeta,
      installId: toOptionalText(payload.installId) || toOptionalText(payload.executionId),
      toolId: toOptionalText(payload.toolId),
      toolName: toText(payload.toolName || payload.name || payload.executable) || 'cli',
      environmentId: toOptionalText(payload.environmentId),
      installMethod: toOptionalText(payload.installMethod),
      spec: toOptionalText(payload.spec),
      raw: payload,
    });
    return;
  }

  if (envelope.eventType === 'runtime:cli-install-finished') {
    handlers.onCliInstallFinished?.({
      sessionId,
      ...runtimeMeta,
      installId: toOptionalText(payload.installId) || toOptionalText(payload.executionId),
      toolId: toOptionalText(payload.toolId),
      toolName: toText(payload.toolName || payload.name || payload.executable) || 'cli',
      environmentId: toOptionalText(payload.environmentId),
      status: toText(payload.status) || (payload.success === false ? 'failed' : 'completed'),
      summary: toText(payload.summary || payload.message || payload.error),
      raw: payload,
    });
    return;
  }

  if (envelope.eventType === 'runtime:cli-execution-started') {
    handlers.onCliExecutionStarted?.({
      sessionId,
      ...runtimeMeta,
      executionId: toText(payload.executionId || payload.id),
      environmentId: toOptionalText(payload.environmentId),
      toolId: toOptionalText(payload.toolId),
      toolName: toText(payload.toolName || payload.name || payload.executable) || 'cli',
      argv: Array.isArray(payload.argv) ? payload.argv.map((item) => toText(item)).filter(Boolean) : [],
      cwd: toOptionalText(payload.cwd),
      raw: payload,
    });
    return;
  }

  if (envelope.eventType === 'runtime:cli-execution-log') {
    handlers.onCliExecutionLog?.({
      sessionId,
      ...runtimeMeta,
      executionId: toText(payload.executionId || payload.id),
      stream: toOptionalText(payload.stream),
      chunk: String(payload.chunk || payload.content || payload.text || payload.preview || ''),
      raw: payload,
    });
    return;
  }

  if (envelope.eventType === 'runtime:cli-execution-status') {
    handlers.onCliExecutionStatus?.({
      sessionId,
      ...runtimeMeta,
      executionId: toText(payload.executionId || payload.id),
      status: toText(payload.status) || 'running',
      summary: toText(payload.summary || payload.message || payload.error),
      exitCode: toOptionalNumber(payload.exitCode),
      raw: payload,
    });
    return;
  }

  if (envelope.eventType === 'runtime:cli-escalation-requested') {
    const scopeOptions = toTextArray(payload.scopeOptions).filter(
      (item): item is 'once' | 'session' | 'always' => item === 'once' || item === 'session' || item === 'always',
    );
    handlers.onCliEscalationRequested?.({
      sessionId,
      ...runtimeMeta,
      escalationId: toText(payload.escalationId || payload.id),
      executionId: toOptionalText(payload.executionId),
      title: toText(payload.title) || 'CLI 需要额外权限',
      description: toText(payload.description || payload.message),
      reason: toOptionalText(payload.reason),
      commandPreview: toOptionalText(payload.commandPreview || payload.command),
      permissionSummary: toTextArray(payload.permissionSummary || payload.permissions),
      scopeOptions,
      raw: payload,
    });
    return;
  }

  if (envelope.eventType === 'runtime:cli-escalation-resolved') {
    handlers.onCliEscalationResolved?.({
      sessionId,
      ...runtimeMeta,
      escalationId: toText(payload.escalationId || payload.id),
      executionId: toOptionalText(payload.executionId),
      status: toText(payload.status || payload.resolution) || 'resolved',
      scope: toOptionalText(payload.scope),
      summary: toText(payload.summary || payload.message || payload.reason),
      raw: payload,
    });
    return;
  }

  if (envelope.eventType === 'runtime:cli-verification-finished') {
    handlers.onCliVerificationFinished?.({
      sessionId,
      ...runtimeMeta,
      executionId: toText(payload.executionId || payload.id),
      status: toText(payload.status) || (payload.success === false ? 'failed' : 'completed'),
      summary: toText(payload.summary || payload.message || payload.error),
      raw: payload,
    });
    return;
  }

  if (envelope.eventType === 'runtime:task-node-changed') {
    handlers.onTaskNodeChanged?.({
      sessionId,
      ...runtimeMeta,
      taskId,
      nodeId: toText(payload.nodeId) || 'node',
      status: toText(payload.status).toLowerCase(),
      summary: toText(payload.summary),
      error: toText(payload.error),
      parentTaskId: toOptionalText(payload.parentTaskId),
      sourceTaskId: toOptionalText(payload.sourceTaskId),
    });
    return;
  }

  if (envelope.eventType === 'runtime:subagent-started') {
    handlers.onSubagentSpawned?.({
      sessionId,
      ...runtimeMeta,
      taskId,
      roleId: toText(payload.roleId) || 'subagent',
      runtimeMode: toText(payload.runtimeMode) || 'unknown',
      childRuntimeId: toOptionalText(payload.childRuntimeId),
      childTaskId: toOptionalText(payload.childTaskId),
      childSessionId: toOptionalText(payload.childSessionId),
      parentTaskId: toOptionalText(payload.parentTaskId) || toOptionalText(taskId),
    });
    return;
  }

  if (envelope.eventType === 'runtime:subagent-finished') {
    handlers.onSubagentFinished?.({
      sessionId,
      ...runtimeMeta,
      taskId,
      roleId: toText(payload.roleId) || 'subagent',
      runtimeMode: toText(payload.runtimeMode) || 'unknown',
      status: toText(payload.status) || 'completed',
      summary: toText(payload.summary),
      error: toText(payload.error),
      childRuntimeId: toOptionalText(payload.childRuntimeId),
      childTaskId: toOptionalText(payload.childTaskId),
      childSessionId: toOptionalText(payload.childSessionId),
      parentTaskId: toOptionalText(payload.parentTaskId) || toOptionalText(taskId),
    });
    return;
  }

  if (envelope.eventType === 'runtime:checkpoint') {
    const checkpointType = toText(payload.checkpointType);
    const checkpointPayload = toRecord(payload.payload);
    const summary = toText(payload.summary);
    handlers.onTaskCheckpointSaved?.({
      sessionId,
      ...runtimeMeta,
      taskId,
      checkpointType,
      summary,
      checkpointPayload,
    });
    if (checkpointType === 'chat.plan_updated') {
      const steps = Array.isArray(checkpointPayload.steps) ? checkpointPayload.steps : [];
      handlers.onChatPlanUpdated?.({ sessionId, ...runtimeMeta, steps });
      return;
    }
    if (checkpointType === 'chat.thought_end') {
      handlers.onChatThoughtEnd?.({ sessionId, ...runtimeMeta });
      return;
    }
    if (checkpointType === 'chat.response_end') {
      handlers.onChatResponseEnd?.({ sessionId, ...runtimeMeta, content: String(checkpointPayload.content || '') });
      return;
    }
    if (checkpointType === 'chat.cancelled') {
      handlers.onChatCancelled?.({ sessionId, ...runtimeMeta });
      return;
    }
    if (checkpointType === 'chat.error') {
      handlers.onChatError?.({ sessionId, ...runtimeMeta, errorPayload: checkpointPayload });
      return;
    }
    if (checkpointType === 'chat.session_title_updated') {
      const checkpointSessionId = toText(checkpointPayload.sessionId) || sessionId;
      const title = toText(checkpointPayload.title);
      if (!checkpointSessionId || !title) return;
      handlers.onChatSessionTitleUpdated?.({ sessionId: checkpointSessionId, ...runtimeMeta, title });
      return;
    }
    if (checkpointType === 'chat.skill_activated') {
      handlers.onChatSkillActivated?.({
        sessionId,
        ...runtimeMeta,
        name: toText(checkpointPayload.name),
        description: toText(checkpointPayload.description),
      });
      return;
    }
    if (checkpointType === 'chat.tool_confirm_request') {
      const request = normalizeToolConfirmRequest(checkpointPayload);
      if (!request) return;
      handlers.onChatToolConfirmRequest?.({
        sessionId,
        ...runtimeMeta,
        request,
      });
      return;
    }
    if (checkpointType === 'creative_chat.user_message') {
      const roomId = toText(checkpointPayload.roomId);
      if (!roomId) return;
      handlers.onCreativeChatUserMessage?.({
        roomId,
        message: toRecord(checkpointPayload.message),
      });
      return;
    }
    if (checkpointType === 'creative_chat.advisor_start') {
      const roomId = toText(checkpointPayload.roomId);
      if (!roomId) return;
      handlers.onCreativeChatAdvisorStart?.({
        roomId,
        advisorId: toText(checkpointPayload.advisorId),
        advisorName: toText(checkpointPayload.advisorName),
        advisorAvatar: toText(checkpointPayload.advisorAvatar),
        phase: toText(checkpointPayload.phase),
      });
      return;
    }
    if (checkpointType === 'creative_chat.thinking') {
      const roomId = toText(checkpointPayload.roomId);
      if (!roomId) return;
      handlers.onCreativeChatThinking?.({
        roomId,
        advisorId: toText(checkpointPayload.advisorId),
        thinkingType: toText(checkpointPayload.type),
        content: toText(checkpointPayload.content),
      });
      return;
    }
    if (checkpointType === 'creative_chat.rag') {
      const roomId = toText(checkpointPayload.roomId);
      if (!roomId) return;
      handlers.onCreativeChatRag?.({
        roomId,
        advisorId: toText(checkpointPayload.advisorId),
        ragType: toText(checkpointPayload.type),
        content: toText(checkpointPayload.content),
        sources: toTextArray(checkpointPayload.sources),
      });
      return;
    }
    if (checkpointType === 'creative_chat.tool') {
      const roomId = toText(checkpointPayload.roomId);
      if (!roomId) return;
      handlers.onCreativeChatTool?.({
        roomId,
        advisorId: toText(checkpointPayload.advisorId),
        toolType: toText(checkpointPayload.type),
        tool: toRecord(checkpointPayload.tool),
      });
      return;
    }
    if (checkpointType === 'creative_chat.stream') {
      const roomId = toText(checkpointPayload.roomId);
      if (!roomId) return;
      handlers.onCreativeChatStream?.({
        roomId,
        advisorId: toText(checkpointPayload.advisorId),
        advisorName: toText(checkpointPayload.advisorName),
        advisorAvatar: toText(checkpointPayload.advisorAvatar),
        content: String(checkpointPayload.content || ''),
        done: Boolean(checkpointPayload.done),
      });
      return;
    }
    if (checkpointType === 'creative_chat.done') {
      const roomId = toText(checkpointPayload.roomId);
      if (!roomId) return;
      handlers.onCreativeChatDone?.({ roomId });
      return;
    }
    if (checkpointType === 'creative_chat.error') {
      const roomId = toText(checkpointPayload.roomId);
      if (!roomId) return;
      handlers.onCreativeChatError?.({
        roomId,
        error: checkpointPayload,
      });
      return;
    }
  }
}

export function subscribeRuntimeEventStream(handlers: RuntimeEventStreamHandlers): () => void {
  const listener = (_event: unknown, envelope?: unknown) => {
    const parsed = parseRuntimeEnvelope(envelope);
    if (!parsed) return;
    const sessionId = toText(parsed.sessionId);
    if (shouldSkipBySession(handlers, sessionId)) return;
    dispatchRuntimeEnvelope(handlers, parsed);
  };
  window.ipcRenderer.on('runtime:event', listener as (...args: unknown[]) => void);
  return () => {
    window.ipcRenderer.off('runtime:event', listener as (...args: unknown[]) => void);
  };
}
