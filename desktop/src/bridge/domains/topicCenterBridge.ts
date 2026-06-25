import type { BridgeCore } from '../types';

export interface TopicCenterListOptions {
  includeAbandoned?: boolean;
  status?: string;
  query?: string;
}

export function createTopicCenterBridge(core: BridgeCore) {
  return {
    topicCenter: {
      list: <T = unknown>(options?: TopicCenterListOptions) =>
        core.invokeChannel('topic-center:list', options || {}) as Promise<T>,
      get: <T = unknown>(id: string) =>
        core.invokeChannel('topic-center:get', id) as Promise<T>,
      create: <T = unknown>(payload: Record<string, unknown>) =>
        core.invokeChannel('topic-center:create', payload) as Promise<T>,
      update: <T = unknown>(id: string, patch: Record<string, unknown>) =>
        core.invokeChannel('topic-center:update', { id, patch }) as Promise<T>,
      bulkUpsert: <T = unknown>(payload: Record<string, unknown>) =>
        core.invokeChannel('topic-center:bulk-upsert', payload) as Promise<T>,
      abandon: <T = unknown>(id: string) =>
        core.invokeChannel('topic-center:abandon', id) as Promise<T>,
      delete: <T = unknown>(id: string) =>
        core.invokeChannel('topic-center:delete', id) as Promise<T>,
    },
  };
}
