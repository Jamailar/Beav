import {
  normalizeOnboardingAnswers,
  type RedClawOnboardingAnswers,
} from './onboardingMvp';

export type RedclawOnboardingState = Record<string, unknown> | null;

export function isRedClawOnboardingCompleted(state: RedclawOnboardingState): boolean {
  const completedAt = String(state?.completedAt || '').trim();
  return completedAt.length > 0;
}

export function readRedClawOnboardingDraft(state: RedclawOnboardingState): {
  stepIndex: number;
  answers: RedClawOnboardingAnswers;
} {
  const uiFlow = state?.uiFlow && typeof state.uiFlow === 'object'
    ? state.uiFlow as Record<string, unknown>
    : null;
  const draft = uiFlow?.draft && typeof uiFlow.draft === 'object'
    ? uiFlow.draft as Record<string, unknown>
    : null;
  const rawAnswers = draft?.answers && typeof draft.answers === 'object'
    ? draft.answers as Record<string, unknown>
    : null;
  const stepIndex = Number(draft?.stepIndex);
  return {
    stepIndex: Number.isFinite(stepIndex) ? Math.max(0, Math.round(stepIndex)) : 0,
    answers: normalizeOnboardingAnswers(rawAnswers),
  };
}
