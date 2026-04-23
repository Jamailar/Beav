let installed = false;

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
  },
) {
  try {
    await window.ipcRenderer.logs.appendRenderer({
      level: options?.level || 'error',
      category: options?.category || 'plugin.bridge',
      event: options?.event || 'renderer.error',
      message: options?.message || toMessage(error),
      fields: toFields(error, options?.fields),
    });
  } catch {
    // Diagnostics reporting must never break the renderer.
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
    });
  });
}
