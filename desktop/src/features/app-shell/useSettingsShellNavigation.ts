import { useState } from 'react';
import type { SettingsNavigationTarget } from './types';

export function useSettingsShellNavigation() {
  const [settingsNavigationTarget, setSettingsNavigationTarget] = useState<SettingsNavigationTarget | null>(null);

  return {
    settingsNavigationTarget,
    setSettingsNavigationTarget,
  };
}
