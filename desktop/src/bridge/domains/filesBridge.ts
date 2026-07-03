import type { BridgeCore } from '../types';

export function createFilesBridge(core: BridgeCore) {
  return {
    files: {
      showInFolder: (payload: { source: string }) => core.invokeChannel('file:show-in-folder', payload),
      copyImage: (payload: { source: string }) => core.invokeChannel('file:copy-image', payload),
      saveAs: (payload: { source: string; defaultName?: string }) => core.invokeChannel('file:save-as', payload),
      saveZip: (payload: { defaultName?: string; files: Array<{ source: string; name?: string }> }) =>
        core.invokeChannel('file:save-zip', payload),
      resolvePreview: (payload: { source: string }) => core.invokeChannel('file:preview-resolve', payload),
    },
  };
}
