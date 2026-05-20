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

export interface NotificationSettingsPayload {
  enabled: boolean;
  inApp: {
    enabled: boolean;
    maxVisible: number;
    autoCloseMs: number;
  };
  sound: {
    enabled: boolean;
    volume: number;
    muteWhenFocused: boolean;
    success: boolean;
    failure: boolean;
    attention: boolean;
  };
  system: {
    enabled: boolean;
  };
  quietHours: {
    enabled: boolean;
    start: string;
    end: string;
  };
  rules: {
    runtimeBackgroundDone: boolean;
    runtimeFailed: boolean;
    runtimeNeedsApproval: boolean;
    generationCompleted: boolean;
    generationFailed: boolean;
    redclawCompleted: boolean;
    redclawFailed: boolean;
  };
}

export interface NotificationPermissionState {
  state: 'granted' | 'denied' | 'prompt' | 'unknown';
}

export interface ThrivePluginSummary {
  id: string;
  name: string;
  displayName: string;
  version: string;
  description?: string | null;
  enabled: boolean;
  marketplace: string;
  installedAt: string;
  updatedAt: string;
  root: string;
  dataDir: string;
  capabilities: string[];
  approvalRequired: string[];
  uiSlots: string[];
  mcpServersPath?: string | null;
  skillsPath?: string | null;
  actionsPath?: string | null;
  mediaPath?: string | null;
  homeWidgets?: number;
  homeQuickActions?: number;
  error?: string | null;
}

export interface ThrivePluginMarketplaceItem {
  id: string;
  name: string;
  author: string;
  description: string;
  repo: string;
  version?: string | null;
  displayName?: string | null;
  capabilities: string[];
  packageUrl?: string | null;
  packageAssetName?: string | null;
  manifestUrl?: string | null;
  installed: boolean;
  installedPluginId?: string | null;
  error?: string | null;
}

export interface ThrivePluginMarketplaceResponse {
  success: boolean;
  registryUrl: string;
  plugins: ThrivePluginMarketplaceItem[];
  error?: string;
}

export interface ThriveSkillMarketplaceItem {
  id: string;
  name: string;
  author: string;
  description: string;
  repo: string;
  installed?: boolean;
}

export interface ThriveSkillMarketplaceResponse {
  success: boolean;
  registryUrl?: string;
  skills: ThriveSkillMarketplaceItem[];
  error?: string;
}

export interface ThrivePluginHomeWidget {
  id: string;
  pluginId: string;
  pluginName?: string;
  zone?: 'main' | 'sidebar' | string;
  title: string;
  subtitle?: string | null;
  kind: 'metric' | 'list' | 'prompt' | 'action' | string;
  source?: string | null;
  label?: string | null;
  prompt?: string | null;
  icon?: string | null;
  tone?: string | null;
  order?: number;
  limit?: number;
  data?: Record<string, unknown> | null;
}

export interface ThrivePluginHomeAction {
  id: string;
  pluginId: string;
  pluginName?: string;
  label: string;
  prompt?: string | null;
  target?: 'redclaw' | 'coverStudio' | 'generationStudio' | 'manuscripts' | string | null;
  mode?: string | null;
  icon?: string | null;
  tone?: string | null;
  order?: number;
}

export interface ThrivePluginHomeResponse {
  success: boolean;
  widgets: ThrivePluginHomeWidget[];
  sidebarSections: ThrivePluginHomeWidget[];
  quickActions: ThrivePluginHomeAction[];
  error?: string;
}

