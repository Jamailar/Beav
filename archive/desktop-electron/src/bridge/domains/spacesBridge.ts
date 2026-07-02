import type { BridgeCore, Listener } from '../types';

type SpaceListResult = {
  activeSpaceId?: string;
  spaces?: Array<{ id: string; name: string; createdAt?: string; updatedAt?: string }>;
};

type CreateSpacePayload = string | { name: string };

function normalizeCreateSpacePayload(payload: CreateSpacePayload): string {
  if (typeof payload === 'string') return payload;
  return payload.name;
}

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
              activeSpaceId: typeof raw.activeSpaceId === 'string' ? raw.activeSpaceId : 'default',
              spaces: Array.isArray(raw.spaces) ? raw.spaces as SpaceListResult['spaces'] : [],
            };
          },
        },
      ),
      switch: (spaceId: string) => core.invokeChannel('spaces:switch', spaceId),
      create: (payload: CreateSpacePayload) => core.invokeChannel('spaces:create', normalizeCreateSpacePayload(payload)),
      rename: (payload: { id: string; name: string }) => core.invokeChannel('spaces:rename', payload),
      delete: (spaceId: string) => core.invokeChannel('spaces:delete', spaceId),
      onChanged: (listener: Listener) => core.on('space:changed', listener),
      offChanged: (listener: Listener) => core.off('space:changed', listener),
    },
  };
}
