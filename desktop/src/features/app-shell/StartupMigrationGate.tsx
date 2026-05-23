import { useCallback, useEffect, useState } from 'react';
import { StartupMigrationModal } from '../../components/StartupMigrationModal';
import type { StartupMigrationState } from './types';

export function StartupMigrationGate() {
  const [startupMigration, setStartupMigration] = useState<StartupMigrationState | null>(null);
  const [startupMigrationBusy, setStartupMigrationBusy] = useState(false);
  const [startupMigrationDismissed, setStartupMigrationDismissed] = useState(false);

  useEffect(() => {
    let disposed = false;

    const applyStatus = (value: unknown) => {
      if (disposed || !value || typeof value !== 'object') return;
      const next = value as StartupMigrationState;
      setStartupMigration(next);
      if (next.status === 'running') {
        setStartupMigrationBusy(true);
        setStartupMigrationDismissed(false);
      } else {
        setStartupMigrationBusy(false);
      }
    };

    void window.ipcRenderer.startupMigration.getStatus<StartupMigrationState>().then(applyStatus);
    const handleStatus = (_event: unknown, payload: unknown) => applyStatus(payload);
    window.ipcRenderer.on('app:startup-migration-status', handleStatus as (...args: unknown[]) => void);

    return () => {
      disposed = true;
      window.ipcRenderer.off('app:startup-migration-status', handleStatus as (...args: unknown[]) => void);
    };
  }, []);

  const shouldShowStartupMigration = Boolean(
    startupMigration
      && startupMigration.shouldShowModal
      && !startupMigrationDismissed
      && (
        startupMigration.status === 'running'
        || startupMigration.status === 'completed'
        || startupMigration.status === 'failed'
        || startupMigration.status === 'pending'
      ),
  );

  const handleStartStartupMigration = useCallback(async () => {
    setStartupMigrationBusy(true);
    setStartupMigrationDismissed(false);
    try {
      const next = await window.ipcRenderer.startupMigration.start<StartupMigrationState>();
      if (next && typeof next === 'object') {
        setStartupMigration(next);
      }
    } finally {
      setStartupMigrationBusy(false);
    }
  }, []);

  const handleCloseStartupMigration = useCallback(() => {
    if (startupMigration?.status === 'running') return;
    setStartupMigration((current) => {
      if (!current) return current;
      return {
        ...current,
        shouldShowModal: false,
      };
    });
    setStartupMigrationDismissed(true);
  }, [startupMigration?.status]);

  return (
    <StartupMigrationModal
      open={shouldShowStartupMigration}
      state={startupMigration}
      busy={startupMigrationBusy}
      onStart={() => void handleStartStartupMigration()}
      onClose={handleCloseStartupMigration}
    />
  );
}
