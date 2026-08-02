import fs from 'node:fs/promises';
import path from 'node:path';
import {
  addChatMessage,
  addRuntimeEvent,
  addSessionCheckpoint,
  addSessionToolResult,
  addSessionTranscriptRecord,
  createChatSession,
  deleteChatSession,
  getChatMessages,
  getChatSession,
  getChatSessions,
  getWorkspacePaths,
  listRuntimeEventSessionIds,
  listRuntimeEvents,
  listSessionCheckpoints,
  listSessionToolResults,
  listSessionTranscriptRecords,
  type ChatMessage,
  type ChatSession,
  type RuntimeEventRecord,
  type SessionCheckpointRecord,
  type SessionToolResultRecord,
  type SessionTranscriptRecord,
} from '../db';

const ARCHIVE_FORMAT = 'redbox-runtime-session';
const ARCHIVE_VERSION = 1;
const MAX_ARCHIVE_ITEMS = 100_000;

type RuntimeSessionArchiveManifest = {
  format: typeof ARCHIVE_FORMAT;
  version: number;
  exportedAt: string;
  sessionId: string;
  sessionIds: string[];
  includeChildSessions: boolean;
  counts: {
    sessions: number;
    messages: number;
    transcriptRecords: number;
    checkpoints: number;
    toolResults: number;
    runtimeEvents: number;
  };
};

type RuntimeSessionArchiveBundle = {
  manifest: RuntimeSessionArchiveManifest;
  sessions: ChatSession[];
  messages: ChatMessage[];
  transcriptRecords: SessionTranscriptRecord[];
  checkpoints: SessionCheckpointRecord[];
  toolResults: SessionToolResultRecord[];
  runtimeEvents: RuntimeEventRecord[];
};

