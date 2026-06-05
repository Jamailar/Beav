import type { BridgeCore, Listener } from '../types';

export function createPluginsBridge(core: BridgeCore) {
  return {
    plugins: {
      list: () => core.invokeChannel('plugins:list'),
      marketplace: (payload?: { url?: string }) => core.invokeChannel('plugins:marketplace', payload || {}),
      install: (payload: { path: string }) => core.invokeChannel('plugins:install', payload),
      installMarketplace: (payload: { id?: string; repo: string; version?: string; packageUrl?: string }) =>
        core.invokeChannel('plugins:install-marketplace', payload),
      setEnabled: (payload: { pluginId: string; enabled: boolean }) =>
        core.invokeChannel('plugins:set-enabled', payload),
      uninstall: (payload: { pluginId: string }) => core.invokeChannel('plugins:uninstall', payload),
      openDataDir: (payload?: { pluginId?: string }) => core.invokeChannel('plugins:open-data-dir', payload || {}),
      syncCapabilities: () => core.invokeChannel('plugins:sync-capabilities'),
      readData: (payload: { pluginId: string; source: string; limit?: number; kind?: string; query?: string }) =>
        core.invokeChannel('plugins:read-data', payload),
      home: () => core.invokeChannel('plugins:home'),
      onChanged: (listener: Listener) => core.on('plugins:changed', listener),
      offChanged: (listener: Listener) => core.off('plugins:changed', listener),
    },
  };
}
