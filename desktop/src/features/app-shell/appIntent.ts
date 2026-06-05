import { REDBOX_NAVIGATE_EVENT } from '../../notifications/types';
import type { AppIntent, AppNavigateEventDetail } from './types';

export function dispatchAppNavigateDetail(detail: AppNavigateEventDetail | Record<string, unknown>): void {
  window.dispatchEvent(new CustomEvent(REDBOX_NAVIGATE_EVENT, { detail }));
}

export function dispatchAppIntent(intent: AppIntent): void {
  dispatchAppNavigateDetail(intent);
}
