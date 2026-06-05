import { useEffect, useState } from 'react';

type LlmReadinessSnapshot = Awaited<ReturnType<typeof window.ipcRenderer.llmReadiness.getState>>;

type LlmReadinessStateResult = {
  snapshot: LlmReadinessSnapshot | null;
  bootstrapped: boolean;
};

export function useLlmReadinessState(): LlmReadinessStateResult {
  const [snapshot, setSnapshot] = useState<LlmReadinessSnapshot | null>(null);
  const [bootstrapped, setBootstrapped] = useState(false);

  useEffect(() => {
    let mounted = true;

    const applySnapshot = (nextSnapshot: LlmReadinessSnapshot | null | undefined) => {
      if (!mounted) return;
      setSnapshot(nextSnapshot || null);
    };

    const handleStateChanged = (
      event:
        | { payload?: LlmReadinessSnapshot | null }
        | LlmReadinessSnapshot
        | null
        | undefined,
      payloadArg?: LlmReadinessSnapshot | null,
    ) => {
      const payload = payloadArg !== undefined
        ? payloadArg
        : (event && typeof event === 'object' && 'payload' in event)
          ? (event as { payload?: LlmReadinessSnapshot | null }).payload
          : (event as LlmReadinessSnapshot | null | undefined);
      applySnapshot(payload);
    };

    void window.ipcRenderer.llmReadiness.getState()
      .then((nextSnapshot) => {
        applySnapshot(nextSnapshot);
      })
      .catch(() => {
        applySnapshot(null);
      })
      .finally(() => {
        if (mounted) {
          setBootstrapped(true);
        }
      });

    const handleSettingsUpdated = () => {
      void window.ipcRenderer.llmReadiness.refresh()
        .then((nextSnapshot) => applySnapshot(nextSnapshot as LlmReadinessSnapshot))
        .catch(() => undefined);
    };

    window.ipcRenderer.llmReadiness.onStateChanged(handleStateChanged);
    window.ipcRenderer.onSettingsUpdated(handleSettingsUpdated);
    return () => {
      mounted = false;
      window.ipcRenderer.llmReadiness.offStateChanged(handleStateChanged);
      window.ipcRenderer.offSettingsUpdated(handleSettingsUpdated);
    };
  }, []);

  return {
    snapshot,
    bootstrapped,
  };
}
