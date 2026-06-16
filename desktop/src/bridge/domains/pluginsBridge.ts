import type { BridgeCore, Listener } from '../types';

export function createPluginsBridge(core: BridgeCore) {
  return {
    plugins: {
      list: () => core.invokeChannel('plugins:list'),
      connectors: () => core.invokeChannel('plugins:connectors'),
      marketplace: (payload?: { url?: string }) => core.invokeChannel('plugins:marketplace', payload || {}),
      codexMarketplace: (payload?: { path?: string; codexRoot?: string }) =>
        core.invokeChannel('plugins:codex-marketplace', payload || {}),
      discoverLocal: (payload: { path?: string; sourceRoot?: string }) =>
        core.invokeChannel('plugins:discover-local', payload),
      install: (payload: { path: string; pluginName?: string; pluginId?: string; id?: string }) =>
        core.invokeChannel('plugins:install', payload),
      installCodex: (payload: { path?: string; pluginName?: string; pluginId?: string; id?: string; remotePluginId?: string; remoteMarketplaceName?: string; codexRoot?: string }) =>
        core.invokeChannel('plugins:install-codex', payload),
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