const nextId = (prefix: string): string => `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

function parseMetadata(value: string | null | undefined): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function safeArchiveName(value: string): string {
  return String(value || 'session')
    .replace(/[^a-zA-Z0-9._-]+/g, '_')
    .replace(/^\.+/, '')
    .slice(0, 80) || 'session';
}

function toJsonl<T>(items: T[]): string {
  return items.map((item) => JSON.stringify(item)).join('\n') + (items.length ? '\n' : '');
}

function parseJsonl<T>(raw: string, fileName: string): T[] {
  const lines = String(raw || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length > MAX_ARCHIVE_ITEMS) {
    throw new Error(`${fileName} contains too many records`);
  }
  return lines.map((line, index) => {
    try {
      return JSON.parse(line) as T;
    } catch {
      throw new Error(`${fileName} has invalid JSON at line ${index + 1}`);
    }
  });
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await fs.writeFile(filePath, JSON.stringify(value, null, 2), 'utf-8');
}

async function readJson<T>(filePath: string): Promise<T> {
  const raw = await fs.readFile(filePath, 'utf-8');
  return JSON.parse(raw) as T;
}

function sessionIdsForArchive(sessionId: string, includeChildSessions: boolean): string[] {
  return listRuntimeEventSessionIds(sessionId, includeChildSessions);
}

function buildBundle(sessionId: string, includeChildSessions: boolean): RuntimeSessionArchiveBundle | null {
  const root = getChatSession(sessionId);
  if (!root) return null;
  const sessionIds = sessionIdsForArchive(sessionId, includeChildSessions);
  const sessions = getChatSessions().filter((session) => sessionIds.includes(session.id));
  const messages = sessions.flatMap((session) => getChatMessages(session.id));
  const transcriptRecords = sessions.flatMap((session) => listSessionTranscriptRecords(session.id));
  const checkpoints = sessions.flatMap((session) => listSessionCheckpoints(session.id));
  const toolResults = sessions.flatMap((session) => listSessionToolResults(session.id));
  const runtimeEvents = listRuntimeEvents({ sessionIds, limit: 1000 });
  const manifest: RuntimeSessionArchiveManifest = {
    format: ARCHIVE_FORMAT,
    version: ARCHIVE_VERSION,
    exportedAt: new Date().toISOString(),
    sessionId,
    sessionIds,
    includeChildSessions,
    counts: {
      sessions: sessions.length,
      messages: messages.length,
      transcriptRecords: transcriptRecords.length,
      checkpoints: checkpoints.length,
      toolResults: toolResults.length,
      runtimeEvents: runtimeEvents.length,
    },
  };
  return { manifest, sessions, messages, transcriptRecords, checkpoints, toolResults, runtimeEvents };
}

async function writeBundle(packagePath: string, bundle: RuntimeSessionArchiveBundle): Promise<void> {
  await fs.mkdir(packagePath, { recursive: true });
  await Promise.all([
    writeJson(path.join(packagePath, 'manifest.json'), bundle.manifest),
    fs.writeFile(path.join(packagePath, 'sessions.jsonl'), toJsonl(bundle.sessions), 'utf-8'),
    writeJson(path.join(packagePath, 'messages.json'), bundle.messages),
    fs.writeFile(path.join(packagePath, 'session-items.jsonl'), toJsonl([
      ...bundle.transcriptRecords.map((item) => ({ kind: 'transcript', item })),
      ...bundle.checkpoints.map((item) => ({ kind: 'checkpoint', item })),
      ...bundle.toolResults.map((item) => ({ kind: 'tool_result', item })),
      ...bundle.runtimeEvents.map((item) => ({ kind: 'runtime_event', item })),
    ]), 'utf-8'),
    fs.writeFile(path.join(packagePath, 'transcript-records.jsonl'), toJsonl(bundle.transcriptRecords), 'utf-8'),
    fs.writeFile(path.join(packagePath, 'transcript-file-entries.jsonl'), '', 'utf-8'),
    fs.writeFile(path.join(packagePath, 'checkpoints.jsonl'), toJsonl(bundle.checkpoints), 'utf-8'),
    fs.writeFile(path.join(packagePath, 'tool-results.jsonl'), toJsonl(bundle.toolResults), 'utf-8'),
    fs.writeFile(path.join(packagePath, 'runtime-events.jsonl'), toJsonl(bundle.runtimeEvents), 'utf-8'),
    writeJson(path.join(packagePath, 'bundle-messages.json'), bundle.messages),
  ]);
}

export async function exportRuntimeSession(input: {
  sessionId: string;
  includeChildSessions?: boolean;
  writePackage?: boolean;
}): Promise<Record<string, unknown>> {
  const sessionId = String(input.sessionId || '').trim();
  if (!sessionId) return { success: false, error: 'sessionId is required' };
  const includeChildSessions = Boolean(input.includeChildSessions);
  const bundle = buildBundle(sessionId, includeChildSessions);
  if (!bundle) return { success: false, error: '会话不存在' };
  if (input.writePackage === false) {
    return {
      success: true,
      ...bundle,
      messages: bundle.messages,
      transcriptRecords: bundle.transcriptRecords,
      checkpoints: bundle.checkpoints,
      toolResults: bundle.toolResults,
      runtimeEvents: bundle.runtimeEvents,
    };
  }

  const root = path.join(getWorkspaceRootForArchive(), '.redbox', 'runtime-exports');
  const packagePath = path.join(root, `${safeArchiveName(sessionId)}-${Date.now()}`);
  await writeBundle(packagePath, bundle);
  return {
    success: true,
    sessionId,
    packagePath,
    manifest: bundle.manifest,
    counts: bundle.manifest.counts,
  };
}

function getWorkspaceRootForArchive(): string {
  return getWorkspacePaths().base;
}

async function readBundle(packagePath: string): Promise<RuntimeSessionArchiveBundle> {
  const resolvedPath = path.resolve(String(packagePath || '').trim());
  const stat = await fs.stat(resolvedPath);
  if (!stat.isDirectory()) throw new Error('packagePath must point to a runtime export directory');
  const manifest = await readJson<RuntimeSessionArchiveManifest>(path.join(resolvedPath, 'manifest.json'));
  if (manifest?.format !== ARCHIVE_FORMAT || Number(manifest.version) !== ARCHIVE_VERSION) {
    throw new Error('unsupported runtime session package');
  }
  const sessions = parseJsonl<ChatSession>(await fs.readFile(path.join(resolvedPath, 'sessions.jsonl'), 'utf-8'), 'sessions.jsonl');
  const messages = await readJson<ChatMessage[]>(path.join(resolvedPath, 'messages.json'));
  const transcriptRecords = parseJsonl<SessionTranscriptRecord>(await fs.readFile(path.join(resolvedPath, 'transcript-records.jsonl'), 'utf-8'), 'transcript-records.jsonl');
  const checkpoints = parseJsonl<SessionCheckpointRecord>(await fs.readFile(path.join(resolvedPath, 'checkpoints.jsonl'), 'utf-8'), 'checkpoints.jsonl');
  const toolResults = parseJsonl<SessionToolResultRecord>(await fs.readFile(path.join(resolvedPath, 'tool-results.jsonl'), 'utf-8'), 'tool-results.jsonl');
  const runtimeEvents = parseJsonl<RuntimeEventRecord>(await fs.readFile(path.join(resolvedPath, 'runtime-events.jsonl'), 'utf-8'), 'runtime-events.jsonl');
  if (!Array.isArray(messages) || messages.length > MAX_ARCHIVE_ITEMS) throw new Error('messages.json contains too many records');
  return { manifest, sessions, messages, transcriptRecords, checkpoints, toolResults, runtimeEvents };
}

function assertBelongsToPackage(value: string | null | undefined, sessionIds: Set<string>, label: string): void {
  if (value && !sessionIds.has(value)) {
    throw new Error(`${label} references a session outside the package`);
  }
}

export async function importRuntimeSession(input: {
  packagePath: string;
  overwrite?: boolean;
}): Promise<Record<string, unknown>> {
  const packagePath = String(input.packagePath || '').trim();
  if (!packagePath) return { success: false, error: 'packagePath is required' };
  const bundle = await readBundle(packagePath);
  const sessionIds = new Set(bundle.manifest.sessionIds.map((value) => String(value || '').trim()).filter(Boolean));
  if (!sessionIds.has(bundle.manifest.sessionId) || !bundle.sessions.some((session) => session.id === bundle.manifest.sessionId)) {
    throw new Error('runtime package does not contain its root session');
  }
  for (const item of [...bundle.messages, ...bundle.transcriptRecords, ...bundle.checkpoints, ...bundle.toolResults, ...bundle.runtimeEvents]) {
    assertBelongsToPackage((item as { session_id?: string; sessionId?: string }).session_id || (item as { sessionId?: string }).sessionId, sessionIds, 'package record');
  }
  const existingIds = bundle.sessions.filter((session) => Boolean(getChatSession(session.id))).map((session) => session.id);
  if (existingIds.length > 0 && !input.overwrite) {
    return { success: false, error: '目标会话已存在，请开启 overwrite', existingSessionIds: existingIds };
  }
  if (input.overwrite) {
    for (const sessionId of existingIds) deleteChatSession(sessionId);
  }

  for (const session of bundle.sessions) {
    const metadata = parseMetadata(session.metadata);
    createChatSession(session.id, session.title, metadata, {
      created_at: session.created_at,
      updated_at: session.updated_at,
    });
  }
  for (const message of bundle.messages) {
    addChatMessage({
      id: message.id || nextId('message'),
      session_id: message.session_id,
      role: message.role,
      content: message.content,
      tool_calls: message.tool_calls,
      tool_call_id: message.tool_call_id,
      display_content: message.display_content,
      attachment: message.attachment,
      metadata: message.metadata,
      timestamp: message.timestamp,
    });
  }
  for (const record of bundle.transcriptRecords) {
    addSessionTranscriptRecord({
      id: record.id || nextId('transcript'),
      session_id: record.session_id,
      record_type: record.record_type,
      role: record.role,
      content: record.content,
      payload_json: record.payload_json,
      created_at: record.created_at,
    });
  }
  for (const record of bundle.checkpoints) {
    addSessionCheckpoint({
      id: record.id || nextId('checkpoint'),
      session_id: record.session_id,
      checkpoint_type: record.checkpoint_type,
      summary: record.summary,
      payload_json: record.payload_json,
      created_at: record.created_at,
    });
  }
  for (const record of bundle.toolResults) {
    addSessionToolResult({
      id: record.id || nextId('tool-result'),
      session_id: record.session_id,
      call_id: record.call_id,
      tool_name: record.tool_name,
      command: record.command,
      success: record.success,
      result_text: record.result_text,
      summary_text: record.summary_text,
      prompt_text: record.prompt_text,
      original_chars: record.original_chars,
      prompt_chars: record.prompt_chars,
      truncated: record.truncated,
      payload_json: record.payload_json,
      created_at: record.created_at,
      updated_at: record.updated_at,
    });
  }
  for (const record of bundle.runtimeEvents) {
    addRuntimeEvent({
      id: record.id || nextId('runtime-event'),
      category: record.category,
      event_type: record.event_type,
      session_id: record.session_id,
      runtime_id: record.runtime_id,
      parent_runtime_id: record.parent_runtime_id,
      source_task_id: record.source_task_id,
      task_id: record.task_id,
      tool_call_id: record.tool_call_id,
      project_id: record.project_id,
      payload_json: record.payload_json,
      created_at: record.created_at,
    });
  }
  return {
    success: true,
    sessionId: bundle.manifest.sessionId,
    importedSessionIds: bundle.sessions.map((session) => session.id),
    messageCount: bundle.messages.length,
    transcriptRecordCount: bundle.transcriptRecords.length,
    transcriptFileEntryCount: 0,
    checkpointCount: bundle.checkpoints.length,
    toolResultCount: bundle.toolResults.length,
    runtimeEventCount: bundle.runtimeEvents.length,
    bundleMessageCount: bundle.messages.length,
    overwritten: existingIds.length > 0,
  };
}