export interface VideoEditorV2ProjectSummary {
  id: string;
  title: string;
  projectDir: string;
  status: string;
  updatedAt: string;
  assets: Array<{
    id: string;
    kind: 'video' | 'audio' | 'image';
    title: string;
    projectPath: string;
    proxyPath?: string | null;
    thumbnailPath?: string | null;
    durationMs?: number;
    width?: number;
    height?: number;
    fps?: number;
  }>;
  transcriptTracks: Array<{
    id: string;
    assetId: string;
    segments: Array<{
      id: string;
      index: number;
      assetId: string;
      startMs: number;
      endMs: number;
      text: string;
      tags: string[];
    }>;
  }>;
  timeline?: {
    id: string;
    durationMs: number;
    tracks: Array<{
      id: string;
      kind: string;
      name: string;
      clips: Array<{
        id: string;
        assetId?: string;
        transcriptSegmentIds?: string[];
        disabled?: boolean;
        sourceStartMs: number;
        sourceEndMs: number;
        timelineStartMs: number;
        timelineEndMs: number;
        text?: string;
      }>;
    }>;
  };
  autoEditRuns?: Array<{
    id: string;
    createdAt: string;
    appliedAt?: string | null;
    trackId?: string;
    userGoal: string;
    targetDurationMs?: number | null;
    status: string;
    plan?: {
      summary?: string;
      warnings?: string[];
      selectedSegments?: unknown[];
      removedSegments?: unknown[];
    };
    decisions?: unknown[];
  }>;
  undoStack?: Array<{
    id: string;
    createdAt: string;
    label: string;
  }>;
  remotionSnapshot?: {
    compositionPath: string;
    updatedAt: string;
  } | null;
  renderOutputs?: Array<{
    id: string;
    path: string;
    createdAt: string;
    durationMs?: number;
  }>;
  lastError?: string | null;
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
  | 'runtime:cli-tool-detected'
  | 'runtime:cli-install-started'
  | 'runtime:cli-install-finished'
  | 'runtime:cli-execution-started'
  | 'runtime:cli-execution-log'
  | 'runtime:cli-execution-status'
  | 'runtime:cli-escalation-requested'
  | 'runtime:cli-escalation-resolved'
  | 'runtime:cli-verification-finished'
  | 'runtime:collab-session-changed'
  | 'runtime:collab-member-changed'
  | 'runtime:collab-task-changed'
  | 'runtime:collab-report-submitted'
  | 'runtime:collab-message-delivered'
  | 'runtime:collab-report-tick'
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

export interface CollabSessionRecord {
  id: string;
  ownerSessionId?: string | null;
  coordinatorMemberId?: string | null;
  workspaceRoot?: string | null;
  title: string;
  objective: string;
  status: string;
  runtimeMode: string;
  source: string;
  metadata?: Record<string, unknown> | null;
  createdAt: number;
  updatedAt: number;
  completedAt?: number | null;
}

export interface CollabMemberRecord {
  id: string;
  sessionId: string;
  displayName: string;
  roleId: string;
  sourceKind: string;
  backend: string;
  adapterKind: string;
  status: string;
  currentTaskId?: string | null;
  conversationId?: string | null;
  runtimeId?: string | null;
  capabilities: string[];
  allowedTools: string[];
  progressIntervalMs: number;
  reportIntervalSeconds: number;
  lastSeenAt?: number | null;
  lastReportAt?: number | null;
  lastActivityAt?: number | null;
  lastError?: string | null;
  metadata?: Record<string, unknown> | null;
}

export interface CollabTaskRecord {
  id: string;
  sessionId: string;
  parentTaskId?: string | null;
  source: string;
  memberId?: string | null;
  assigneeAgentId?: string | null;
  reviewerMemberId?: string | null;
  title: string;
  objective: string;
  description: string;
  status: string;
  priority: number;
  taskType: string;
  dependsOnTaskIds: string[];
  blockedByTaskIds: string[];
  blocksTaskIds: string[];
  runtimeTaskId?: string | null;
  externalTaskRef?: string | null;
  attempt: number;
  maxAttempts: number;
  leaseOwner?: string | null;
  leaseExpiresAt?: number | null;
  sessionResumeId?: string | null;
  workDir?: string | null;
  failureReason?: string | null;
  resultSummary?: string | null;
  progressPercent?: number | null;
  artifacts: unknown[];
  artifactIds: string[];
  dueAt?: number | null;
  metadata?: Record<string, unknown> | null;
  createdAt: number;
  updatedAt: number;
  startedAt?: number | null;
  completedAt?: number | null;
}

export interface CollabMailboxMessageRecord {
  id: string;
  sessionId: string;
  fromMemberId?: string | null;
  toMemberId?: string | null;
  fromKind: string;
  taskId?: string | null;
  kind: string;
  messageType: string;
  status: string;
  subject?: string | null;
  body: string;
  attachmentRefs: string[];
  payload?: Record<string, unknown> | null;
  createdAt: number;
  readAt?: number | null;
}

export interface CollabProgressReportRecord {
  id: string;
  sessionId: string;
  memberId: string;
  taskId?: string | null;
  reportType: string;
  status: string;
  summary: string;
  nextAction?: string | null;
  nextSteps: string[];
  progressPercent?: number | null;
  blockers: string[];
  artifacts: unknown[];
  artifactIds: string[];
  payload?: Record<string, unknown> | null;
  createdAt: number;
}

export interface ReviewDocketRecord {
  id: string;
  sourceKind: string;
  sourceId?: string | null;
  sessionId?: string | null;
  taskId?: string | null;
  title: string;
  summary: string;
  body: string;
  decisionType: string;
  priority: string;
  status: string;
  riskLevel: string;
  proposedAction?: Record<string, unknown> | null;
  evidenceRefs: unknown[];
  artifactRefs: string[];
  options: unknown[];
  createdByAgentId?: string | null;
  assignedToUserId?: string | null;
  expiresAt?: number | null;
  createdAt: number;
  updatedAt: number;
  decidedAt?: number | null;
}

export interface ReviewDecisionRecord {
  id: string;
  docketId: string;
  decision: string;
  comment?: string | null;
  selectedOptionId?: string | null;
  patch?: Record<string, unknown> | null;
  decidedAt: number;
}

export interface ReviewDocketStats {
  total: number;
  pending: number;
  approved: number;
  rejected: number;
  changesRequested: number;
  skipped: number;
  archived: number;
  expiredPending: number;
  linkedTasks: number;
}

export interface TaskPanelItem {
  id: string;
  source: 'redclaw' | 'collaboration' | 'approval' | string;
  sourceLabel: string;
  sourceId?: string | null;
  sourceTaskId?: string | null;
  title: string;
  summary: string;
  status: 'queued' | 'running' | 'review' | 'blocked' | 'completed' | 'failed' | 'paused' | string;
  owner: string;
  sessionTitle: string;
  priorityLabel: string;
  progress: number;
  artifactCount: number;
  updatedAt: number;
  createdAt: number;
  reviewCount: number;
  taskId?: string | null;
  definitionId?: string | null;
  latestReportSummary?: string;
  failureReason?: string | null;
  latestExecution?: {
    status?: string;
    scheduledForAt?: string | null;
    lastHeartbeatAt?: string | null;
    lastError?: string | null;
  } | null;
}

export interface TaskPanelListResponse {
  success?: boolean;
  items?: TaskPanelItem[];
  count?: number;
}

export interface CollabMemberMatchCandidate {
  memberId: string;
  displayName?: string;
  roleId?: string;
  status?: string;
  score?: number;
  reasons?: string[];
  activeExecutorCount?: number;
  maxExecutorThreads?: number;
  agentCard?: Record<string, unknown>;
}

export interface CollabMemberMatchResult {
  sessionId: string;
  query?: Record<string, unknown>;
  candidates: CollabMemberMatchCandidate[];
}

export interface CollabSessionSnapshot {
  session: CollabSessionRecord;
  members: CollabMemberRecord[];
  tasks: CollabTaskRecord[];
  mailbox: CollabMailboxMessageRecord[];
  reports: CollabProgressReportRecord[];
}

export type CliRuntimeToolSource =
  | 'system'
  | 'app-managed'
  | 'workspace-managed'
  | 'user-declared'
  | 'unknown';

export type CliRuntimeToolHealth =
  | 'unknown'
  | 'ready'
  | 'missing'
  | 'broken';

export type CliRuntimeResolvedFrom =
  | 'host-shell-path'
  | 'extra-bin-path'
  | 'managed-environment'
  | 'explicit-path'
  | 'unknown';

export type CliRuntimeEnvironmentScope =
  | 'app-global'
  | 'workspace-local'
  | 'task-ephemeral';

export type CliRuntimeExecutionStatus =
  | 'pending'
  | 'running'
  | 'waiting-approval'
  | 'completed'
  | 'failed'
  | 'cancelled';

export type CliRuntimeEscalationScope = 'once' | 'session' | 'always';

export interface CliRuntimeToolRecord {
  id: string;
  name: string;
  executable: string;
  resolvedPath?: string | null;
  resolvedFrom?: CliRuntimeResolvedFrom | null;
  source: CliRuntimeToolSource;
  installMethod?: string | null;
  installSpec?: string | null;
  version?: string | null;
  health: CliRuntimeToolHealth;
  manifestId?: string | null;
  environmentId?: string | null;
  lastCheckedAt?: number | null;
  effectivePathPreview?: string[];
  searchedPathEntriesCount?: number | null;
  isInDefaultDetectCatalog?: boolean;
  metadata?: Record<string, unknown> | null;
}

export interface CliRuntimeEnvironmentRecord {
  id: string;
  scope: CliRuntimeEnvironmentScope;
  rootPath: string;
  workspaceRoot?: string | null;
  pathEntries: string[];
  installedToolIds: string[];
  runtimes?: Record<string, unknown> | null;
  createdAt?: number | null;
  updatedAt?: number | null;
  metadata?: Record<string, unknown> | null;
}

export interface CliRuntimeVerificationRecord {
  ruleType?: string;
  status?: 'passed' | 'failed' | 'skipped' | 'unknown';
  summary?: string;
  detail?: string;
  payload?: Record<string, unknown> | null;
}

export interface CliRuntimeExecutionRecord {
  id: string;
  sessionId?: string | null;
  taskId?: string | null;
  runtimeId?: string | null;
  environmentId?: string | null;
  toolId?: string | null;
  toolName?: string | null;
  argv: string[];
  cwd?: string | null;
  commandPreview?: string | null;
  status: CliRuntimeExecutionStatus;
  usePty?: boolean;
  exitCode?: number | null;
  summary?: string | null;
  lastLogChunk?: string | null;
  startedAt?: number | null;
  updatedAt?: number | null;
  completedAt?: number | null;
  verificationResults?: CliRuntimeVerificationRecord[];
  metadata?: Record<string, unknown> | null;
}

export interface CliRuntimeEscalationRequest {
  escalationId: string;
  sessionId?: string | null;
  taskId?: string | null;
  runtimeId?: string | null;
  executionId?: string | null;
  title: string;
  description: string;
  reason?: string;
  commandPreview?: string;
  permissionSummary?: string[];
  scopeOptions?: CliRuntimeEscalationScope[];
  requestedAt?: number | null;
  metadata?: Record<string, unknown> | null;
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

export interface DiagnosticsLogStatus {
  enabled: boolean;
  logDirectory: string;
  reportDirectory?: string;
  retentionDays?: number;
  maxFileMb?: number;
  recentPreviewLimit?: number;
  uploadConfigured?: boolean;
  uploadEndpoint?: string | null;
  pendingCount?: number;
  debugVerboseEnabled?: boolean;
  previousUncleanShutdown?: boolean;
}

export interface DiagnosticsPendingReport {
  id: string;
  trigger: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  summary: string;
  includeAdvancedContext: boolean;
  lastError?: string | null;
  uploadedAt?: string | null;
  lastAttemptAt?: string | null;
  dedupeKey?: string | null;
  bundleFileName?: string | null;
  metadata?: unknown;
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
    createdAt?: string;
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
      createdAt?: string;
    } | null;
  }

