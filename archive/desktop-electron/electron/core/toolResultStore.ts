import { EventEmitter } from 'events';
import {
  addSessionToolResult,
  listSessionToolResults,
  updateSessionToolResult,
} from '../db';
import type { ToolResult } from './toolRegistry';

export interface PersistedToolResult {
  id: string;
  sessionId: string;
  callId: string;
  toolName: string;
  command?: string;
  success: boolean;
  resultText?: string;
  summaryText?: string;
  promptText?: string;
  originalChars?: number;
  promptChars?: number;
  truncated: boolean;
  payload?: Record<string, unknown> | null;
  createdAt: number;
  updatedAt: number;
}

const nextId = (prefix: string) => `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

const toPayloadJson = (value: Record<string, unknown> | undefined): string | null => {
  if (!value) return null;
  try {
    return JSON.stringify(value);
  } catch {
    return JSON.stringify({ error: 'json-stringify-failed' });
  }
};

const parsePayload = (value: string | null | undefined): Record<string, unknown> | null => {
  if (!value) return null;
  try {
    return JSON.parse(value) as Record<string, unknown>;
  } catch {
    return null;
  }
};

const extractResultText = (result: ToolResult): string => {
  return String(result.llmContent || result.display || result.error?.message || '').trim();
};

export class ToolResultStore {
  private readonly emitter = new EventEmitter();
  add(params: {
    sessionId: string;
    callId: string;
    toolName: string;
    command?: string;
    result: ToolResult;
    summaryText?: string | null;
    payload?: Record<string, unknown>;
  }): PersistedToolResult {
    const record = addSessionToolResult({
      id: nextId('tool_result'),
      session_id: params.sessionId,
      call_id: params.callId,
      tool_name: params.toolName,
      command: params.command ?? null,
      success: params.result.success ? 1 : 0,
      result_text: extractResultText(params.result) || null,
      summary_text: params.summaryText ?? null,
      prompt_text: null,
      original_chars: null,
      prompt_chars: null,
      truncated: 0,
      payload_json: toPayloadJson({
        result: params.result,
        ...(params.payload || {}),
      }),
    });
    const payload = this.toPublic(record);
    this.emitter.emit('tool-result-added', payload);
    return payload;
  }

  applyBudget(params: {
    sessionId: string;
    callId: string;
    promptText: string;
    originalChars: number;
    promptChars: number;
    truncated: boolean;
  }): PersistedToolResult | null {
    const updated = updateSessionToolResult(params.sessionId, params.callId, {
      prompt_text: params.promptText,
      original_chars: params.originalChars,
      prompt_chars: params.promptChars,
      truncated: params.truncated ? 1 : 0,
    });
    const payload = updated ? this.toPublic(updated) : null;
    if (payload) {
      this.emitter.emit('tool-result-updated', payload);
    }
    return payload;
  }

  list(sessionId: string, limit?: number): PersistedToolResult[] {
    return listSessionToolResults(sessionId, limit).map((record) => this.toPublic(record));
  }

  private toPublic(record: {
    id: string;
    session_id: string;
    call_id: string;
    tool_name: string;
    command?: string | null;
    success: number;
    result_text?: string | null;
    summary_text?: string | null;
    prompt_text?: string | null;
    original_chars?: number | null;
    prompt_chars?: number | null;
    truncated: number;
    payload_json?: string | null;
    created_at: number;
    updated_at: number;
  }): PersistedToolResult {
    return {
      id: record.id,
      sessionId: record.session_id,
      callId: record.call_id,
      toolName: record.tool_name,
      command: record.command ?? undefined,
      success: Boolean(record.success),
      resultText: record.result_text ?? undefined,
      summaryText: record.summary_text ?? undefined,
      promptText: record.prompt_text ?? undefined,
      originalChars: record.original_chars ?? undefined,
      promptChars: record.prompt_chars ?? undefined,
      truncated: Boolean(record.truncated),
      payload: parsePayload(record.payload_json),
      createdAt: record.created_at,
      updatedAt: record.updated_at,
    };
  }

  on(
    event: 'tool-result-added' | 'tool-result-updated',
    listener: (payload: PersistedToolResult) => void,
  ): () => void {
    this.emitter.on(event, listener);
    return () => {
      this.emitter.off(event, listener);
    };
  }
}

let toolResultStore: ToolResultStore | null = null;

export const getToolResultStore = (): ToolResultStore => {
  if (!toolResultStore) {
    toolResultStore = new ToolResultStore();
  }
  return toolResultStore;
};
