import { CompactManager } from './compactManager';
import { getMemoryMaintenanceService } from './memoryMaintenanceService';
import { executeRuntimeHooks } from './runtimeHooks';
import { evaluateRuntimeToolPermission } from './runtimePermissions';
import { getSessionRuntimeStore } from './sessionRuntimeStore';
import { getToolResultStore } from './toolResultStore';
import { applyToolResultBudget } from './toolResultBudget';
import { summarizeToolBatch } from './toolBatchSummary';
import { getTaskGraphRuntime } from './ai/taskGraphRuntime';
import {
  createErrorResult,
  ToolErrorType,
  ToolKind,
  ToolRegistry,
  ToolExecutor,
  type ToolCallRequest,
  type ToolCallResponse,
  type ToolResult,
} from './toolRegistry';
import { normalizeApiBaseUrl, safeUrlJoin } from './urlUtils';
import { getChatMessages } from '../db';
import type { RuntimeAdapter, RuntimeConfig, RuntimeMessage } from './runtimeTypes';

type LlmToolCall = {
  id: string;
  name: string;
  args: Record<string, unknown>;
};

type LlmResponse = {
  content: string;
  toolCalls: LlmToolCall[];
  finishReason?: string;
  usage?: {
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
  };
};

const now = () => Date.now();
const nextId = (prefix: string) => `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
const truncateText = (value: unknown, limit: number): string => {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}...`;
};

const isToolConcurrencySafe = (registry: ToolRegistry, toolName: string, args: Record<string, unknown>): boolean => {
  const tool = registry.getTool(toolName);
  if (!tool) return false;
  if (tool.requiresConfirmation) {
    return false;
  }
  try {
    if (typeof tool.isConcurrencySafe === 'function') {
      return Boolean(tool.isConcurrencySafe(args));
    }
  } catch {
    return false;
  }
  return tool.kind === ToolKind.Read || tool.kind === ToolKind.Search || tool.kind === ToolKind.Fetch;
};

const toToolFeedbackMessage = (name: string, content: string): RuntimeMessage => ({
  role: 'user',
  content: `Tool result from ${name}:\n${content}`,
});

const extractAssistantText = (content: unknown): string => {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (typeof item === 'string') return item;
        if (item && typeof item === 'object') {
          const record = item as Record<string, unknown>;
          return typeof record.text === 'string' ? record.text : '';
        }
        return '';
      })
      .join('');
  }
  return '';
};

export class QueryRuntime {
  private readonly store = getSessionRuntimeStore();
  private readonly toolResults = getToolResultStore();
  private readonly compactManager: CompactManager;

  constructor(
    private readonly registry: ToolRegistry,
    private readonly executor: ToolExecutor,
    private readonly adapter: RuntimeAdapter,
    private readonly config: RuntimeConfig,
  ) {
    this.compactManager = new CompactManager({
      apiKey: config.apiKey,
      baseURL: config.baseURL,
      model: config.model,
    });
  }

