import type { BridgeCore } from '../types';

export function createAccountsBridge(core: BridgeCore) {
  return {
    accounts: {
      list: <T = unknown>() => core.invokeChannel('accounts:list') as Promise<T>,
      get: <T = unknown>(payload: { accountId: string }) => core.invokeChannel('accounts:get', payload) as Promise<T>,
    },
  };
}
