let installed = false;
const AUTO_REPORT_COOLDOWN_MS = 60_000;
const EVENT_LOOP_STALL_THRESHOLD_MS = 15_000;
const HEARTBEAT_INTERVAL_MS = 5_000;
const autoReportLastSeen = new Map<string, number>();

type RendererLogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error';

function toMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message || error.name || 'Renderer error';
  }
  if (typeof error === 'string') {
    return error;
  }
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function toFields(error: unknown, extra?: Record<string, unknown>) {
  if (error instanceof Error) {
    return {
      name: error.name,
      stack: error.stack,
      ...extra,
    };
  }
  return {
    error: error ?? null,
    ...extra,
  };
}

export async function reportRendererError(
  error: unknown,
  options?: {
    level?: RendererLogLevel;
    category?: string;
    event?: string;
    message?: string;
    fields?: Record<string, unknown>;
    autoReport?: boolean;
    trigger?: string;
  },
) {
  const event = options?.event || 'renderer.error';
  const message = options?.message || toMessage(error);
  const fields = toFields(error, options?.fields);
  try {
    await window.ipcRenderer.logs.appendRenderer({
      level: options?.level || 'error',
      category: options?.category || 'plugin.bridge',
      event,
      message,
      fields,
    });
  } catch {
    // Diagnostics reporting must never break the renderer.
  }
  if (options?.autoReport === false) {
    return;
  }
  const key = `${event}:${message}`.slice(0, 240);
  const now = Date.now();
  const lastSeen = autoReportLastSeen.get(key) || 0;
  if (now - lastSeen < AUTO_REPORT_COOLDOWN_MS) {
    return;
  }
  autoReportLastSeen.set(key, now);
  try {
    await window.ipcRenderer.logs.createAutoReport({
      level: options?.level || 'error',
      category: options?.category || 'plugin.bridge',
      event,
      message,
      fields,
      trigger: options?.trigger || 'renderer_error',
    });
  } catch {
    // Automatic reporting must never break the renderer.
  }
}

export function installRendererDiagnostics() {
  if (installed || typeof window === 'undefined') {
    return;
  }
  installed = true;

  window.addEventListener('error', (event) => {
    void reportRendererError(event.error || event.message, {
      category: 'plugin.bridge',
      event: 'window.error',
      trigger: 'renderer_window_error',
      fields: {
        filename: event.filename,
        lineno: event.lineno,
        colno: event.colno,
      },
    });
  });

  window.addEventListener('unhandledrejection', (event) => {
    void reportRendererError(event.reason, {
      category: 'plugin.bridge',
      event: 'window.unhandledrejection',
      trigger: 'renderer_unhandled_rejection',
    });
  });

  let lastHeartbeat = Date.now();
  window.setInterval(() => {
    const now = Date.now();
    const drift = now - lastHeartbeat - HEARTBEAT_INTERVAL_MS;
    lastHeartbeat = now;
    if (drift < EVENT_LOOP_STALL_THRESHOLD_MS) {
      return;
    }
    void reportRendererError(new Error(`Renderer event loop stalled for ${Math.round(drift)}ms`), {
      category: 'renderer.health',
      event: 'renderer.event_loop_stall',
      trigger: 'renderer_event_loop_stall',
      fields: {
        driftMs: Math.round(drift),
        heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS,
      },
    });
  }, HEARTBEAT_INTERVAL_MS);
}