  async run(userInput: string): Promise<{ response: string; error?: string }> {
    const startedAt = now();
    const maxTurns = this.config.maxTurns || 24;
    const maxTimeMs = (this.config.maxTimeMinutes || 12) * 60 * 1000;

    let messages: RuntimeMessage[] = [
      { role: 'system', content: this.config.systemPrompt },
      ...this.config.messages,
      { role: 'user', content: this.config.userInputContent ?? userInput },
    ];

    this.adapter.onEvent({ type: 'query_start', sessionId: this.config.sessionId, message: userInput });
    this.store.appendTranscript({
      sessionId: this.config.sessionId,
      recordType: 'query.user',
      role: 'user',
      content: userInput,
      payload: { kind: 'query.user', data: { toolPack: this.config.toolPack } },
    });
    this.store.addCheckpoint({
      sessionId: this.config.sessionId,
      checkpointType: 'query.start',
      summary: '用户消息已进入统一运行时',
      payload: { model: this.config.model, toolPack: this.config.toolPack },
    });

    await executeRuntimeHooks({
      event: 'query.before',
      context: {
        sessionId: this.config.sessionId,
        event: 'query.before',
        payload: { message: userInput, model: this.config.model },
      },
      adapter: this.adapter,
      llm: {
        apiKey: this.config.apiKey,
        baseURL: this.config.baseURL,
        model: this.config.model,
      },
    });

    let turnCount = 0;
    let responseText = '';
    let reactiveCompactUsed = false;
    let continuationCount = 0;
    let lastContinuationDelta = 0;
    let compactFailureCount = 0;
    let hadCompaction = false;

    while (turnCount < maxTurns) {
      if (now() - startedAt > maxTimeMs) {
        const message = 'Query runtime timeout';
        this.adapter.onEvent({ type: 'error', message });
        this.store.addCheckpoint({
          sessionId: this.config.sessionId,
          checkpointType: 'stop.failure',
          summary: message,
          payload: { turnCount },
        });
        await executeRuntimeHooks({
          event: 'stop.failure',
          context: {
            sessionId: this.config.sessionId,
            event: 'stop.failure',
            payload: { message, turnCount },
          },
          adapter: this.adapter,
        });
        return { response: responseText, error: message };
      }
      if (this.config.signal?.aborted) {
        const message = 'Query runtime cancelled';
        this.adapter.onEvent({ type: 'error', message });
        return { response: responseText, error: message };
      }

      turnCount += 1;
      let compacted = null;
      try {
        if (compactFailureCount < 3) {
          compacted = await this.compactManager.maybeCompact(messages);
        }
      } catch (error) {
        compactFailureCount += 1;
        const compactError = error instanceof Error ? error.message : String(error);
        this.adapter.onEvent({
          type: 'tool_summary',
          toolName: 'runtime.compact',
          content: `compact attempt failed (${compactFailureCount}/3): ${compactError}`,
        });
        this.store.appendTranscript({
          sessionId: this.config.sessionId,
          recordType: 'query.compact.failure',
          role: 'system',
          content: compactError,
          payload: {
            kind: 'query.compact.failure',
            data: {
              failures: compactFailureCount,
            },
          },
        });
        this.store.addCheckpoint({
          sessionId: this.config.sessionId,
          checkpointType: 'compact.failure',
          summary: compactError,
          payload: {
            failures: compactFailureCount,
          },
        });
      }
      if (compacted) {
        hadCompaction = true;
        compactFailureCount = 0;
        const rehydrated = this.rehydrateCompactedMessages(messages, compacted);
        this.adapter.onEvent({ type: 'compact_start', strategy: compacted.strategy });
        this.store.appendTranscript({
          sessionId: this.config.sessionId,
          recordType: 'query.compact',
          role: 'system',
          content: compacted.summary,
          payload: {
            kind: 'query.compact',
            data: {
              strategy: compacted.strategy,
              reinjected: rehydrated.reinjected,
              preservedSegments: rehydrated.preservedSegmentCount,
            },
          },
        });
        this.store.addCheckpoint({
          sessionId: this.config.sessionId,
          checkpointType: 'compact',
          summary: `${compacted.strategy} compact applied`,
          payload: {
            strategy: compacted.strategy,
            summary: compacted.summary,
            reinjected: rehydrated.reinjected,
            preservedSegments: rehydrated.preservedSegmentCount,
          },
        });
        if (rehydrated.reinjectedSummary) {
          this.store.appendTranscript({
            sessionId: this.config.sessionId,
            recordType: 'query.compact.rehydrated',
            role: 'system',
            content: rehydrated.reinjectedSummary,
            payload: {
              kind: 'query.compact.rehydrated',
              data: {
                strategy: compacted.strategy,
                preservedSegmentCount: rehydrated.preservedSegmentCount,
              },
            },
          });
          this.store.addCheckpoint({
            sessionId: this.config.sessionId,
            checkpointType: 'compact.rehydrated',
            summary: `compact context rehydrated (${rehydrated.preservedSegmentCount} segments)`,
            payload: {
              strategy: compacted.strategy,
              preservedSegmentCount: rehydrated.preservedSegmentCount,
            },
          });
        }
        messages = rehydrated.messages;
        this.adapter.onEvent({
          type: 'compact_end',
          strategy: compacted.strategy,
          summary: rehydrated.reinjectedSummary || compacted.summary,
          compacted: true,
        });
      }

      let llmResponse: LlmResponse;
      try {
        llmResponse = await this.callLlm(messages);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const normalized = message.toLowerCase();
        if (!reactiveCompactUsed && (normalized.includes('context_length_exceeded') || normalized.includes('prompt too long') || normalized.includes('maximum context'))) {
          reactiveCompactUsed = true;
          const reactive = await this.compactManager.maybeCompact([
            ...messages,
            { role: 'system', content: 'Reactive compaction requested after context overflow.' },
          ]);
          if (reactive) {
            hadCompaction = true;
            messages = reactive.compactedMessages;
            this.adapter.onEvent({ type: 'compact_start', strategy: 'reactive' });
            this.adapter.onEvent({ type: 'compact_end', strategy: 'reactive', summary: reactive.summary, compacted: true });
            continue;
          }
        }
        this.adapter.onEvent({ type: 'error', message });
        this.store.addCheckpoint({
          sessionId: this.config.sessionId,
          checkpointType: 'stop.failure',
          summary: message,
          payload: { turnCount },
        });
        await executeRuntimeHooks({
          event: 'stop.failure',
          context: {
            sessionId: this.config.sessionId,
            event: 'stop.failure',
            payload: { message, turnCount },
          },
          adapter: this.adapter,
        });
        return { response: responseText, error: message };
      }

      if (llmResponse.toolCalls.length > 0) {
        messages.push({ role: 'assistant', content: llmResponse.content || '' });
        this.store.appendTranscript({
          sessionId: this.config.sessionId,
          recordType: 'assistant.tool_call',
          role: 'assistant',
          content: llmResponse.content || '',
          payload: {
            kind: 'assistant.tool_call',
            data: {
              calls: llmResponse.toolCalls.map((call) => ({ id: call.id, name: call.name, args: call.args })),
            },
          },
        });
        const thoughtText = String(llmResponse.content || '').trim();
        if (thoughtText) {
          this.adapter.onEvent({ type: 'thinking', phase: 'tooling', content: thoughtText });
        }
        const toolResponses = await this.executeToolCalls(llmResponse.toolCalls);
        const batchSummary = summarizeToolBatch(
          llmResponse.toolCalls.map((call, index) => ({
            name: call.name,
            args: call.args,
            result: toolResponses[index]?.result,
          })).filter((item): item is { name: string; args: Record<string, unknown>; result: ToolResult } => Boolean(item.result)),
        );
        if (batchSummary) {
          this.adapter.onEvent({
            type: 'tool_summary',
            toolName: 'tool.batch',
            content: batchSummary,
          });
          this.store.appendTranscript({
            sessionId: this.config.sessionId,
            recordType: 'tool.batch.summary',
            role: 'system',
            content: batchSummary,
            payload: {
              kind: 'tool.batch.summary',
              data: {
                toolCount: toolResponses.length,
                toolNames: toolResponses.map((toolResponse) => toolResponse.name),
              },
            },
          });
        }
        const budgetedResults = applyToolResultBudget(
          this.registry,
          toolResponses.map((toolResponse) => ({
            toolName: toolResponse.name,
            result: toolResponse.result,
          })),
        );
        messages.push(
          ...budgetedResults.map((toolResult) => toToolFeedbackMessage(toolResult.toolName, toolResult.promptText)),
        );
        for (const [index, toolResult] of budgetedResults.entries()) {
          const response = toolResponses[index];
          const persisted = response
            ? this.toolResults.applyBudget({
                sessionId: this.config.sessionId,
                callId: response.callId,
                promptText: toolResult.promptText,
                originalChars: toolResult.originalChars,
                promptChars: toolResult.promptChars,
                truncated: toolResult.truncated,
              })
            : null;
          if (!toolResult.truncated) {
            continue;
          }
          this.adapter.onEvent({
            type: 'tool_summary',
            toolName: toolResult.toolName,
            content: `tool result budget applied: ${toolResult.originalChars} -> ${toolResult.promptChars} chars`,
          });
          this.store.appendTranscript({
            sessionId: this.config.sessionId,
            recordType: 'tool.result.budget',
            role: 'system',
            content: `tool=${toolResult.toolName}; original=${toolResult.originalChars}; prompt=${toolResult.promptChars}`,
            payload: {
              kind: 'tool.result.budget',
              data: {
                callId: response?.callId,
                toolResultId: persisted?.id,
                toolName: toolResult.toolName,
                originalChars: toolResult.originalChars,
                promptChars: toolResult.promptChars,
              },
            },
          });
        }
        this.store.addCheckpoint({
          sessionId: this.config.sessionId,
          checkpointType: 'tool.batch',
          summary: batchSummary || `Completed ${toolResponses.length} tool call(s)`,
          payload: {
            tools: toolResponses.map((toolResponse) => ({
              name: toolResponse.name,
              success: toolResponse.result.success,
            })),
          },
        });
        continue;
      }

      responseText = llmResponse.content || '';
      this.adapter.onEvent({ type: 'thinking', phase: 'respond', content: `Turn ${turnCount}: preparing final response` });
      if (responseText) {
        this.adapter.onEvent({ type: 'response_chunk', content: responseText });
      }
      const shouldContinueForLength =
        llmResponse.finishReason === 'length' &&
        continuationCount < 3 &&
        !(continuationCount >= 2 && responseText.length <= 500 && lastContinuationDelta <= 500);
      if (shouldContinueForLength) {
        continuationCount += 1;
        lastContinuationDelta = responseText.length;
        messages.push({ role: 'assistant', content: responseText });
        const continuationPrompt = `Continue exactly from where you stopped. Do not repeat prior content. This is continuation ${continuationCount}.`;
        messages.push({ role: 'user', content: continuationPrompt });
        this.store.appendTranscript({
          sessionId: this.config.sessionId,
          recordType: 'assistant.partial',
          role: 'assistant',
          content: responseText,
          payload: {
            kind: 'assistant.partial',
            data: {
              turnCount,
              continuationCount,
              finishReason: llmResponse.finishReason,
              usage: llmResponse.usage || null,
            },
          },
        });
        this.store.addCheckpoint({
          sessionId: this.config.sessionId,
          checkpointType: 'response.continue',
          summary: `response continuation requested (${continuationCount})`,
          payload: {
            finishReason: llmResponse.finishReason,
            usage: llmResponse.usage || null,
          },
        });
        this.adapter.onEvent({
          type: 'thinking',
          phase: 'respond',
          content: `Response hit model output limit, continuing (${continuationCount}/3)`,
        });
        continue;
      }
      this.adapter.onEvent({ type: 'response_end', content: responseText });
      this.adapter.onEvent({ type: 'done', response: responseText });
      this.store.appendTranscript({
        sessionId: this.config.sessionId,
        recordType: 'assistant.response',
        role: 'assistant',
        content: responseText,
        payload: { kind: 'assistant.response', data: { turnCount } },
      });
      this.store.addCheckpoint({
        sessionId: this.config.sessionId,
        checkpointType: 'response.final',
        summary: responseText.slice(0, 240) || 'Assistant response completed',
        payload: { turnCount, responseLength: responseText.length },
      });
      this.notifyMemoryLifecycle({
        responseLength: responseText.length,
        compacted: hadCompaction,
      });
      await executeRuntimeHooks({
        event: 'query.after',
        context: {
          sessionId: this.config.sessionId,
          event: 'query.after',
          payload: { response: responseText, turnCount },
        },
        adapter: this.adapter,
        llm: {
          apiKey: this.config.apiKey,
          baseURL: this.config.baseURL,
          model: this.config.model,
        },
      });
      return { response: responseText };
    }

    const message = 'Query runtime exceeded max turns';
    this.adapter.onEvent({ type: 'error', message });
    return { response: responseText, error: message };
  }

