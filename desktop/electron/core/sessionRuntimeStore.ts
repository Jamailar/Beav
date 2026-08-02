import { EventEmitter } from 'events';
import {
  addRuntimeEvent,
  addSessionCheckpoint,
  addSessionTranscriptRecord,
  cloneChatSession,
  getChatSession,
  getChatSessions,
  listRuntimeEventSessionIds,
  listRuntimeEvents,
  listSessionCheckpoints,
  listSessionTranscriptRecords,
} from '../db';
import { getToolResultStore } from './toolResultStore';
import type {
  QuerySession,
  RuntimeTranscriptEnvelope,
  SessionCheckpoint,
} from './runtimeTypes';

const nextId = (prefix: string) => `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

const toPayloadJson = (value: Record<string, unknown> | undefined): string | null => {
  if (!value || !Object.keys(value).length) return null;
  return JSON.stringify(value);
};

const toRuntimePayloadJson = (value: unknown): string | null => {
  if (value === undefined) return null;
  try {
    return JSON.stringify(value);
  } catch {
    return JSON.stringify({ error: 'json-stringify-failed' });
  }
};

const readJson = (value: string | null | undefined): unknown => {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
};

export class SessionRuntimeStore {
  private readonly emitter = new EventEmitter();
  private readonly toolResults = getToolResultStore();

  appendTranscript(params: {
    sessionId: string;
    recordType: string;
    role?: string;
    content?: string;
    payload?: RuntimeTranscriptEnvelope | Record<string, unknown>;
  }) {
    const record = addSessionTranscriptRecord({
      id: nextId('transcript'),
      session_id: params.sessionId,
      record_type: params.recordType,
      role: params.role,
      content: params.content,
      payload_json: params.payload ? JSON.stringify(params.payload) : undefined,
    });
    const payload = {
      id: record.id,
      sessionId: record.session_id,
      recordType: record.record_type,
      role: record.role,
      content: record.content,
      payload: record.payload_json ? JSON.parse(record.payload_json) : null,
      createdAt: record.created_at,
    };
    this.emitter.emit('transcript-appended', payload);
    return record;
  }

  addCheckpoint(params: {
    sessionId: string;
    checkpointType: string;
    summary: string;
    payload?: Record<string, unknown>;
  }): SessionCheckpoint {
    const record = addSessionCheckpoint({
      id: nextId('checkpoint'),
      session_id: params.sessionId,
      checkpoint_type: params.checkpointType,
      summary: params.summary,
      payload_json: toPayloadJson(params.payload) ?? undefined,
    });
    const payload = {
      id: record.id,
      sessionId: record.session_id,
      checkpointType: record.checkpoint_type,
      summary: record.summary,
      payload: record.payload_json ? JSON.parse(record.payload_json) as Record<string, unknown> : undefined,
      createdAt: record.created_at,
    };
    this.emitter.emit('checkpoint-added', payload);
    return payload;
  }

  appendRuntimeEvent(params: {
    category: string;
    eventType: string;
    sessionId?: string | null;
    runtimeId?: string | null;
    parentRuntimeId?: string | null;
    sourceTaskId?: string | null;
    taskId?: string | null;
    toolCallId?: string | null;
    projectId?: string | null;
    payload?: unknown;
  }) {
    const sessionId = String(params.sessionId || '').trim() || null;
    const session = sessionId ? getChatSession(sessionId) : null;
    let metadata: Record<string, unknown> = {};
    if (session?.metadata) {
      try {
        metadata = JSON.parse(session.metadata) as Record<string, unknown>;
      } catch {
        metadata = {};
      }
    }
    const record = addRuntimeEvent({
      id: nextId('runtime-event'),
      category: String(params.category || 'runtime').trim() || 'runtime',
      event_type: String(params.eventType || 'runtime:event').trim() || 'runtime:event',
      session_id: sessionId,
      runtime_id: params.runtimeId ?? (typeof metadata.runtimeId === 'string' ? metadata.runtimeId : null),
      parent_runtime_id: params.parentRuntimeId ?? (typeof metadata.parentRuntimeId === 'string' ? metadata.parentRuntimeId : null),
      source_task_id: params.sourceTaskId ?? (typeof metadata.sourceTaskId === 'string' ? metadata.sourceTaskId : null),
      task_id: params.taskId ?? null,
      tool_call_id: params.toolCallId ?? null,
      project_id: params.projectId ?? null,
      payload_json: toRuntimePayloadJson(params.payload),
    });
    const payload = {
      id: record.id,
      category: record.category,
      eventType: record.event_type,
      sessionId: record.session_id,
      runtimeId: record.runtime_id,
      parentRuntimeId: record.parent_runtime_id,
      sourceTaskId: record.source_task_id,
      taskId: record.task_id,
      toolCallId: record.tool_call_id,
      projectId: record.project_id,
      payload: readJson(record.payload_json),
      createdAt: record.created_at,
    };
    this.emitter.emit('runtime-event-added', payload);
    return payload;
  }

  listTranscript(sessionId: string, limit?: number) {
    return listSessionTranscriptRecords(sessionId, limit).map((record) => ({
      id: record.id,
      sessionId: record.session_id,
      recordType: record.record_type,
      role: record.role,
      content: record.content,
      payload: record.payload_json ? JSON.parse(record.payload_json) : null,
      createdAt: record.created_at,
    }));
  }

  listCheckpoints(sessionId: string, limit?: number): SessionCheckpoint[] {
    return listSessionCheckpoints(sessionId, limit).map((record) => ({
      id: record.id,
      sessionId: record.session_id,
      checkpointType: record.checkpoint_type,
      summary: record.summary,
      payload: record.payload_json ? JSON.parse(record.payload_json) as Record<string, unknown> : undefined,
      createdAt: record.created_at,
    }));
  }

  getSession(sessionId: string): QuerySession | null {
    const session = getChatSession(sessionId);
    if (!session) return null;
    return {
      id: session.id,
      transcriptCount: listSessionTranscriptRecords(sessionId).length,
      checkpointCount: listSessionCheckpoints(sessionId).length,
    };
  }

  listSessions(): QuerySession[] {
    return getChatSessions().map((session) => ({
      id: session.id,
      transcriptCount: listSessionTranscriptRecords(session.id).length,
      checkpointCount: listSessionCheckpoints(session.id).length,
    }));
  }

  forkSession(sourceSessionId: string, title?: string): QuerySession {
    const forked = cloneChatSession(sourceSessionId, `session_${Date.now()}`, title);
    return {
      id: forked.id,
      transcriptCount: listSessionTranscriptRecords(forked.id).length,
      checkpointCount: listSessionCheckpoints(forked.id).length,
    };
  }

  listToolResults(sessionId: string, limit?: number) {
    return this.toolResults.list(sessionId, limit);
  }

  listRuntimeEvents(params: {
    sessionId: string;
    includeChildSessions?: boolean;
    category?: string;
    eventType?: string;
    limit?: number;
  }) {
    const sessionIds = listRuntimeEventSessionIds(params.sessionId, Boolean(params.includeChildSessions));
    return listRuntimeEvents({
      sessionIds,
      category: params.category,
      eventType: params.eventType,
      limit: params.limit,
    }).map((record) => ({
      id: record.id,
      category: record.category,
      eventType: record.event_type,
      sessionId: record.session_id,
      runtimeId: record.runtime_id,
      parentRuntimeId: record.parent_runtime_id,
      sourceTaskId: record.source_task_id,
      taskId: record.task_id,
      toolCallId: record.tool_call_id,
      projectId: record.project_id,
      payload: readJson(record.payload_json),
      createdAt: record.created_at,
    }));
  }

  on(
    event: 'transcript-appended' | 'checkpoint-added' | 'runtime-event-added',
    listener: (payload: unknown) => void,
  ): () => void {
    this.emitter.on(event, listener);
    return () => {
      this.emitter.off(event, listener);
    };
  }
}

let runtimeStore: SessionRuntimeStore | null = null;

export const getSessionRuntimeStore = (): SessionRuntimeStore => {
  if (!runtimeStore) {
    runtimeStore = new SessionRuntimeStore();
  }
  return runtimeStore;
};
