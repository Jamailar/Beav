import type { BridgeCore } from '../types';

export function createAiConfigBridge(core: BridgeCore) {
  return {
    fetchModels: (config: unknown) => core.invokeChannel('ai:fetch-models', config),
    aiRoles: {
      list: () => core.invokeChannel('ai:roles:list'),
    },
    detectAiProtocol: (config: unknown) => core.invokeChannel('ai:detect-protocol', config),
    testAiConnection: (config: unknown) => core.invokeChannel('ai:test-connection', config),
  };
}
