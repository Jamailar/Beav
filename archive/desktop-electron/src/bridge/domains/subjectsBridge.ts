import type { BridgeCore } from '../types';

const brandWorkspaceUnavailable = {
  success: false,
  error: '品牌工作区后端尚未迁移到 Electron 开源版',
};

export function createSubjectsBridge(core: BridgeCore) {
  return {
    subjects: {
      list: (payload?: Record<string, unknown>) => core.invokeChannel('subjects:list', payload || {}),
      get: (payload: { id: string }) => core.invokeChannel('subjects:get', payload),
      create: (payload: unknown) => core.invokeChannel('subjects:create', payload),
      update: (payload: unknown) => core.invokeChannel('subjects:update', payload),
      delete: (payload: { id: string }) => core.invokeChannel('subjects:delete', payload),
      generateCharacterCard: (payload: { id: string }) => core.invokeChannel('subjects:generate-character-card', payload),
      search: (payload?: Record<string, unknown>) => core.invokeChannel('subjects:search', payload || {}),
      categories: {
        list: () => core.invokeChannel('subjects:categories:list'),
        create: (payload: { name: string }) => core.invokeChannel('subjects:categories:create', payload),
        update: (payload: { id: string; name: string }) => core.invokeChannel('subjects:categories:update', payload),
        delete: (payload: { id: string }) => core.invokeChannel('subjects:categories:delete', payload),
      },
    },
    brandWorkspace: {
      list: async () => ({ success: true, brands: [] }),
      get: async () => ({ ...brandWorkspaceUnavailable, brand: null }),
      upsertBrand: async () => brandWorkspaceUnavailable,
      upsertProduct: async () => brandWorkspaceUnavailable,
      upsertSku: async () => brandWorkspaceUnavailable,
      upsertProductDetailPage: async () => brandWorkspaceUnavailable,
      rebuildAiIndex: async () => brandWorkspaceUnavailable,
    },
  };
}
