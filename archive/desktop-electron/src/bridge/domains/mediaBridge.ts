import type { BridgeCore } from '../types';

export function createMediaBridge(core: BridgeCore) {
  return {
    media: {
      list: <T = unknown>(payload?: Record<string, unknown>) => core.invokeChannel('media:list', payload || {}) as Promise<T>,
      update: <T = unknown>(payload: Record<string, unknown>) => core.invokeChannel('media:update', payload) as Promise<T>,
      bind: <T = unknown>(payload: Record<string, unknown>) => core.invokeChannel('media:bind', payload) as Promise<T>,
      delete: <T = unknown>(payload: Record<string, unknown>) => core.invokeChannel('media:delete', payload) as Promise<T>,
      open: <T = unknown>(payload: { assetId: string }) => core.invokeChannel('media:open', payload) as Promise<T>,
      openRoot: <T = unknown>() => core.invokeChannel('media:open-root') as Promise<T>,
      importFiles: <T = unknown>() => core.invokeChannel('media:import-files') as Promise<T>,
    },
    imageGeneration: {
      generate: <T = unknown>(payload: Record<string, unknown>) => core.invokeChannel('image-gen:generate', payload) as Promise<T>,
    },
    videoGeneration: {
      generate: <T = unknown>(payload: Record<string, unknown>) => core.invokeChannel('video-gen:generate', payload) as Promise<T>,
    },
  };
}
