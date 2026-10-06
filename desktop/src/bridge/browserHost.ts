export const BROWSER_IPC_BASE_URL = 'http://127.0.0.1:31937/api/ipc';

export function isTauriRuntime(): boolean {
  if (typeof window === 'undefined') {
    return false;
  }
  const tauriWindow = window as unknown as {
    __TAURI__?: unknown;
    __TAURI_INTERNALS__?: unknown;
  };
  return Boolean(tauriWindow.__TAURI_INTERNALS__ || tauriWindow.__TAURI__);
}

export async function invokeBrowserHost(channel: string, payload?: unknown): Promise<any> {
  const response = await fetch(`${BROWSER_IPC_BASE_URL}/invoke`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ channel, payload: payload ?? null }),
  });
  const value = await response.json().catch(() => null);
  if (!response.ok) {
    const message = value && typeof value === 'object' && 'error' in value
      ? String((value as { error?: unknown }).error || response.statusText)
      : response.statusText;
    throw new Error(message || `HTTP ${response.status}`);
  }
  return value;
}

export function browserPayloadForCommand(command: string, args?: unknown): unknown {
  if (
    command.startsWith('knowledge_')
    && args
    && typeof args === 'object'
    && Object.prototype.hasOwnProperty.call(args, 'payload')
  ) {
    return (args as { payload?: unknown }).payload ?? null;
  }
  return args;
}
