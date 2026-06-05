import type { BridgeCore } from '../types';

export function createToolsBridge(core: BridgeCore) {
  return {
    toolHooks: {
      list: () => core.invokeChannel('tools:hooks:list'),
      register: (hook: unknown) => core.invokeChannel('tools:hooks:register', hook),
      remove: (hookId: string) => core.invokeChannel('tools:hooks:remove', { hookId }),
    },
    toolDiagnostics: {
      list: () => core.invokeChannel('tools:diagnostics:list'),
      runDirect: (toolName: string) => core.invokeChannel('tools:diagnostics:run-direct', { toolName }),
      runAi: (toolName: string) => core.invokeChannel('tools:diagnostics:run-ai', { toolName }),
    },
  };
}
