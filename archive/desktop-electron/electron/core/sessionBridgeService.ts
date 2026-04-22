import { EventEmitter } from 'events';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { URL } from 'node:url';
import { WebSocketServer, type WebSocket } from 'ws';
import {
  createChatSession,
  getChatSession,
  getChatSessions,
  type ChatSession,
} from '../db';
import { PiChatService } from '../pi/PiChatService';
import { getBackgroundTaskRegistry, type BackgroundTaskRecord } from './backgroundTaskRegistry';
import { getSessionRuntimeStore } from './sessionRuntimeStore';
import { getTaskGraphRuntime } from './ai/taskGraphRuntime';
import { getToolResultStore } from './toolResultStore';
import {
  ToolConfirmationOutcome,
  type ToolConfirmationDetails,
} from './toolRegistry';

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 31957;
const SNAPSHOT_TRANSCRIPT_LIMIT = 200;
const SNAPSHOT_CHECKPOINT_LIMIT = 100;
const SNAPSHOT_TOOL_RESULT_LIMIT = 100;

type SessionBridgeMessage =
  | { type: 'session_snapshot'; payload: Awaited<ReturnType<SessionBridgeService['getSessionSnapshot']>> }
  | { type: 'transcript'; payload: unknown }
  | { type: 'checkpoint'; payload: unknown }
  | { type: 'tool_result'; payload: unknown }
  | { type: 'background_task'; payload: BackgroundTaskRecord }
  | { type: 'permission_request'; payload: SessionBridgePermissionRequest }
  | { type: 'permission_resolved'; payload: SessionBridgePermissionRequest }
  | { type: 'bridge_event'; payload: Record<string, unknown> };

export type SessionBridgeSessionSummary = {
  id: string;
  title: string;
  updatedAt: number;
  createdAt: number;
  contextType: string;
  runtimeMode: string;
  isBackgroundSession: boolean;
  ownerTaskCount: number;
  backgroundTaskCount: number;
};

export type SessionBridgeStatus = {
  enabled: boolean;
  listening: boolean;
  host: string;
  port: number;
  authToken: string;
  websocketUrl: string;
  httpBaseUrl: string;
  subscriberCount: number;
  lastError: string | null;
};

export type SessionBridgePermissionRequest = {
  id: string;
  sessionId: string;
  callId: string;
  toolName: string;
  params: Record<string, unknown>;
  details: ToolConfirmationDetails;
  createdAt: number;
  resolvedAt?: number;
  status: 'pending' | 'approved_once' | 'approved_always' | 'cancelled';
  decision?: ToolConfirmationOutcome;
};

type PendingPermissionRequest = {
  request: SessionBridgePermissionRequest;
  resolve: (outcome: ToolConfirmationOutcome) => void;
};

function parseSessionMetadata(session: ChatSession): Record<string, unknown> {
  if (!session.metadata) return {};
  try {
    return JSON.parse(session.metadata) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function previewError(error: unknown): string {
  return error instanceof Error ? error.message : String(error || 'unknown error');
}

async function readJsonBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  if (!chunks.length) return {};
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // ignore
  }
  return {};
}

function sendJson(res: http.ServerResponse, statusCode: number, payload: Record<string, unknown>): void {
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(payload));
}

export class SessionBridgeService extends EventEmitter {
  private server: http.Server | null = null;
  private wsServer: WebSocketServer | null = null;
  private readonly subscribers = new Map<string, Set<WebSocket>>();
  private readonly bridgeChatServices = new Map<string, PiChatService>();
  private readonly pendingPermissionRequests = new Map<string, PendingPermissionRequest>();
  private readonly authToken = randomUUID();
  private host = DEFAULT_HOST;
  private port = DEFAULT_PORT;
  private listening = false;
  private lastError: string | null = null;
  private detachFns: Array<() => void> = [];

