import type { BridgeCore } from '../types';

export function createSubjectsBridge(core: BridgeCore) {
  return {
    subjects: {
      list: (payload?: Record<string, unknown>) => core.invokeChannel('subjects:list', payload || {}),
      get: (payload: { id: string }) => core.invokeChannel('subjects:get', payload),
      create: (payload: unknown) => core.invokeChannel('subjects:create', payload),
      update: (payload: unknown) => core.invokeChannel('subjects:update', payload),
      generateCharacterCard: (payload: { id: string }) => core.invokeChannel('subjects:generate-character-card', payload),
      delete: (payload: { id: string }) => core.invokeChannel('subjects:delete', payload),
      search: (payload?: Record<string, unknown>) => core.invokeChannel('subjects:search', payload || {}),
      categories: {
        list: () => core.invokeChannel('subjects:categories:list'),
        create: (payload: { name: string }) => core.invokeChannel('subjects:categories:create', payload),
        update: (payload: { id: string; name: string }) => core.invokeChannel('subjects:categories:update', payload),
        delete: (payload: { id: string }) => core.invokeChannel('subjects:categories:delete', payload),
      },
    },
    brandWorkspace: {
      list: () => core.invokeChannel('brand-workspace:list'),
      get: (payload: { id: string }) => core.invokeChannel('brand-workspace:get', payload),
      upsertBrand: (payload: unknown) => core.invokeChannel('brand-workspace:brand:upsert', payload),
      upsertProduct: (payload: unknown) => core.invokeChannel('brand-workspace:product:upsert', payload),
      upsertSku: (payload: unknown) => core.invokeChannel('brand-workspace:sku:upsert', payload),
      upsertProductDetailPage: (payload: unknown) => core.invokeChannel('brand-workspace:product-detail-page:upsert', payload),
      rebuildAiIndex: () => core.invokeChannel('brand-workspace:rebuild-ai-index'),
    },
  };
}
