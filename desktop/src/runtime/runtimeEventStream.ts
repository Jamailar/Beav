import type { RuntimeUnifiedEvent } from '../types';

type UnknownRecord = Record<string, unknown>;

export interface RuntimeEventStreamHandlers {
  getActiveSessionId?: () => string | null | undefined;
  onPhaseStart?: (payload: { sessionId: string; phase: string; runtimeMode: string }) => void;
  onThoughtStart?: (payload: { sessionId: string }) => void;
  onThoughtDelta?: (payload: { sessionId: string; content: string }) => void;
  onResponseDelta?: (payload: { sessionId: string; content: string }) => void;
  onToolRequest?: (payload: { sessionId: string; callId: string; name: string; input: unknown; description: string }) => void;
  onToolResult?: (payload: { sessionId: string; callId: string; name: string; output: UnknownRecord }) => void;
  onTaskNodeChanged?: (payload: {
    sessionId: string;
    taskId: string;
    nodeId: string;
    status: string;
    summary: string;
    error: string;
  }) => void;
  onSubagentSpawned?: (payload: { sessionId: string; taskId: string; roleId: string; runtimeMode: string }) => void;
  onTaskCheckpointSaved?: (payload: {
    sessionId: string;
    taskId: string;
    checkpointType: string;
    summary: string;
    checkpointPayload: UnknownRecord;
  }) => void;
  onChatPlanUpdated?: (payload: { sessionId: string; steps: unknown[] }) => void;
  onChatThoughtEnd?: (payload: { sessionId: string }) => void;
  onChatResponseEnd?: (payload: { sessionId: string; content: string }) => void;
  onChatError?: (payload: { sessionId: string; errorPayload: UnknownRecord }) => void;
  onChatSessionTitleUpdated?: (payload: { sessionId: string; title: string }) => void;
  onChatSkillActivated?: (payload: { sessionId: string; name: string; description: string }) => void;
  onChatToolConfirmRequest?: (payload: { sessionId: string; request: UnknownRecord }) => void;
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
}

function toRecord(value: unknown): UnknownRecord {
  if (!value || typeof value !== 'object') return {};
  return value as UnknownRecord;
}

function toText(value: unknown): string {
  return String(value || '').trim();
}

function toTextArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => toText(item)).filter((item) => Boolean(item));
}

function shouldSkipBySession(handlers: RuntimeEventStreamHandlers, sessionId: string): boolean {
  if (!handlers.getActiveSessionId) return false;
  const activeSessionId = toText(handlers.getActiveSessionId());
  if (!activeSessionId || !sessionId) return false;
  return activeSessionId !== sessionId;
}

function parseRuntimeEnvelope(envelope: unknown): RuntimeUnifiedEvent | null {
  const record = toRecord(envelope);
  const eventType = toText(record.eventType) as RuntimeUnifiedEvent['eventType'];
  if (!eventType) return null;
  return {
    eventType,
    sessionId: toText(record.sessionId) || null,
    taskId: toText(record.taskId) || null,
    payload: toRecord(record.payload),
    timestamp: Number(record.timestamp || Date.now()),
  };
}

function dispatchRuntimeEnvelope(handlers: RuntimeEventStreamHandlers, envelope: RuntimeUnifiedEvent): void {
  const sessionId = toText(envelope.sessionId);
  if (shouldSkipBySession(handlers, sessionId)) return;
  const taskId = toText(envelope.taskId);
  const payload = toRecord(envelope.payload);

  if (envelope.eventType === 'stream_start') {
    const phase = toText(payload.phase);
    if (!phase) return;
    handlers.onPhaseStart?.({
      sessionId,
      phase,
      runtimeMode: toText(payload.runtimeMode),
    });
    if (phase === 'thinking') {
      handlers.onThoughtStart?.({ sessionId });
    }
    return;
  }

  if (envelope.eventType === 'text_delta') {
    const content = String(payload.content || '');
    if (!content) return;
    const stream = toText(payload.stream || 'response');
    if (stream === 'thought') {
      handlers.onThoughtDelta?.({ sessionId, content });
      return;
    }
    handlers.onResponseDelta?.({ sessionId, content });
    return;
  }

  if (envelope.eventType === 'tool_request') {
    handlers.onToolRequest?.({
      sessionId,
      callId: toText(payload.callId),
      name: toText(payload.name),
      input: payload.input,
      description: toText(payload.description),
    });
    return;
  }

  if (envelope.eventType === 'tool_result') {
    handlers.onToolResult?.({
      sessionId,
      callId: toText(payload.callId),
      name: toText(payload.name),
      output: toRecord(payload.output),
    });
    return;
  }

  if (envelope.eventType === 'task_node_changed') {
    handlers.onTaskNodeChanged?.({
      sessionId,
      taskId,
      nodeId: toText(payload.nodeId) || 'node',
      status: toText(payload.status).toLowerCase(),
      summary: toText(payload.summary),
      error: toText(payload.error),
    });
    return;
  }

  if (envelope.eventType === 'subagent_spawned') {
    handlers.onSubagentSpawned?.({
      sessionId,
      taskId,
      roleId: toText(payload.roleId) || 'subagent',
      runtimeMode: toText(payload.runtimeMode) || 'unknown',
    });
    return;
  }

  if (envelope.eventType === 'task_checkpoint_saved') {
    const checkpointType = toText(payload.checkpointType);
    const checkpointPayload = toRecord(payload.payload);
    const summary = toText(payload.summary);
    handlers.onTaskCheckpointSaved?.({
      sessionId,
      taskId,
      checkpointType,
      summary,
      checkpointPayload,
    });
    if (checkpointType === 'chat.plan_updated') {
      const steps = Array.isArray(checkpointPayload.steps) ? checkpointPayload.steps : [];
      handlers.onChatPlanUpdated?.({ sessionId, steps });
      return;
    }
    if (checkpointType === 'chat.thought_end') {
      handlers.onChatThoughtEnd?.({ sessionId });
      return;
    }
    if (checkpointType === 'chat.response_end') {
      handlers.onChatResponseEnd?.({ sessionId, content: String(checkpointPayload.content || '') });
      return;
    }
    if (checkpointType === 'chat.error') {
      handlers.onChatError?.({ sessionId, errorPayload: checkpointPayload });
      return;
    }
    if (checkpointType === 'chat.session_title_updated') {
      const checkpointSessionId = toText(checkpointPayload.sessionId) || sessionId;
      const title = toText(checkpointPayload.title);
      if (!checkpointSessionId || !title) return;
      handlers.onChatSessionTitleUpdated?.({ sessionId: checkpointSessionId, title });
      return;
    }
    if (checkpointType === 'chat.skill_activated') {
      handlers.onChatSkillActivated?.({
        sessionId,
        name: toText(checkpointPayload.name),
        description: toText(checkpointPayload.description),
      });
      return;
    }
    if (checkpointType === 'chat.tool_confirm_request') {
      handlers.onChatToolConfirmRequest?.({
        sessionId,
        request: checkpointPayload,
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
  }
}

export function subscribeRuntimeEventStream(handlers: RuntimeEventStreamHandlers): () => void {
  const listener = (_event: unknown, envelope?: unknown) => {
    const parsed = parseRuntimeEnvelope(envelope);
    if (!parsed) return;
    dispatchRuntimeEnvelope(handlers, parsed);
  };
  window.ipcRenderer.on('runtime:event', listener as (...args: unknown[]) => void);
  return () => {
    window.ipcRenderer.off('runtime:event', listener as (...args: unknown[]) => void);
  };
}
