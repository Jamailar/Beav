import type { BridgeCore } from '../types';

export function createArchivesBridge(core: BridgeCore) {
  return {
    archives: {
      list: <T = unknown>() => core.invokeChannel('archives:list') as Promise<T>,
      create: <T = unknown>(payload: Record<string, unknown>) => core.invokeChannel('archives:create', payload) as Promise<T>,
      update: <T = unknown>(payload: Record<string, unknown>) => core.invokeChannel('archives:update', payload) as Promise<T>,
      delete: <T = unknown>(profileId: string) => core.invokeChannel('archives:delete', profileId) as Promise<T>,
      samples: {
        list: <T = unknown>(profileId: string) => core.invokeChannel('archives:samples:list', profileId) as Promise<T>,
        create: <T = unknown>(payload: Record<string, unknown>) => core.invokeChannel('archives:samples:create', payload) as Promise<T>,
        update: <T = unknown>(payload: Record<string, unknown>) => core.invokeChannel('archives:samples:update', payload) as Promise<T>,
        delete: <T = unknown>(sampleId: string) => core.invokeChannel('archives:samples:delete', sampleId) as Promise<T>,
      },
    },
  };
}
