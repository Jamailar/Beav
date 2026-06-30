import type { BridgeCore } from '../types';

export function createSkillsBridge(core: BridgeCore) {
  return {
    listSkills: () => core.invokeChannel('skills:list'),
    listSkillsGuarded: <T = Record<string, unknown>>() =>
      core.invokeChannelGuarded<Array<T> | null>('skills:list', undefined, {
        timeoutMs: 2800,
        fallback: null,
        normalize: (value) => Array.isArray(value) ? value as Array<T> : [],
      }),
    skills: {
      save: (payload: Record<string, unknown>) => core.invokeChannel('skills:save', payload),
      create: <T = unknown>(payload: { name: string }) => core.invokeChannel('skills:create', payload) as Promise<T>,
      enable: <T = unknown>(payload: { name: string }) => core.invokeChannel('skills:enable', payload) as Promise<T>,
      disable: <T = unknown>(payload: { name: string }) => core.invokeChannel('skills:disable', payload) as Promise<T>,
      uninstall: <T = unknown>(payload: { name: string; scope?: 'user' | 'workspace' | string }) => core.invokeChannel('skills:uninstall', payload) as Promise<T>,
      marketplace: (payload?: Record<string, unknown>) => core.invokeChannel('skills:marketplace', payload || {}) as Promise<any>,
      marketplaceList: (payload?: Record<string, unknown>) => core.invokeChannel('skills:marketplace:list', payload || {}) as Promise<any>,
      readMarketplacePackage: <T = unknown>(payload: Record<string, unknown>) => core.invokeChannel('skills:marketplace:read-package', payload) as Promise<T>,
      installMarketplace: <T = unknown>(payload: Record<string, unknown>) => core.invokeChannel('skills:marketplace:install', payload) as Promise<T>,
      updateMarketplaceInstalled: <T = unknown>(payload: Record<string, unknown>) => core.invokeChannel('skills:marketplace:update-installed', payload) as Promise<T>,
      marketInstall: <T = unknown>(payload: Record<string, unknown>) => core.invokeChannel('skills:market-install', payload) as Promise<T>,
      marketSources: {
        list: <T = unknown>(payload?: Record<string, unknown>) => core.invokeChannel('skills:market-sources:list', payload || {}) as Promise<T>,
        add: <T = unknown>(payload: Record<string, unknown>) => core.invokeChannel('skills:market-sources:add', payload) as Promise<T>,
        update: <T = unknown>(payload: Record<string, unknown>) => core.invokeChannel('skills:market-sources:update', payload) as Promise<T>,
        remove: <T = unknown>(payload: Record<string, unknown>) => core.invokeChannel('skills:market-sources:remove', payload) as Promise<T>,
        refresh: <T = unknown>(payload?: Record<string, unknown>) => core.invokeChannel('skills:market-sources:refresh', payload || {}) as Promise<T>,
      },
      installFromRepo: <T = unknown>(payload: Record<string, unknown>) => core.invokeChannel('skills:install-from-repo', payload) as Promise<T>,
    },
  };
}
