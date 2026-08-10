const CONTENT_RUNTIME_KEY = '__redboxBrowserControlContentRuntimeV1';

/**
 * Content scripts can be injected repeatedly after navigation recovery or an
 * extension update. Replace the prior listener deterministically instead of
 * allowing duplicate handlers to race over the same request.
 */
export function installContentRuntimeLifecycle(options = {}) {
  const root = options.globalObject || globalThis;
  const key = String(options.key || CONTENT_RUNTIME_KEY);
  const previous = root[key];
  if (previous && typeof previous.dispose === 'function') previous.dispose('superseded');

  const runtime = {
    key,
    revision: Number(previous?.revision || 0) + 1,
    disposed: false,
    disposeReason: '',
    disposeHandlers: new Set(),
    onDispose(handler) {
      if (typeof handler !== 'function') return () => {};
      if (runtime.disposed) {
        handler(runtime.disposeReason || 'already_disposed');
        return () => {};
      }
      runtime.disposeHandlers.add(handler);
      return () => runtime.disposeHandlers.delete(handler);
    },
    dispose(reason = 'manual') {
      if (runtime.disposed) return;
      runtime.disposed = true;
      runtime.disposeReason = String(reason || 'manual');
      for (const handler of runtime.disposeHandlers) {
        try {
          handler(runtime.disposeReason);
        } catch {}
      }
      runtime.disposeHandlers.clear();
      if (root[key] === runtime) delete root[key];
    },
  };
  root[key] = runtime;
  return runtime;
}

export { CONTENT_RUNTIME_KEY };
