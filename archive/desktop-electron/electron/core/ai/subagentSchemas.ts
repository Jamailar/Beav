import type { RoleId } from './types';
import type { SubagentOutput } from './subagentRuntime';

export type SubagentOutputRule = {
  requireArtifact?: boolean;
  requireHandoff?: boolean;
  requireApproved?: boolean;
};

export const ROLE_OUTPUT_RULES: Record<RoleId, SubagentOutputRule> = {
  planner: { requireHandoff: true },
  researcher: { requireHandoff: true },
  copywriter: { requireArtifact: true, requireHandoff: true },
  'image-director': { requireArtifact: true, requireHandoff: true },
  reviewer: { requireApproved: true },
  'ops-coordinator': { requireHandoff: true },
};

export const ROLE_OUTPUT_SCHEMA_HINT: Record<RoleId, string> = {
  planner: '必须输出 JSON：{ "summary": string, "handoff": string, "artifact"?: string, "risks"?: string[] }',
  researcher: '必须输出 JSON：{ "summary": string, "handoff": string, "artifact"?: string, "risks"?: string[] }',
  copywriter: '必须输出 JSON：{ "summary": string, "artifact": string, "handoff": string, "risks"?: string[] }',
  'image-director': '必须输出 JSON：{ "summary": string, "artifact": string, "handoff": string, "risks"?: string[] }',
  reviewer: '必须输出 JSON：{ "summary": string, "approved": boolean, "issues"?: string[], "handoff"?: string, "risks"?: string[] }',
  'ops-coordinator': '必须输出 JSON：{ "summary": string, "handoff": string, "artifact"?: string, "risks"?: string[] }',
};

export function validateSubagentOutput(roleId: RoleId, output: SubagentOutput): void {
  const rules = ROLE_OUTPUT_RULES[roleId];
  if (!String(output.summary || '').trim()) {
    throw new Error(`subagent ${roleId} missing required field: summary`);
  }
  if (rules.requireArtifact && !String(output.artifact || '').trim()) {
    throw new Error(`subagent ${roleId} missing required field: artifact`);
  }
  if (rules.requireHandoff && !String(output.handoff || '').trim()) {
    throw new Error(`subagent ${roleId} missing required field: handoff`);
  }
  if (rules.requireApproved && typeof output.approved !== 'boolean') {
    throw new Error(`subagent ${roleId} missing required field: approved`);
  }
}
