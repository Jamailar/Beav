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
      marketplace: (payload?: { url?: string }) => core.invokeChannel('skills:marketplace', payload || {}) as Promise<any>,
      marketInstall: <T = unknown>(payload: Record<string, unknown>) => core.invokeChannel('skills:market-install', payload) as Promise<T>,
      installFromRepo: <T = unknown>(payload: Record<string, unknown>) => core.invokeChannel('skills:install-from-repo', payload) as Promise<T>,
    },
  };
}
