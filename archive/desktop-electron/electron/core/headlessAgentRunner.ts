import { addChatMessage, getChatMessages, getSettings, getWorkspacePathsForSpace } from '../db';
import { PiChatService } from '../pi/PiChatService';
import { getAgentRuntime } from './ai';
import { getBackgroundSessionStore } from './backgroundSessionStore';
import { getBackgroundTaskRegistry } from './backgroundTaskRegistry';
import { getHeadlessWorkerProcessManager } from './headlessWorkerProcessManager';
import type { BuiltinToolPack } from './tools/catalog';

type HeadlessRuntimeMode = 'redclaw' | 'background-maintenance';

function createBackgroundEventSink(taskId: string) {
  const registry = getBackgroundTaskRegistry();
  return async (channel: string, data: unknown) => {
    if (channel === 'chat:thought-delta') {
      const text = typeof (data as any)?.content === 'string' ? (data as any).content : '';
      await registry.updatePhase(taskId, 'thinking');
      await registry.appendTurn(taskId, { source: 'thought', text });
      return;
    }
    if (channel === 'chat:response-chunk') {
      const text = typeof (data as any)?.content === 'string' ? (data as any).content : '';
      await registry.updatePhase(taskId, 'responding');
      await registry.appendTurn(taskId, { source: 'response', text });
      return;
    }
    if (channel === 'chat:tool-start') {
      const name = typeof (data as any)?.toolName === 'string' ? (data as any).toolName : 'unknown';
      await registry.updatePhase(taskId, 'tooling');
      await registry.appendTurn(taskId, { source: 'tool', text: `调用工具：${name}` });
      return;
    }
    if (channel === 'chat:error') {
      const text = typeof (data as any)?.message === 'string' ? (data as any).message : 'unknown error';
      await registry.appendTurn(taskId, { source: 'system', text: `错误：${text}` });
    }
  };
}

export class HeadlessAgentRunner {
  async runRedClawTask(input: {
    taskId: string;
    title: string;
    contextId: string;
    contextContent: string;
    prompt: string;
    displayContent?: string;
    historyUserContent?: string;
    runtimeMode?: HeadlessRuntimeMode;
    contextType?: string;
    metadata?: Record<string, unknown>;
    spaceId?: string;
    toolPack?: BuiltinToolPack;
    service?: PiChatService;
    rollback?: () => Promise<void> | void;
    attemptSignal?: AbortSignal;
  }): Promise<{ sessionId: string; response: string }> {
    const session = getBackgroundSessionStore().ensureSession({
      contextId: input.contextId,
      contextType: input.contextType || 'redclaw',
      title: input.title,
      contextContent: input.contextContent,
      runtimeMode: input.runtimeMode || 'redclaw',
      metadata: {
        headless: true,
        spaceId: input.spaceId,
        ...(input.metadata || {}),
      },
    });
    const registry = getBackgroundTaskRegistry();
    await registry.attachSession(input.taskId, session.id);

    addChatMessage({
      id: `msg_bg_user_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      session_id: session.id,
      role: 'user',
      content: String(input.historyUserContent || input.prompt || '').trim() || input.prompt,
      display_content: input.displayContent || '[后台任务]',
    });

    const workspacePaths = input.spaceId ? getWorkspacePathsForSpace(input.spaceId) : null;
    const toolPack = input.toolPack || 'redclaw';
    const service = input.service || new PiChatService({
      toolPack,
      workspacePathsOverride: workspacePaths || undefined,
    });

    if (input.service) {
      const onAttemptAbort = () => service.abort();
      if (input.attemptSignal) {
        if (input.attemptSignal.aborted) {
          service.abort();
        } else {
          input.attemptSignal.addEventListener('abort', onAttemptAbort, { once: true });
        }
      }
      registry.registerCancelHandle(input.taskId, {
        cancel: () => service.abort(),
        rollback: input.rollback,
      });
      service.setEventSink((channel, data) => {
        void createBackgroundEventSink(input.taskId)(channel, data);
      });
      try {
        await service.sendMessage(input.prompt, session.id);
        const latestAssistant = [...getChatMessages(session.id)]
          .reverse()
          .find((msg) => msg.role === 'assistant' && String(msg.content || '').trim());
        return {
          sessionId: session.id,
          response: String(latestAssistant?.content || ''),
        };
      } finally {
        if (input.attemptSignal) {
          input.attemptSignal.removeEventListener('abort', onAttemptAbort);
        }
        registry.clearCancelHandle(input.taskId);
      }
    }

    const prepared = await service.prepareBackgroundRuntimeTask(input.prompt, session.id);
    try {
      const result = await getHeadlessWorkerProcessManager().runRuntimeTask({
        taskId: input.taskId,
        sessionId: session.id,
        model: prepared.modelName,
        apiKey: prepared.apiKey,
        baseURL: prepared.baseURL,
        systemPrompt: prepared.systemPrompt,
        messages: prepared.runtimeMessages,
        userInput: input.prompt,
        toolPack,
        runtimeMode: prepared.runtimeMode,
        requiresHumanApproval: prepared.preparedExecution.route.requiresHumanApproval,
        temperature: prepared.temperature,
        maxTurns: prepared.maxTurns,
        maxTimeMinutes: prepared.maxTimeMinutes,
        workspaceRoot: workspacePaths?.base,
        projectRoot: workspacePaths?.base,
        rollback: input.rollback,
        attemptSignal: input.attemptSignal,
      });
      addChatMessage({
        id: `msg_bg_assistant_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        session_id: session.id,
        role: 'assistant',
        content: result.response,
      });
      getAgentRuntime().completeExecution(prepared.preparedExecution.task.id, {
        backgroundTaskId: input.taskId,
        responseLength: result.response.length,
        workerMode: 'child-runtime-worker',
      });
      return {
        sessionId: session.id,
        response: result.response,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      getAgentRuntime().failExecution(prepared.preparedExecution.task.id, message);
      throw error;
    }
  }

