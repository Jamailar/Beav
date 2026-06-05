import type { BridgeCore } from '../types';

export function createCoverBridge(core: BridgeCore) {
  return {
    cover: {
      list: (payload?: Record<string, unknown>) => core.invokeChannel('cover:list', payload || {}),
      generate: (payload: Record<string, unknown>) => core.invokeChannel('cover:generate', payload),
      openRoot: () => core.invokeChannel('cover:open-root'),
      open: (payload: { assetId: string }) => core.invokeChannel('cover:open', payload),
      saveTemplateImage: (payload: { imageSource: string }) => core.invokeChannel('cover:save-template-image', payload),
      templates: {
        list: () => core.invokeChannel('cover:templates:list'),
        save: (payload: { template: Record<string, unknown> }) => core.invokeChannel('cover:templates:save', payload),
        delete: (payload: { templateId: string }) => core.invokeChannel('cover:templates:delete', payload),
        importLegacy: (payload: { templates: Record<string, unknown>[] }) => core.invokeChannel('cover:templates:import-legacy', payload),
      },
    },
  };
}
