import type { BridgeCore } from '../types';

export function createCliRuntimeBridge(core: BridgeCore) {
  return {
    cliRuntime: {
      detect: (payload?: { commands?: string[] }) => core.invokeChannel('cli-runtime:detect', payload || {}),
      diagnose: async (payload: { command: string; executionMode?: string }) => {
        const command = String(payload?.command || '').trim();
        const detectResult = await core.invokeChannel('cli-runtime:detect', command ? { commands: [command] } : {});
        const inspectResult = command ? await core.invokeChannel('cli-runtime:inspect', { command }) : null;
        const tool = (inspectResult && typeof inspectResult === 'object' && (inspectResult as Record<string, unknown>).tool)
          || (detectResult && typeof detectResult === 'object' && Array.isArray((detectResult as Record<string, unknown>).tools)
            ? ((detectResult as Record<string, unknown>).tools as unknown[])[0]
            : null);
        return {
          success: true,
          command,
          executionMode: payload?.executionMode || 'host',
          tool,
          detection: detectResult,
          inspection: inspectResult,
          sandbox: { mode: payload?.executionMode || 'host', backend: 'electron', allowNetwork: true },
          summary: tool ? `已检测到 ${command}` : `未检测到 ${command}`,
        };
      },
      discover: (payload?: { query?: string; limit?: number }) =>
        core.invokeChannel('cli-runtime:discover', payload || {}),
      listTools: () => core.invokeChannel('cli-runtime:list-tools'),
      inspect: (payload: { toolId?: string; command?: string; executable?: string }) =>
        core.invokeChannel('cli-runtime:inspect', payload),
      listEnvironments: () => core.invokeChannel('cli-runtime:list-environments'),
      createEnvironment: (payload: {
        scope: 'app-global' | 'workspace-local' | 'task-ephemeral';
        workspaceRoot?: string;
        taskId?: string;
      }) => core.invokeChannel('cli-runtime:create-environment', payload),
      install: (payload: {
        environmentId?: string;
        installMethod: string;
        spec: string;
        toolName?: string;
        executionMode?: string;
      }) => core.invokeChannel('cli-runtime:install', payload),
      execute: (payload: {
        environmentId: string;
        toolId?: string;
        argv: string[];
        cwd: string;
        executionMode?: string;
        usePty?: boolean;
        verificationRules?: unknown[];
      }) => core.invokeChannel('cli-runtime:execute', payload),
      cancelExecution: (payload: { executionId: string }) =>
        core.invokeChannel('cli-runtime:cancel-execution', payload),
      pollExecution: (payload: { executionId: string }) =>
        core.invokeChannel('cli-runtime:poll-execution', payload),
      verify: (payload: { executionId: string; rules: unknown[] }) =>
        core.invokeChannel('cli-runtime:verify', payload),
      approveEscalation: (payload: { escalationId: string; scope: 'once' | 'session' | 'always' }) =>
        core.invokeChannel('cli-runtime:approve-escalation', payload),
      denyEscalation: (payload: { escalationId: string; reason?: string }) =>
        core.invokeChannel('cli-runtime:deny-escalation', payload),
    },
  };
}
