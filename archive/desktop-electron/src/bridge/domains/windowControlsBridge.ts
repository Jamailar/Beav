import type { BridgeCore } from '../types';

export function createWindowControlsBridge(core: BridgeCore) {
  return {
    windowControls: {
      startDragging: async () => undefined,
      minimize: () => core.invokeChannel('window:minimize'),
      toggleMaximize: () => core.invokeChannel('window:toggle-maximize'),
      close: () => core.invokeChannel('window:close'),
    },
  };
}
