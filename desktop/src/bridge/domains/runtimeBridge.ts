import type { BridgeCore, Listener } from '../types';

export function createRuntimeBridge(core: BridgeCore) {
  return {
    runtime: {
      query: (payload: { sessionId?: string; message: string; modelConfig?: unknown }) =>
        core.invokeChannel('runtime:query', payload),
      resume: (payload: { sessionId: string }) => core.invokeChannel('runtime:resume', payload),
      forkSession: (payload: { sessionId: string }) => core.invokeChannel('runtime:fork-session', payload),
      exportSession: (payload: { sessionId: string; includeChildSessions?: boolean; writePackage?: boolean }) =>
        core.invokeChannelGuarded('runtime:export-session', payload, {
          fallback: { success: false, error: 'Runtime session export is unavailable in the Electron archive' },
        }),
      importSession: (payload: { packagePath: string; overwrite?: boolean }) =>
        core.invokeChannelGuarded('runtime:import-session', payload, {
          fallback: { success: false, error: 'Runtime session import is unavailable in the Electron archive' },
        }),
      getTrace: (payload: { sessionId: string; limit?: number }) => core.invokeChannel('runtime:get-trace', payload),
      getCheckpoints: (payload: { sessionId: string; limit?: number }) =>
        core.invokeChannel('runtime:get-checkpoints', payload),
      getToolResults: (payload: { sessionId: string; limit?: number }) =>
        core.invokeChannel('runtime:get-tool-results', payload),
      getEvents: (payload: {
        sessionId: string;
        limit?: number;
        includeChildSessions?: boolean;
        category?: string;
        eventType?: string;
      }) => core.invokeChannelGuarded('runtime:get-events', payload, { fallback: [] }),
      getModelConfig: () => core.invokeChannelGuarded('runtime:get-model-config', undefined, { fallback: null }),
      listApprovals: () => core.invokeChannelGuarded('runtime:list-approvals', undefined, { fallback: [] }),
      onEvent: (listener: Listener) => core.on('runtime:event', listener),
      offEvent: (listener: Listener) => core.off('runtime:event', listener),
    },
    taskPanel: {
      list: (payload?: { limit?: number }) => core.invokeChannel('task-panel:list', payload || {}),
    },
    backgroundTasks: {
      list: () => core.invokeChannel('background-tasks:list'),
      get: (taskId: string) => core.invokeChannel('background-tasks:get', { taskId }),
      cancel: (taskId: string) => core.invokeChannel('background-tasks:cancel', { taskId }),
      retry: (taskId: string) => core.invokeChannel('background-tasks:retry', { taskId }),
      archive: (taskId: string) => core.invokeChannel('background-tasks:archive', { taskId }),
      onUpdated: (listener: Listener) => core.on('background:task-updated', listener),
      offUpdated: (listener: Listener) => core.off('background:task-updated', listener),
    },
    backgroundWorkers: {
      getPoolState: () => core.invokeChannel('background-workers:get-pool-state'),
    },
    tasks: {
      create: (payload?: Record<string, unknown>) => core.invokeChannel('tasks:create', payload || {}),
      list: (payload?: Record<string, unknown>) => core.invokeChannel('tasks:list', payload || {}),
      get: (payload: { taskId: string }) => core.invokeChannel('tasks:get', payload),
      resume: (payload: { taskId: string }) => core.invokeChannel('tasks:resume', payload),
      cancel: (payload: { taskId: string }) => core.invokeChannel('tasks:cancel', payload),
      trace: (payload: { taskId: string; limit?: number }) => core.invokeChannel('tasks:trace', payload),
    },
    work: {
      list: (payload?: Record<string, unknown>) => core.invokeChannel('work:list', payload || {}),
      get: (payload: { id: string }) => core.invokeChannel('work:get', payload),
      ready: (payload?: Record<string, unknown>) => core.invokeChannel('work:ready', payload || {}),
      update: (payload: Record<string, unknown>) => core.invokeChannel('work:update', payload),
    },
  };
}
