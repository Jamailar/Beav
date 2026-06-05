import { REDBOX_NAVIGATE_EVENT } from '../../notifications/types';
import type { AppIntent } from './types';

export function dispatchAppIntent(intent: AppIntent): void {
  window.dispatchEvent(new CustomEvent(REDBOX_NAVIGATE_EVENT, { detail: intent }));
}
