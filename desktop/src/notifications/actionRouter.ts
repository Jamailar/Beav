import { REDBOX_NAVIGATE_EVENT, type NotificationAction } from './types';

export async function runNotificationAction(action: NotificationAction): Promise<void> {
  if (action.action === 'navigate') {
    window.dispatchEvent(new CustomEvent(REDBOX_NAVIGATE_EVENT, { detail: action.payload }));
    return;
  }

  if (action.action === 'open-path') {
    await window.ipcRenderer.openPath(action.payload.path);
    return;
  }

  if (action.action === 'retry-generation') {
    await window.ipcRenderer.generation.retryJob(action.payload.jobId);
    window.dispatchEvent(
      new CustomEvent(REDBOX_NAVIGATE_EVENT, { detail: { view: 'generation-studio' } }),
    );
    return;
  }

  if (action.action === 'open-feedback-report') {
    window.dispatchEvent(new CustomEvent('redbox:open-feedback-report', {
      detail: {
        sourcePage: 'notifications',
        operation: action.payload.feedbackId ? `feedback:${action.payload.feedbackId}` : 'feedback',
      },
    }));
  }
}