  interface ChatMessage {
    id: string;
    session_id: string;
    role: string;
    content: string;
    display_content?: string;
    attachment?: unknown;
    metadata?: unknown;
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
    videoPath?: string;
    voiceScript?: string;
    createdAt: string;
    updatedAt: string;
    absoluteImagePaths?: string[];
    previewUrls?: string[];
    primaryPreviewUrl?: string;
    absoluteVoicePath?: string;
    voicePreviewUrl?: string;
    absoluteVideoPath?: string;
    videoPreviewUrl?: string;
    voice?: Record<string, unknown>;
    video?: Record<string, unknown>;
  }

  interface Window {
    ipcRenderer: {
      windowControls: {
        startDragging: () => Promise<void>;
        minimize: () => Promise<void>;
        toggleMaximize: () => Promise<void>;
        close: () => Promise<void>;
      };
      audio: {
        getCaptureCapability: () => Promise<{
          success?: boolean;
          available?: boolean;
          activeRecording?: boolean;
          platform?: string;
          reason?: string | null;
          message?: string;
          error?: string;
          deviceName?: string;
          sampleRate?: number;
          channels?: number;
          sampleFormat?: string;
        }>;
        startRecording: () => Promise<{ success?: boolean; error?: string; reason?: string; message?: string }>;
        stopRecording: () => Promise<{
          success?: boolean;
          error?: string;
          reason?: string;
          message?: string;
          clip?: {
            audioBase64: string;
            mimeType: string;
            fileName: string;
            durationMs?: number;
            byteLength?: number;
            sampleRate?: number;
            channels?: number;
            deviceName?: string;
            strategy?: string;
          };
        }>;
        cancelRecording: () => Promise<{ success?: boolean; error?: string; reason?: string; durationMs?: number; discarded?: boolean }>;
        openMicrophoneSettings: () => Promise<{ success?: boolean; error?: string; path?: string }>;
      };
      saveSettings: (settings: { api_endpoint?: string; api_key?: string; model_name?: string; model_name_wander?: string; model_name_chatroom?: string; model_name_knowledge?: string; model_name_redclaw?: string; search_provider?: string; search_endpoint?: string; search_api_key?: string; visual_index_enabled?: boolean; visual_index_provider?: string; visual_index_endpoint?: string; visual_index_api_key?: string; visual_index_model?: string; visual_index_prompt_version?: string; visual_index_timeout_seconds?: number; visual_index_max_image_edge?: number; visual_index_skip_small_images?: boolean; visual_index_pdf_max_pages?: number; visual_index_pdf_render_dpi?: number; visual_index_concurrency?: number; proxy_enabled?: boolean; proxy_url?: string; proxy_bypass?: string; workspace_dir?: string; active_space_id?: string; role_mapping?: Record<string, string> | string; transcription_model?: string; transcription_endpoint?: string; transcription_key?: string; embedding_endpoint?: string; embedding_key?: string; embedding_model?: string; ai_sources_json?: string; default_ai_source_id?: string; image_provider?: string; image_endpoint?: string; image_api_key?: string; image_model?: string; video_endpoint?: string; video_api_key?: string; video_model?: string; image_provider_template?: string; image_aspect_ratio?: string; image_size?: string; image_quality?: string; mcp_servers_json?: string; redclaw_compact_target_tokens?: number; wander_deep_think_enabled?: boolean; wander_skill_loading_enabled?: boolean; memberSkillDistillation?: boolean; memberRuntimeOverlay?: boolean; memberToolPolicy?: boolean; memberSkillAutoRefresh?: boolean; debug_log_enabled?: boolean; developer_mode_enabled?: boolean; developer_mode_unlocked_at?: string | null; cli_runtime_execution_mode?: string; chat_max_tokens_default?: number; chat_max_tokens_deepseek?: number; diagnostics_upload_consent?: 'none' | 'prompt' | 'approved'; diagnostics_include_advanced_context?: boolean; diagnostics_auto_send_same_crash?: boolean; diagnostics_last_prompted_at?: string | null; release_log_retention_days?: number; release_log_max_file_mb?: number; notifications_json?: string; ai_model_routes_json?: string }) => Promise<unknown>;
      getSettings: () => Promise<{ api_endpoint: string; api_key: string; model_name: string; model_name_wander?: string; model_name_chatroom?: string; model_name_knowledge?: string; model_name_redclaw?: string; search_provider?: string; search_endpoint?: string; search_api_key?: string; visual_index_enabled?: boolean; visual_index_provider?: string; visual_index_endpoint?: string; visual_index_api_key?: string; visual_index_model?: string; visual_index_prompt_version?: string; visual_index_timeout_seconds?: number; visual_index_max_image_edge?: number; visual_index_skip_small_images?: boolean; visual_index_pdf_max_pages?: number; visual_index_pdf_render_dpi?: number; visual_index_concurrency?: number; proxy_enabled?: boolean; proxy_url?: string; proxy_bypass?: string; workspace_dir?: string; active_space_id?: string; role_mapping?: string; transcription_model?: string; transcription_endpoint?: string; transcription_key?: string; embedding_endpoint?: string; embedding_key?: string; embedding_model?: string; ai_sources_json?: string; default_ai_source_id?: string; image_provider?: string; image_endpoint?: string; image_api_key?: string; image_model?: string; video_endpoint?: string; video_api_key?: string; video_model?: string; image_provider_template?: string; image_aspect_ratio?: string; image_size?: string; image_quality?: string; mcp_servers_json?: string; redclaw_compact_target_tokens?: number; wander_deep_think_enabled?: boolean; wander_skill_loading_enabled?: boolean; memberSkillDistillation?: boolean; memberRuntimeOverlay?: boolean; memberToolPolicy?: boolean; memberSkillAutoRefresh?: boolean; debug_log_enabled?: boolean; developer_mode_enabled?: boolean; developer_mode_unlocked_at?: string | null; chat_max_tokens_default?: number; chat_max_tokens_deepseek?: number; diagnostics_upload_consent?: 'none' | 'prompt' | 'approved'; diagnostics_include_advanced_context?: boolean; diagnostics_auto_send_same_crash?: boolean; diagnostics_last_prompted_at?: string | null; release_log_retention_days?: number; release_log_max_file_mb?: number; notifications_json?: string; ai_model_routes_json?: string } | undefined>;
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
      logs: {
        getStatus: () => Promise<DiagnosticsLogStatus>;
        getRecent: (limit?: number) => Promise<{ lines: string[] }>;
        openDir: () => Promise<{ success: boolean; error?: string; path: string }>;
        listPendingReports: () => Promise<DiagnosticsPendingReport[]>;
        exportBundle: (reportId?: string, payload?: { includeAdvancedContext?: boolean }) => Promise<{ success: boolean; reportId: string; path: string; error?: string }>;
        createFeedbackReport: (payload: { title?: string; content: string; category?: string; priority?: 'low' | 'medium' | 'high' | 'urgent'; source?: string; contact?: string; includeAdvancedContext?: boolean; uploadNow?: boolean; context?: Record<string, unknown> }) => Promise<{ success: boolean; uploaded?: boolean; report?: DiagnosticsPendingReport; response?: unknown; error?: string }>;
        uploadReport: (reportId: string) => Promise<{ success: boolean; report?: DiagnosticsPendingReport; response?: { reportId: string; receivedAt: string; retentionDays: number; dedupeKey: string }; error?: string }>;
        dismissReport: (reportId: string) => Promise<{ success: boolean; reportId: string; error?: string }>;
        setUploadConsent: (payload: { consent: 'none' | 'prompt' | 'approved'; autoSendSameCrash?: boolean }) => Promise<{ success: boolean; error?: string }>;
        appendRenderer: (payload: { level?: 'trace' | 'debug' | 'info' | 'warn' | 'error'; category?: string; event?: string; message?: string; fields?: unknown }) => Promise<{ success: boolean; error?: string }>;
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
        getPricing: () => Promise<{
          success: boolean;
          pricing?: Record<string, unknown> | null;
          stale?: boolean;
          error?: string;
        }>;
      };
      llmReadiness: {
        getState: () => Promise<{
          ready?: boolean;
          mode?: 'official' | 'custom' | 'local' | 'none' | string;
          reason?: string;
          sourceId?: string;
          sourceName?: string;
          baseURL?: string;
          model?: string;
          protocol?: 'openai' | 'anthropic' | 'gemini' | string;
          officialLoggedIn?: boolean;
          canUseOfficial?: boolean;
          canUseCustom?: boolean;
          updatedAt?: string;
        }>;
        refresh: () => Promise<unknown>;
        configureCustomSource: (payload: {
          baseURL: string;
          apiKey?: string;
          presetId?: string;
          protocol?: 'openai' | 'anthropic' | 'gemini' | string;
          preferredModel?: string;
          name?: string;
        }) => Promise<{
          success?: boolean;
          error?: string;
          source?: Record<string, unknown>;
          models?: Array<{ id: string; capabilities?: string[] }>;
          readiness?: Record<string, unknown>;
        }>;
        onStateChanged: (listener: (...args: any[]) => void) => void;
        offStateChanged: (listener: (...args: any[]) => void) => void;
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
      taskPanel: {
        list: (payload?: { limit?: number }) => Promise<TaskPanelListResponse>;
      };
      teamRuntime: {
        listSessions: () => Promise<CollabSessionRecord[]>;
        createSession: (payload: Record<string, unknown>) => Promise<CollabSessionRecord>;
        getSession: (payload: { sessionId: string; mailboxLimit?: number; reportLimit?: number }) => Promise<CollabSessionSnapshot>;
        listMembers: (payload: { sessionId: string }) => Promise<CollabMemberRecord[]>;
        addMember: (payload: Record<string, unknown>) => Promise<CollabMemberRecord>;
        setSessionCoordinator: (payload: Record<string, unknown>) => Promise<CollabSessionRecord>;
        matchMember: (payload: Record<string, unknown>) => Promise<CollabMemberMatchResult>;
        renameMember: (payload: Record<string, unknown>) => Promise<CollabMemberRecord>;
        shutdownMember: (payload: Record<string, unknown>) => Promise<CollabMemberRecord>;
        listTasks: (payload: { sessionId: string }) => Promise<CollabTaskRecord[]>;
        createTask: (payload: Record<string, unknown>) => Promise<CollabTaskRecord>;
        updateTask: (payload: Record<string, unknown>) => Promise<CollabTaskRecord>;
        claimTask: (payload: Record<string, unknown>) => Promise<CollabTaskRecord>;
        startTask: (payload: Record<string, unknown>) => Promise<CollabTaskRecord>;
        waitReviewTask: (payload: Record<string, unknown>) => Promise<CollabTaskRecord>;
        completeTask: (payload: Record<string, unknown>) => Promise<CollabTaskRecord>;
        failTask: (payload: Record<string, unknown>) => Promise<CollabTaskRecord>;
        cancelTask: (payload: Record<string, unknown>) => Promise<CollabTaskRecord>;
        pinTaskSession: (payload: Record<string, unknown>) => Promise<CollabTaskRecord>;
        retryTask: (payload: Record<string, unknown>) => Promise<CollabTaskRecord>;
        listReviewDockets: (payload?: Record<string, unknown>) => Promise<ReviewDocketRecord[]>;
        getReviewDocket: (payload: { docketId: string }) => Promise<ReviewDocketRecord>;
        reviewDocketStats: () => Promise<ReviewDocketStats>;
        createReviewDocket: (payload: Record<string, unknown>) => Promise<ReviewDocketRecord>;
        decideReviewDocket: (payload: Record<string, unknown>) => Promise<ReviewDecisionRecord>;
        skipReviewDocket: (payload: { docketId: string }) => Promise<ReviewDocketRecord>;
        archiveReviewDocket: (payload: { docketId: string }) => Promise<ReviewDocketRecord>;
        listMessages: (payload: { sessionId: string; memberId?: string; taskId?: string; unreadOnly?: boolean; limit?: number }) => Promise<CollabMailboxMessageRecord[]>;
        readMailbox: (payload: { sessionId: string; memberId?: string; taskId?: string; unreadOnly?: boolean; markRead?: boolean; limit?: number }) => Promise<CollabMailboxMessageRecord[]>;
        sendMessage: (payload: Record<string, unknown>) => Promise<CollabMailboxMessageRecord>;
        listReports: (payload: { sessionId: string; memberId?: string; taskId?: string; limit?: number }) => Promise<CollabProgressReportRecord[]>;
        requestReport: (payload: Record<string, unknown>) => Promise<CollabMailboxMessageRecord>;
        submitReport: (payload: Record<string, unknown>) => Promise<CollabProgressReportRecord>;
        attachArtifact: (payload: Record<string, unknown>) => Promise<CollabProgressReportRecord>;
        raiseBlocker: (payload: Record<string, unknown>) => Promise<CollabProgressReportRecord>;
        pauseSession: (payload: { sessionId: string }) => Promise<CollabSessionRecord>;
        resumeSession: (payload: { sessionId: string }) => Promise<CollabSessionRecord>;
        archiveSession: (payload: { sessionId: string }) => Promise<CollabSessionRecord>;
        tickReports: (payload: { sessionId: string }) => Promise<Record<string, unknown>>;
        listAgentBackends: () => Promise<Array<Record<string, unknown>>>;
        listTools: () => Promise<Array<Record<string, unknown>>>;
        executeTool: (payload: { action: string; payload?: Record<string, unknown> }) => Promise<unknown>;
        runExternalMember: (payload: Record<string, unknown>) => Promise<Record<string, unknown>>;
        onEvent: (listener: (event: RuntimeUnifiedEvent) => void) => void;
        offEvent: (listener: (event: RuntimeUnifiedEvent) => void) => void;
      };
      collab: Window['ipcRenderer']['teamRuntime'];
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
        generateCharacterCard: (payload: { id: string }) => Promise<{ success?: boolean; error?: string; subject?: SubjectRecord; asset?: unknown }>;
        delete: (payload: { id: string }) => Promise<{ success?: boolean; error?: string }>;
        search: (payload?: { query?: string; categoryId?: string; limit?: number }) => Promise<{ success?: boolean; error?: string; subjects?: SubjectRecord[] }>;
        categories: {
          list: () => Promise<{ success?: boolean; error?: string; categories?: SubjectCategory[] }>;
          create: (payload: { name: string }) => Promise<{ success?: boolean; error?: string; category?: SubjectCategory }>;
          update: (payload: { id: string; name: string }) => Promise<{ success?: boolean; error?: string; category?: SubjectCategory }>;
          delete: (payload: { id: string }) => Promise<{ success?: boolean; error?: string }>;
        };
      };
      videoEditorV2: {
        getOrCreateForManuscript: (payload: { manuscriptPath: string; title?: string }) => Promise<{ success?: boolean; error?: string; project?: VideoEditorV2ProjectSummary }>;
        createProject: (payload?: Record<string, unknown>) => Promise<{ success?: boolean; error?: string; project?: VideoEditorV2ProjectSummary }>;
        getProject: (payload: { projectId: string }) => Promise<{ success?: boolean; error?: string; project?: VideoEditorV2ProjectSummary }>;
        importAssets: (payload: { projectId: string; sourcePaths?: string[] }) => Promise<{ success?: boolean; canceled?: boolean; error?: string; project?: VideoEditorV2ProjectSummary }>;
        importSrt: (payload: { projectId: string; assetId?: string; srtPath?: string; srtContent?: string; language?: string }) => Promise<{ success?: boolean; canceled?: boolean; error?: string; project?: VideoEditorV2ProjectSummary }>;
        runAsr: (payload: { projectId: string; assetId: string; language?: string }) => Promise<{ success?: boolean; error?: string; project?: VideoEditorV2ProjectSummary }>;
        updateSrtSegment: (payload: Record<string, unknown>) => Promise<{ success?: boolean; error?: string; project?: VideoEditorV2ProjectSummary }>;
        mergeSrtSegments: (payload: Record<string, unknown>) => Promise<{ success?: boolean; error?: string; project?: VideoEditorV2ProjectSummary }>;
        splitSrtSegment: (payload: Record<string, unknown>) => Promise<{ success?: boolean; error?: string; project?: VideoEditorV2ProjectSummary }>;
        setTimelineClipDisabled: (payload: Record<string, unknown>) => Promise<{ success?: boolean; error?: string; project?: VideoEditorV2ProjectSummary }>;
        trimTimelineClip: (payload: Record<string, unknown>) => Promise<{ success?: boolean; error?: string; project?: VideoEditorV2ProjectSummary }>;
        splitTimelineClip: (payload: Record<string, unknown>) => Promise<{ success?: boolean; error?: string; project?: VideoEditorV2ProjectSummary }>;
        reorderTimelineClip: (payload: Record<string, unknown>) => Promise<{ success?: boolean; error?: string; project?: VideoEditorV2ProjectSummary }>;
        undoTimeline: (payload: Record<string, unknown>) => Promise<{ success?: boolean; error?: string; project?: VideoEditorV2ProjectSummary }>;
        generateAutoEdit: (payload: Record<string, unknown>) => Promise<{ success?: boolean; error?: string; project?: VideoEditorV2ProjectSummary }>;
        applyAutoEdit: (payload: Record<string, unknown>) => Promise<{ success?: boolean; error?: string; project?: VideoEditorV2ProjectSummary }>;
        render: (payload: Record<string, unknown>) => Promise<{ success?: boolean; error?: string; project?: VideoEditorV2ProjectSummary; outputPath?: string; compositionPath?: string; subtitlePath?: string | null }>;
      };
      getAppVersion: () => Promise<string>;
      checkAppUpdate: (force?: boolean) => Promise<{ success: boolean; hasUpdate: boolean; throttled?: boolean; inFlight?: boolean; message?: string; notice?: { currentVersion: string; latestVersion: string; htmlUrl: string; name: string; publishedAt: string; body: string } }>;
      openAppReleasePage: (url?: string) => Promise<{ success: boolean; error?: string }>;
      openPath: (path: string) => Promise<{ success: boolean; error?: string }>;
      clipboardReadText: () => Promise<string>;
      openKnowledgeApiGuide: () => Promise<{ success: boolean; path?: string; error?: string }>;
      plugins: {
        list: () => Promise<{ success: boolean; schemaVersion: number; root: string; plugins: ThrivePluginSummary[]; error?: string }>;
        marketplace: (payload?: { url?: string }) => Promise<ThrivePluginMarketplaceResponse>;
        install: (payload: { path: string }) => Promise<{ success: boolean; plugin?: ThrivePluginSummary; error?: string }>;
        installMarketplace: (payload: { id?: string; repo: string; version?: string; packageUrl?: string }) => Promise<{ success: boolean; plugin?: ThrivePluginSummary; error?: string }>;
        setEnabled: (payload: { pluginId: string; enabled: boolean }) => Promise<{ success: boolean; plugin?: ThrivePluginSummary; error?: string }>;
        uninstall: (payload: { pluginId: string }) => Promise<{ success: boolean; pluginId?: string; error?: string }>;
        openDataDir: (payload?: { pluginId?: string }) => Promise<{ success: boolean; path?: string; error?: string }>;
        syncCapabilities: () => Promise<{ success: boolean; pluginIds?: string[]; skills?: number; mcpServers?: number; error?: string }>;
        readData: (payload: { pluginId: string; source: string; limit?: number; kind?: string; query?: string }) => Promise<{ success: boolean; pluginId?: string; source?: string; data?: Record<string, unknown>; error?: string }>;
        home: () => Promise<ThrivePluginHomeResponse>;
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
        uninstall: (payload: { name: string; scope?: 'user' | 'workspace' | string }) => Promise<unknown>;
        marketplace: (payload?: { url?: string }) => Promise<ThriveSkillMarketplaceResponse>;
        marketInstall: (payload: { slug?: string; id?: string; repo?: string; tag?: string; ref?: string; refName?: string }) => Promise<unknown>;
        installFromRepo: (payload: {
          source?: string;
          url?: string;
          repo?: string;
          ref?: string;
          refName?: string;
          path?: string;
          paths?: string[];
          scope?: 'user' | 'workspace' | string;
        }) => Promise<unknown>;
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
        create: () => Promise<unknown>;
        rename: (payload: { id: string; name: string }) => Promise<unknown>;
        delete: (spaceId: string) => Promise<unknown>;
      };
      advisors: {
        list: <T = Record<string, unknown>>() => Promise<Array<T>>;
        listTemplates: <T = Record<string, unknown>>() => Promise<Array<T>>;
        create: (payload: Record<string, unknown>) => Promise<unknown>;
        update: (payload: Record<string, unknown>) => Promise<unknown>;
        delete: (advisorId: string) => Promise<unknown>;
        pickKnowledgeFiles: <T = Record<string, unknown>>() => Promise<T>;
        pickKnowledgeFolder: <T = Record<string, unknown>>() => Promise<T>;
        uploadKnowledge: (payload: string | { advisorId: string; filePaths?: string[] }) => Promise<unknown>;
        deleteKnowledge: (payload: { advisorId: string; fileName: string }) => Promise<unknown>;
        inspectMemberSkill: (payload: { advisorId: string }) => Promise<unknown>;
        distillMemberSkill: (payload: { advisorId: string }) => Promise<unknown>;
        promoteMemberSkillCandidate: (payload: { advisorId: string; candidateVersion?: string }) => Promise<unknown>;
        discardMemberSkillCandidate: (payload: { advisorId: string }) => Promise<unknown>;
        rollbackMemberSkillVersion: (payload: { advisorId: string; version: string }) => Promise<unknown>;
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
        getFileIndexDashboard: <T = Record<string, unknown>>() => Promise<T>;
        rebuildCatalog: (payload?: { mode?: 'full' | 'fts' | 'canonicalBlocks' | 'canonicalReparse'; sourceId?: string; includeVisualIndex?: boolean }) => Promise<unknown>;
        openIndexRoot: () => Promise<unknown>;
        deleteNote: (noteId: string) => Promise<unknown>;
        deleteBatch: (payload: { items: Array<{ id: string; kind: 'redbook-note' | 'link-article' | 'wechat-article' | 'zhihu-answer' | 'zhihu-article' | 'youtube-video' | 'document-source' }> }) => Promise<unknown>;
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
        saveAs: (payload: { source: string; defaultName?: string }) => Promise<unknown>;
        resolvePreview: (payload: { source: string }) => Promise<{
          success: boolean;
          error?: string;
          isLocal?: boolean;
          exists?: boolean;
          isDirectory?: boolean;
          absolutePath?: string | null;
          localPathCandidate?: string | null;
          resolvedUrl?: string | null;
          title?: string | null;
          extension?: string | null;
          kind?: string | null;
          mimeType?: string | null;
          sizeBytes?: number | null;
          previewText?: string | null;
        }>;
      };
      notifications: {
        getPermissionState: () => Promise<NotificationPermissionState>;
        requestPermission: () => Promise<NotificationPermissionState>;
        showSystem: (payload: { title: string; body?: string; sound?: string }) => Promise<{ success: boolean; error?: string }>;
        syncRemote: (payload?: { cursor?: string | null; limit?: number; unreadOnly?: boolean }) => Promise<{
          success: boolean;
          status?: number;
          data?: Record<string, unknown>;
          raw?: Record<string, unknown>;
          context?: { appSlug?: string; userId?: string; realm?: string; baseUrl?: string };
          error?: string;
        }>;
        listRemote: (payload?: { limit?: number; unreadOnly?: boolean }) => Promise<{
          success: boolean;
          status?: number;
          data?: Record<string, unknown>;
          raw?: Record<string, unknown>;
          context?: { appSlug?: string; userId?: string; realm?: string; baseUrl?: string };
          error?: string;
        }>;
        markRemoteRead: (payload: { notificationId: string }) => Promise<{
          success: boolean;
          status?: number;
          data?: Record<string, unknown>;
          raw?: Record<string, unknown>;
          context?: { appSlug?: string; userId?: string; realm?: string; baseUrl?: string };
          error?: string;
        }>;
        markAllRemoteRead: () => Promise<{
          success: boolean;
          status?: number;
          data?: Record<string, unknown>;
          raw?: Record<string, unknown>;
          context?: { appSlug?: string; userId?: string; realm?: string; baseUrl?: string };
          error?: string;
        }>;
      };

      // YouTube Import
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
        assetReferences?: unknown[];
        modelConfig?: unknown;
        taskHints?: {
          intent?: string;
          forceMultiAgent?: boolean;
          forceLongRunningTask?: boolean;
          activeSkills?: string[];
          executionProfile?: 'artifact-authoring';
          artifactType?: 'manuscript';
          writeTarget?: 'manuscripts://current';
          requiredSkill?: string | string[];
          allowedTools?: string[];
          allowedAppCliActions?: string[];
          allowedOperateActions?: string[];
          allowedWriteTargets?: string[];
          requireSourceRead?: boolean;
          requireProfileRead?: boolean;
          requireSave?: boolean;
          deferredDiscovery?: boolean;
          teamEscalation?: 'disabled' | 'allowed';
          saveArtifact?: 'folder';
          saveSubdir?: string;
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
        createPathAttachment: (payload: { path: string; sessionId?: string }) => Promise<{ success?: boolean; error?: string; attachment?: unknown }>;
        createInlineAttachment: (payload: { dataUrl: string; fileName?: string; sessionId?: string }) => Promise<{ success?: boolean; error?: string; attachment?: unknown }>;
        createVideoThumbnail: (payload: { path?: string; source?: string; sessionId?: string }) => Promise<{ success?: boolean; error?: string; thumbnailUrl?: string; thumbnailDataUrl?: string }>;
        discardAttachments: (payload: { attachments: unknown[] }) => Promise<{ success?: boolean; error?: string }>;
        transcribeAudio: (payload: { audioBase64: string; mimeType?: string; fileName?: string }) => Promise<{ success?: boolean; text?: string; error?: string; reason?: string; diagnostic?: string }>;
        cancel: (data?: { sessionId?: string } | string) => void;
        confirmTool: (callId: string, confirmed: boolean) => void;
        getSessions: () => Promise<ChatSession[]>;
        createSession: (title?: string) => Promise<ChatSession>;
        createDiagnosticsSession: (payload?: { title?: string; contextId?: string; contextType?: string }) => Promise<ChatSession>;
        listContextSessions: (payload: { contextId: string; contextType: string }) => Promise<ContextChatSessionListItem[]>;
        createContextSession: (payload: { contextId: string; contextType: string; title?: string; initialContext?: string; workingDirectory?: string; metadata?: Record<string, unknown> }) => Promise<ChatSession>;
        getOrCreateContextSession: (params: { contextId: string; contextType: string; title: string; initialContext?: string; workingDirectory?: string; metadata?: Record<string, unknown> }) => Promise<ChatSession>;
        renameSession: (payload: { sessionId: string; title: string }) => Promise<{ success: boolean; session?: ChatSession; error?: string }>;
        deleteSession: (sessionId: string) => Promise<{ success: boolean }>;
        archiveSession: (sessionId: string) => Promise<{ success: boolean }>;
        unarchiveSession: (sessionId: string) => Promise<{ success: boolean }>;
        listArchivedSessions: () => Promise<ChatSession[]>;
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
      generation: {
        submitImage: (payload: Record<string, unknown>) => Promise<{ success?: boolean; error?: string; jobId?: string; status?: string }>;
        submitVideo: (payload: Record<string, unknown>) => Promise<{ success?: boolean; error?: string; jobId?: string; status?: string }>;
        submitAudio: (payload: Record<string, unknown>) => Promise<{ success?: boolean; error?: string; jobId?: string; status?: string }>;
        submitVoiceClone: (payload: Record<string, unknown>) => Promise<{ success?: boolean; error?: string; jobId?: string; status?: string }>;
        prepareVideoRetalkSource: (payload: Record<string, unknown>) => Promise<{ success?: boolean; error?: string; path?: string; normalized?: boolean; width?: number; height?: number; sourceWidth?: number; sourceHeight?: number; targetShortEdge?: number }>;
        uploadTempFile: (payload: Record<string, unknown>) => Promise<{ success?: boolean; error?: string; fileUrl?: string; url?: string; upload?: Record<string, unknown> }>;
        listJobSummaries: (payload?: Record<string, unknown>) => Promise<{ success?: boolean; items?: Array<Record<string, unknown>> }>;
        listJobs: (payload?: Record<string, unknown>) => Promise<{ success?: boolean; items?: Array<Record<string, unknown>> }>;
        getJob: (jobId: string) => Promise<Record<string, unknown> | null>;
        getJobArtifacts: (jobId: string) => Promise<{ success?: boolean; items?: Array<Record<string, unknown>> }>;
        awaitJob: (payload: { jobId: string; timeoutMs?: number }) => Promise<Record<string, unknown> | null>;
        cancelJob: (jobId: string) => Promise<{ success?: boolean; jobId?: string; status?: string; error?: string }>;
        retryJob: (jobId: string) => Promise<{ success?: boolean; jobId?: string; status?: string; attemptNo?: number; error?: string }>;
        getRuntimeStatus: () => Promise<{ success?: boolean; runtimeReady?: boolean; runtimeRunning?: boolean }>;
        onJobUpdated: (listener: (...args: any[]) => void) => void;
        offJobUpdated: (listener: (...args: any[]) => void) => void;
        onJobLog: (listener: (...args: any[]) => void) => void;
        offJobLog: (listener: (...args: any[]) => void) => void;
      };
      voice: {
        list: (payload?: Record<string, unknown>) => Promise<{ success?: boolean; voices?: Array<Record<string, unknown>>; items?: Array<Record<string, unknown>>; error?: string }>;
        get: (payload: { voiceId: string }) => Promise<Record<string, unknown>>;
        clone: (payload: Record<string, unknown>) => Promise<Record<string, unknown>>;
        bindAsset: (payload: Record<string, unknown>) => Promise<Record<string, unknown>>;
        speech: (payload: Record<string, unknown>) => Promise<Record<string, unknown>>;
        delete: (payload: { voiceId: string }) => Promise<Record<string, unknown>>;
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
        taskPreview: (payload: Record<string, unknown>) => Promise<unknown>;
        taskCreate: (payload: Record<string, unknown>) => Promise<unknown>;
        taskConfirm: (payload: { draftId: string; confirm: boolean }) => Promise<unknown>;
        taskUpdate: (payload: { jobDefinitionId: string; patch: Record<string, unknown>; reason: string }) => Promise<unknown>;
        taskCancel: (payload: { jobDefinitionId: string; reason?: string; deleteSource?: boolean }) => Promise<unknown>;
        taskList: (payload?: { ownerScope?: string; includeDrafts?: boolean }) => Promise<{
          success?: boolean;
          items?: Array<{
            definitionId: string;
            title: string;
            kind: 'scheduled' | 'long_cycle' | string;
            sourceKind?: 'scheduled' | 'long_cycle' | string | null;
            sourceTaskId?: string | null;
            enabled: boolean;
            ownerScope?: string | null;
            createdBy?: string | null;
            creatorMode?: string | null;
            requiresConfirmation: boolean;
            policySignature?: string | null;
            definitionFingerprint?: string | null;
            triggerKind: 'interval' | 'daily' | 'weekly' | 'once' | string;
            progressionKind?: 'single_run' | 'multi_round' | string;
            nextDueAt?: string | null;
            draftId?: string | null;
            timezone?: string | null;
            missedRunPolicy?: 'drop' | 'single' | 'catchup' | string | null;
            cooldown?: {
              state?: string;
              activatedAt?: string;
              consecutiveFailures?: number;
              reason?: string;
            } | null;
            policyDecision?: 'allow' | 'require_confirm' | 'reject' | string | null;
            policyWarnings?: string[] | null;
            actionType?: string | null;
            goal?: string | null;
            prompt?: string | null;
            objective?: string | null;
            stepPrompt?: string | null;
            intervalMinutes?: number | null;
            time?: string | null;
            weekdays?: number[] | null;
            runAt?: string | null;
            riskRationale?: string | null;
            totalRounds?: number | null;
            completedRounds?: number | null;
            lastUpdatedReason?: string | null;
            latestExecution?: {
              executionId: string;
              runId?: string | null;
              status: 'queued' | 'leased' | 'running' | 'retrying' | 'succeeded' | 'completed' | 'failed' | 'cancelled' | 'dead_lettered' | string;
              scheduledForAt?: string | null;
              attemptNo?: number | null;
              retryBucket?: string | null;
              lastHeartbeatAt?: string | null;
              lastError?: string | null;
              updatedAt: string;
            } | null;
            updatedAt: string;
            createdAt: string;
          }>;
          count?: number;
        }>;
        taskStats: () => Promise<{
          success?: boolean;
          definitions?: {
            total?: number;
            drafts?: number;
            active?: number;
          };
          executions?: {
            total?: number;
            running?: number;
            failed?: number;
            recent?: Array<{
              executionId: string;
              runId?: string | null;
              definitionId: string;
              status: string;
              scheduledForAt?: string | null;
              attemptNo?: number | null;
              retryBucket?: string | null;
              lastError?: string | null;
            }>;
          };
        }>;
      };
      redclawOrchestration: {
        createRun: (payload: {
          goal: string;
          sessionId?: string;
          projectId?: string;
          platform?: string;
          format?: string;
        }) => Promise<{
          success: boolean;
          runId: string;
          runtimeTaskId: string;
          sessionId: string;
          graph: {
            id: string;
            goal: string;
            platform?: string | null;
            contentFormat?: string | null;
            createdAt: string;
            nodes: Array<{
              id: string;
              title: string;
              agentId: string;
              skillIds: string[];
              requiredArtifacts: string[];
              outputSchema: string;
              status: string;
            }>;
            edges: Array<{
              from: string;
              to: string;
              dependencyType: string;
            }>;
          };
          snapshot?: unknown;
          task?: unknown;
        }>;
        getRegistry: () => Promise<{
          success: boolean;
          agents: Array<Record<string, unknown>>;
          skills: Array<Record<string, unknown>>;
          memoryScopes: string[];
        }>;
      };
      redclawProjects: {
        list: () => Promise<{
          success?: boolean;
          count?: number;
          items?: Array<{
            id: string;
            goal: string;
            platform?: string | null;
            taskType?: string | null;
            status: string;
            runId?: string | null;
            graphId?: string | null;
            runtimeTaskId?: string | null;
            collabSessionId?: string | null;
            contentFormat?: string | null;
            artifactPath?: string | null;
            artifacts?: Array<Record<string, unknown>>;
            checkpoints?: Array<Record<string, unknown>>;
            learningCandidates?: Array<Record<string, unknown>>;
            skillRuns?: Array<Record<string, unknown>>;
            metadata?: Record<string, unknown> | null;
            createdAt?: string | null;
            updatedAt: string;
          }>;
        }>;
        updateLearningCandidate: (payload: {
          projectId: string;
          candidateId: string;
          status: 'accepted' | 'rejected' | 'pending';
        }) => Promise<{
          success?: boolean;
          project?: unknown;
          candidate?: unknown;
          error?: string;
        }>;
        updateSection: (payload: {
          projectId: string;
          sectionId: string;
          content: string;
        }) => Promise<{
          success?: boolean;
          project?: unknown;
          sectionId?: string;
          error?: string;
        }>;
        exportMediaPlan: (payload: {
          projectId: string;
        }) => Promise<{
          success?: boolean;
          project?: unknown;
          path?: string;
          packagePath?: string;
          concatPath?: string;
          readmePath?: string;
          plan?: unknown;
          error?: string;
        }>;
        renderRoughCut: (payload: {
          projectId: string;
        }) => Promise<{
          success?: boolean;
          project?: unknown;
          path?: string;
          packagePath?: string;
          inputCount?: number;
          sizeBytes?: number;
          error?: string;
        }>;
        exportPublishPackage: (payload: {
          projectId: string;
        }) => Promise<{
          success?: boolean;
          project?: unknown;
          packagePath?: string;
          jsonPath?: string;
          markdownPath?: string;
          coverBriefPath?: string;
          package?: unknown;
          error?: string;
        }>;
        exportReviewReport: (payload: {
          projectId: string;
        }) => Promise<{
          success?: boolean;
          project?: unknown;
          packagePath?: string;
          jsonPath?: string;
          markdownPath?: string;
          report?: unknown;
          error?: string;
        }>;
        exportXhsPackage: (payload: {
          projectId: string;
        }) => Promise<{
          success?: boolean;
          project?: unknown;
          packagePath?: string;
          jsonPath?: string;
          markdownPath?: string;
          layoutPath?: string;
          imageManifestPath?: string;
          package?: unknown;
          error?: string;
        }>;
      };
      redclawProfile: {
        getBundle: () => Promise<{
          activeSpaceId?: string;
          profileRoot?: string;
          success?: boolean;
          agent?: string;
          soul?: string;
          identity?: string;
          user?: string;
          creatorProfile?: string;
          bootstrap?: string;
          styleProfile?: Record<string, unknown>;
          files?: {
            agent?: string;
            soul?: string;
            identity?: string;
            user?: string;
            creatorProfile?: string;
            bootstrap?: string;
          };
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
        saveInitializationProgress: (payload: { stepIndex: number; answers: Record<string, unknown> }) => Promise<{
          success?: boolean;
          state?: Record<string, unknown>;
        }>;
        completeInitialization: (payload: { answers: Record<string, unknown> }) => Promise<{
          success?: boolean;
          summary?: {
            headline?: string;
            chips?: string[];
            lines?: string[];
          };
          styleProfile?: Record<string, unknown>;
          skill?: {
            name?: string;
            path?: string;
          };
          onboardingState?: Record<string, unknown>;
        }>;
        startStyleDefinition: (payload?: { forceRestart?: boolean; source?: string; sessionId?: string }) => Promise<{
          success?: boolean;
          state?: Record<string, unknown>;
          error?: string;
        }>;
        completeStyleDefinition: (payload: Record<string, unknown>) => Promise<{
          success?: boolean;
          summary?: unknown;
          styleProfile?: Record<string, unknown>;
          skill?: {
            name?: string;
            path?: string;
          };
          onboardingState?: Record<string, unknown>;
          error?: string;
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
