import type { BridgeCore, Listener } from '../types';

type SpaceListResult = {
  activeSpaceId?: string;
  spaces?: Array<{ id: string; name: string; createdAt?: string; updatedAt?: string }>;
};

export type SpaceInitStatus = 'not_started' | 'running' | 'completed' | 'failed';

export type SpaceInitState = {
  schemaVersion?: number;
  status?: SpaceInitStatus;
  phase?: 'branch' | 'input' | 'capture' | 'positioning' | 'completed' | string | null;
  homepageUrl?: string | null;
  platform?: string | null;
  accountId?: string | null;
  progress?: Record<string, unknown> | null;
  startedAt?: string | null;
  completedAt?: string | null;
  lastError?: string | null;
  updatedAt?: string | null;
};

export function createSpacesBridge(core: BridgeCore) {
  return {
    spaces: {
      list: () => core.invokeCommandGuarded<SpaceListResult>(
        'spaces_list',
        undefined,
        {
          timeoutMs: 2200,
          fallbackChannel: 'spaces:list',
          normalize: (value) => {
            const raw = (value && typeof value === 'object') ? value as {
              activeSpaceId?: unknown;
              spaces?: unknown;
            } : {};
            return {
              activeSpaceId: typeof raw.activeSpaceId === 'string' ? raw.activeSpaceId : undefined,
              spaces: Array.isArray(raw.spaces) ? raw.spaces as SpaceListResult['spaces'] : undefined,
            };
          },
        },
      ),
      switch: (spaceId: string) => core.invokeChannel('spaces:switch', spaceId),
      create: (payload: { name: string }) => core.invokeChannel('spaces:create', payload),
      rename: (payload: { id: string; name: string }) => core.invokeChannel('spaces:rename', payload),
      delete: (spaceId: string) => core.invokeChannel('spaces:delete', spaceId),
      init: {
        get: <T = SpaceInitState>() => core.invokeChannel('space-init:get') as Promise<T>,
        start: <T = SpaceInitState>(payload: { homepageUrl: string; platform?: string; accountId?: string; phase?: string; progress?: Record<string, unknown> }) =>
          core.invokeChannel('space-init:start', payload) as Promise<T>,
        progress: <T = SpaceInitState>(payload: {
          phase?: string;
          homepageUrl?: string;
          platform?: string;
          accountId?: string;
          progress?: Record<string, unknown>;
        }) => core.invokeChannel('space-init:progress', payload) as Promise<T>,
        complete: <T = SpaceInitState>(payload: {
          homepageUrl: string;
          platform?: string;
          accountId?: string;
          account?: Record<string, unknown> | null;
          progress?: Record<string, unknown>;
          skipProfileWrite?: boolean;
        }) => core.invokeChannel('space-init:complete', payload) as Promise<T>,
        fail: <T = SpaceInitState>(payload: { error: string }) => core.invokeChannel('space-init:fail', payload) as Promise<T>,
      },
      onChanged: (listener: Listener) => core.on('space:changed', listener),
      offChanged: (listener: Listener) => core.off('space:changed', listener),
    },
  };
}
