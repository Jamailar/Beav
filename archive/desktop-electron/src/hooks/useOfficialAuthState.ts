import { useEffect, useState } from 'react';

type OfficialAuthStateSnapshot = Awaited<ReturnType<typeof window.ipcRenderer.auth.getState>>;

type OfficialAuthStateResult = {
  snapshot: OfficialAuthStateSnapshot | null;
  bootstrapped: boolean;
};

export function useOfficialAuthState(): OfficialAuthStateResult {
  const [snapshot, setSnapshot] = useState<OfficialAuthStateSnapshot | null>(null);
  const [bootstrapped, setBootstrapped] = useState(false);

  useEffect(() => {
    let mounted = true;

    const applySnapshot = (nextSnapshot: OfficialAuthStateSnapshot | null | undefined) => {
      if (!mounted) return;
      setSnapshot(nextSnapshot || null);
    };

    const handleStateChanged = (
      event:
        | { payload?: OfficialAuthStateSnapshot | null }
        | OfficialAuthStateSnapshot
        | null
        | undefined,
      payloadArg?: OfficialAuthStateSnapshot | null,
    ) => {
      const payload = payloadArg !== undefined
        ? payloadArg
        : (event && typeof event === 'object' && 'payload' in event)
          ? (event as { payload?: OfficialAuthStateSnapshot | null }).payload
          : (event as OfficialAuthStateSnapshot | null | undefined);
      applySnapshot(payload);
    };

    void window.ipcRenderer.auth.getState()
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

    window.ipcRenderer.auth.onStateChanged(handleStateChanged);
    return () => {
      mounted = false;
      window.ipcRenderer.auth.offStateChanged(handleStateChanged);
    };
  }, []);

  return {
    snapshot,
    bootstrapped,
  };
}
