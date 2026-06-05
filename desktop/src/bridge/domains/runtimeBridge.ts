import type { BridgeCore } from '../types';

export function createRuntimeBridge(core: BridgeCore) {
  return {
    runtime: {
      query: (payload: { sessionId?: string; message: string; modelConfig?: unknown }) =>
        core.invokeChannel('runtime:query', payload),
      resume: (payload: { sessionId: string }) => core.invokeChannel('runtime:resume', payload),
      forkSession: (payload: { sessionId: string }) =>
        core.invokeChannel('runtime:fork-session', payload),
      getTrace: (payload: { sessionId: string; limit?: number }) =>
        core.invokeChannel('runtime:get-trace', payload),
      getCheckpoints: (payload: { sessionId: string; limit?: number }) =>
        core.invokeChannel('runtime:get-checkpoints', payload),
      getToolResults: (payload: { sessionId: string; limit?: number }) =>
        core.invokeChannel('runtime:get-tool-results', payload),
      listApprovals: () => core.invokeChannel('runtime:list-approvals'),
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
