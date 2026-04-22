import { EventEmitter } from 'events';
import {
  addSessionCheckpoint,
  addSessionTranscriptRecord,
  cloneChatSession,
  getChatSession,
  getChatSessions,
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

  on(
    event: 'transcript-appended' | 'checkpoint-added',
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
