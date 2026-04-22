import type {
  AgentTaskArtifactRecord,
  AgentTaskCheckpointRecord,
  AgentTaskNodeRecord,
  AgentTaskStatus,
} from '../../db';

export type RuntimeMode =
  | 'redclaw'
  | 'knowledge'
  | 'chatroom'
  | 'advisor-discussion'
  | 'background-maintenance';

export type IntentName =
  | 'direct_answer'
  | 'file_operation'
  | 'manuscript_creation'
  | 'image_creation'
  | 'cover_generation'
  | 'knowledge_retrieval'
  | 'long_running_task'
  | 'discussion'
  | 'memory_maintenance'
  | 'automation'
  | 'advisor_persona';

export type RoleId =
  | 'planner'
  | 'researcher'
  | 'copywriter'
  | 'image-director'
  | 'reviewer'
  | 'ops-coordinator';

export type ThinkingBudget = 'minimal' | 'low' | 'medium' | 'high';

export interface IntentRoute {
  intent: IntentName;
  secondaryIntents?: IntentName[];
  goal: string;
  deliverables?: string[];
  requiredCapabilities: string[];
  recommendedRole: RoleId;
  requiresLongRunningTask: boolean;
  requiresMultiAgent: boolean;
  requiresHumanApproval: boolean;
  confidence: number;
  reasoning: string;
  source?: 'rule' | 'llm' | 'llm+rule';
}

export interface RoleSpec {
  roleId: RoleId;
  purpose: string;
  systemPrompt: string;
  allowedToolPack: RuntimeMode | 'full';
  inputSchema: string;
  outputSchema: string;
  handoffContract: string;
  artifactTypes: string[];
}

export interface RuntimeContext {
  sessionId: string;
  runtimeMode: RuntimeMode;
  userInput: string;
  metadata?: Record<string, unknown>;
  workspaceRoot?: string;
  currentSpaceRoot?: string;
}

export interface ExecutionTrace {
  scope: string;
  event: string;
  payload?: unknown;
}

export interface AgentTaskSnapshot {
  id: string;
  taskType: string;
  status: AgentTaskStatus;
  runtimeMode: RuntimeMode;
  ownerSessionId?: string | null;
  intent?: string | null;
  roleId?: string | null;
  goal?: string | null;
  currentNode?: string | null;
  route?: IntentRoute | null;
  graph: AgentTaskNodeRecord[];
  artifacts: AgentTaskArtifactRecord[];
  checkpoints: AgentTaskCheckpointRecord[];
  metadata?: unknown;
  lastError?: string | null;
  createdAt: number;
  updatedAt: number;
  startedAt?: number | null;
  completedAt?: number | null;
}

export interface PreparedRuntimeExecution {
  task: AgentTaskSnapshot;
  route: IntentRoute;
  role: RoleSpec;
  systemPrompt: string;
  thinkingBudget: ThinkingBudget;
  orchestration?: {
    outputs: Array<{
      roleId: RoleId;
      summary: string;
      artifact?: string;
      handoff?: string;
      risks?: string[];
    }>;
  } | null;
}
