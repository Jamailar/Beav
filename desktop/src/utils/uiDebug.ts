type DebugPayload = Record<string, unknown>;

const UI_DEBUG_STORAGE_KEY = 'redbox:ui-debug';
const UI_DEBUG_HOST_SCOPES = new Set(['chat', 'runtime-event']);

function forwardUiDebugToHost(scope: string, event: string, payload?: DebugPayload): void {
  if (typeof window === 'undefined' || !UI_DEBUG_HOST_SCOPES.has(scope)) {
    return;
  }
  try {
    const bridge = (window as typeof window & {
      ipcRenderer?: { send?: (channel: string, payload?: unknown) => void };
    }).ipcRenderer;
    bridge?.send?.('debug:ui-log', {
      scope,
      event,
      payload: payload || {},
    });
  } catch {
    // Ignore debug forwarding failures to avoid affecting UI behavior.
  }
}

export function uiDebugEnabled(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    const stored = window.localStorage.getItem(UI_DEBUG_STORAGE_KEY);
    if (stored === '1' || stored === 'true') {
      return true;
    }
  } catch {
    // Ignore storage access errors and fall back to dev mode.
  }
  return Boolean(import.meta.env.DEV);
}

export function uiDebug(scope: string, event: string, payload?: DebugPayload): void {
  if (!uiDebugEnabled()) return;
  const prefix = `[ui][${scope}] ${event}`;
  forwardUiDebugToHost(scope, event, payload);
  if (payload && Object.keys(payload).length > 0) {
    console.debug(prefix, payload);
    return;
  }
  console.debug(prefix);
}

export async function uiMeasure<T>(
  scope: string,
  event: string,
  task: () => Promise<T>,
  payload?: DebugPayload,
): Promise<T> {
  if (!uiDebugEnabled()) {
    return task();
  }
  const startedAt = performance.now();
  uiDebug(scope, `${event}:start`, payload);
  try {
    const result = await task();
    uiDebug(scope, `${event}:done`, {
      ...(payload || {}),
      elapsedMs: Math.round(performance.now() - startedAt),
    });
    return result;
  } catch (error) {
    uiDebug(scope, `${event}:error`, {
      ...(payload || {}),
      elapsedMs: Math.round(performance.now() - startedAt),
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

export function uiTraceInteraction(
  scope: string,
  event: string,
  payload?: DebugPayload,
): void {
  uiDebug(scope, `interaction:${event}`, payload);
}