  private async callLlm(messages: RuntimeMessage[]): Promise<LlmResponse> {
    const response = await fetch(safeUrlJoin(normalizeApiBaseUrl(this.config.baseURL), '/chat/completions'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.config.apiKey}`,
      },
      signal: this.config.signal,
      body: JSON.stringify({
        model: this.config.model,
        temperature: this.config.temperature ?? 0.5,
        messages,
        tools: this.registry.getToolSchemas(),
      }),
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      throw new Error(`Runtime LLM error (${response.status}): ${errorText || response.statusText}`);
    }

    const data = await response.json() as {
      usage?: {
        prompt_tokens?: number;
        completion_tokens?: number;
        total_tokens?: number;
      };
      choices?: Array<{
        finish_reason?: string;
        message?: {
          content?: string | Array<{ text?: string }>;
          tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }>;
        };
      }>;
    };
    const message = data?.choices?.[0]?.message;
    return {
      content: extractAssistantText(message?.content),
      toolCalls: Array.isArray(message?.tool_calls)
        ? message!.tool_calls!.map((toolCall) => ({
            id: String(toolCall.id || nextId('tool')),
            name: String(toolCall.function?.name || ''),
            args: (() => {
              try {
                return JSON.parse(String(toolCall.function?.arguments || '{}')) as Record<string, unknown>;
              } catch {
                return {};
              }
            })(),
          })).filter((toolCall) => toolCall.name)
        : [],
      finishReason: typeof data?.choices?.[0]?.finish_reason === 'string'
        ? data.choices?.[0]?.finish_reason
        : undefined,
      usage: data?.usage ? {
        promptTokens: data.usage.prompt_tokens,
        completionTokens: data.usage.completion_tokens,
        totalTokens: data.usage.total_tokens,
      } : undefined,
    };
  }

  private async executeToolCalls(toolCalls: LlmToolCall[]): Promise<ToolCallResponse[]> {
    const serial: LlmToolCall[] = [];
    const responses: ToolCallResponse[] = [];
    let currentConcurrentBatch: LlmToolCall[] = [];
    const flushConcurrentBatch = async () => {
      if (currentConcurrentBatch.length === 0) {
        return;
      }
      responses.push(...await Promise.all(currentConcurrentBatch.map((toolCall) => this.executeSingleToolCall(toolCall))));
      currentConcurrentBatch = [];
    };

    for (const toolCall of toolCalls) {
      if (isToolConcurrencySafe(this.registry, toolCall.name, toolCall.args)) {
        currentConcurrentBatch.push(toolCall);
        continue;
      }
      await flushConcurrentBatch();
      serial.push(toolCall);
    }
    await flushConcurrentBatch();
    for (const toolCall of serial) {
      responses.push(await this.executeSingleToolCall(toolCall));
    }
    return responses;
  }

  private async executeSingleToolCall(toolCall: LlmToolCall): Promise<ToolCallResponse> {
    const tool = this.registry.getTool(toolCall.name);
    const description = tool?.getDescription(toolCall.args) || `Executing ${toolCall.name}`;
    const startedAt = now();

    if (!tool) {
      return {
        callId: toolCall.id,
        name: toolCall.name,
        result: createErrorResult(`Tool "${toolCall.name}" not found`, ToolErrorType.EXECUTION_FAILED),
        durationMs: 0,
      };
    }

    const permission = evaluateRuntimeToolPermission({
      tool,
      toolName: toolCall.name,
      args: toolCall.args,
      context: {
        sessionId: this.config.sessionId,
        toolPack: this.config.toolPack,
        runtimeMode: this.config.runtimeMode,
        interactive: this.config.interactive !== false,
        requiresHumanApproval: this.config.requiresHumanApproval,
      },
    });

    if (permission.outcome !== 'allow') {
      this.adapter.onEvent({
        type: 'tool_summary',
        toolName: toolCall.name,
        content: `permission ${permission.outcome}: ${permission.reason}`,
      });
      this.store.appendTranscript({
        sessionId: this.config.sessionId,
        recordType: 'tool.permission',
        role: 'system',
        content: `${toolCall.name}: ${permission.outcome} - ${permission.reason}`,
        payload: {
          kind: 'tool.permission',
          data: {
            callId: toolCall.id,
            toolName: toolCall.name,
            outcome: permission.outcome,
            source: permission.source,
          },
        },
      });
      this.store.addCheckpoint({
        sessionId: this.config.sessionId,
        checkpointType: permission.outcome === 'deny' ? 'tool.permission.denied' : 'tool.permission.confirm',
        summary: `${toolCall.name}: ${permission.reason}`,
        payload: {
          callId: toolCall.id,
          toolName: toolCall.name,
          outcome: permission.outcome,
        },
      });
    }

    if (permission.outcome === 'deny') {
      const deniedResult = createErrorResult(permission.reason, ToolErrorType.PERMISSION_DENIED);
      const persistedToolResult = this.toolResults.add({
        sessionId: this.config.sessionId,
        callId: toolCall.id,
        toolName: toolCall.name,
        command: this.extractCommand(toolCall.args),
        result: deniedResult,
        summaryText: deniedResult.llmContent,
        payload: {
          deniedByRuntimePermission: true,
          source: permission.source,
        },
      });
      this.adapter.onEvent({
        type: 'tool_end',
        callId: toolCall.id,
        name: toolCall.name,
        result: deniedResult,
        durationMs: now() - startedAt,
      });
      this.store.appendTranscript({
        sessionId: this.config.sessionId,
        recordType: 'tool.result',
        role: 'tool',
        content: deniedResult.llmContent,
        payload: {
          kind: 'tool.result',
          data: {
            toolResultId: persistedToolResult.id,
            callId: toolCall.id,
            toolName: toolCall.name,
            success: false,
            deniedByRuntimePermission: true,
            durationMs: now() - startedAt,
          },
        },
      });
      this.adapter.onToolResult?.(toolCall.name, deniedResult, this.extractCommand(toolCall.args));
      return {
        callId: toolCall.id,
        name: toolCall.name,
        result: deniedResult,
        durationMs: now() - startedAt,
      };
    }

    await executeRuntimeHooks({
      event: 'tool.before',
      context: {
        sessionId: this.config.sessionId,
        event: 'tool.before',
        payload: {
          name: toolCall.name,
          args: toolCall.args,
        },
      },
      adapter: this.adapter,
      llm: {
        apiKey: this.config.apiKey,
        baseURL: this.config.baseURL,
        model: this.config.model,
      },
    });

    this.adapter.onEvent({
      type: 'tool_start',
      callId: toolCall.id,
      name: toolCall.name,
      params: toolCall.args,
      description,
    });

    const request: ToolCallRequest = {
      callId: toolCall.id,
      name: toolCall.name,
      params: toolCall.args,
      forceConfirmation: permission.outcome === 'confirm',
      confirmationDetails: permission.details || null,
    };
    const response = await this.executor.execute(
      request,
      this.config.signal ?? new AbortController().signal,
      (chunk) => {
        this.adapter.onEvent({
          type: 'tool_output',
          callId: toolCall.id,
          name: toolCall.name,
          chunk,
        });
      },
    );

    const summarized = this.summarizeToolResult(toolCall.name, response.result);
    const persistedToolResult = this.toolResults.add({
      sessionId: this.config.sessionId,
      callId: response.callId,
      toolName: toolCall.name,
      command: this.extractCommand(toolCall.args),
      result: response.result,
      summaryText: summarized,
      payload: {
        durationMs: response.durationMs,
      },
    });
    if (summarized) {
      this.adapter.onEvent({
        type: 'tool_summary',
        toolName: toolCall.name,
        content: summarized,
      });
    }

    this.adapter.onEvent({
      type: 'tool_end',
      callId: response.callId,
      name: response.name,
      result: response.result,
      durationMs: response.durationMs,
    });

    this.adapter.onToolResult?.(toolCall.name, response.result, this.extractCommand(toolCall.args));
    this.store.appendTranscript({
      sessionId: this.config.sessionId,
      recordType: 'tool.result',
      role: 'tool',
      content: summarized || response.result.llmContent,
      payload: {
        kind: 'tool.result',
        data: {
          toolResultId: persistedToolResult.id,
          callId: response.callId,
          toolName: toolCall.name,
          success: response.result.success,
          durationMs: response.durationMs,
        },
      },
    });

    await executeRuntimeHooks({
      event: 'tool.after',
      context: {
        sessionId: this.config.sessionId,
        event: 'tool.after',
        payload: {
          name: toolCall.name,
          args: toolCall.args,
          success: response.result.success,
          output: summarized || response.result.llmContent,
        },
      },
      adapter: this.adapter,
      llm: {
        apiKey: this.config.apiKey,
        baseURL: this.config.baseURL,
        model: this.config.model,
      },
    });

    return response;
  }

  private summarizeToolResult(toolName: string, result: ToolResult): string | null {
    const override = this.adapter.summarizeToolResult?.(toolName, result);
    if (override) return override;
    const text = String(result.llmContent || result.display || result.error?.message || '').trim();
    if (!text) return null;
    if (text.length <= 4_000) return text;
    return `${text.slice(0, 4_000)}\n\n[tool result summarized for runtime event]`;
  }

  private extractCommand(args: Record<string, unknown>): string {
    return typeof args.command === 'string' ? args.command : '';
  }

  private notifyMemoryLifecycle(params: {
    responseLength: number;
    compacted: boolean;
  }): void {
    if (this.config.runtimeMode === 'background-maintenance') {
      return;
    }
    try {
      getMemoryMaintenanceService().notifyQueryLifecycleEvent({
        sessionId: this.config.sessionId,
        runtimeMode: this.config.runtimeMode,
        responseLength: params.responseLength,
        compacted: params.compacted,
      });
    } catch (error) {
      this.adapter.onEvent({
        type: 'tool_summary',
        toolName: 'memory-maintenance',
        content: `memory lifecycle notify failed: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }

  private rehydrateCompactedMessages(
    originalMessages: RuntimeMessage[],
    compacted: { strategy: 'micro' | 'normal' | 'reactive'; summary: string; compactedMessages: RuntimeMessage[] },
  ): {
    messages: RuntimeMessage[];
    reinjected: boolean;
    reinjectedSummary: string;
    preservedSegmentCount: number;
  } {
    const firstSystemMessage = originalMessages.find((message) => message.role === 'system') || compacted.compactedMessages[0];
    const compactedTail = compacted.compactedMessages.filter((message, index) => {
      if (message.role !== 'system') return true;
      return index === 0 && message === firstSystemMessage;
    }).filter(Boolean) as RuntimeMessage[];

    const checkpoints = this.store.listCheckpoints(this.config.sessionId, 8)
      .filter((checkpoint) => !checkpoint.checkpointType.startsWith('compact'))
      .slice(0, 5);
    const toolResults = this.store.listToolResults(this.config.sessionId, 6).slice(0, 4);
    const attachmentSummaries = this.getRecentAttachmentSummaries();
    const taskNodeSummaries = this.getRecentTaskNodeSummaries();
    const recentTurns = originalMessages
      .filter((message) => message.role !== 'system')
      .slice(-4)
      .map((message) => `${message.role}: ${truncateText(message.content, 280)}`);

    const preservedSegments: string[] = [
      `runtimeMode: ${this.config.runtimeMode || 'unknown'}`,
      `toolPack: ${this.config.toolPack}`,
      `requiresHumanApproval: ${this.config.requiresHumanApproval ? 'true' : 'false'}`,
    ];

    if (checkpoints.length > 0) {
      preservedSegments.push(
        'Recent checkpoints:',
        ...checkpoints.map((checkpoint) => `- ${checkpoint.checkpointType}: ${truncateText(checkpoint.summary, 220)}`),
      );
    }

    if (toolResults.length > 0) {
      preservedSegments.push(
        'Recent tool outcomes:',
        ...toolResults.map((result) => `- ${result.toolName} [${result.success ? 'ok' : 'fail'}]: ${truncateText(result.summaryText || result.promptText || result.resultText, 220)}`),
      );
    }

    if (attachmentSummaries.length > 0) {
      preservedSegments.push(
        'Recent attachments and rich user payloads:',
        ...attachmentSummaries.map((item) => `- ${item}`),
      );
    }

    if (taskNodeSummaries.length > 0) {
      preservedSegments.push(
        'Recent task graph state:',
        ...taskNodeSummaries.map((item) => `- ${item}`),
      );
    }

    if (recentTurns.length > 0) {
      preservedSegments.push(
        'Recent live turns:',
        ...recentTurns.map((item) => `- ${item}`),
      );
    }

    const reinjectedSummary = [
      '## Compact Boundary',
      `Strategy: ${compacted.strategy}`,
      `Summary: ${truncateText(compacted.summary, 3200)}`,
      '',
      '## Preserved Runtime Context',
      ...preservedSegments,
      '',
      'Rules:',
      '- Favor the latest live turns and preserved runtime context over older compressed details.',
      '- Preserve current task goal, active role, and recent tool outcomes.',
      '- Do not repeat already completed work unless the preserved context says it is incomplete.',
    ].join('\n');

    return {
      messages: [
        firstSystemMessage,
        { role: 'system', content: reinjectedSummary },
        ...compactedTail.slice(-8),
      ].filter(Boolean) as RuntimeMessage[],
      reinjected: true,
      reinjectedSummary,
      preservedSegmentCount: preservedSegments.length,
    };
  }

  private getRecentAttachmentSummaries(): string[] {
    const messages = getChatMessages(this.config.sessionId)
      .filter((message) => message.role === 'user' && (message.attachment || message.display_content))
      .slice(-4);

    return messages.map((message) => {
      let attachmentText = '';
      if (message.attachment) {
        try {
          const parsed = JSON.parse(String(message.attachment)) as Record<string, unknown>;
          const attachmentType = String(parsed.type || 'attachment').trim() || 'attachment';
          const attachmentName = String(parsed.name || parsed.title || parsed.absolutePath || '').trim();
          const attachmentSummary = String(parsed.summary || '').trim();
          const attachmentKind = String(parsed.kind || '').trim();
          attachmentText = [
            attachmentType,
            attachmentName && `name=${attachmentName}`,
            attachmentKind && `kind=${attachmentKind}`,
            attachmentSummary && `summary=${truncateText(attachmentSummary, 180)}`,
          ].filter(Boolean).join(' | ');
        } catch {
          attachmentText = truncateText(message.attachment, 180);
        }
      }
      const displayText = String(message.display_content || '').trim();
      const contentText = String(message.content || '').trim();
      return [
        attachmentText && `attachment: ${attachmentText}`,
        displayText && `display: ${truncateText(displayText, 180)}`,
        contentText && `content: ${truncateText(contentText, 180)}`,
      ].filter(Boolean).join(' || ');
    }).filter(Boolean);
  }

  private getRecentTaskNodeSummaries(): string[] {
    const tasks = getTaskGraphRuntime()
      .listTasks({ ownerSessionId: this.config.sessionId, limit: 3 })
      .slice(0, 2);

    return tasks.flatMap((task) => {
      const activeNodes = task.graph
        .filter((node) => node.status === 'running' || node.status === 'failed' || node.status === 'pending')
        .slice(0, 3);
      const header = `task=${task.id} intent=${task.intent || task.taskType} status=${task.status}`;
      const nodeLines = activeNodes.map((node) => `${node.type}:${node.status}${node.summary ? ` (${truncateText(node.summary, 120)})` : ''}`);
      if (nodeLines.length === 0) {
        return [header];
      }
      return [header, ...nodeLines];
    });
  }
}
