export { };
// Type definitions
export interface VideoEntry {
  id: string;
  title: string;
  publishedAt: string;
  status: 'pending' | 'downloading' | 'success' | 'failed';
  retryCount: number;
  errorMessage?: string;
  subtitleFile?: string;
}

export interface ToolDiagnosticDescriptor {
  name: string;
  displayName: string;
  description: string;
  kind: string;
  visibility: 'public' | 'developer' | 'internal';
  contexts: string[];
  availabilityStatus: 'available' | 'missing_context' | 'internal_only' | 'not_in_current_pack' | 'registration_error';
  availabilityReason: string;
}

export interface ToolDiagnosticRunResult {
  success: boolean;
  mode: 'direct' | 'ai';
  toolName: string;
  request: unknown;
  response?: unknown;
  error?: string;
  toolCallReturned?: boolean;
  toolNameMatched?: boolean;
  argumentsParsed?: boolean;
  executionSucceeded?: boolean;
}

export interface AgentTaskNode {
  id: string;
  type: string;
  title: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'skipped';
  startedAt?: number;
  completedAt?: number;
  summary?: string;
  error?: string;
}

export interface AgentTaskCheckpoint {
  id: string;
  nodeId: string;
  summary: string;
  payload?: unknown;
  createdAt: number;
}

export interface AgentTaskArtifact {
  id: string;
  type: string;
  label: string;
  path?: string;
  metadata?: unknown;
  createdAt: number;
}

export interface IntentRouteInfo {
  intent: string;
  goal: string;
  requiredCapabilities: string[];
  recommendedRole: string;
  requiresLongRunningTask: boolean;
  requiresMultiAgent: boolean;
  requiresHumanApproval: boolean;
  confidence: number;
  reasoning: string;
}

export interface AgentTaskSnapshot {
  id: string;
  taskType: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
  runtimeMode: string;
  ownerSessionId?: string | null;
  intent?: string | null;
  roleId?: string | null;
  goal?: string | null;
  currentNode?: string | null;
  route?: IntentRouteInfo | null;
  graph: AgentTaskNode[];
  artifacts: AgentTaskArtifact[];
  checkpoints: AgentTaskCheckpoint[];
  metadata?: unknown;
  lastError?: string | null;
  createdAt: number;
  updatedAt: number;
  startedAt?: number | null;
  completedAt?: number | null;
}

export interface AgentTaskTrace {
  id: number;
  taskId: string;
  nodeId?: string | null;
  runtimeId?: string | null;
  parentRuntimeId?: string | null;
  sourceTaskId?: string | null;
  eventType: string;
  payload?: unknown;
  createdAt: number;
}

export type RuntimeUnifiedEventType =
  | 'runtime:stream-start'
  | 'runtime:text-delta'
  | 'runtime:done'
  | 'runtime:tool-start'
  | 'runtime:tool-update'
  | 'runtime:tool-end'
  | 'runtime:task-node-changed'
  | 'runtime:subagent-started'
  | 'runtime:subagent-finished'
  | 'runtime:checkpoint'
  | 'stream_start'
  | 'text_delta'
  | 'tool_request'
  | 'tool_result'
  | 'task_node_changed'
  | 'subagent_spawned'
  | 'subagent_finished'
  | 'task_checkpoint_saved';

export interface RuntimeUnifiedEvent {
  eventType: RuntimeUnifiedEventType;
  sessionId?: string | null;
  taskId?: string | null;
  runtimeId?: string | null;
  parentRuntimeId?: string | null;
  payload?: unknown;
  timestamp: number;
}

export interface SessionRuntimeRecord {
  id: number;
  sessionId: string;
  recordType: string;
  role: string;
  content: string;
  payload?: unknown;
  createdAt: number;
}

export interface SessionCheckpointRecord {
  id: string;
  sessionId: string;
  runtimeId?: string | null;
  parentRuntimeId?: string | null;
  sourceTaskId?: string | null;
  checkpointType: string;
  summary: string;
  payload?: unknown;
  createdAt: number;
}

export interface SessionToolResultItem {
  id: string;
  sessionId: string;
  runtimeId?: string | null;
  parentRuntimeId?: string | null;
  sourceTaskId?: string | null;
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
  payload?: unknown;
  createdAt: number;
  updatedAt: number;
}

export interface SessionBridgeSessionSummary {
  id: string;
  title: string;
  updatedAt: number;
  createdAt: number;
  contextType: string;
  runtimeMode: string;
  isBackgroundSession: boolean;
  ownerTaskCount: number;
  backgroundTaskCount: number;
}

export interface SessionBridgeStatus {
  enabled: boolean;
  listening: boolean;
  host: string;
  port: number;
  authToken: string;
  websocketUrl: string;
  httpBaseUrl: string;
  subscriberCount: number;
  lastError: string | null;
}

export interface SessionBridgeSnapshot {
  session: SessionBridgeSessionSummary & {
    metadata?: Record<string, unknown>;
  };
  transcript: SessionRuntimeRecord[];
  checkpoints: SessionCheckpointRecord[];
  toolResults: SessionToolResultItem[];
  tasks: AgentTaskSnapshot[];
  backgroundTasks: Array<{
    id: string;
    kind: string;
    title: string;
    status: string;
    phase: string;
    sessionId?: string;
    contextId?: string;
    error?: string;
    summary?: string;
    latestText?: string;
    attemptCount: number;
    workerState: string;
    workerMode?: string;
    workerPid?: number;
    workerLabel?: string;
    workerLastHeartbeatAt?: string;
    cancelReason?: string;
    rollbackState: string;
    rollbackError?: string;
    createdAt: string;
    updatedAt: string;
    completedAt?: string;
    turns: Array<{
      id: string;
      at: string;
      text: string;
      source: 'thought' | 'tool' | 'response' | 'system';
    }>;
  }>;
  permissionRequests: SessionBridgePermissionRequest[];
}

export interface SessionBridgePermissionRequest {
  id: string;
  sessionId: string;
  callId: string;
  toolName: string;
  params: Record<string, unknown>;
  details: {
    type: 'edit' | 'exec' | 'info';
    title: string;
    description: string;
    impact?: string;
  };
  createdAt: number;
  resolvedAt?: number;
  status: 'pending' | 'approved_once' | 'approved_always' | 'cancelled';
  decision?: 'proceed_once' | 'proceed_always' | 'cancel';
}

export interface IpcInvokeGuardOptions<T = unknown> {
  timeoutMs?: number;
  fallback?: T | null | (() => T | null);
  normalize?: (value: unknown) => T;
}

export interface RoleSpec {
  roleId: string;
  purpose: string;
  systemPrompt: string;
  allowedToolPack: string;
  inputSchema: string;
  outputSchema: string;
  handoffContract: string;
  artifactTypes: string[];
}

