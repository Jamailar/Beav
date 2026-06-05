import type { BridgeCore, Listener } from '../types';

type SpaceListResult = {
  activeSpaceId?: string;
  spaces?: Array<{ id: string; name: string; createdAt?: string; updatedAt?: string }>;
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
      create: () => Promise.resolve({ success: false, error: '创建新空间功能已关闭' }),
      rename: (payload: { id: string; name: string }) => core.invokeChannel('spaces:rename', payload),
      delete: (spaceId: string) => core.invokeChannel('spaces:delete', spaceId),
      onChanged: (listener: Listener) => core.on('space:changed', listener),
      offChanged: (listener: Listener) => core.off('space:changed', listener),
    },
  };
}
