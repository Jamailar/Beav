import type { BridgeCore, Listener } from '../types';

export function createWanderBridge(core: BridgeCore) {
  return {
    wander: {
      listHistory: <T = unknown>(options?: { includeAbandoned?: boolean }) =>
        core.invokeChannel('wander:list-history', options || {}) as Promise<T>,
      abandonHistory: (id: string) => core.invokeChannel('wander:abandon-history', id),
      deleteHistory: (id: string) => core.invokeChannel('wander:delete-history', id),
      getGuidedItems: <T = unknown>(payload: Record<string, unknown>) =>
        core.invokeChannel('wander:get-guided-items', payload) as Promise<T>,
      listCommentCandidates: <T = unknown>() =>
        core.invokeChannel('wander:list-comment-candidates') as Promise<T>,
      getRandom: <T = unknown>() => core.invokeChannel('wander:get-random') as Promise<T>,
      brainstorm: (payload: Record<string, unknown>) => core.sendChannel('wander:brainstorm', payload),
      onProgress: (listener: Listener) => core.on('wander:progress', listener),
      offProgress: (listener: Listener) => core.off('wander:progress', listener),
      onResult: (listener: Listener) => core.on('wander:result', listener),
      offResult: (listener: Listener) => core.off('wander:result', listener),
    },
  };
}
