import type { AutoEditPlan, SrtSegment, TranscriptTrack } from '../../../shared/videoAutoEdit';

export interface AutoEditPlannerInput {
  transcript: TranscriptTrack;
  userGoal?: string;
  targetDurationMs?: number | null;
  pacing?: 'tight' | 'balanced' | 'slow';
}

type ScoredSegment = {
  segment: SrtSegment;
  score: number;
  role: 'hook' | 'context' | 'proof' | 'detail' | 'cta' | 'filler-removal';
  reason: string;
};

function segmentDurationMs(segment: SrtSegment): number {
  return Math.max(0, Math.round(segment.endMs - segment.startMs));
}

function scoreSegment(segment: SrtSegment, index: number, total: number): ScoredSegment {
  const tags = new Set(segment.tags || []);
  let score = 40;
  let role: ScoredSegment['role'] = 'detail';
  const reasons: string[] = [];

  if (tags.has('remove')) {
    score -= 100;
    reasons.push('用户标记为删除');
  }
  if (tags.has('filler')) {
    score -= 45;
    reasons.push('用户标记为废话');
  }
  if (tags.has('unclear')) {
    score -= 25;
    reasons.push('用户标记为不清楚');
  }
  if (tags.has('keep')) {
    score += 100;
    role = 'proof';
    reasons.push('用户标记为保留');
  }
  if (tags.has('highlight')) {
    score += 70;
    role = 'proof';
    reasons.push('用户标记为亮点');
  }
  if (tags.has('hook')) {
    score += 90;
    role = 'hook';
    reasons.push('用户标记为开头');
  }
  if (index < Math.max(2, Math.ceil(total * 0.12))) {
    score += 12;
    if (role === 'detail') role = 'context';
  }
  if (index > total - Math.max(2, Math.ceil(total * 0.12))) {
    score += 6;
    if (role === 'detail') role = 'cta';
  }

  const text = segment.text.trim();
  if (/[？?]/.test(text)) {
    score += 10;
    if (role === 'detail') role = 'hook';
  }
  if (text.length < 3) {
    score -= 20;
    reasons.push('字幕过短');
  }

  return {
    segment,
    score,
    role,
    reason: reasons.length ? reasons.join('，') : '按字幕内容和顺序保留',
  };
}

function resolveDurationBudget(input: AutoEditPlannerInput, totalDurationMs: number): number {
  const explicit = Number(input.targetDurationMs || 0);
  if (Number.isFinite(explicit) && explicit > 0) return explicit;
  if (input.pacing === 'tight') return Math.min(totalDurationMs, 60000);
  if (input.pacing === 'slow') return Math.min(totalDurationMs, 180000);
  return Math.min(totalDurationMs, 90000);
}

export function buildHeuristicAutoEditPlan(input: AutoEditPlannerInput): AutoEditPlan {
  const segments = [...(input.transcript.segments || [])].sort((left, right) => left.startMs - right.startMs);
  const totalDurationMs = segments.reduce((sum, segment) => sum + segmentDurationMs(segment), 0);
  const budgetMs = resolveDurationBudget(input, totalDurationMs);
  const scored = segments.map((segment, index) => scoreSegment(segment, index, segments.length));
  const mandatory = scored.filter((item) => item.segment.tags.includes('keep') || item.segment.tags.includes('hook'));
  const candidates = scored
    .filter((item) => item.score > 0 || item.segment.tags.includes('highlight'))
    .filter((item) => !item.segment.tags.includes('remove') || item.segment.tags.includes('keep'))
    .sort((left, right) => right.score - left.score || left.segment.startMs - right.segment.startMs);

  const selectedIds = new Set<string>();
  let selectedDurationMs = 0;

  for (const item of mandatory) {
    if (selectedIds.has(item.segment.id)) continue;
    selectedIds.add(item.segment.id);
    selectedDurationMs += segmentDurationMs(item.segment);
  }

  for (const item of candidates) {
    if (selectedIds.has(item.segment.id)) continue;
    const duration = segmentDurationMs(item.segment);
    if (selectedDurationMs > 0 && selectedDurationMs + duration > budgetMs && !item.segment.tags.includes('highlight')) {
      continue;
    }
    selectedIds.add(item.segment.id);
    selectedDurationMs += duration;
    if (selectedDurationMs >= budgetMs) break;
  }

  if (selectedIds.size === 0) {
    for (const item of scored.slice(0, Math.min(segments.length, 12))) {
      selectedIds.add(item.segment.id);
    }
  }

  const selectedBySourceOrder = scored
    .filter((item) => selectedIds.has(item.segment.id))
    .sort((left, right) => left.segment.startMs - right.segment.startMs);
  const removedBySourceOrder = scored
    .filter((item) => !selectedIds.has(item.segment.id))
    .sort((left, right) => left.segment.startMs - right.segment.startMs);

  return {
    summary: [
      input.userGoal?.trim() ? `目标：${input.userGoal.trim()}` : '目标：生成字幕驱动粗剪',
      `预算：约 ${Math.round(budgetMs / 1000)} 秒`,
      `选择 ${selectedBySourceOrder.length} 条字幕，移除 ${removedBySourceOrder.length} 条字幕`,
    ].join('；'),
    selectedSegments: selectedBySourceOrder.map((item, index) => ({
      segmentId: item.segment.id,
      reason: item.reason,
      role: item.role,
      priority: selectedBySourceOrder.length - index,
    })),
    removedSegments: removedBySourceOrder.map((item) => ({
      segmentId: item.segment.id,
      reason: item.segment.tags.includes('remove') ? '用户标记为删除' : '未进入目标时长预算',
    })),
    titleCards: selectedBySourceOrder.length > 0
      ? [{
        text: input.userGoal?.trim()
          ? input.userGoal.trim().slice(0, 32)
          : selectedBySourceOrder[0].segment.text.trim().slice(0, 32),
        durationMs: 1200,
      }]
      : [],
    subtitleStyle: {
      preset: 'clean-bold',
      source: 'heuristic',
    },
    warnings: selectedDurationMs > budgetMs * 1.12
      ? ['保留/开头标签较多，粗剪时长可能超过目标预算。']
      : [],
  };
}