  getStatus(): SessionBridgeStatus {
    return {
      enabled: true,
      listening: this.listening,
      host: this.host,
      port: this.port,
      authToken: this.authToken,
      websocketUrl: `ws://${this.host}:${this.port}/bridge/sessions/{sessionId}/stream?token=${this.authToken}`,
      httpBaseUrl: `http://${this.host}:${this.port}`,
      subscriberCount: Array.from(this.subscribers.values()).reduce((count, set) => count + set.size, 0),
      lastError: this.lastError,
    };
  }

  async start(): Promise<void> {
    if (this.server && this.listening) {
      return;
    }

    this.server = http.createServer((req, res) => {
      void this.handleRequest(req, res).catch((error) => {
        this.lastError = previewError(error);
        sendJson(res, 500, { success: false, error: this.lastError });
      });
    });
    this.wsServer = new WebSocketServer({ noServer: true });
    this.server.on('upgrade', (req, socket, head) => {
      const wsServer = this.wsServer;
      if (!wsServer) {
        socket.destroy();
        return;
      }
      const parsed = new URL(req.url || '/', `http://${this.host}:${this.port}`);
      const match = parsed.pathname.match(/^\/bridge\/sessions\/([^/]+)\/stream$/);
      if (!match || !this.authorizeRequest(req, parsed)) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }
      const sessionId = decodeURIComponent(match[1] || '').trim();
      if (!sessionId) {
        socket.destroy();
        return;
      }
      wsServer.handleUpgrade(req, socket, head, (ws) => {
        wsServer.emit('connection', ws, req, sessionId);
      });
    });

