export type RedclawOnboardingState = Record<string, unknown> | null;

export function isRedClawOnboardingCompleted(state: RedclawOnboardingState): boolean {
  const completedAt = String(state?.completedAt || '').trim();
  return completedAt.length > 0;
}
