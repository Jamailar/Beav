import type { BridgeCore } from '../types';

export function createMcpBridge(core: BridgeCore) {
  return {
    mcp: {
      list: () => core.invokeChannel('mcp:list'),
      add: (payload: {
        name: string;
        url?: string;
        command?: string;
        args?: string[];
        env?: Record<string, string>;
        cwd?: string;
        transport?: string;
        enabled?: boolean;
        bearerTokenEnvVar?: string;
      }) => core.invokeChannel('mcp:add', payload),
      get: (serverId: string) => core.invokeChannel('mcp:get', { serverId }),
      remove: (serverId: string) => core.invokeChannel('mcp:remove', { serverId }),
      enable: (serverId: string) => core.invokeChannel('mcp:enable', { serverId }),
      disable: (serverId: string) => core.invokeChannel('mcp:disable', { serverId }),
      save: (servers: unknown[]) => core.invokeChannel('mcp:save', { servers }),
      test: (server: unknown) => core.invokeChannel('mcp:test', { server }),
      call: (server: unknown, method: string, params?: unknown) =>
        core.invokeChannel('mcp:call', { server, method, params: params ?? {} }),
      sessions: () => core.invokeChannel('mcp:sessions'),
      listTools: (server: unknown) => core.invokeChannel('mcp:list-tools', { server }),
      listResources: (server: unknown) => core.invokeChannel('mcp:list-resources', { server }),
      listResourceTemplates: (server: unknown) =>
        core.invokeChannel('mcp:list-resource-templates', { server }),
      disconnect: (server: unknown) => core.invokeChannel('mcp:disconnect', { server }),
      disconnectAll: () => core.invokeChannel('mcp:disconnect-all'),
      discoverLocal: () => core.invokeChannel('mcp:discover-local'),
      importLocal: () => core.invokeChannel('mcp:import-local'),
      oauthStatus: (serverId: string) => core.invokeChannel('mcp:oauth-status', { serverId }),
    },
  };
}