    this.wsServer.on('connection', (ws: WebSocket, _req: http.IncomingMessage, sessionId: string) => {
      this.addSubscriber(sessionId, ws);
      void this.getSessionSnapshot(sessionId)
        .then((snapshot) => this.sendMessage(ws, { type: 'session_snapshot', payload: snapshot }))
        .catch((error) => {
          this.sendMessage(ws, {
            type: 'bridge_event',
            payload: { level: 'error', message: previewError(error) },
          });
        });
      ws.on('close', () => {
        this.removeSubscriber(sessionId, ws);
      });
    });

    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        this.lastError = previewError(error);
        reject(error);
      };
      this.server?.once('error', onError);
      this.server?.listen(this.port, this.host, () => {
        this.server?.off('error', onError);
        this.listening = true;
        this.attachRuntimeListeners();
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    for (const detach of this.detachFns.splice(0)) {
      detach();
    }
    for (const service of this.bridgeChatServices.values()) {
      service.abort();
      service.setEventSink(null);
    }
    this.bridgeChatServices.clear();
    for (const sockets of this.subscribers.values()) {
      for (const socket of sockets) {
        try {
          socket.close();
        } catch {
          // ignore
        }
      }
    }
    this.subscribers.clear();
    await new Promise<void>((resolve) => {
      this.wsServer?.close(() => resolve());
      if (!this.wsServer) resolve();
    });
    this.wsServer = null;
    await new Promise<void>((resolve) => {
      this.server?.close(() => resolve());
      if (!this.server) resolve();
    });
    this.server = null;
    this.listening = false;
  }

  listSessions(): SessionBridgeSessionSummary[] {
    return getChatSessions().map((session) => {
      const metadata = parseSessionMetadata(session);
      return {
        id: session.id,
        title: session.title,
        updatedAt: session.updated_at,
        createdAt: session.created_at,
        contextType: String(metadata.contextType || '').trim() || 'chat',
        runtimeMode: String(metadata.runtimeMode || '').trim() || 'redclaw',
        isBackgroundSession: Boolean(metadata.isBackgroundSession),
        ownerTaskCount: getTaskGraphRuntime().listTasks({ ownerSessionId: session.id, limit: 100 }).length,
        backgroundTaskCount: 0,
      };
    });
  }

  async getSessionSnapshot(sessionId: string) {
    const session = getChatSession(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    const allBackgroundTasks = await getBackgroundTaskRegistry().listTasks();
    const backgroundTasks = allBackgroundTasks.filter((task) => task.sessionId === sessionId);
    const summary = this.listSessions().find((item) => item.id === sessionId) || {
      id: session.id,
      title: session.title,
      updatedAt: session.updated_at,
      createdAt: session.created_at,
      contextType: 'chat',
      runtimeMode: 'redclaw',
      isBackgroundSession: false,
      ownerTaskCount: 0,
      backgroundTaskCount: backgroundTasks.length,
    };
    return {
      session: {
        ...summary,
        backgroundTaskCount: backgroundTasks.length,
        metadata: parseSessionMetadata(session),
      },
      transcript: getSessionRuntimeStore().listTranscript(sessionId, SNAPSHOT_TRANSCRIPT_LIMIT),
      checkpoints: getSessionRuntimeStore().listCheckpoints(sessionId, SNAPSHOT_CHECKPOINT_LIMIT),
      toolResults: getSessionRuntimeStore().listToolResults(sessionId, SNAPSHOT_TOOL_RESULT_LIMIT),
      tasks: getTaskGraphRuntime().listTasks({ ownerSessionId: sessionId, limit: 100 }),
      backgroundTasks,
      permissionRequests: this.listPermissionRequests(sessionId),
    };
  }

  listPermissionRequests(sessionId?: string): SessionBridgePermissionRequest[] {
    const normalizedSessionId = String(sessionId || '').trim();
    return Array.from(this.pendingPermissionRequests.values())
      .map((entry) => entry.request)
      .filter((request) => !normalizedSessionId || request.sessionId === normalizedSessionId)
      .sort((left, right) => left.createdAt - right.createdAt);
  }

  resolvePermissionRequest(
    requestId: string,
    outcome: ToolConfirmationOutcome,
  ): { success: boolean; request?: SessionBridgePermissionRequest; error?: string } {
    const pending = this.pendingPermissionRequests.get(requestId);
    if (!pending) {
      return { success: false, error: 'permission request not found' };
    }
    const resolvedAt = Date.now();
    const request = pending.request;
    request.resolvedAt = resolvedAt;
    request.decision = outcome;
    request.status = outcome === ToolConfirmationOutcome.ProceedAlways
      ? 'approved_always'
      : outcome === ToolConfirmationOutcome.ProceedOnce
        ? 'approved_once'
        : 'cancelled';
    this.pendingPermissionRequests.delete(requestId);
    pending.resolve(outcome);
    this.broadcast(request.sessionId, {
      type: 'permission_resolved',
      payload: request,
    });
    return { success: true, request };
  }

  async createSession(input?: {
    title?: string;
    contextType?: string;
    runtimeMode?: string;
    metadata?: Record<string, unknown>;
  }): Promise<SessionBridgeSessionSummary> {
    const sessionId = `session_bridge_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    createChatSession(sessionId, String(input?.title || 'Bridge Session'), {
      contextType: String(input?.contextType || 'redclaw'),
      runtimeMode: String(input?.runtimeMode || 'redclaw'),
      createdBy: 'session-bridge',
      ...(input?.metadata || {}),
    });
    return this.listSessions().find((item) => item.id === sessionId)!;
  }

  async sendSessionMessage(sessionId: string, message: string): Promise<{ accepted: boolean; sessionId: string }> {
    const trimmed = String(message || '').trim();
    if (!trimmed) {
      throw new Error('message is required');
    }
    const session = getChatSession(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    let service = this.bridgeChatServices.get(sessionId);
    if (!service) {
      service = new PiChatService({
        onToolConfirmationRequest: (callId, tool, params, details) =>
          this.handlePermissionRequest(sessionId, callId, tool.name, params, details),
      });
      service.setEventSink((channel, data) => {
        this.broadcast(sessionId, {
          type: 'bridge_event',
          payload: {
            channel,
            data,
          },
        });
      });
      this.bridgeChatServices.set(sessionId, service);
    }
    this.broadcast(sessionId, {
      type: 'bridge_event',
      payload: {
        channel: 'bridge:message:accepted',
        data: { sessionId, preview: trimmed.slice(0, 160) },
      },
    });
    void service.sendMessage(trimmed, sessionId).catch((error) => {
      this.broadcast(sessionId, {
        type: 'bridge_event',
        payload: {
          channel: 'bridge:message:error',
          data: { sessionId, error: previewError(error) },
        },
      });
    });
    return { accepted: true, sessionId };
  }

  private async handlePermissionRequest(
    sessionId: string,
    callId: string,
    toolName: string,
    params: unknown,
    details: ToolConfirmationDetails,
  ): Promise<ToolConfirmationOutcome> {
    const request: SessionBridgePermissionRequest = {
      id: `perm_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      sessionId,
      callId,
      toolName,
      params: params && typeof params === 'object' && !Array.isArray(params)
        ? params as Record<string, unknown>
        : {},
      details,
      createdAt: Date.now(),
      status: 'pending',
    };
    return new Promise<ToolConfirmationOutcome>((resolve) => {
      this.pendingPermissionRequests.set(request.id, {
        request,
        resolve,
      });
      this.broadcast(sessionId, {
        type: 'permission_request',
        payload: request,
      });
      this.broadcast(sessionId, {
        type: 'bridge_event',
        payload: {
          channel: 'bridge:permission:requested',
          data: {
            requestId: request.id,
            callId,
            toolName,
          },
        },
      });
      setTimeout(() => {
        if (!this.pendingPermissionRequests.has(request.id)) {
          return;
        }
        this.resolvePermissionRequest(request.id, ToolConfirmationOutcome.Cancel);
      }, 60000);
    });
  }

  private attachRuntimeListeners(): void {
    if (this.detachFns.length > 0) {
      return;
    }
    const backgroundTaskHandler = (task: BackgroundTaskRecord) => {
      if (!task?.sessionId) return;
      this.broadcast(task.sessionId, { type: 'background_task', payload: task });
    };
    getBackgroundTaskRegistry().on('task-updated', backgroundTaskHandler);
    this.detachFns.push(
      getSessionRuntimeStore().on('transcript-appended', (payload: any) => {
        const sessionId = String(payload?.sessionId || '').trim();
        if (!sessionId) return;
        this.broadcast(sessionId, { type: 'transcript', payload });
      }),
      getSessionRuntimeStore().on('checkpoint-added', (payload: any) => {
        const sessionId = String(payload?.sessionId || '').trim();
        if (!sessionId) return;
        this.broadcast(sessionId, { type: 'checkpoint', payload });
      }),
      getToolResultStore().on('tool-result-added', (payload) => {
        const sessionId = String(payload?.sessionId || '').trim();
        if (!sessionId) return;
        this.broadcast(sessionId, { type: 'tool_result', payload });
      }),
      getToolResultStore().on('tool-result-updated', (payload) => {
        const sessionId = String(payload?.sessionId || '').trim();
        if (!sessionId) return;
        this.broadcast(sessionId, { type: 'tool_result', payload });
      }),
      () => {
        getBackgroundTaskRegistry().off('task-updated', backgroundTaskHandler);
      },
    );
  }

  private addSubscriber(sessionId: string, ws: WebSocket): void {
    const current = this.subscribers.get(sessionId) || new Set<WebSocket>();
    current.add(ws);
    this.subscribers.set(sessionId, current);
  }

  private removeSubscriber(sessionId: string, ws: WebSocket): void {
    const current = this.subscribers.get(sessionId);
    if (!current) return;
    current.delete(ws);
    if (!current.size) {
      this.subscribers.delete(sessionId);
    }
  }

  private sendMessage(ws: WebSocket, message: SessionBridgeMessage): void {
    if (ws.readyState !== 1) {
      return;
    }
    ws.send(JSON.stringify(message));
  }

  private broadcast(sessionId: string, message: SessionBridgeMessage): void {
    const subscribers = this.subscribers.get(sessionId);
    if (!subscribers?.size) return;
    for (const ws of subscribers) {
      this.sendMessage(ws, message);
    }
  }

  private authorizeRequest(req: http.IncomingMessage, parsed: URL): boolean {
    const bearer = String(req.headers.authorization || '').trim();
    if (bearer === `Bearer ${this.authToken}`) {
      return true;
    }
    const token = String(parsed.searchParams.get('token') || '').trim();
    return token === this.authToken;
  }

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const method = String(req.method || 'GET').toUpperCase();
    const parsed = new URL(req.url || '/', `http://${this.host}:${this.port}`);
    if (!this.authorizeRequest(req, parsed) && parsed.pathname !== '/health') {
      sendJson(res, 401, { success: false, error: 'unauthorized' });
      return;
    }
    if (method === 'GET' && parsed.pathname === '/health') {
      sendJson(res, 200, { success: true, status: this.getStatus() });
      return;
    }
    if (method === 'GET' && parsed.pathname === '/sessions') {
      const sessions = this.listSessions();
      const allBackgroundTasks = await getBackgroundTaskRegistry().listTasks();
      const backgroundTaskCounts = new Map<string, number>();
      for (const task of allBackgroundTasks) {
        if (!task.sessionId) continue;
        backgroundTaskCounts.set(task.sessionId, (backgroundTaskCounts.get(task.sessionId) || 0) + 1);
      }
      sendJson(res, 200, {
        success: true,
        sessions: sessions.map((session) => ({
          ...session,
          backgroundTaskCount: backgroundTaskCounts.get(session.id) || 0,
        })),
      });
      return;
    }
    if (method === 'GET' && parsed.pathname === '/permissions') {
      sendJson(res, 200, {
        success: true,
        permissions: this.listPermissionRequests(String(parsed.searchParams.get('sessionId') || '').trim() || undefined),
      });
      return;
    }
    const sessionMatch = parsed.pathname.match(/^\/sessions\/([^/]+)$/);
    if (method === 'GET' && sessionMatch) {
      sendJson(res, 200, {
        success: true,
        snapshot: await this.getSessionSnapshot(decodeURIComponent(sessionMatch[1] || '').trim()),
      });
      return;
    }
    if (method === 'POST' && parsed.pathname === '/sessions') {
      const body = await readJsonBody(req);
      sendJson(res, 200, {
        success: true,
        session: await this.createSession({
          title: typeof body.title === 'string' ? body.title : undefined,
          contextType: typeof body.contextType === 'string' ? body.contextType : undefined,
          runtimeMode: typeof body.runtimeMode === 'string' ? body.runtimeMode : undefined,
          metadata: body.metadata && typeof body.metadata === 'object' ? body.metadata as Record<string, unknown> : undefined,
        }),
      });
      return;
    }
    const messageMatch = parsed.pathname.match(/^\/sessions\/([^/]+)\/messages$/);
    if (method === 'POST' && messageMatch) {
      const body = await readJsonBody(req);
      const message = String(body.message || '').trim();
      sendJson(res, 202, {
        success: true,
        result: await this.sendSessionMessage(decodeURIComponent(messageMatch[1] || '').trim(), message),
      });
      return;
    }
    const permissionResolveMatch = parsed.pathname.match(/^\/permissions\/([^/]+)\/resolve$/);
    if (method === 'POST' && permissionResolveMatch) {
      const body = await readJsonBody(req);
      const rawOutcome = String(body.outcome || '').trim();
      const outcome = rawOutcome === ToolConfirmationOutcome.ProceedAlways
        ? ToolConfirmationOutcome.ProceedAlways
        : rawOutcome === ToolConfirmationOutcome.Cancel
          ? ToolConfirmationOutcome.Cancel
          : ToolConfirmationOutcome.ProceedOnce;
      const result = this.resolvePermissionRequest(
        decodeURIComponent(permissionResolveMatch[1] || '').trim(),
        outcome,
      );
      sendJson(res, result.success ? 200 : 404, result);
      return;
    }
    sendJson(res, 404, { success: false, error: 'not found' });
  }
}

let sessionBridgeService: SessionBridgeService | null = null;

export function getSessionBridgeService(): SessionBridgeService {
  if (!sessionBridgeService) {
    sessionBridgeService = new SessionBridgeService();
  }
  return sessionBridgeService;
}
