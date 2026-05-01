import type {
  CollabProgressReportRecord,
  CollabTaskRecord,
  ReviewDocketRecord,
} from '../types';

export type HumanApprovalPriority = 'low' | 'normal' | 'high' | 'urgent';
export type HumanApprovalRiskLevel = 'low' | 'normal' | 'medium' | 'high';
export type HumanApprovalDecisionKey = 'approved' | 'rejected' | 'changes_requested';
export type HumanApprovalTaskStatus =
  | 'queued'
  | 'claimed'
  | 'running'
  | 'waiting_for_review'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'blocked';
export type HumanApprovalActionKind =
  | 'collab_task_completion'
  | 'redclaw_task_draft'
  | 'manuscript_publish'
  | 'media_generation_result'
  | 'plugin_import_batch';

export interface HumanApprovalDocketInput {
  sourceKind: string;
  sourceId?: string | null;
  sessionId?: string | null;
  taskId?: string | null;
  title: string;
  summary: string;
  body?: string;
  decisionType?: string;
  priority?: HumanApprovalPriority;
  riskLevel?: HumanApprovalRiskLevel;
  artifactRefs?: string[];
  evidenceRefs?: unknown[];
  options?: unknown[];
  createdByAgentId?: string | null;
  assignedToUserId?: string | null;
  expiresAt?: number | null;
  actionKind?: HumanApprovalActionKind;
  proposedAction?: Record<string, unknown>;
  onDecisionTaskStatus?: Partial<Record<HumanApprovalDecisionKey, HumanApprovalTaskStatus>>;
}

export interface CollabTaskCompletionApprovalInput {
  task: CollabTaskRecord;
  latestReport?: CollabProgressReportRecord | null;
  artifactRefs?: string[];
}

export function approvalArtifactRef(value: unknown): string {
  if (typeof value === 'string') return value;
  const record = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  return String(record.path || record.id || record.ref || record.kind || JSON.stringify(value));
}

export function buildHumanApprovalDocketPayload(input: HumanApprovalDocketInput): Record<string, unknown> {
  const title = input.title.trim();
  const summary = input.summary.trim();
  if (!title) throw new Error('审批项缺少标题。');
  if (!summary) throw new Error('审批项缺少摘要。');

  const proposedAction = {
    ...(input.proposedAction || {}),
    ...(input.actionKind ? { kind: input.actionKind } : {}),
    ...(input.onDecisionTaskStatus
      ? { onDecisionTaskStatus: input.onDecisionTaskStatus }
      : {}),
  };

  return {
    sourceKind: input.sourceKind,
    sourceId: input.sourceId || undefined,
    sessionId: input.sessionId || undefined,
    taskId: input.taskId || undefined,
    title,
    summary,
    body: input.body ?? summary,
    decisionType: input.decisionType || 'human_approval',
    priority: input.priority || 'normal',
    riskLevel: input.riskLevel || 'medium',
    artifactRefs: input.artifactRefs || [],
    evidenceRefs: input.evidenceRefs || [],
    options: input.options || [],
    createdByAgentId: input.createdByAgentId || undefined,
    assignedToUserId: input.assignedToUserId || undefined,
    expiresAt: input.expiresAt || undefined,
    proposedAction: Object.keys(proposedAction).length > 0 ? proposedAction : undefined,
  };
}

export async function createHumanApprovalDocket(input: HumanApprovalDocketInput): Promise<ReviewDocketRecord> {
  return window.ipcRenderer.teamRuntime.createReviewDocket(buildHumanApprovalDocketPayload(input));
}

export async function createCollabTaskCompletionApprovalDocket({
  task,
  latestReport,
  artifactRefs,
}: CollabTaskCompletionApprovalInput): Promise<ReviewDocketRecord> {
  return createHumanApprovalDocket({
    sourceKind: 'collab_task',
    sourceId: task.id,
    sessionId: task.sessionId,
    taskId: task.id,
    title: task.title,
    summary: latestReport?.summary || task.resultSummary || task.description || task.objective || task.title,
    body: [
      task.objective || task.description || task.title,
      latestReport?.summary ? `\n最新汇报：${latestReport.summary}` : '',
      task.failureReason ? `\n失败原因：${task.failureReason}` : '',
    ].filter(Boolean).join('\n'),
    decisionType: 'completion_review',
    priority: task.priority > 0 ? 'high' : 'normal',
    riskLevel: task.status === 'failed' ? 'high' : 'normal',
    artifactRefs: artifactRefs || [...task.artifactIds, ...task.artifacts.map(approvalArtifactRef)],
    createdByAgentId: task.assigneeAgentId,
    actionKind: 'collab_task_completion',
    onDecisionTaskStatus: {
      approved: 'completed',
      rejected: 'failed',
      changes_requested: 'claimed',
    },
  });
}
