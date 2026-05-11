export const APP_ONBOARDING_SEEN_KEY = 'redbox:app-onboarding:v1:seen';

export const STEPS = ['概览', '亮点功能', '快速设置', '开始'];

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
