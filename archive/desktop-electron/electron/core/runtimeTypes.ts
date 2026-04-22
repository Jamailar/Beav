import type { ToolDefinition, ToolResult } from './toolRegistry';

export type RuntimeEvent =
  | { type: 'query_start'; sessionId: string; message: string }
  | { type: 'thinking'; phase: 'analyze' | 'tooling' | 'respond' | 'compact'; content: string }
  | { type: 'response_chunk'; content: string }
  | { type: 'response_end'; content: string }
  | { type: 'tool_start'; callId: string; name: string; params: unknown; description: string }
  | { type: 'tool_output'; callId: string; name: string; chunk: string }
  | { type: 'tool_end'; callId: string; name: string; result: ToolResult; durationMs: number }
  | { type: 'tool_summary'; toolName: string; content: string }
  | { type: 'hook_start'; hookId: string; event: string }
  | { type: 'hook_end'; hookId: string; event: string; success: boolean; output?: string }
  | { type: 'compact_start'; strategy: 'micro' | 'normal' | 'reactive' }
  | { type: 'compact_end'; strategy: 'micro' | 'normal' | 'reactive'; summary?: string; compacted: boolean }
  | { type: 'checkpoint'; checkpointType: string; summary: string }
  | { type: 'error'; message: string }
  | { type: 'done'; response: string };

export interface RuntimeTranscriptEnvelope {
  kind: string;
  data: Record<string, unknown>;
}

export type RuntimeMessageContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

export interface RuntimeMessage {
  role: 'system' | 'user' | 'assistant';
  content: string | RuntimeMessageContentPart[];
}

export interface RuntimeToolContext {
  tools: ToolDefinition<unknown, ToolResult>[];
  toolPack: string;
}

export interface QuerySession {
  id: string;
  transcriptCount: number;
  checkpointCount: number;
}

export interface QueryState {
  turnCount: number;
  startedAt: number;
  lastCheckpointAt?: number;
  compacted: boolean;
  compactRounds: number;
  lastResponse: string;
}

export interface RuntimeConfig {
  sessionId: string;
  apiKey: string;
  baseURL: string;
  model: string;
  systemPrompt: string;
  messages: RuntimeMessage[];
  userInputContent?: string | RuntimeMessageContentPart[];
  signal?: AbortSignal;
  maxTurns?: number;
  maxTimeMinutes?: number;
  temperature?: number;
  toolPack: string;
  runtimeMode?: string;
  interactive?: boolean;
  requiresHumanApproval?: boolean;
}

export interface RuntimeAdapter {
  onEvent: (event: RuntimeEvent) => void;
  onToolResult?: (toolName: string, result: ToolResult, command?: string) => void;
  summarizeToolResult?: (toolName: string, result: ToolResult) => string | null;
}

export interface HookContext {
  sessionId: string;
  event: string;
  payload: Record<string, unknown>;
}

export type HookType = 'command' | 'prompt' | 'http' | 'agent';

export interface HookDefinition {
  id: string;
  event: 'query.before' | 'query.after' | 'tool.before' | 'tool.after' | 'stop.failure';
  type: HookType;
  matcher?: string;
  command?: string;
  prompt?: string;
  url?: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
  enabled?: boolean;
}

export interface CompactBoundary {
  id: string;
  sessionId: string;
  strategy: 'micro' | 'normal' | 'reactive';
  summary: string;
  createdAt: number;
}

export interface CompactSummary {
  strategy: 'micro' | 'normal' | 'reactive';
  summary: string;
  compactedMessages: RuntimeMessage[];
}

export interface SessionCheckpoint {
  id: string;
  sessionId: string;
  checkpointType: string;
  summary: string;
  payload?: Record<string, unknown>;
  createdAt: number;
}