  async runJsonRuntimeTask(input: {
    taskId: string;
    title: string;
    contextId: string;
    systemPrompt: string;
    userInput: string;
    model?: string;
    baseURL?: string;
    apiKey?: string;
    maxTurns?: number;
    temperature?: number;
    rollback?: () => Promise<void> | void;
    attemptSignal?: AbortSignal;
  }): Promise<{ sessionId: string; response: string; error?: string }> {
    const session = getBackgroundSessionStore().ensureSession({
      contextId: input.contextId,
      contextType: 'background-maintenance',
      title: input.title,
      contextContent: input.title,
      runtimeMode: 'background-maintenance',
      metadata: {
        headless: true,
        jsonTask: true,
      },
    });
    const registry = getBackgroundTaskRegistry();
    await registry.attachSession(input.taskId, session.id);
    const settings = (getSettings() || {}) as Record<string, unknown>;
    const apiKey = input.apiKey || String(settings.api_key || '').trim();
    const baseURL = String(input.baseURL || settings.api_endpoint || 'https://api.openai.com/v1');
    const model = input.model || String(settings.model_name || 'gpt-4o-mini');
    const result = await getHeadlessWorkerProcessManager().runJsonTask({
      taskId: input.taskId,
      sessionId: session.id,
      model,
      apiKey,
      baseURL,
      systemPrompt: input.systemPrompt,
      userInput: input.userInput,
      temperature: input.temperature ?? 0.1,
      rollback: input.rollback,
      attemptSignal: input.attemptSignal,
    });
    return {
      sessionId: session.id,
      response: result.response,
    };
  }
}

let headlessAgentRunner: HeadlessAgentRunner | null = null;

export function getHeadlessAgentRunner(): HeadlessAgentRunner {
  if (!headlessAgentRunner) {
    headlessAgentRunner = new HeadlessAgentRunner();
  }
  return headlessAgentRunner;
}
