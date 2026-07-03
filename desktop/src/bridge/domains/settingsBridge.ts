import type { BridgeCore, Listener } from '../types';

export function createSettingsBridge(core: BridgeCore) {
  return {
    saveSettings: (settings: unknown) => core.invokeChannel('db:save-settings', settings),
    getSettings: () => core.invokeChannel('db:get-settings'),
    onSettingsUpdated: (listener: Listener) => core.on('settings:updated', listener),
    offSettingsUpdated: (listener: Listener) => core.off('settings:updated', listener),
    onDataChanged: (listener: Listener) => core.on('data:changed', listener),
    offDataChanged: (listener: Listener) => core.off('data:changed', listener),
    pickWorkspaceDir: () => core.invokeChannel('settings:pick-workspace-dir'),
  };
}