declare global {
  interface ChatSession {
    id: string;
    title: string;
    updatedAt: string;
  }

  interface ContextChatSessionListItem {
    id: string;
    messageCount: number;
    summary: string;
    transcriptCount: number;
    checkpointCount: number;
    context?: unknown;
    chatSession?: {
      id: string;
      title?: string;
      updatedAt?: string;
    } | null;
  }

  interface ChatMessage {
    id: string;
    session_id: string;
    role: string;
    content: string;
    tool_call_id?: string;
    created_at: string;
  }

  interface SubjectCategory {
    id: string;
    name: string;
    createdAt: string;
    updatedAt: string;
  }

  interface SubjectAttribute {
    key: string;
    value: string;
  }

  interface SubjectRecord {
    id: string;
    name: string;
    categoryId?: string;
    description?: string;
    tags: string[];
    attributes: SubjectAttribute[];
    imagePaths: string[];
    voicePath?: string;
    voiceScript?: string;
    createdAt: string;
    updatedAt: string;
    absoluteImagePaths?: string[];
    previewUrls?: string[];
    primaryPreviewUrl?: string;
    absoluteVoicePath?: string;
    voicePreviewUrl?: string;
  }

  interface Window {
    ipcRenderer: {
      saveSettings: (settings: { api_endpoint: string; api_key: string; model_name: string; model_name_wander?: string; model_name_chatroom?: string; model_name_knowledge?: string; model_name_redclaw?: string; search_provider?: string; search_endpoint?: string; search_api_key?: string; proxy_enabled?: boolean; proxy_url?: string; proxy_bypass?: string; workspace_dir?: string; active_space_id?: string; role_mapping?: Record<string, string> | string; transcription_model?: string; transcription_endpoint?: string; transcription_key?: string; embedding_endpoint?: string; embedding_key?: string; embedding_model?: string; ai_sources_json?: string; default_ai_source_id?: string; image_provider?: string; image_endpoint?: string; image_api_key?: string; image_model?: string; video_endpoint?: string; video_api_key?: string; video_model?: string; image_provider_template?: string; image_aspect_ratio?: string; image_size?: string; image_quality?: string; mcp_servers_json?: string; redclaw_compact_target_tokens?: number; wander_deep_think_enabled?: boolean; wander_skill_loading_enabled?: boolean; debug_log_enabled?: boolean; developer_mode_enabled?: boolean; developer_mode_unlocked_at?: string | null; chat_max_tokens_default?: number; chat_max_tokens_deepseek?: number }) => Promise<unknown>;
      getSettings: () => Promise<{ api_endpoint: string; api_key: string; model_name: string; model_name_wander?: string; model_name_chatroom?: string; model_name_knowledge?: string; model_name_redclaw?: string; search_provider?: string; search_endpoint?: string; search_api_key?: string; proxy_enabled?: boolean; proxy_url?: string; proxy_bypass?: string; workspace_dir?: string; active_space_id?: string; role_mapping?: string; transcription_model?: string; transcription_endpoint?: string; transcription_key?: string; embedding_endpoint?: string; embedding_key?: string; embedding_model?: string; ai_sources_json?: string; default_ai_source_id?: string; image_provider?: string; image_endpoint?: string; image_api_key?: string; image_model?: string; video_endpoint?: string; video_api_key?: string; video_model?: string; image_provider_template?: string; image_aspect_ratio?: string; image_size?: string; image_quality?: string; mcp_servers_json?: string; redclaw_compact_target_tokens?: number; wander_deep_think_enabled?: boolean; wander_skill_loading_enabled?: boolean; debug_log_enabled?: boolean; developer_mode_enabled?: boolean; developer_mode_unlocked_at?: string | null; chat_max_tokens_default?: number; chat_max_tokens_deepseek?: number } | undefined>;
      pickWorkspaceDir: () => Promise<{ success: boolean; canceled?: boolean; path?: string | null; error?: string }>;
      debug: {
        getStatus: () => Promise<{ enabled: boolean; logDirectory: string }>;
        getRecent: (limit?: number) => Promise<{ lines: string[] }>;
        getRuntimeSummary: () => Promise<{
          generatedAt?: number;
          runtimeWarm?: {
            lastWarmedAt?: number;
            entries?: Array<{
              mode: string;
              warmedAt: number;
              systemPromptChars: number;
              longTermContextChars: number;
              hasModelConfig: boolean;
            }>;
          };
          phase0?: {
            personaGeneration?: {
              count: number;
              avgElapsedMs?: number;
              avgSearchElapsedMs?: number;
              avgKnowledgeFiles?: number;
              avgSearchHits?: number;
              avgAdvisorKnowledgeHits?: number;
              avgManuscriptHits?: number;
              byAdvisor?: Array<Record<string, unknown>>;
              recent?: Array<Record<string, unknown>>;
            };
            knowledgeIngest?: {
              count: number;
              avgElapsedMs?: number;
              avgImportedFiles?: number;
              avgTotalKnowledgeFiles?: number;
              byAdvisor?: Array<Record<string, unknown>>;
              recent?: Array<Record<string, unknown>>;
            };
            runtimeQueries?: {
              count: number;
              avgElapsedMs?: number;
              avgPromptChars?: number;
              avgActiveSkillCount?: number;
              avgResponseChars?: number;
              byAdvisor?: Array<Record<string, unknown>>;
              byMode?: Array<Record<string, unknown>>;
              recent?: Array<Record<string, unknown>>;
            };
            skillInvocations?: {
              count: number;
              avgElapsedMs?: number;
              avgActiveSkillCount?: number;
              bySkill?: Array<Record<string, unknown>>;
              recent?: Array<Record<string, unknown>>;
            };
            toolCalls?: {
              count: number;
              successCount?: number;
              successRate?: number;
              byAdvisor?: Array<Record<string, unknown>>;
              byTool?: Array<Record<string, unknown>>;
              recent?: Array<Record<string, unknown>>;
            };
          };
        }>;
        openLogDir: () => Promise<{ success: boolean; error?: string; path: string }>;
      };
      startupMigration: {
        getStatus: () => Promise<{
          status?: string;
          needsDbImport?: boolean;
          needsProjectUpgrade?: boolean;
          shouldShowModal?: boolean;
          legacyDbPath?: string | null;
          legacyWorkspacePath?: string | null;
          workspacePath?: string | null;
          currentStep?: string | null;
          message?: string | null;
          error?: string | null;
          progress?: number;
          legacyMarkdownCount?: number | null;
          importedCounts?: Record<string, number> | null;
          projectUpgradeCounts?: Record<string, number> | null;
        }>;
        start: () => Promise<{
          status?: string;
          needsDbImport?: boolean;
          needsProjectUpgrade?: boolean;
          shouldShowModal?: boolean;
          legacyDbPath?: string | null;
          legacyWorkspacePath?: string | null;
          workspacePath?: string | null;
          currentStep?: string | null;
          message?: string | null;
          error?: string | null;
          progress?: number;
          legacyMarkdownCount?: number | null;
          importedCounts?: Record<string, number> | null;
          projectUpgradeCounts?: Record<string, number> | null;
        }>;
      };
      officialAuth: {
        bootstrap: (payload?: { reason?: string }) => Promise<{
          success: boolean;
          loggedIn?: boolean;
          session?: Record<string, unknown> | null;
          data?: Record<string, unknown> | null;
          reason?: string;
          error?: string;
        }>;
        refresh: () => Promise<{
          success: boolean;
          queued?: boolean;
          tokenRefreshed?: boolean;
          requestedAt?: string;
          session?: Record<string, unknown> | null;
          data?: Record<string, unknown> | null;
          error?: string;
        }>;
      };
      sessions: {
        list: () => Promise<Array<{
          id: string;
          transcriptCount: number;
          checkpointCount: number;
          chatSession?: { id: string; title?: string; updatedAt?: string } | null;
        }>>;
        get: (sessionId: string) => Promise<{
          chatSession?: { id: string; title?: string; updatedAt?: string } | null;
          transcript?: SessionRuntimeRecord[];
          checkpoints?: SessionCheckpointRecord[];
          toolResults?: SessionToolResultItem[];
        } | null>;
        resume: (sessionId: string) => Promise<{
          chatSession?: { id: string; title?: string; updatedAt?: string } | null;
          lastCheckpoint?: SessionCheckpointRecord | null;
        } | null>;
        fork: (sessionId: string) => Promise<{ success: boolean; session?: { id: string; transcriptCount: number; checkpointCount: number }; error?: string }>;
        getTranscript: (sessionId: string, limit?: number) => Promise<SessionRuntimeRecord[]>;
        getToolResults: (sessionId: string, limit?: number) => Promise<SessionToolResultItem[]>;
      };
      sessionBridge: {
        getStatus: () => Promise<SessionBridgeStatus>;
        listSessions: () => Promise<SessionBridgeSessionSummary[]>;
        getSession: (sessionId: string) => Promise<SessionBridgeSnapshot | null>;
        listPermissions: (payload?: { sessionId?: string }) => Promise<SessionBridgePermissionRequest[]>;
        createSession: (payload?: {
          title?: string;
          contextType?: string;
          runtimeMode?: string;
          metadata?: Record<string, unknown>;
        }) => Promise<SessionBridgeSessionSummary>;
        sendMessage: (payload: { sessionId: string; message: string }) => Promise<{ accepted: boolean; sessionId?: string; error?: string }>;
        resolvePermission: (payload: { requestId: string; outcome: 'proceed_once' | 'proceed_always' | 'cancel' }) => Promise<{ success: boolean; request?: SessionBridgePermissionRequest; error?: string }>;
      };
      runtime: {
        query: (payload: { sessionId?: string; message: string; modelConfig?: unknown }) => Promise<{ success: boolean; sessionId: string; response?: string; error?: string }>;
        resume: (payload: { sessionId: string }) => Promise<{ success: boolean; sessionId: string }>;
        forkSession: (payload: { sessionId: string }) => Promise<{ success: boolean; sessionId?: string; forkedSessionId?: string }>;
        getTrace: (payload: { sessionId: string; runtimeId?: string; limit?: number; includeChildSessions?: boolean }) => Promise<SessionRuntimeRecord[]>;
        getCheckpoints: (payload: { sessionId: string; runtimeId?: string; limit?: number; includeChildSessions?: boolean }) => Promise<SessionCheckpointRecord[]>;
        getToolResults: (payload: { sessionId: string; runtimeId?: string; limit?: number; includeChildSessions?: boolean }) => Promise<SessionToolResultItem[]>;
      };
      toolHooks: {
        list: () => Promise<unknown[]>;
        register: (hook: unknown) => Promise<{ success: boolean; hookId: string }>;
        remove: (hookId: string) => Promise<{ success: boolean }>;
      };
      backgroundTasks: {
        list: () => Promise<Array<{
          id: string;
          definitionId?: string;
          executionId?: string;
          sourceTaskId?: string;
          kind: 'redclaw-project' | 'scheduled-task' | 'long-cycle' | 'heartbeat' | 'memory-maintenance' | 'headless-runtime';
          title: string;
          status: string;
          phase: string;
          sessionId?: string;
          contextId?: string;
          error?: string;
          summary?: string;
          latestText?: string;
          attemptCount: number;
          workerState: string;
          workerMode?: 'main-process' | 'child-json-worker' | 'child-runtime-worker';
          workerPid?: number;
          workerLabel?: string;
          workerLastHeartbeatAt?: string;
          cancelReason?: string;
          deadLetteredAt?: string;
          archivedAt?: string;
          rollbackState: 'idle' | 'running' | 'completed' | 'failed' | 'not_required';
          rollbackError?: string;
          createdAt: string;
          updatedAt: string;
          completedAt?: string;
          turns: Array<{
            id: string;
            at: string;
            text: string;
            source: 'thought' | 'tool' | 'response' | 'system';
          }>;
        }>>;
        get: (taskId: string) => Promise<{
          id: string;
          definitionId?: string;
          executionId?: string;
          sourceTaskId?: string;
          kind: 'redclaw-project' | 'scheduled-task' | 'long-cycle' | 'heartbeat' | 'memory-maintenance' | 'headless-runtime';
          title: string;
          status: string;
          phase: string;
          sessionId?: string;
          contextId?: string;
          error?: string;
          summary?: string;
          latestText?: string;
          attemptCount: number;
          workerState: string;
          workerMode?: 'main-process' | 'child-json-worker' | 'child-runtime-worker';
          workerPid?: number;
          workerLabel?: string;
          workerLastHeartbeatAt?: string;
          cancelReason?: string;
          deadLetteredAt?: string;
          archivedAt?: string;
          rollbackState: 'idle' | 'running' | 'completed' | 'failed' | 'not_required';
          rollbackError?: string;
          createdAt: string;
          updatedAt: string;
          completedAt?: string;
          turns: Array<{
            id: string;
            at: string;
            text: string;
            source: 'thought' | 'tool' | 'response' | 'system';
          }>;
        } | null>;
        cancel: (taskId: string) => Promise<{
          id: string;
          definitionId?: string;
          executionId?: string;
          sourceTaskId?: string;
          kind: 'redclaw-project' | 'scheduled-task' | 'long-cycle' | 'heartbeat' | 'memory-maintenance' | 'headless-runtime';
          title: string;
          status: string;
          phase: string;
          sessionId?: string;
          contextId?: string;
          error?: string;
          summary?: string;
          latestText?: string;
          attemptCount: number;
          workerState: string;
          workerMode?: 'main-process' | 'child-json-worker' | 'child-runtime-worker';
          workerPid?: number;
          workerLabel?: string;
          workerLastHeartbeatAt?: string;
          cancelReason?: string;
          deadLetteredAt?: string;
          archivedAt?: string;
          rollbackState: 'idle' | 'running' | 'completed' | 'failed' | 'not_required';
          rollbackError?: string;
          createdAt: string;
          updatedAt: string;
          completedAt?: string;
          turns: Array<{
            id: string;
            at: string;
            text: string;
            source: 'thought' | 'tool' | 'response' | 'system';
          }>;
        } | null>;
        retry: (taskId: string) => Promise<{ success: boolean; executionId: string; definitionId: string }>;
        archive: (taskId: string) => Promise<{ success: boolean; executionId: string }>;
      };
      backgroundWorkers: {
        getPoolState: () => Promise<{
          json: Array<{
            id: string;
            mode: 'child-json-worker' | 'child-runtime-worker';
            ready: boolean;
            busy: boolean;
            pid?: number;
            sessionId?: string;
            taskId?: string;
            lastHeartbeatAt?: string;
            lastUsedAt?: string;
          }>;
          runtime: Array<{
            id: string;
            mode: 'child-json-worker' | 'child-runtime-worker';
            ready: boolean;
            busy: boolean;
            pid?: number;
            sessionId?: string;
            taskId?: string;
            lastHeartbeatAt?: string;
            lastUsedAt?: string;
          }>;
        }>;
      };
      tasks: {
        create: (payload?: { runtimeMode?: string; sessionId?: string; userInput?: string; metadata?: Record<string, unknown> }) => Promise<AgentTaskSnapshot>;
        list: (payload?: { status?: string; ownerSessionId?: string; limit?: number }) => Promise<AgentTaskSnapshot[]>;
        get: (payload: { taskId: string }) => Promise<AgentTaskSnapshot | null>;
        resume: (payload: { taskId: string }) => Promise<AgentTaskSnapshot | null>;
        cancel: (payload: { taskId: string }) => Promise<AgentTaskSnapshot | null>;
        trace: (payload: { taskId: string; limit?: number }) => Promise<AgentTaskTrace[]>;
      };
      work: {
        list: (payload?: { status?: string; type?: string; limit?: number; tag?: string }) => Promise<Array<{
          id: string;
          title: string;
          description?: string;
          type: string;
          status: string;
          effectiveStatus: string;
          priority: number;
          tags: string[];
          dependsOn: string[];
          parentId?: string;
          summary?: string;
          blockedBy: string[];
          ready: boolean;
          refs: {
            projectIds: string[];
            sessionIds: string[];
            taskIds: string[];
            backgroundTaskIds: string[];
            filePaths: string[];
          };
          schedule?: {
            mode: string;
            enabled?: boolean;
            intervalMinutes?: number;
            time?: string;
            weekdays?: number[];
            runAt?: string;
            totalRounds?: number;
            completedRounds?: number;
            nextRunAt?: string;
            lastRunAt?: string;
          };
          metadata?: Record<string, unknown>;
          createdAt: string;
          updatedAt: string;
          completedAt?: string;
        }>>;
        update: (payload: {
          id: string;
          title?: string;
          description?: string | null;
          status?: 'pending' | 'active' | 'waiting' | 'done' | 'cancelled';
          priority?: number;
          summary?: string | null;
        }) => Promise<{
          id: string;
          title: string;
          description?: string;
          type: string;
          status: string;
          effectiveStatus: string;
          priority: number;
          tags: string[];
          dependsOn: string[];
          parentId?: string;
          summary?: string;
          blockedBy: string[];
          ready: boolean;
          refs: {
            projectIds: string[];
            sessionIds: string[];
            taskIds: string[];
            backgroundTaskIds: string[];
            filePaths: string[];
          };
          schedule?: {
            mode: string;
            enabled?: boolean;
            intervalMinutes?: number;
            time?: string;
            weekdays?: number[];
            runAt?: string;
            totalRounds?: number;
            completedRounds?: number;
            nextRunAt?: string;
            lastRunAt?: string;
          };
          metadata?: Record<string, unknown>;
          createdAt: string;
          updatedAt: string;
          completedAt?: string;
        }>;
        get: (payload: { id: string }) => Promise<{
          id: string;
          title: string;
          description?: string;
          type: string;
          status: string;
          effectiveStatus: string;
          priority: number;
          tags: string[];
          dependsOn: string[];
          parentId?: string;
          summary?: string;
          blockedBy: string[];
          ready: boolean;
          refs: {
            projectIds: string[];
            sessionIds: string[];
            taskIds: string[];
            backgroundTaskIds: string[];
            filePaths: string[];
          };
          schedule?: {
            mode: string;
            enabled?: boolean;
            intervalMinutes?: number;
            time?: string;
            weekdays?: number[];
            runAt?: string;
            totalRounds?: number;
            completedRounds?: number;
            nextRunAt?: string;
            lastRunAt?: string;
          };
          metadata?: Record<string, unknown>;
          createdAt: string;
          updatedAt: string;
          completedAt?: string;
        } | null>;
        ready: (payload?: { limit?: number }) => Promise<Array<{
          id: string;
          title: string;
          description?: string;
          type: string;
          status: string;
          effectiveStatus: string;
          priority: number;
          tags: string[];
          dependsOn: string[];
          parentId?: string;
          summary?: string;
          blockedBy: string[];
          ready: boolean;
          refs: {
            projectIds: string[];
            sessionIds: string[];
            taskIds: string[];
            backgroundTaskIds: string[];
            filePaths: string[];
          };
          schedule?: {
            mode: string;
            enabled?: boolean;
            intervalMinutes?: number;
            time?: string;
            weekdays?: number[];
            runAt?: string;
            totalRounds?: number;
            completedRounds?: number;
            nextRunAt?: string;
            lastRunAt?: string;
          };
          metadata?: Record<string, unknown>;
          createdAt: string;
          updatedAt: string;
          completedAt?: string;
        }>>;
      };
      subjects: {
        list: (payload?: { limit?: number }) => Promise<{ success?: boolean; error?: string; subjects?: SubjectRecord[] }>;
        get: (payload: { id: string }) => Promise<{ success?: boolean; error?: string; subject?: SubjectRecord }>;
        create: (payload: unknown) => Promise<{ success?: boolean; error?: string; subject?: SubjectRecord }>;
        update: (payload: unknown) => Promise<{ success?: boolean; error?: string; subject?: SubjectRecord }>;
        delete: (payload: { id: string }) => Promise<{ success?: boolean; error?: string }>;
        search: (payload?: { query?: string; categoryId?: string; limit?: number }) => Promise<{ success?: boolean; error?: string; subjects?: SubjectRecord[] }>;
        categories: {
          list: () => Promise<{ success?: boolean; error?: string; categories?: SubjectCategory[] }>;
          create: (payload: { name: string }) => Promise<{ success?: boolean; error?: string; category?: SubjectCategory }>;
          update: (payload: { id: string; name: string }) => Promise<{ success?: boolean; error?: string; category?: SubjectCategory }>;
          delete: (payload: { id: string }) => Promise<{ success?: boolean; error?: string }>;
        };
      };
      getAppVersion: () => Promise<string>;
      checkAppUpdate: (force?: boolean) => Promise<{ success: boolean; hasUpdate: boolean; throttled?: boolean; inFlight?: boolean; message?: string; notice?: { currentVersion: string; latestVersion: string; htmlUrl: string; name: string; publishedAt: string; body: string } }>;
      openAppReleasePage: (url?: string) => Promise<{ success: boolean; error?: string }>;
      openPath: (path: string) => Promise<{ success: boolean; error?: string }>;
      clipboardReadText: () => Promise<string>;
      openKnowledgeApiGuide: () => Promise<{ success: boolean; path?: string; error?: string }>;
      openRichpostThemeGuide: () => Promise<{ success: boolean; path?: string; error?: string }>;
      browserPlugin: {
        getStatus: () => Promise<{ success: boolean; bundled: boolean; exportPath: string; exported: boolean; bundledPath?: string; pluginPath?: string; checkedPaths?: string[]; error?: string }>;
        prepare: () => Promise<{ success: boolean; path: string; pluginPath?: string; bundledPath?: string; alreadyPrepared?: boolean; error?: string }>;
        openDir: () => Promise<{ success: boolean; path: string; pluginPath?: string; error?: string }>;
      };
      fetchModels: (config: { apiKey: string, baseURL: string, presetId?: string, protocol?: 'openai' | 'anthropic' | 'gemini', purpose?: 'chat' | 'image' }) => Promise<Array<{ id: string; capabilities?: Array<'chat' | 'image' | 'video' | 'audio' | 'transcription' | 'embedding'> }>>;
      aiRoles: {
        list: () => Promise<RoleSpec[]>;
      };
      detectAiProtocol: (config: { baseURL: string; presetId?: string; protocol?: string }) => Promise<{ success: boolean; protocol: 'openai' | 'anthropic' | 'gemini'; error?: string }>;
      testAiConnection: (config: { apiKey: string; baseURL: string; presetId?: string; protocol?: 'openai' | 'anthropic' | 'gemini' }) => Promise<{ success: boolean; protocol: 'openai' | 'anthropic' | 'gemini'; models: Array<{ id: string }>; message: string }>;
      startChat: (message: string, modelConfig?: unknown) => void;
      cancelChat: () => void;
      confirmTool: (callId: string, confirmed: boolean) => void;
      listSkills: () => Promise<SkillDefinition[]>;
      skills: {
        save: (payload: Record<string, unknown>) => Promise<unknown>;
        create: (payload: { name: string }) => Promise<unknown>;
        enable: (payload: { name: string }) => Promise<unknown>;
        disable: (payload: { name: string }) => Promise<unknown>;
        marketInstall: (payload: { slug: string; tag?: string }) => Promise<unknown>;
      };
      cover: {
        saveTemplateImage: (payload: { imageSource: string }) => Promise<unknown>;
        templates: {
          list: () => Promise<unknown>;
          save: (payload: { template: Record<string, unknown> }) => Promise<unknown>;
          delete: (payload: { templateId: string }) => Promise<unknown>;
          importLegacy: (payload: { templates: Record<string, unknown>[] }) => Promise<unknown>;
        };
      };
      toolDiagnostics: {
        list: () => Promise<ToolDiagnosticDescriptor[]>;
        runDirect: (toolName: string) => Promise<ToolDiagnosticRunResult>;
        runAi: (toolName: string) => Promise<ToolDiagnosticRunResult>;
      };
      on: (channel: string, func: (...args: any[]) => void) => void;
      off: (channel: string, func: (...args: any[]) => void) => void;
      removeAllListeners: (channel: string) => void;
      invoke: (channel: string, ...args: unknown[]) => Promise<unknown>;
      invokeGuarded: <T = unknown>(channel: string, payload?: unknown, options?: IpcInvokeGuardOptions<T>) => Promise<T>;
      command: <T = unknown>(command: string, args?: unknown) => Promise<T>;
      commandGuarded: <T = unknown>(command: string, args?: unknown, options?: IpcInvokeGuardOptions<T> & { fallbackChannel?: string }) => Promise<T>;
      spaces: {
        list: () => Promise<{
          activeSpaceId?: string;
          spaces?: Array<{ id: string; name: string; createdAt?: string; updatedAt?: string }>;
        }>;
        switch: (spaceId: string) => Promise<unknown>;
        create: (name: string) => Promise<unknown>;
        rename: (payload: { id: string; name: string }) => Promise<unknown>;
      };
      advisors: {
        list: <T = Record<string, unknown>>() => Promise<Array<T>>;
        listTemplates: <T = Record<string, unknown>>() => Promise<Array<T>>;
        create: (payload: Record<string, unknown>) => Promise<unknown>;
        update: (payload: Record<string, unknown>) => Promise<unknown>;
        delete: (advisorId: string) => Promise<unknown>;
        uploadKnowledge: (advisorId: string) => Promise<unknown>;
        deleteKnowledge: (payload: { advisorId: string; fileName: string }) => Promise<unknown>;
        optimizePrompt: (payload: Record<string, unknown>) => Promise<unknown>;
        optimizePromptDeep: (payload: Record<string, unknown>) => Promise<unknown>;
        generatePersona: (payload: Record<string, unknown>) => Promise<unknown>;
        selectAvatar: () => Promise<unknown>;
      };
      knowledge: {
        listNotes: <T = Record<string, unknown>>() => Promise<Array<T>>;
        listYoutube: <T = Record<string, unknown>>() => Promise<Array<T>>;
        listDocs: <T = Record<string, unknown>>() => Promise<Array<T>>;
        listPage: <T = Record<string, unknown>>(payload?: Record<string, unknown>) => Promise<T>;
        getItemDetail: <T = Record<string, unknown>>(payload: Record<string, unknown>) => Promise<T | null>;
        getIndexStatus: <T = Record<string, unknown>>() => Promise<T>;
        rebuildCatalog: () => Promise<unknown>;
        openIndexRoot: () => Promise<unknown>;
        deleteNote: (noteId: string) => Promise<unknown>;
        transcribe: (noteId: string) => Promise<unknown>;
        deleteYoutube: (videoId: string) => Promise<unknown>;
        retryYoutubeSubtitle: (videoId: string) => Promise<unknown>;
        regenerateYoutubeSummaries: () => Promise<unknown>;
        addDocFiles: () => Promise<unknown>;
        addDocFolder: () => Promise<unknown>;
        addObsidianVault: () => Promise<unknown>;
        deleteDocSource: (sourceId: string) => Promise<unknown>;
      };
      embedding: {
        getManuscriptCache: (manuscriptId: string) => Promise<unknown>;
        compute: (content: string) => Promise<unknown>;
        saveManuscriptCache: (payload: Record<string, unknown>) => Promise<unknown>;
        getSortedSources: (embedding: unknown) => Promise<unknown>;
      };
      similarity: {
        getCache: (manuscriptId: string) => Promise<unknown>;
        getKnowledgeVersion: () => Promise<unknown>;
        saveCache: (payload: Record<string, unknown>) => Promise<unknown>;
      };
      files: {
        showInFolder: (payload: { source: string }) => Promise<unknown>;
        copyImage: (payload: { source: string }) => Promise<unknown>;
      };

      // YouTube Import
      checkYtdlp: () => Promise<{ installed: boolean; version?: string; path?: string }>;
      installYtdlp: () => Promise<{ success: boolean; error?: string }>;
      updateYtdlp: () => Promise<{ success: boolean; error?: string }>;
      fetchYoutubeInfo: (channelUrl: string) => Promise<{ success: boolean; data?: any; error?: string }>;
      downloadYoutubeSubtitles: (params: { channelUrl: string; videoCount: number; advisorId: string }) => Promise<{ success: boolean; successCount?: number; failCount?: number; error?: string }>;
      readYoutubeSubtitle: (videoId: string) => Promise<{ success: boolean; subtitleContent?: string; hasSubtitle?: boolean; error?: string }>;

      // Video Management
      refreshVideos: (advisorId: string, limit?: number) => Promise<{ success: boolean; videos?: VideoEntry[]; error?: string }>;
      getVideos: (advisorId: string) => Promise<{ success: boolean; videos?: VideoEntry[]; youtubeChannel?: { url: string; channelId: string; lastRefreshed?: string; backgroundEnabled?: boolean; refreshIntervalMinutes?: number; subtitleDownloadIntervalSeconds?: number; maxVideosPerRefresh?: number; maxDownloadsPerRun?: number; lastBackgroundRunAt?: string; lastBackgroundError?: string }; error?: string }>;
      downloadVideo: (advisorId: string, videoId: string) => Promise<{ success: boolean; subtitleFile?: string; error?: string }>;
      retryFailedVideos: (advisorId: string) => Promise<{ success: boolean; successCount?: number; failCount?: number; error?: string }>;
      updateAdvisorYoutubeSettings: (advisorId: string, settings: { backgroundEnabled?: boolean; refreshIntervalMinutes?: number; subtitleDownloadIntervalSeconds?: number; maxVideosPerRefresh?: number; maxDownloadsPerRun?: number }) => Promise<{ success: boolean; youtubeChannel?: unknown; error?: string }>;
      getAdvisorYoutubeRunnerStatus: () => Promise<{ success: boolean; status?: { enabled: boolean; isTicking: boolean; tickIntervalMinutes: number; lastTickAt: string | null; nextTickAt: string | null; lastError: string | null }; error?: string }>;
      runAdvisorYoutubeNow: (advisorId?: string) => Promise<{ success: boolean; processed?: number; error?: string }>;

      // Chat Service API
      chat: {
      send: (data: {
        sessionId?: string;
        message: string;
        displayContent?: string;
        attachment?: unknown;
        modelConfig?: unknown;
        taskHints?: {
          intent?: string;
          forceMultiAgent?: boolean;
          forceLongRunningTask?: boolean;
          platform?: 'xiaohongshu' | 'wechat_official_account';
          taskType?: 'direct_write' | 'expand_from_xhs';
          formatTarget?: 'markdown' | 'wechat_rich_text';
          sourcePlatform?: 'xiaohongshu' | 'wechat_official_account';
          sourceNoteId?: string;
          sourceMode?: 'manual' | 'knowledge' | 'manuscript';
          sourceTitle?: string;
          sourceManuscriptPath?: string;
        };
      }) => void;
        pickAttachment: (payload?: { sessionId?: string }) => Promise<{ success?: boolean; canceled?: boolean; error?: string; attachment?: unknown }>;
        transcribeAudio: (payload: { audioBase64: string; mimeType?: string; fileName?: string }) => Promise<{ success?: boolean; text?: string; error?: string }>;
        cancel: (data?: { sessionId?: string } | string) => void;
        confirmTool: (callId: string, confirmed: boolean) => void;
        getSessions: () => Promise<ChatSession[]>;
        createSession: (title?: string) => Promise<ChatSession>;
        createDiagnosticsSession: (payload?: { title?: string; contextId?: string; contextType?: string }) => Promise<ChatSession>;
        listContextSessions: (payload: { contextId: string; contextType: string }) => Promise<ContextChatSessionListItem[]>;
        createContextSession: (payload: { contextId: string; contextType: string; title?: string; initialContext?: string }) => Promise<ChatSession>;
        getOrCreateContextSession: (params: { contextId: string; contextType: string; title: string; initialContext?: string }) => Promise<ChatSession>;
        deleteSession: (sessionId: string) => Promise<{ success: boolean }>;
        getMessages: (sessionId: string) => Promise<ChatMessage[]>;
        clearMessages: (sessionId: string) => Promise<{ success: boolean }>;
        compactContext: (sessionId: string) => Promise<{ success: boolean; compacted: boolean; message: string; compactRounds?: number; compactUpdatedAt?: string }>;
        getContextUsage: (sessionId: string) => Promise<{
          success: boolean;
          error?: string;
          sessionId?: string;
          contextType?: string;
          messageCount?: number;
          compactBaseMessageCount?: number;
          compactRounds?: number;
          compactUpdatedAt?: string | null;
          estimatedTotalTokens?: number;
          estimatedEffectiveTokens?: number;
          compactSummaryTokens?: number;
          activeHistoryTokens?: number;
          compactThreshold?: number;
          compactRatio?: number;
        }>;
        getRuntimeState: (sessionId: string) => Promise<{
          success: boolean;
          error?: string;
          sessionId?: string;
          isProcessing: boolean;
          partialResponse: string;
          updatedAt: number;
        }>;
      };
      redclawRunner: {
        getStatus: () => Promise<{
          enabled: boolean;
          lockState: 'owner' | 'passive';
          blockedBy: string | null;
          intervalMinutes: number;
          keepAliveWhenNoWindow: boolean;
          maxProjectsPerTick: number;
          maxAutomationPerTick?: number;
          isTicking: boolean;
          currentProjectId: string | null;
          currentAutomationTaskId?: string | null;
          nextAutomationFireAt?: string | null;
          inFlightTaskIds?: string[];
          inFlightLongCycleTaskIds?: string[];
          heartbeatInFlight?: boolean;
          lastTickAt: string | null;
          nextTickAt: string | null;
          nextMaintenanceAt?: string | null;
          lastError: string | null;
          heartbeat?: {
            enabled: boolean;
            intervalMinutes: number;
            suppressEmptyReport: boolean;
            reportToMainSession: boolean;
            prompt?: string;
            lastRunAt?: string;
            nextRunAt?: string;
            lastDigest?: string;
          };
          scheduledTasks?: Record<string, {
            id: string;
            name: string;
            enabled: boolean;
            mode: 'interval' | 'daily' | 'weekly' | 'once';
            prompt: string;
            projectId?: string;
            intervalMinutes?: number;
            time?: string;
            weekdays?: number[];
            runAt?: string;
            createdAt: string;
            updatedAt: string;
            lastRunAt?: string;
            lastResult?: 'success' | 'error' | 'skipped';
            lastError?: string;
            nextRunAt?: string;
          }>;
          longCycleTasks?: Record<string, {
            id: string;
            name: string;
            enabled: boolean;
            status: 'running' | 'paused' | 'completed';
            objective: string;
            stepPrompt: string;
            projectId?: string;
            intervalMinutes: number;
            totalRounds: number;
            completedRounds: number;
            createdAt: string;
            updatedAt: string;
            lastRunAt?: string;
            lastResult?: 'success' | 'error' | 'skipped';
            lastError?: string;
            nextRunAt?: string;
          }>;
          projectStates: Record<string, {
            projectId: string;
            enabled: boolean;
            prompt?: string;
            lastRunAt?: string;
            lastResult?: 'success' | 'error' | 'skipped';
            lastError?: string;
          }>;
        }>;
        start: (payload?: {
          intervalMinutes?: number;
          keepAliveWhenNoWindow?: boolean;
          maxProjectsPerTick?: number;
          maxAutomationPerTick?: number;
          heartbeatEnabled?: boolean;
          heartbeatIntervalMinutes?: number;
        }) => Promise<unknown>;
        stop: () => Promise<unknown>;
        runNow: (payload?: { projectId?: string }) => Promise<unknown>;
        setProject: (payload: { projectId: string; enabled: boolean; prompt?: string }) => Promise<unknown>;
        setConfig: (payload: {
          intervalMinutes?: number;
          keepAliveWhenNoWindow?: boolean;
          maxProjectsPerTick?: number;
          maxAutomationPerTick?: number;
          heartbeatEnabled?: boolean;
          heartbeatIntervalMinutes?: number;
          heartbeatSuppressEmptyReport?: boolean;
          heartbeatReportToMainSession?: boolean;
          heartbeatPrompt?: string;
        }) => Promise<unknown>;
        listScheduled: () => Promise<{
          success: boolean;
          error?: string;
          tasks: Array<{
            id: string;
            name: string;
            enabled: boolean;
            mode: 'interval' | 'daily' | 'weekly' | 'once';
            prompt: string;
            projectId?: string;
            intervalMinutes?: number;
            time?: string;
            weekdays?: number[];
            runAt?: string;
            createdAt: string;
            updatedAt: string;
            lastRunAt?: string;
            lastResult?: 'success' | 'error' | 'skipped';
            lastError?: string;
            nextRunAt?: string;
          }>;
        }>;
        addScheduled: (payload: {
          name: string;
          mode: 'interval' | 'daily' | 'weekly' | 'once';
          prompt: string;
          projectId?: string;
          intervalMinutes?: number;
          time?: string;
          weekdays?: number[];
          runAt?: string;
          enabled?: boolean;
        }) => Promise<{ success: boolean; error?: string }>;
        removeScheduled: (payload: { taskId: string }) => Promise<{ success: boolean; error?: string }>;
        setScheduledEnabled: (payload: { taskId: string; enabled: boolean }) => Promise<{ success: boolean; error?: string }>;
        runScheduledNow: (payload: { taskId: string }) => Promise<{ success: boolean; error?: string }>;
        listLongCycle: () => Promise<{
          success: boolean;
          error?: string;
          tasks: Array<{
            id: string;
            name: string;
            enabled: boolean;
            status: 'running' | 'paused' | 'completed';
            objective: string;
            stepPrompt: string;
            projectId?: string;
            intervalMinutes: number;
            totalRounds: number;
            completedRounds: number;
            createdAt: string;
            updatedAt: string;
            lastRunAt?: string;
            lastResult?: 'success' | 'error' | 'skipped';
            lastError?: string;
            nextRunAt?: string;
          }>;
        }>;
        addLongCycle: (payload: {
          name: string;
          objective: string;
          stepPrompt: string;
          projectId?: string;
          intervalMinutes?: number;
          totalRounds?: number;
          enabled?: boolean;
        }) => Promise<{ success: boolean; error?: string }>;
        removeLongCycle: (payload: { taskId: string }) => Promise<{ success: boolean; error?: string }>;
        setLongCycleEnabled: (payload: { taskId: string; enabled: boolean }) => Promise<{ success: boolean; error?: string }>;
        runLongCycleNow: (payload: { taskId: string }) => Promise<{ success: boolean; error?: string }>;
      };
      redclawProfile: {
        getBundle: () => Promise<{
          profileRoot?: string;
          agent?: string;
          soul?: string;
          identity?: string;
          user?: string;
          creatorProfile?: string;
          bootstrap?: string;
          onboardingState?: Record<string, unknown>;
        }>;
        updateDoc: (payload: { docType: 'agent' | 'soul' | 'user' | 'creator_profile'; markdown: string; reason?: string }) => Promise<{
          success?: boolean;
          docType?: string;
          fileName?: string;
          path?: string;
          content?: string;
          reason?: string;
          error?: string;
        }>;
        getOnboardingStatus: () => Promise<{
          completed?: boolean;
          state?: Record<string, unknown>;
        }>;
        onboardingTurn: (payload: { input: string }) => Promise<{
          handled?: boolean;
          completed?: boolean;
          responseText?: string;
        }>;
      };
      assistantDaemon: {
        getStatus: () => Promise<{
          enabled: boolean;
          autoStart: boolean;
          keepAliveWhenNoWindow: boolean;
          host: string;
          port: number;
          listening: boolean;
          lockState: 'owner' | 'passive';
          blockedBy: string | null;
          lastError: string | null;
          activeTaskCount: number;
          queuedPeerCount: number;
          inFlightKeys: string[];
          feishu: {
            enabled: boolean;
            receiveMode: 'webhook' | 'websocket';
            endpointPath: string;
            verificationToken?: string;
            encryptKey?: string;
            appId?: string;
            appSecret?: string;
            replyUsingChatId: boolean;
            webhookUrl: string;
            websocketRunning: boolean;
            websocketReconnectAt?: string | null;
          };
          relay: {
            enabled: boolean;
            endpointPath: string;
            authToken?: string;
            webhookUrl: string;
          };
          knowledgeApi: {
            endpointPath: string;
            webhookUrl: string;
          };
          weixin: {
            enabled: boolean;
            endpointPath: string;
            authToken?: string;
            accountId?: string;
            autoStartSidecar: boolean;
            cursorFile?: string;
            sidecarCommand?: string;
            sidecarArgs?: string[];
            sidecarCwd?: string;
            sidecarEnv?: Record<string, string>;
            webhookUrl: string;
            sidecarRunning: boolean;
            sidecarPid?: number;
            connected: boolean;
            userId?: string;
            stateDir: string;
            availableAccountIds: string[];
          };
        }>;
        start: (payload?: {
          enabled?: boolean;
          autoStart?: boolean;
          keepAliveWhenNoWindow?: boolean;
          host?: string;
          port?: number;
          feishu?: {
            enabled?: boolean;
            receiveMode?: 'webhook' | 'websocket';
            endpointPath?: string;
            verificationToken?: string;
            encryptKey?: string;
            appId?: string;
            appSecret?: string;
            replyUsingChatId?: boolean;
          };
          relay?: {
            enabled?: boolean;
            endpointPath?: string;
            authToken?: string;
          };
          weixin?: {
            enabled?: boolean;
            endpointPath?: string;
            authToken?: string;
            accountId?: string;
            autoStartSidecar?: boolean;
            cursorFile?: string;
            sidecarCommand?: string;
            sidecarArgs?: string[];
            sidecarCwd?: string;
            sidecarEnv?: Record<string, string>;
          };
        }) => Promise<unknown>;
        stop: () => Promise<unknown>;
        setConfig: (payload?: {
          enabled?: boolean;
          autoStart?: boolean;
          keepAliveWhenNoWindow?: boolean;
          host?: string;
          port?: number;
          feishu?: {
            enabled?: boolean;
            receiveMode?: 'webhook' | 'websocket';
            endpointPath?: string;
            verificationToken?: string;
            encryptKey?: string;
            appId?: string;
            appSecret?: string;
            replyUsingChatId?: boolean;
          };
          relay?: {
            enabled?: boolean;
            endpointPath?: string;
            authToken?: string;
          };
          weixin?: {
            enabled?: boolean;
            endpointPath?: string;
            authToken?: string;
            accountId?: string;
            autoStartSidecar?: boolean;
            cursorFile?: string;
            sidecarCommand?: string;
            sidecarArgs?: string[];
            sidecarCwd?: string;
            sidecarEnv?: Record<string, string>;
          };
        }) => Promise<unknown>;
        startWeixinLogin: (payload?: {
          accountId?: string;
          force?: boolean;
        }) => Promise<{
          success: boolean;
          sessionKey?: string;
          qrcodeUrl?: string;
          message: string;
          stateDir: string;
        }>;
        waitForWeixinLogin: (payload?: {
          sessionKey?: string;
          timeoutMs?: number;
        }) => Promise<{
          success: boolean;
          connected: boolean;
          message: string;
          accountId?: string;
          userId?: string;
        }>;
      };
      wechatOfficial: {
        getStatus: () => Promise<{
          success: boolean;
          error?: string;
          bindings: Array<{
            id: string;
            name: string;
            appId: string;
            createdAt: string;
            updatedAt: string;
            verifiedAt?: string;
            isActive: boolean;
          }>;
          activeBinding?: {
            id: string;
            name: string;
            appId: string;
            createdAt: string;
            updatedAt: string;
            verifiedAt?: string;
            isActive: boolean;
          };
        }>;
        bind: (payload: {
          name?: string;
          appId: string;
          secret: string;
          setActive?: boolean;
        }) => Promise<{
          success: boolean;
          error?: string;
          binding?: {
            id: string;
            name: string;
            appId: string;
            createdAt: string;
            updatedAt: string;
            verifiedAt?: string;
            isActive: boolean;
          };
        }>;
        unbind: (payload?: { bindingId?: string }) => Promise<{
          success: boolean;
          error?: string;
        }>;
        createDraft: (payload: {
          bindingId?: string;
          title?: string;
          content: string;
          metadata?: Record<string, unknown>;
          sourcePath?: string;
        }) => Promise<{
          success: boolean;
          error?: string;
          title?: string;
          digest?: string;
          mediaId?: string;
        }>;
      };
      mcp: {
        sessions: () => Promise<{ success: boolean; sessions: Array<{
          key: string;
          serverId: string;
          serverName: string;
          transport: 'stdio' | 'sse' | 'streamable-http' | string;
          connectionStrategy: string;
          initializedAt: number;
          lastUsedAt: number;
          callCount: number;
          toolCount: number;
          resourceCount: number;
          resourceTemplateCount: number;
        }>; error?: string }>;
        list: () => Promise<{ success: boolean; servers: Array<{
          id: string;
          name: string;
          enabled: boolean;
          transport: 'stdio' | 'sse' | 'streamable-http';
          command?: string;
          args?: string[];
          env?: Record<string, string>;
          url?: string;
          oauth?: {
            enabled?: boolean;
            tokenPath?: string;
          };
        }>; items?: Array<{ server: unknown; session?: unknown }>; sessions?: unknown[] }>;
        save: (servers: unknown[]) => Promise<{ success: boolean; servers?: unknown[]; error?: string }>;
        test: (server: unknown) => Promise<{ success: boolean; message: string; detail?: string; session?: unknown; capabilities?: unknown }>;
        call: (server: unknown, method: string, params?: unknown) => Promise<{ success: boolean; response?: unknown; session?: unknown; capabilities?: unknown; error?: string }>;
        listTools: (server: unknown) => Promise<{ success: boolean; response?: unknown; session?: unknown; capabilities?: unknown; error?: string }>;
        listResources: (server: unknown) => Promise<{ success: boolean; response?: unknown; session?: unknown; capabilities?: unknown; error?: string }>;
        listResourceTemplates: (server: unknown) => Promise<{ success: boolean; response?: unknown; session?: unknown; capabilities?: unknown; error?: string }>;
        disconnect: (server: unknown) => Promise<{ success: boolean; disconnected?: boolean; sessions?: unknown[]; error?: string }>;
        disconnectAll: () => Promise<{ success: boolean; disconnected?: number; sessions?: unknown[]; error?: string }>;
        discoverLocal: () => Promise<{ success: boolean; items: Array<{ sourcePath: string; count: number; servers: unknown[] }>; error?: string }>;
        importLocal: () => Promise<{ success: boolean; imported?: number; total?: number; sources?: string[]; servers?: unknown[]; error?: string }>;
        oauthStatus: (serverId: string) => Promise<{ success: boolean; connected?: boolean; tokenPath?: string; error?: string }>;
      };
    };
  }

  interface SkillDefinition {
    name: string;
    description: string;
    location: string;
    body: string;
    baseDir?: string;
    aliases?: string[];
    sourceScope?: string;
    isBuiltin?: boolean;
    disabled?: boolean;
  }

  interface ToolConfirmationDetails {
    type: 'edit' | 'exec' | 'info';
    title: string;
    description: string;
    impact?: string;
  }

  interface ToolConfirmRequest {
    callId: string;
    name: string;
    details: ToolConfirmationDetails;
  }
}
