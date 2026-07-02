import { EventEmitter } from 'events';
import fs from 'node:fs/promises';
import path from 'node:path';
import { app } from 'electron';
import { getChatMessages, getChatSession } from '../db';
import { getSessionBridgeService } from './sessionBridgeService';

type AcpRunStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';

type AcpClientInfo = {
  id?: string;
  name: string;
  kind: string;
};

type AcpRunRecord = {
  id: string;
  sessionId: string;
  client: AcpClientInfo;
  prompt: string;
  status: AcpRunStatus;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  error?: string;
  response?: string;
  artifactIds: string[];
  events: AcpRunEvent[];
};

type AcpRunEvent = {
  id: string;
  runId: string;
  sessionId: string;
  type: string;
  createdAt: string;
  payload: Record<string, unknown>;
};

type AcpArtifact = {
  id: string;
  runId: string;
  sessionId: string;
  type: 'text_response' | 'structured_response';
  label: string;
  content: string;
  createdAt: string;
};

type AcpHttpResult = {
  handled: boolean;
  statusCode: number;
  payload: Record<string, unknown> | null;
};

const ACP_BASE_PATH = '/acp/v1';
const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 31937;
const MAX_BODY_BYTES = 2 * 1024 * 1024;

const nowIso = () => new Date().toISOString();
const nextId = (prefix: string) => `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

function normalizePath(rawPath: string): string {
  const pathOnly = String(rawPath || '/').split('?')[0]?.split('#')[0] || '/';
  const withLeading = pathOnly.startsWith('/') ? pathOnly : `/${pathOnly}`;
  return withLeading.length > 1 ? withLeading.replace(/\/+$/, '') : withLeading;
}

function parseQuery(rawPath: string): URLSearchParams {
  return new URL(rawPath || '/', 'http://127.0.0.1').searchParams;
}

function cleanString(value: unknown): string {
  return String(value || '').trim();
}

function readClient(payload: Record<string, unknown>): AcpClientInfo {
  const rawClient = payload.client && typeof payload.client === 'object' && !Array.isArray(payload.client)
    ? payload.client as Record<string, unknown>
    : {};
  return {
    id: cleanString(rawClient.id) || undefined,
    name: cleanString(rawClient.name) || cleanString(payload.clientName) || 'External Agent',
    kind: cleanString(rawClient.kind) || cleanString(payload.clientKind) || 'agent',
  };
}

function extractPrompt(payload: Record<string, unknown>): string {
  const direct = cleanString(payload.prompt)
    || cleanString(payload.message)
    || cleanString(payload.content)
    || cleanString(payload.text);
  if (direct) return direct;
  const message = payload.message && typeof payload.message === 'object' && !Array.isArray(payload.message)
    ? payload.message as Record<string, unknown>
    : {};
  return cleanString(message.content);
}

function extractSessionId(payload: Record<string, unknown>): string {
  const direct = cleanString(payload.sessionId) || cleanString(payload.acpSessionId);
  if (direct) return direct;
  const attachTo = payload.attachTo && typeof payload.attachTo === 'object' && !Array.isArray(payload.attachTo)
    ? payload.attachTo as Record<string, unknown>
    : {};
  const attachType = cleanString(attachTo.type);
  if (attachType === 'chat_session' || attachType === 'runtime_session' || attachType === 'acp_session') {
    return cleanString(attachTo.id);
  }
  return '';
}

function summarizeSession(sessionId: string) {
  const session = getChatSession(sessionId);
  if (!session) return null;
  let metadata: Record<string, unknown> = {};
  if (session.metadata) {
    try {
      metadata = JSON.parse(session.metadata) as Record<string, unknown>;
    } catch {
      metadata = {};
    }
  }
  return {
    id: session.id,
    title: session.title,
    createdAt: session.created_at,
    updatedAt: session.updated_at,
    metadata,
    messages: getChatMessages(sessionId).slice(-20).map((message) => ({
      id: message.id,
      role: message.role,
      content: message.content,
      timestamp: message.timestamp,
    })),
  };
}

async function readJsonBody(req: NodeJS.ReadableStream): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > MAX_BODY_BYTES) {
      throw new Error('Request body too large');
    }
    chunks.push(buffer);
  }
  if (!chunks.length) return {};
  const raw = Buffer.concat(chunks).toString('utf-8').trim();
  if (!raw) return {};
  const parsed = JSON.parse(raw) as unknown;
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? parsed as Record<string, unknown>
    : {};
}

export class AcpGatewayService extends EventEmitter {
  private host = DEFAULT_HOST;
  private port = DEFAULT_PORT;
  private enabled = false;
  private readonly runs = new Map<string, AcpRunRecord>();
  private readonly artifacts = new Map<string, AcpArtifact>();

  constructor() {
    super();
    getSessionBridgeService().on('session-message', (event) => {
      this.handleSessionBridgeEvent(event as { sessionId?: string; message?: unknown });
    });
  }

  isAcpPath(rawPath: string): boolean {
    const normalized = normalizePath(rawPath);
    return normalized === '/.well-known/redbox-agent.json'
      || normalized === ACP_BASE_PATH
      || normalized.startsWith(`${ACP_BASE_PATH}/`);
  }

  setEndpoint(input: { host?: string; port?: number; enabled?: boolean }) {
    this.host = cleanString(input.host) || this.host;
    const port = Number(input.port);
    if (Number.isFinite(port) && port > 0) {
      this.port = Math.round(port);
    }
    if (input.enabled !== undefined) {
      this.enabled = Boolean(input.enabled);
    }
  }

  getBaseUrl(): string {
    return `http://${this.host || DEFAULT_HOST}:${this.port || DEFAULT_PORT}`;
  }

  getDiscoveryFilePaths(): string[] {
    const userData = app.getPath('userData');
    const parent = path.dirname(userData);
    return Array.from(new Set([
      path.join(userData, 'acp-gateway.json'),
      path.join(parent, 'RedBox', 'acp-gateway.json'),
    ]));
  }

  getManifest() {
    const baseUrl = this.getBaseUrl();
    return {
      schemaVersion: 'redbox.acp.v1',
      agent: {
        id: 'redbox.creator-agent',
        name: 'RedBox Creator Agent',
        description: 'A local creator agent for self-media assets, material retrieval, drafting, cover/video planning, and creator project packaging.',
        home: baseUrl,
        localOnly: true,
        enabled: this.enabled,
      },
      protocol: {
        kind: 'agent-communication',
        version: 'v1',
        baseUrl,
        auth: {
          required: false,
          schemes: ['Bearer', 'X-Auth-Token'],
        },
      },
      capabilities: [
        'conversation.session.auto_create',
        'conversation.message.inbound',
        'run.async',
        'run.cancel',
        'events.audit_stream',
        'artifacts.text_response',
        'materials.media_library_context',
        'creator.draft_and_plan',
      ],
      endpoints: {
        manifest: `${baseUrl}${ACP_BASE_PATH}/manifest`,
        wellKnown: `${baseUrl}/.well-known/redbox-agent.json`,
        guide: `${baseUrl}${ACP_BASE_PATH}/guide`,
        sessions: `${baseUrl}${ACP_BASE_PATH}/sessions`,
        runs: `${baseUrl}${ACP_BASE_PATH}/runs`,
        artifacts: `${baseUrl}${ACP_BASE_PATH}/artifacts/{artifact_id}`,
      },
      sessionRouting: {
        autoCreate: 'Omit sessionId/acpSessionId to create a new ACP-labeled RedBox conversation.',
        explicitAttach: 'Pass sessionId/acpSessionId to continue an existing ACP or chat session.',
        chatProjection: 'Every ACP run is projected into the Electron chat history through SessionBridgeService.',
      },
    };
  }

  getGuide() {
    return {
      success: true,
      contentType: 'text/markdown',
      guide: [
        '# RedBox ACP Guide',
        '',
        'RedBox exposes a local Agent Communication Protocol for external agents that need a creator-side material library and content production partner.',
        '',
        `Base URL: \`${this.getBaseUrl()}\``,
        '',
        '## Discover',
        '',
        '- `GET /.well-known/redbox-agent.json`',
        '- `GET /acp/v1/manifest`',
        '- `GET /acp/v1/guide`',
        '',
        'Preferred local discovery file: `acp-gateway.json` under the RedBox application support directory.',
        '',
        '## Start A Run',
        '',
        '```json',
        `POST ${ACP_BASE_PATH}/runs`,
        '{',
        '  "client": { "name": "Codex", "kind": "coding_agent" },',
        '  "prompt": "Find reusable material refs and draft a short video outline."',
        '}',
        '```',
        '',
        'Poll `GET /acp/v1/runs/{run_id}` and `GET /acp/v1/runs/{run_id}/events` until the run is completed, failed, or cancelled.',
      ].join('\n'),
      copyPrompts: {
        codex: 'Read RedBox acp-gateway.json when available, then read manifestUrl and guideUrl. Use /acp/v1/runs to talk to RedBox Creator Agent. Set client.name=Codex.',
        generic: 'Discover RedBox from acp-gateway.json or http://127.0.0.1:31937/acp/v1, then POST /acp/v1/runs with client.name and prompt.',
      },
    };
  }

  async refreshDiscoveryFile(input: { host?: string; port?: number; enabled?: boolean; listening?: boolean }) {
    this.setEndpoint(input);
    const baseUrl = this.getBaseUrl();
    const payload = {
      schemaVersion: 'redbox.acp.discovery.v1',
      product: 'RedBox',
      agentId: 'redbox.creator-agent',
      enabled: this.enabled,
      listening: Boolean(input.listening),
      baseUrl,
      manifestUrl: `${baseUrl}${ACP_BASE_PATH}/manifest`,
      guideUrl: `${baseUrl}${ACP_BASE_PATH}/guide`,
      endpointUrl: `${baseUrl}${ACP_BASE_PATH}`,
      updatedAt: nowIso(),
      pid: process.pid,
    };
    const targets = this.getDiscoveryFilePaths();
    await Promise.all(targets.map(async (target) => {
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, JSON.stringify(payload, null, 2), 'utf-8');
    }));
  }

  async handleHttpRequest(req: NodeJS.ReadableStream & { method?: string; url?: string }, res: { statusCode: number; setHeader(name: string, value: string): void; end(body?: string): void }): Promise<boolean> {
    const result = await this.resolveHttpRequest(req);
    if (!result.handled) {
      return false;
    }
    res.statusCode = result.statusCode;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(result.payload === null ? '' : JSON.stringify(result.payload));
    return true;
  }

  private async resolveHttpRequest(req: NodeJS.ReadableStream & { method?: string; url?: string }): Promise<AcpHttpResult> {
    const method = cleanString(req.method || 'GET').toUpperCase();
    const rawPath = req.url || '/';
    if (!this.isAcpPath(rawPath)) {
      return { handled: false, statusCode: 404, payload: null };
    }

    const pathname = normalizePath(rawPath);
    const segments = pathname.split('/').filter(Boolean);

    try {
      if (method === 'OPTIONS') {
        return { handled: true, statusCode: 204, payload: null };
      }
      if (method === 'GET' && (pathname === '/.well-known/redbox-agent.json' || pathname === ACP_BASE_PATH || pathname === `${ACP_BASE_PATH}/manifest`)) {
        return { handled: true, statusCode: 200, payload: this.getManifest() };
      }
      if (method === 'GET' && pathname === `${ACP_BASE_PATH}/guide`) {
        return { handled: true, statusCode: 200, payload: this.getGuide() };
      }
      if (method === 'POST' && pathname === `${ACP_BASE_PATH}/sessions`) {
        return { handled: true, statusCode: 201, payload: { success: true, session: await this.createSession(await readJsonBody(req)) } };
      }
      if (method === 'GET' && segments.length === 4 && segments[0] === 'acp' && segments[1] === 'v1' && segments[2] === 'sessions') {
        const session = summarizeSession(decodeURIComponent(segments[3] || ''));
        return session
          ? { handled: true, statusCode: 200, payload: { success: true, session } }
          : { handled: true, statusCode: 404, payload: { success: false, error: 'session_not_found' } };
      }
      if (method === 'POST' && segments.length === 5 && segments[0] === 'acp' && segments[1] === 'v1' && segments[2] === 'sessions' && segments[4] === 'messages') {
        const sessionId = decodeURIComponent(segments[3] || '');
        const payload = await readJsonBody(req);
        const prompt = extractPrompt(payload);
        if (!prompt) {
          return { handled: true, statusCode: 400, payload: { success: false, error: 'prompt_required' } };
        }
        return {
          handled: true,
          statusCode: 202,
          payload: {
            success: true,
            result: await getSessionBridgeService().sendSessionMessage(sessionId, prompt),
          },
        };
      }
      if (method === 'POST' && pathname === `${ACP_BASE_PATH}/runs`) {
        return { handled: true, statusCode: 202, payload: { success: true, run: await this.createRun(await readJsonBody(req)) } };
      }
      if (method === 'GET' && segments.length === 4 && segments[0] === 'acp' && segments[1] === 'v1' && segments[2] === 'runs') {
        return this.getRunResponse(decodeURIComponent(segments[3] || ''));
      }
      if (method === 'GET' && segments.length === 5 && segments[0] === 'acp' && segments[1] === 'v1' && segments[2] === 'runs' && segments[4] === 'events') {
        return this.getRunEventsResponse(decodeURIComponent(segments[3] || ''), rawPath);
      }
      if (method === 'POST' && segments.length === 5 && segments[0] === 'acp' && segments[1] === 'v1' && segments[2] === 'runs' && segments[4] === 'cancel') {
        return this.cancelRunResponse(decodeURIComponent(segments[3] || ''));
      }
      if (method === 'GET' && segments.length === 4 && segments[0] === 'acp' && segments[1] === 'v1' && segments[2] === 'artifacts') {
        return this.getArtifactResponse(decodeURIComponent(segments[3] || ''));
      }
      return { handled: true, statusCode: 404, payload: { success: false, error: 'not_found' } };
    } catch (error) {
      return {
        handled: true,
        statusCode: 500,
        payload: {
          success: false,
          error: error instanceof Error ? error.message : String(error),
        },
      };
    }
  }

  private async createSession(payload: Record<string, unknown>) {
    const client = readClient(payload);
    const title = cleanString(payload.title) || cleanString(payload.objective) || `${client.name} ACP Session`;
    const session = await getSessionBridgeService().createSession({
      title,
      contextType: 'redclaw',
      runtimeMode: 'redclaw',
      metadata: {
        source: 'acp',
        sourceLabel: client.name,
        senderKind: 'external_agent',
        client,
        objective: cleanString(payload.objective) || undefined,
      },
    });
    return session;
  }

  private async createRun(payload: Record<string, unknown>) {
    const prompt = extractPrompt(payload);
    if (!prompt) {
      throw new Error('prompt is required');
    }
    const client = readClient(payload);
    let sessionId = extractSessionId(payload);
    if (!sessionId) {
      const session = await this.createSession(payload);
      sessionId = session.id;
    } else if (!getChatSession(sessionId)) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    const run: AcpRunRecord = {
      id: nextId('acp_run'),
      sessionId,
      client,
      prompt,
      status: 'running',
      createdAt: nowIso(),
      updatedAt: nowIso(),
      artifactIds: [],
      events: [],
    };
    this.runs.set(run.id, run);
    this.addRunEvent(run, 'run.created', { client, promptPreview: prompt.slice(0, 240) });
    void getSessionBridgeService().sendSessionMessage(sessionId, prompt).catch((error) => {
      this.failRun(run.id, error instanceof Error ? error.message : String(error));
    });
    return this.publicRunValue(run);
  }

  private publicRunValue(run: AcpRunRecord) {
    return {
      id: run.id,
      sessionId: run.sessionId,
      client: run.client,
      status: run.status,
      createdAt: run.createdAt,
      updatedAt: run.updatedAt,
      completedAt: run.completedAt,
      error: run.error,
      artifactRefs: run.artifactIds.map((id) => ({
        id,
        url: `${this.getBaseUrl()}${ACP_BASE_PATH}/artifacts/${encodeURIComponent(id)}`,
      })),
      responsePreview: run.response ? run.response.slice(0, 500) : undefined,
    };
  }

  private getRunResponse(runId: string): AcpHttpResult {
    const run = this.runs.get(runId);
    return run
      ? { handled: true, statusCode: 200, payload: { success: true, run: this.publicRunValue(run) } }
      : { handled: true, statusCode: 404, payload: { success: false, error: 'run_not_found' } };
  }

  private getRunEventsResponse(runId: string, rawPath: string): AcpHttpResult {
    const run = this.runs.get(runId);
    if (!run) {
      return { handled: true, statusCode: 404, payload: { success: false, error: 'run_not_found' } };
    }
    const params = parseQuery(rawPath);
    const cursor = cleanString(params.get('cursor'));
    const limit = Math.max(1, Math.min(500, Number(params.get('limit') || 100)));
    const startIndex = cursor
      ? Math.max(0, run.events.findIndex((event) => event.id === cursor) + 1)
      : 0;
    const events = run.events.slice(startIndex, startIndex + limit);
    const last = events[events.length - 1];
    return {
      handled: true,
      statusCode: 200,
      payload: {
        success: true,
        runId,
        sessionId: run.sessionId,
        cursor: cursor || null,
        limit,
        nextCursor: last?.id || null,
        hasMore: startIndex + limit < run.events.length,
        events,
      },
    };
  }

  private cancelRunResponse(runId: string): AcpHttpResult {
    const run = this.runs.get(runId);
    if (!run) {
      return { handled: true, statusCode: 404, payload: { success: false, error: 'run_not_found' } };
    }
    if (run.status === 'running' || run.status === 'queued') {
      run.status = 'cancelled';
      run.updatedAt = nowIso();
      run.completedAt = run.updatedAt;
      this.addRunEvent(run, 'run.cancelled', {});
    }
    return { handled: true, statusCode: 200, payload: { success: true, run: this.publicRunValue(run) } };
  }

  private getArtifactResponse(artifactId: string): AcpHttpResult {
    const artifact = this.artifacts.get(artifactId);
    return artifact
      ? { handled: true, statusCode: 200, payload: { success: true, artifact } }
      : { handled: true, statusCode: 404, payload: { success: false, error: 'artifact_not_found' } };
  }

  private handleSessionBridgeEvent(event: { sessionId?: string; message?: unknown }) {
    const sessionId = cleanString(event.sessionId);
    if (!sessionId) return;
    const run = Array.from(this.runs.values())
      .reverse()
      .find((candidate) => candidate.sessionId === sessionId && (candidate.status === 'running' || candidate.status === 'queued'));
    if (!run) return;
    const message = event.message && typeof event.message === 'object'
      ? event.message as { type?: string; payload?: unknown }
      : {};
    const payload = message.payload && typeof message.payload === 'object' && !Array.isArray(message.payload)
      ? message.payload as Record<string, unknown>
      : {};
    this.addRunEvent(run, cleanString(message.type) || 'session.event', payload);
    if (message.type !== 'bridge_event') return;
    const channel = cleanString(payload.channel);
    const data = payload.data && typeof payload.data === 'object' && !Array.isArray(payload.data)
      ? payload.data as Record<string, unknown>
      : {};
    if (channel === 'chat:response-end') {
      this.completeRun(run.id, cleanString(data.content));
    } else if (channel === 'chat:error' || channel === 'bridge:message:error') {
      this.failRun(run.id, cleanString(data.message) || cleanString(data.error) || 'run failed');
    }
  }

  private completeRun(runId: string, response: string) {
    const run = this.runs.get(runId);
    if (!run || run.status !== 'running') return;
    const artifact: AcpArtifact = {
      id: nextId('acp_artifact'),
      runId,
      sessionId: run.sessionId,
      type: 'text_response',
      label: 'Assistant response',
      content: response,
      createdAt: nowIso(),
    };
    this.artifacts.set(artifact.id, artifact);
    run.response = response;
    run.artifactIds.push(artifact.id);
    run.status = 'completed';
    run.updatedAt = nowIso();
    run.completedAt = run.updatedAt;
    this.addRunEvent(run, 'run.completed', { artifactId: artifact.id, responsePreview: response.slice(0, 500) });
  }

  private failRun(runId: string, error: string) {
    const run = this.runs.get(runId);
    if (!run || run.status !== 'running') return;
    run.status = 'failed';
    run.error = error;
    run.updatedAt = nowIso();
    run.completedAt = run.updatedAt;
    this.addRunEvent(run, 'run.failed', { error });
  }

  private addRunEvent(run: AcpRunRecord, type: string, payload: Record<string, unknown>) {
    const event: AcpRunEvent = {
      id: nextId('acp_event'),
      runId: run.id,
      sessionId: run.sessionId,
      type,
      createdAt: nowIso(),
      payload,
    };
    run.events.push(event);
    run.updatedAt = event.createdAt;
    this.emit('run-event', event);
  }
}

let acpGatewayService: AcpGatewayService | null = null;

export function getAcpGatewayService(): AcpGatewayService {
  if (!acpGatewayService) {
    acpGatewayService = new AcpGatewayService();
  }
  return acpGatewayService;
}
