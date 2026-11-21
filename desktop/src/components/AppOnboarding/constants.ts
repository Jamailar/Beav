export const APP_ONBOARDING_SEEN_KEY = 'redbox:app-onboarding:v2:seen';
export const APP_ACQUISITION_SOURCE_KEY = 'redbox:app-onboarding:v1:acquisition-source';

export const STEPS = ['品牌更名', '用户来源', '空间管理', '概览', '文件拖动', '评论洞察', '开始'];

export interface AppOnboardingStatus {
  seen: boolean;
  seenAt?: string;
  migrated?: boolean;
  error?: string;
}

export function hasSeenAppOnboarding(): boolean {
  try {
    return window.localStorage.getItem(APP_ONBOARDING_SEEN_KEY) === '1';
  } catch {
    return true;
  }
}

export function markAppOnboardingSeen() {
  try {
    window.localStorage.setItem(APP_ONBOARDING_SEEN_KEY, '1');
  } catch {
    // Onboarding is non-critical UI state; storage failures should not block the app.
  }
}

export async function getAppOnboardingStatus(): Promise<AppOnboardingStatus> {
  const legacySeen = hasSeenAppOnboarding();
  try {
    const result = await window.ipcRenderer.getAppOnboardingStatus({ legacySeen });
    const seen = result?.success === false ? legacySeen : Boolean(result?.seen);
    if (seen) {
      markAppOnboardingSeen();
    }
    return {
      seen,
      seenAt: result?.seenAt,
      migrated: Boolean(result?.migrated),
      error: result?.error,
    };
  } catch (error) {
    return {
      seen: legacySeen,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function markAppOnboardingSeenOnDevice(): Promise<void> {
  markAppOnboardingSeen();
  try {
    await window.ipcRenderer.markAppOnboardingSeen();
  } catch {
    // Local fallback is enough to avoid blocking onboarding completion.
  }
}

export function getAppAcquisitionSource(): string {
  try {
    return window.localStorage.getItem(APP_ACQUISITION_SOURCE_KEY) || '';
  } catch {
    return '';
  }
}

export function setAppAcquisitionSource(source: string) {
  try {
    window.localStorage.setItem(APP_ACQUISITION_SOURCE_KEY, source);
  } catch {
    // Onboarding is non-critical UI state; storage failures should not block the app.
  }
}
