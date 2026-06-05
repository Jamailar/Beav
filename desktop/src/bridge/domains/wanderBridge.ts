import type { BridgeCore } from '../types';

export function createWanderBridge(core: BridgeCore) {
  return {
    wander: {
      listHistory: <T = unknown>() => core.invokeChannel('wander:list-history') as Promise<T>,
      deleteHistory: (id: string) => core.invokeChannel('wander:delete-history', id),
      getGuidedItems: <T = unknown>(payload: Record<string, unknown>) => core.invokeChannel('wander:get-guided-items', payload) as Promise<T>,
      getRandom: <T = unknown>() => core.invokeChannel('wander:get-random') as Promise<T>,
      brainstorm: (payload: Record<string, unknown>) => core.sendChannel('wander:brainstorm', payload),
    },
  };
}
