import type { BridgeCore } from '../types';

export type TopicCenterListOptions = {
  includeAbandoned?: boolean;
  status?: string;
  query?: string;
};

const unavailable = (feature: string) => ({
  success: false,
  error: `${feature} is not available in the Electron archive build.`,
  unavailable: true,
});

export function createTopicCenterBridge(core: BridgeCore) {
  return {
    topicCenter: {
      list: <T = unknown>(options?: TopicCenterListOptions) =>
        core.invokeChannelGuarded<T>('topic-center:list', options || {}, {
          timeoutMs: 3200,
          fallback: { success: true, items: [], topics: [], unavailable: true } as T,
        }),
      get: <T = unknown>(id: string) =>
        core.invokeChannelGuarded<T>('topic-center:get', id, {
          timeoutMs: 3200,
          fallback: { success: false, item: null, topic: null, unavailable: true } as T,
        }),
      create: <T = unknown>(payload: Record<string, unknown>) =>
        core.invokeChannelGuarded<T>('topic-center:create', payload, {
          timeoutMs: 3200,
          fallback: unavailable('Topic center creation') as T,
        }),
      update: <T = unknown>(id: string, patch: Record<string, unknown>) =>
        core.invokeChannelGuarded<T>('topic-center:update', { id, patch }, {
          timeoutMs: 3200,
          fallback: unavailable('Topic center updates') as T,
        }),
      bulkUpsert: <T = unknown>(payload: Record<string, unknown>) =>
        core.invokeChannelGuarded<T>('topic-center:bulk-upsert', payload, {
          timeoutMs: 3200,
          fallback: unavailable('Topic center bulk upsert') as T,
        }),
      abandon: <T = unknown>(id: string) =>
        core.invokeChannelGuarded<T>('topic-center:abandon', id, {
          timeoutMs: 3200,
          fallback: unavailable('Topic center abandon') as T,
        }),
      delete: <T = unknown>(id: string) =>
        core.invokeChannelGuarded<T>('topic-center:delete', id, {
          timeoutMs: 3200,
          fallback: unavailable('Topic center deletion') as T,
        }),
    },
  };
}
