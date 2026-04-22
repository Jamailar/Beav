/**
 * PiChatService - 基于 pi-agent-core 的聊天服务
 *
 * 主聊天与知识库聊天统一走这里。
 */

import { BrowserWindow } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import {
  Agent,
  type AgentEvent,
  type AgentTool,
  type BeforeToolCallResult,
  type AfterToolCallResult,
} from '@mariozechner/pi-agent-core';
import { getModel, type Model } from '@mariozechner/pi-ai';
import {
  getSettings,
  addChatMessage,
  getWorkspacePaths,
  getChatSession,
  getChatMessages,
  updateChatSessionMetadata,
} from '../db';
import { SkillManager } from '../core/skillManager';
import { Instance } from '../core/instance';
import {
  ToolRegistry,
  ToolExecutor,
  type ToolCallRequest,
  type ToolCallResponse,
  ToolConfirmationOutcome,
  type ToolConfirmationDetails,
  type ToolResult,
} from '../core/toolRegistry';
import { createBuiltinTools } from '../core/tools';
import type { BuiltinToolPack } from '../core/tools/catalog';
import { createCompressionService } from '../core/compressionService';
import { QueryRuntime } from '../core/queryRuntime';
import { getLongTermMemoryPrompt } from '../core/fileMemoryStore';
import { getRedClawProjectContextPrompt } from '../core/redclawStore';
import { getWorkItemStore } from '../core/workItemStore';
import { buildMcpPromptSection } from '../core/mcpPromptSummary';
import {
  ensureRedClawOnboardingCompletedWithDefaults,
  handleRedClawOnboardingTurn,
  loadRedClawProfilePromptBundle,
  type RedClawProfilePromptBundle,
} from '../core/redclawProfileStore';
import { resolveChatMaxTokens } from '../core/chatTokenConfig';
import { resolveModelScopeFromContextType, resolveScopedModelName } from '../core/modelScopeSettings';
import { normalizeApiBaseUrl, safeUrlJoin } from '../core/urlUtils';
import { logDebugEvent } from '../core/debugLogger';
import { loadPrompt, renderPrompt } from '../prompts/runtime';
import { getAgentRuntime, getTaskGraphRuntime, type PreparedRuntimeExecution, type RuntimeMode } from '../core/ai';
import type { RuntimeEvent, RuntimeMessageContentPart } from '../core/runtimeTypes';

interface SessionMetadata {
  associatedFilePath?: string;
  associatedFileId?: string;
  associatedPackageKind?: 'video' | 'audio';
  agentProfile?: 'default' | 'video-editor' | 'audio-editor';
  associatedPackageTitle?: string;
  associatedPackageAssetCount?: number;
  associatedPackageClipCount?: number;
  associatedPackageTrackNames?: string[];
  associatedPackageClips?: Array<{
    assetId?: string;
    name?: string;
    track?: string;
    order?: number;
    durationMs?: number;
    trimInMs?: number;
    trimOutMs?: number;
    enabled?: boolean;
  }>;
  contextId?: string;
  contextType?: string;
  contextContent?: string;
  isContextBound?: boolean;
  compactSummary?: string;
  compactBaseMessageCount?: number;
  compactRounds?: number;
  compactUpdatedAt?: string;
  workItemId?: string;
}

interface AgentTextContent {
  type: 'text';
  text: string;
}

interface AssistantToolCallContent {
  type: 'toolCall';
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

interface AssistantMessageLike {
  role?: string;
  content?: Array<AgentTextContent | AssistantToolCallContent | { type: string; [k: string]: unknown }>;
}

interface HistoryMessage {
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
}

interface AgentRunResult {
  response: string;
  error?: string;
  streamedChunks: boolean;
}

export interface PreparedPiRuntimeTask {
  sessionId: string;
  apiKey: string;
  baseURL: string;
  modelName: string;
  runtimeMode: RuntimeMode;
  metadata: SessionMetadata;
  systemPrompt: string;
  runtimeMessages: Array<{ role: 'user' | 'assistant'; content: string }>;
  preparedExecution: PreparedRuntimeExecution;
  temperature: number;
  maxTurns: number;
  maxTimeMinutes: number;
}

type PreparePiRuntimeOutcome =
  | { kind: 'handled'; localResponse: string }
  | ({ kind: 'prepared' } & PreparedPiRuntimeTask);

interface ToolMarkupCleanupResult {
  hasLeakedToolMarkup: boolean;
  cleanedText: string;
  leakedToolNames: string[];
}

interface PiChatServiceOptions {
  onToolConfirmationRequest?: (
    callId: string,
    tool: { name: string; displayName?: string },
    params: unknown,
    details: ToolConfirmationDetails,
  ) => Promise<ToolConfirmationOutcome>;
  toolPack?: BuiltinToolPack;
  workspacePathsOverride?: ReturnType<typeof getWorkspacePaths>;
}

interface TextualToolCall {
  raw: string;
  name: string;
  args: Record<string, unknown>;
}

interface GeneratedImagePreview {
  id: string;
  previewUrl: string;
  prompt?: string;
}

interface GeneratedVideoPreview {
  id: string;
  previewUrl: string;
  prompt?: string;
}

interface CompactContextResult {
  success: boolean;
  compacted: boolean;
  message: string;
  compactRounds?: number;
  compactUpdatedAt?: string;
}

interface SessionRuntimeState {
  isProcessing: boolean;
  partialResponse: string;
  updatedAt: number;
}

interface ChatModelOverrideConfig {
  apiKey?: string;
  baseURL?: string;
  modelName?: string;
}

interface ChatAttachmentRuntimeOptions {
  userInputContent?: string | RuntimeMessageContentPart[];
}

const DEFAULT_REDCLAW_AUTO_COMPACT_TOKENS = 256000;
const DEFAULT_MODEL_CONTEXT_WINDOW_FALLBACK = 64000;
const TOOL_GUARD_MAX_TOTAL_CALLS = 100;
const TOOL_GUARD_MAX_CALLS_PER_TOOL = 100;
const TOOL_GUARD_MAX_REPEAT_SIGNATURE = 100;
const TOOL_RESULT_MAX_TEXT_CHARS = 32000;
const TOOL_RESULT_MAX_LLM_CHARS = 22000;
const TOOL_RESULT_MAX_DISPLAY_CHARS = 26000;
const TOOL_RESULT_MAX_ERROR_CHARS = 4000;
const PI_CHAT_SYSTEM_BASE_TEMPLATE = loadPrompt(
  'runtime/pi/system_base.txt',
  'You are RedClaw, the self-media operations expert agent inside RedBox.\nCurrent date: {{current_date}}\nCurrent working directory: {{current_working_directory}}'
);
const PI_CHAT_VIDEO_EDITOR_TEMPLATE = loadPrompt('runtime/pi/video_editor.txt', '');
const PI_CHAT_AUDIO_EDITOR_TEMPLATE = loadPrompt('runtime/pi/audio_editor.txt', '');

interface ToolGuardState {
  totalCalls: number;
  callsByTool: Map<string, number>;
  callsBySignature: Map<string, number>;
  restrictToAppCliInRedClaw: boolean;
  blockedTools: Set<string>;
}

interface ChatErrorPayload {
  message: string;
  raw?: string;
  category?: 'auth' | 'quota' | 'rate_limit' | 'network' | 'timeout' | 'request' | 'validation' | 'execution' | 'unknown';
  statusCode?: number;
  errorCode?: string;
  hint?: string;
}

export class PiChatService {
  private window: BrowserWindow | null = null;
  private eventSink: ((channel: string, data: unknown) => void) | null = null;
  private abortController: AbortController | null = null;
  private sessionId: string;
  private skillManager: SkillManager;
  private agent: Agent | null = null;
  private unsubscribeAgentEvents: (() => void) | null = null;
  private toolRegistry: ToolRegistry;
  private toolExecutor: ToolExecutor;
  private activeRuntimeExecution: PreparedRuntimeExecution | null = null;
  private discoveredWorkspaceForSkills: string | null = null;
  private readonly toolPack: BuiltinToolPack;
  private readonly workspacePathsOverride: ReturnType<typeof getWorkspacePaths> | null;
  private runtimeState: SessionRuntimeState = {
    isProcessing: false,
    partialResponse: '',
    updatedAt: 0,
  };

  constructor(options: PiChatServiceOptions = {}) {
    this.sessionId = `session_${Date.now()}`;
    this.skillManager = new SkillManager();
    this.toolRegistry = new ToolRegistry();
    this.toolPack = options.toolPack || 'redclaw';
    this.workspacePathsOverride = options.workspacePathsOverride || null;
    const tools = createBuiltinTools({
      pack: this.toolPack,
      skillManager: this.skillManager,
      workspaceRootOverride: this.workspacePathsOverride?.base,
      onSkillActivated: (payload) => {
        this.sendToUI('chat:skill-activated', payload);
      },
    });
    this.toolRegistry.registerTools(tools);
    this.toolExecutor = new ToolExecutor(
      this.toolRegistry,
      options.onToolConfirmationRequest || (async () => ToolConfirmationOutcome.ProceedOnce),
    );
  }

  setWindow(window: BrowserWindow) {
    this.window = window;
  }

  setEventSink(sink: ((channel: string, data: unknown) => void) | null) {
    this.eventSink = sink;
  }

  getSkillManager() {
    return this.skillManager;
  }

  async activateSkills(skillNames: string[]): Promise<Array<{ name: string; description: string }>> {
    const normalized = Array.from(new Set(
      Array.isArray(skillNames)
        ? skillNames.map((item) => String(item || '').trim()).filter(Boolean)
        : [],
    ));
    if (!normalized.length) {
      return [];
    }

    const workspacePaths = this.workspacePathsOverride || getWorkspacePaths();
    await this.ensureSkillsDiscovered(workspacePaths.base);

    const activated: Array<{ name: string; description: string }> = [];
    for (const skillName of normalized) {
      const skill = this.skillManager.getSkill(skillName);
      if (!skill || skill.disabled) continue;
      const wasActive = this.skillManager.isSkillActive(skill.name);
      const content = await this.skillManager.activateSkill(skill.name);
      if (!content || wasActive) continue;
      activated.push({
        name: skill.name,
        description: skill.description,
      });
      this.sendToUI('chat:skill-activated', {
        name: skill.name,
        description: skill.description,
      });
    }

    return activated;
  }

  private sendToUI(channel: string, data: unknown) {
    if (this.eventSink) {
      try {
        this.eventSink(channel, data);
      } catch (error) {
        console.error(`[PiChatService] Failed to send sink event: ${channel}`, error);
      }
    }

    if (!this.window || this.window.isDestroyed()) {
      return;
    }

    try {
      this.window.webContents.send(channel, data);
    } catch (error) {
      console.error(`[PiChatService] Failed to send event: ${channel}`, error);
    }
  }

  private buildChatErrorPayload(rawError: unknown): ChatErrorPayload {
    const explicit = (rawError && typeof rawError === 'object')
      ? rawError as {
        chatErrorMessage?: unknown;
        chatErrorHint?: unknown;
        chatErrorCategory?: ChatErrorPayload['category'];
        chatErrorStatusCode?: unknown;
        chatErrorCode?: unknown;
      }
      : null;
    const rawMessage = rawError instanceof Error
      ? (rawError.message || String(rawError))
      : String(rawError || 'Unknown error');
    const compactRaw = rawMessage.trim().slice(0, 6000);
    const lower = compactRaw.toLowerCase();

    const statusMatch = compactRaw.match(/\b([1-5]\d{2})\b/);
    const statusCode = statusMatch ? Number(statusMatch[1]) : undefined;

    const errorCodeMatch = compactRaw.match(/\b(invalid_api_key|incorrect_api_key|insufficient_quota|quota_exceeded|rate_limit_exceeded|invalid_request_error|context_length_exceeded|max_tokens|model_not_found|authentication_error)\b/i);
    const errorCode = errorCodeMatch ? errorCodeMatch[1] : undefined;

    let category: ChatErrorPayload['category'] = explicit?.chatErrorCategory || 'unknown';
    let hint = String(explicit?.chatErrorHint || '').trim() || '请检查 AI 源配置后重试。';

    if (category === 'validation') {
      hint = hint || '当前任务在校验阶段未通过，请先修复评审指出的问题后再重试。';
    } else if (category === 'execution') {
      hint = hint || '当前任务在执行阶段失败，请检查素材读取、工具调用、文件路径或权限。';
    } else if (
      statusCode === 401 ||
      statusCode === 403 ||
      lower.includes('invalid api key') ||
      lower.includes('incorrect api key') ||
      lower.includes('authentication') ||
      lower.includes('unauthorized') ||
      lower.includes('permission denied') ||
      lower.includes('api key')
    ) {
      category = 'auth';
      hint = '请检查 API Key 是否正确、是否过期、是否有权限访问该模型。';
    } else if (
      lower.includes('insufficient balance') ||
      lower.includes('insufficient_balance') ||
      lower.includes('insufficient_quota') ||
      lower.includes('quota') ||
      lower.includes('billing') ||
      lower.includes('(1008)') ||
      lower.includes('余额') ||
      lower.includes('额度')
    ) {
      category = 'quota';
      hint = '账号额度可能已用尽，请充值或切换到有余额的 AI 源。';
    } else if (
      statusCode === 429 ||
      lower.includes('rate limit') ||
      lower.includes('too many requests')
    ) {
      category = 'rate_limit';
      hint = '请求频率过高，请稍后重试或降低并发。';
    } else if (
      lower.includes('fetch failed') ||
      lower.includes('network') ||
      lower.includes('econnrefused') ||
      lower.includes('enotfound') ||
      lower.includes('certificate') ||
      lower.includes('self signed')
    ) {
      category = 'network';
      hint = '网络或网关连接异常，请检查 baseURL、代理和证书配置。';
    } else if (
      lower.includes('timeout') ||
      lower.includes('timed out') ||
      lower.includes('abort')
    ) {
      category = 'timeout';
      hint = '请求超时，请稍后重试。';
    } else if (
      lower.includes('max_tokens') ||
      lower.includes('context length') ||
      lower.includes('context_length_exceeded') ||
      lower.includes('invalid request')
    ) {
      category = 'request';
      hint = '请求参数可能不兼容（例如模型名、max_tokens、上下文长度）。';
    }

    const statusLabel = statusCode ? `HTTP ${statusCode}` : '';
    const codeLabel = errorCode ? `${errorCode}` : '';
    const explicitMessage = String(explicit?.chatErrorMessage || '').trim();
    const title = [statusLabel, codeLabel].filter(Boolean).join(' · ');
    const message = explicitMessage || (
      title
        ? `AI 请求失败（${title}）`
        : 'AI 请求失败'
    );

    return {
      message,
      raw: compactRaw,
      category,
      statusCode: Number.isFinite(Number(explicit?.chatErrorStatusCode)) ? Number(explicit?.chatErrorStatusCode) : statusCode,
      errorCode: String(explicit?.chatErrorCode || '').trim() || errorCode,
      hint,
    };
  }

  private previewForLog(value: unknown, maxLength = 500): string {
    try {
      const text = typeof value === 'string' ? value : JSON.stringify(value);
      if (!text) return '';
      return text.length > maxLength ? `${text.slice(0, maxLength)}...<truncated>` : text;
    } catch {
      return String(value);
    }
  }

  private normalizeStreamingTextDelta(rawDelta: string, currentResponse: string): string {
    const delta = typeof rawDelta === 'string' ? rawDelta : '';
    if (!delta) return '';
    if (!currentResponse) return delta;

    // Some providers emit cumulative content instead of strict token deltas.
    if (delta.startsWith(currentResponse)) {
      return delta.slice(currentResponse.length);
    }

    // Merge overlapped chunks to avoid duplicated tail/head when stream framing differs.
    const maxOverlap = Math.min(currentResponse.length, delta.length);
    for (let overlap = maxOverlap; overlap >= 4; overlap -= 1) {
      if (currentResponse.endsWith(delta.slice(0, overlap))) {
        return delta.slice(overlap);
      }
    }

    return delta;
  }

  private reconcileAssistantText(currentResponse: string, candidate: string): string {
    const current = typeof currentResponse === 'string' ? currentResponse : '';
    const next = typeof candidate === 'string' ? candidate : '';
    if (!next) return current;
    if (!current) return next;
    if (next === current) return current;
    if (next.startsWith(current)) return next;
    if (next.length > current.length) return next;
    return current;
  }

  private emitDebugLog(level: 'info' | 'warn' | 'error', message: string, data?: unknown) {
    logDebugEvent('pi-chat', level, message, {
      sessionId: this.sessionId,
      ...((data && typeof data === 'object' && !Array.isArray(data)) ? data as Record<string, unknown> : { data }),
    });
  }

  abort() {
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }

    if (this.agent) {
      this.agent.abort();
    }
  }

  getRuntimeState(): SessionRuntimeState {
    return {
      ...this.runtimeState,
    };
  }

  private setRuntimeState(next: Partial<SessionRuntimeState>) {
    this.runtimeState = {
      ...this.runtimeState,
      ...next,
      updatedAt: Date.now(),
    };
  }

  clearHistory() {
    this.sessionId = `session_${Date.now()}`;
    this.skillManager.resetActiveSkills();
    this.setRuntimeState({
      isProcessing: false,
      partialResponse: '',
    });

    if (this.agent) {
      this.agent.clearMessages();
    }

    this.sendToUI('chat:response-chunk', { content: '\n\n[System] 对话历史已清除。\n' });
  }

  async compactContextNow(sessionId: string): Promise<CompactContextResult> {
    const metadata = this.getSessionMetadata(sessionId);
    if (metadata.contextType !== 'redclaw') {
      return {
        success: false,
        compacted: false,
        message: '当前会话不是 RedClaw 上下文会话，无法手动 compact。',
      };
    }

    const settings = (getSettings() || {}) as Record<string, unknown>;
    const apiKey = (settings.api_key as string) || (settings.openaiApiKey as string) || process.env.OPENAI_API_KEY || '';
    const baseURL = normalizeApiBaseUrl(
      (settings.api_endpoint as string) || (settings.openaiApiBase as string) || 'https://api.openai.com/v1',
      'https://api.openai.com/v1',
    );
    const modelName = (settings.model_name as string) || (settings.openaiModel as string) || 'gpt-4o';

    if (!apiKey) {
      return {
        success: false,
        compacted: false,
        message: 'API Key 未配置，无法执行上下文压缩。',
      };
    }

    const model = this.createModelWithBaseUrl(modelName, baseURL, settings);
    const beforeRounds = metadata.compactRounds || 0;
    const nextMetadata = await this.maybeCompactContext({
      sessionId,
      currentInput: '',
      metadata,
      apiKey,
      baseURL,
      modelName,
      contextWindow: this.getModelContextWindow(model),
      redClawCompactTargetTokens: this.getRedClawCompactTargetTokens(settings),
      force: true,
    });

    const compacted = (nextMetadata.compactRounds || 0) > beforeRounds;
    return {
      success: true,
      compacted,
      message: compacted ? '上下文已压缩。' : '当前上下文暂无可压缩内容。',
      compactRounds: nextMetadata.compactRounds,
      compactUpdatedAt: nextMetadata.compactUpdatedAt,
    };
  }

  async sendMessage(
    content: string,
    sessionId: string,
    modelOverride?: ChatModelOverrideConfig,
    attachmentRuntime?: ChatAttachmentRuntimeOptions,
  ) {
    this.sessionId = sessionId;
    this.abortController = new AbortController();
    const signal = this.abortController.signal;
    this.setRuntimeState({
      isProcessing: true,
      partialResponse: '',
    });

    let preparedOutcome: PreparePiRuntimeOutcome;
    try {
      preparedOutcome = await this.prepareRuntimeExecutionInput({
        content,
        sessionId,
        allowInteractiveOnboarding: true,
        emitSkillActivation: true,
        modelOverride,
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      this.emitDebugLog('error', 'sendMessage:prepare-failed', { error: errorMessage });
      this.abortController = null;
      this.setRuntimeState({ isProcessing: false });
      this.sendToUI('chat:error', this.buildChatErrorPayload(errorMessage));
      return;
    }
    if (preparedOutcome.kind === 'handled') {
      const onboardingResponse = preparedOutcome.localResponse.trim();
      if (onboardingResponse) {
        this.emitLocalAssistantResponse(sessionId, onboardingResponse);
      }
      this.abortController = null;
      this.setRuntimeState({ isProcessing: false });
      return;
    }

    const {
      apiKey,
      baseURL,
      modelName,
      metadata,
      runtimeMode,
      systemPrompt,
      runtimeMessages,
      preparedExecution,
      maxTurns,
      maxTimeMinutes,
      temperature,
    } = preparedOutcome;
    this.activeRuntimeExecution = preparedExecution;

    console.log('[PiChatService] sendMessage', {
      sessionId,
      modelName,
      baseURL,
      hasApiKey: Boolean(apiKey),
      historyCount: runtimeMessages.length,
      isContextBound: Boolean(metadata.isContextBound),
      compacted: Boolean(metadata.compactSummary),
      taskId: preparedExecution.task.id,
      route: preparedExecution.route.intent,
      role: preparedExecution.role.roleId,
      thinkingBudget: preparedExecution.thinkingBudget,
    });
    this.emitDebugLog('info', 'sendMessage:prepared', {
      modelName,
      baseURL,
      historyCount: runtimeMessages.length,
      isContextBound: Boolean(metadata.isContextBound),
      compacted: Boolean(metadata.compactSummary),
      taskId: preparedExecution.task.id,
      route: preparedExecution.route.intent,
      role: preparedExecution.role.roleId,
      thinkingBudget: preparedExecution.thinkingBudget,
    });
    this.traceActiveExecution('runtime.prepared', {
      modelName,
      baseURL,
      runtimeMode,
      route: preparedExecution.route,
      role: preparedExecution.role.roleId,
      thinkingBudget: preparedExecution.thinkingBudget,
      historyCount: runtimeMessages.length,
    }, 'plan');

    try {
      this.emitDebugLog('info', 'agent:run:start');
      const generatedImages: GeneratedImagePreview[] = [];
      const generatedVideos: GeneratedVideoPreview[] = [];
      const runtime = new QueryRuntime(
        this.toolRegistry,
        this.toolExecutor,
        {
          onEvent: (event) => this.handleQueryRuntimeEvent(event, generatedImages, generatedVideos),
          onToolResult: (toolName, result, command) => {
            this.maybeRegisterArtifactFromRuntimeToolResult(toolName, result, command);
          },
          summarizeToolResult: (_toolName, result) => {
            const contentText = String(result.llmContent || result.display || result.error?.message || '');
            if (contentText.length <= 22000) {
              return contentText;
            }
            return `${contentText.slice(0, 22000)}\n\n[tool result truncated]`;
          },
        },
        {
          sessionId,
          apiKey,
          baseURL,
          model: modelName,
          systemPrompt,
          messages: runtimeMessages,
          userInputContent: attachmentRuntime?.userInputContent,
          signal,
          maxTurns,
          maxTimeMinutes,
          temperature,
          toolPack: 'redclaw',
          runtimeMode,
          interactive: true,
          requiresHumanApproval: preparedExecution.route.requiresHumanApproval,
        },
      );
      const runResult = await runtime.run(content);
      const finalResultError = runResult.error || '';
      if (finalResultError) {
        console.error('[PiChatService] Chat failed after fallback:', finalResultError);
        this.emitDebugLog('error', 'sendMessage:failed', { error: finalResultError });
        getAgentRuntime().failExecution(preparedExecution.task.id, finalResultError);
        this.sendToUI('chat:error', this.buildChatErrorPayload(finalResultError));
        return;
      }

      let fullResponse = runResult.response || '';
      if (generatedImages.length > 0) {
        fullResponse = this.appendGeneratedImagesMarkdown(fullResponse, generatedImages);
      }
      if (generatedVideos.length > 0) {
        fullResponse = this.appendGeneratedVideosMarkdown(fullResponse, generatedVideos);
      }
      if (fullResponse) {
        this.emitDebugLog('info', 'sendMessage:full-response', {
          streamedChunks: true,
          responseLength: fullResponse.length,
          responsePreview: fullResponse.slice(0, 160),
        });
        this.setRuntimeState({ partialResponse: fullResponse });
        addChatMessage({
          id: `msg_${Date.now()}`,
          session_id: sessionId,
          role: 'assistant',
          content: fullResponse,
        });
      } else {
        console.warn('[PiChatService] Empty assistant response', {
          sessionId,
          streamedChunks: true,
          historyCount: history.length,
        });
        this.emitDebugLog('warn', 'sendMessage:empty-response', {
          streamedChunks: true,
          historyCount: history.length,
        });
      }

      this.emitDebugLog('info', 'sendMessage:success', {
        streamedChunks: true,
        responseLength: fullResponse.length,
      });
      getAgentRuntime().completeExecution(preparedExecution.task.id, {
        responseLength: fullResponse.length,
        streamedChunks: true,
      });
      this.sendToUI('chat:response-end', { content: fullResponse });
    } catch (error: unknown) {
      if (!signal.aborted) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        console.error('[PiChatService] Error:', errorMessage);
        this.emitDebugLog('error', 'sendMessage:exception', { error: errorMessage });
        getAgentRuntime().failExecution(preparedExecution.task.id, errorMessage);
        this.sendToUI('chat:error', this.buildChatErrorPayload(errorMessage));
      }
    } finally {
      this.cleanupAgentSubscription();
      this.abortController = null;
      this.activeRuntimeExecution = null;
      this.setRuntimeState({
        isProcessing: false,
      });
      this.emitDebugLog('info', 'sendMessage:done');
    }
  }

  async prepareBackgroundRuntimeTask(content: string, sessionId: string): Promise<PreparedPiRuntimeTask> {
    this.sessionId = sessionId;
    const prepared = await this.prepareRuntimeExecutionInput({
      content,
      sessionId,
      allowInteractiveOnboarding: false,
      emitSkillActivation: false,
    });
    if (prepared.kind === 'handled') {
      throw new Error('Background runtime task should not enter interactive onboarding path');
    }
    return prepared;
  }

  private async prepareRuntimeExecutionInput(params: {
    content: string;
    sessionId: string;
    allowInteractiveOnboarding: boolean;
    emitSkillActivation: boolean;
    modelOverride?: ChatModelOverrideConfig;
  }): Promise<PreparePiRuntimeOutcome> {
    const { content, sessionId, allowInteractiveOnboarding, emitSkillActivation, modelOverride } = params;
    const settings = (getSettings() || {}) as Record<string, unknown>;
    const apiKey = String(modelOverride?.apiKey || (settings.api_key as string) || (settings.openaiApiKey as string) || process.env.OPENAI_API_KEY || '').trim();
    const baseURL = normalizeApiBaseUrl(
      String(modelOverride?.baseURL || (settings.api_endpoint as string) || (settings.openaiApiBase as string) || 'https://api.openai.com/v1'),
      'https://api.openai.com/v1',
    );
    let metadata = this.getSessionMetadata(sessionId);
    const modelScope = resolveModelScopeFromContextType(String(metadata.contextType || ''));
    const modelName = String(modelOverride?.modelName || resolveScopedModelName(settings, modelScope, (settings.openaiModel as string) || 'gpt-4o')).trim();
    const runtimeMode = this.resolveRuntimeMode(metadata);

    const workspacePaths = this.workspacePathsOverride || getWorkspacePaths();
    const workspace = workspacePaths.base;
    Instance.init(workspace);
    this.emitDebugLog('info', 'runtime:prepare:start', {
      messageLength: String(content || '').length,
      modelName,
      baseURL,
      workspace,
      contextType: String(metadata.contextType || ''),
      contextId: String(metadata.contextId || ''),
      allowInteractiveOnboarding,
    });

    try {
      await this.ensureSkillsDiscovered(workspace);
    } catch (error) {
      console.warn('[PiChatService] Failed to load skills:', error);
    }

    try {
      const preactivatedSkills = await this.skillManager.preactivateMentionedSkills(content);
      if (emitSkillActivation) {
        for (const item of preactivatedSkills) {
          this.sendToUI('chat:skill-activated', {
            name: item.skill.name,
            description: item.skill.description,
          });
        }
      }
    } catch (error) {
      console.warn('[PiChatService] Failed to preactivate mentioned skills:', error);
    }

    let redClawProfileBundle: RedClawProfilePromptBundle | null = null;

    if (this.shouldHandleRedClawOnboarding(metadata)) {
      try {
        redClawProfileBundle = await loadRedClawProfilePromptBundle();
        const isFirstRedClawTurn = this.isFirstAssistantTurn(sessionId);
        if (allowInteractiveOnboarding && isFirstRedClawTurn) {
          const onboarding = await handleRedClawOnboardingTurn(content);
          if (onboarding.handled) {
            return {
              kind: 'handled',
              localResponse: (onboarding.responseText || '').trim(),
            };
          }
        }
        if (!redClawProfileBundle.onboardingState.completedAt) {
          await ensureRedClawOnboardingCompletedWithDefaults();
        }
        redClawProfileBundle = await loadRedClawProfilePromptBundle();
      } catch (error) {
        console.warn('[PiChatService] RedClaw onboarding/profile failed:', error);
      }
    } else if (metadata.contextType === 'redclaw') {
      try {
        redClawProfileBundle = await loadRedClawProfilePromptBundle();
      } catch (error) {
        console.warn('[PiChatService] Failed to load RedClaw profile bundle for non-primary session:', error);
      }
    }

    if (!apiKey) {
      this.emitDebugLog('error', 'runtime:prepare:missing-api-key');
      throw new Error('API Key 未配置');
    }

    const model = this.createModelWithBaseUrl(modelName, baseURL, settings);
    const redClawCompactTargetTokens = this.getRedClawCompactTargetTokens(settings);
    metadata = await this.maybeCompactContext({
      sessionId,
      currentInput: content,
      metadata,
      apiKey,
      baseURL,
      modelName,
      contextWindow: this.getModelContextWindow(model),
      redClawCompactTargetTokens,
    });
    const longTermMemory = await this.loadLongTermMemoryContext();
    const redClawProjectContext = await this.loadRedClawProjectContext(metadata);
    if (metadata.contextType === 'redclaw' && !redClawProfileBundle) {
      try {
        redClawProfileBundle = await loadRedClawProfilePromptBundle();
      } catch (error) {
        console.warn('[PiChatService] Failed to reload RedClaw profile bundle:', error);
      }
    }

    const baseSystemPrompt = this.buildSystemPrompt(
      workspacePaths,
      metadata,
      longTermMemory,
      redClawProjectContext,
      redClawProfileBundle,
    );
    const preparedExecution = await getAgentRuntime().prepareExecution({
      runtimeContext: {
        sessionId,
        runtimeMode,
        userInput: content,
        metadata: metadata as Record<string, unknown>,
        workspaceRoot: workspacePaths.workspaceRoot,
        currentSpaceRoot: workspacePaths.base,
      },
      baseSystemPrompt,
      llm: {
        apiKey,
        baseURL,
        model: modelName,
      },
    });

    const runtimeMessages = this.historyToRuntimeMessages(sessionId, content, metadata);
    this.emitDebugLog('info', 'runtime:prepare:done', {
      sessionId,
      taskId: preparedExecution.task.id,
      route: preparedExecution.route.intent,
      role: preparedExecution.role.roleId,
      thinkingBudget: preparedExecution.thinkingBudget,
      historyCount: runtimeMessages.length,
    });

    return {
      kind: 'prepared',
      sessionId,
      apiKey,
      baseURL,
      modelName,
      runtimeMode,
      metadata,
      systemPrompt: preparedExecution.systemPrompt,
      runtimeMessages,
      preparedExecution,
      temperature: 0.6,
      maxTurns: 100,
      maxTimeMinutes: 12,
    };
  }

  private emitLocalAssistantResponse(sessionId: string, content: string) {
    const text = String(content || '').trim();
    if (!text) return;

    this.sendToUI('chat:response-chunk', { content: text });
    this.sendToUI('chat:response-end', { content: text });
    this.setRuntimeState({ partialResponse: text });

    addChatMessage({
      id: `msg_${Date.now()}`,
      session_id: sessionId,
      role: 'assistant',
      content: text,
    });
  }

  private isFirstAssistantTurn(sessionId: string): boolean {
    const history = getChatMessages(sessionId).filter((msg) => msg.role === 'user' || msg.role === 'assistant');
    const assistantCount = history.filter((msg) => msg.role === 'assistant').length;
    return assistantCount === 0 && history.length <= 1;
  }

  private shouldHandleRedClawOnboarding(metadata: SessionMetadata): boolean {
    if (metadata.contextType !== 'redclaw') return false;
    const contextId = String(metadata.contextId || '');
    return contextId.startsWith('redclaw-singleton:');
  }

  private cleanupAgentSubscription() {
    if (this.unsubscribeAgentEvents) {
      this.unsubscribeAgentEvents();
      this.unsubscribeAgentEvents = null;
    }
  }

  private async runAgentAttempt(params: {
    model: Model<any>;
    apiKey: string;
    prompt: string;
    history: Array<{ role: 'user' | 'assistant'; content: Array<{ type: 'text'; text: string }>; timestamp: number }>;
    userInput: string;
    signal: AbortSignal;
    metadata?: SessionMetadata;
  }): Promise<AgentRunResult> {
    const { model, apiKey, prompt, history, userInput, signal, metadata } = params;
    const runtime = {
      rawResponse: '',
      displayResponse: '',
      streamedChunks: false,
    };
    const toolGuardState = this.createToolGuardState(metadata);
    const appCliCommands = new Map<string, string>();
    const generatedImages: GeneratedImagePreview[] = [];
    const generatedVideos: GeneratedVideoPreview[] = [];
    let sawAnyToolExecution = false;

    this.agent = this.createAgent(model, apiKey, prompt, history, signal, toolGuardState);
    this.emitDebugLog('info', 'agent:init', {
      modelId: (model as { id?: string }).id || 'unknown',
      historyCount: history.length,
    });
    this.traceActiveExecution('agent.init', {
      modelId: (model as { id?: string }).id || 'unknown',
      historyCount: history.length,
    }, 'execute_tools');

    this.cleanupAgentSubscription();
    this.unsubscribeAgentEvents = this.agent.subscribe((event: AgentEvent) => {
      if (signal.aborted) return;

      switch (event.type) {
        case 'message_update':
          if (event.assistantMessageEvent.type === 'thinking_start') {
            this.sendToUI('chat:thought-start', {});
            break;
          }
          if (event.assistantMessageEvent.type === 'thinking_delta') {
            const safeThoughtDelta = this.sanitizeThoughtDelta(event.assistantMessageEvent.delta || '');
            if (safeThoughtDelta) {
              this.sendToUI('chat:thought-delta', { content: safeThoughtDelta });
            }
            break;
          }
          if (event.assistantMessageEvent.type === 'thinking_end') {
            this.sendToUI('chat:thought-end', {});
            break;
          }
          if (event.assistantMessageEvent.type === 'text_delta') {
            const rawDelta = event.assistantMessageEvent.delta || '';
            const normalizedDelta = this.normalizeStreamingTextDelta(rawDelta, runtime.rawResponse);
            this.emitDebugLog('info', 'agent:text-delta', {
              rawLength: rawDelta.length,
              rawPreview: rawDelta.slice(0, 80),
              normalizedLength: normalizedDelta.length,
              normalizedPreview: normalizedDelta.slice(0, 80),
              responseLengthBefore: runtime.rawResponse.length,
            });
            if (normalizedDelta) {
              runtime.rawResponse += normalizedDelta;
              runtime.streamedChunks = true;
              const nextVisibleResponse = this.getUiSafeAssistantText(runtime.rawResponse);
              const visibleDelta = this.diffVisibleResponse(runtime.displayResponse, nextVisibleResponse);
              runtime.displayResponse = nextVisibleResponse;
              this.setRuntimeState({ partialResponse: runtime.displayResponse });
              this.emitDebugLog('info', 'agent:text-delta:applied', {
                appendedLength: normalizedDelta.length,
                responseLengthAfter: runtime.rawResponse.length,
                responsePreview: runtime.rawResponse.slice(0, 120),
              });
              if (visibleDelta) {
                this.sendToUI('chat:response-chunk', { content: visibleDelta });
              }
            }
          }
          break;

        case 'message_end': {
          const msg = event.message as AssistantMessageLike;
          const extractedText = this.extractText(msg.content);
          this.traceActiveExecution('agent.message_end', {
            role: msg.role || 'unknown',
            extractedLength: extractedText.length,
          }, 'execute_tools');
          this.emitDebugLog('info', 'agent:message-end', {
            role: msg.role || 'unknown',
            extractedLength: extractedText.length,
            extractedPreview: extractedText.slice(0, 120),
            existingResponseLength: runtime.rawResponse.length,
            rawContentPreview: this.previewForLog(msg.content, 500),
          });
          if (msg.role === 'assistant' && extractedText) {
            if (!runtime.rawResponse) {
              runtime.rawResponse = extractedText;
              runtime.streamedChunks = true;
              const nextVisibleResponse = this.getUiSafeAssistantText(runtime.rawResponse);
              const visibleDelta = this.diffVisibleResponse(runtime.displayResponse, nextVisibleResponse);
              runtime.displayResponse = nextVisibleResponse;
              this.setRuntimeState({ partialResponse: runtime.displayResponse });
              if (visibleDelta) {
                this.sendToUI('chat:response-chunk', { content: visibleDelta });
              }
            } else {
              const previous = runtime.rawResponse;
              const reconciled = this.reconcileAssistantText(runtime.rawResponse, extractedText);

              if (reconciled !== previous) {
                this.emitDebugLog('info', 'agent:message-end:reconciled', {
                  previousLength: previous.length,
                  reconciledLength: reconciled.length,
                  reconciledPreview: reconciled.slice(0, 160),
                });
                runtime.rawResponse = reconciled;
                runtime.streamedChunks = true;
                const nextVisibleResponse = this.getUiSafeAssistantText(runtime.rawResponse);
                const visibleDelta = this.diffVisibleResponse(runtime.displayResponse, nextVisibleResponse);
                runtime.displayResponse = nextVisibleResponse;
                this.setRuntimeState({ partialResponse: runtime.displayResponse });
                if (visibleDelta) {
                  this.sendToUI('chat:response-chunk', { content: visibleDelta });
                }
              }
            }
          }
          break;
        }

        case 'tool_execution_start':
          sawAnyToolExecution = true;
          if (event.toolName === 'app_cli') {
            const command = typeof (event.args as { command?: unknown } | undefined)?.command === 'string'
              ? String((event.args as { command?: unknown }).command)
              : '';
            if (command) {
              appCliCommands.set(event.toolCallId, command);
            }
          }
          console.log('[PiChatService] tool:start', {
            sessionId: this.sessionId,
            callId: event.toolCallId,
            name: event.toolName,
            args: this.previewForLog(event.args),
          });
          this.emitDebugLog('info', 'tool:start', {
            callId: event.toolCallId,
            name: event.toolName,
            args: event.args,
          });
          this.traceActiveExecution('tool.start', {
            callId: event.toolCallId,
            name: event.toolName,
            args: event.args,
          }, event.toolName === 'workspace' ? 'retrieve' : 'execute_tools');
          this.sendToUI('chat:tool-start', {
            callId: event.toolCallId,
            name: event.toolName,
            input: event.args,
            description: `执行工具: ${event.toolName}`,
          });
          break;

        case 'tool_execution_update': {
          const partialText = this.toolExecutionUpdateToText(event.partialResult);
          if (!partialText) break;
          console.log('[PiChatService] tool:update', {
            sessionId: this.sessionId,
            callId: event.toolCallId,
            name: event.toolName,
            partialPreview: this.previewForLog(partialText),
          });
          this.emitDebugLog('info', 'tool:update', {
            callId: event.toolCallId,
            name: event.toolName,
            partialPreview: partialText,
          });
          this.sendToUI('chat:tool-update', {
            callId: event.toolCallId,
            name: event.toolName,
            partial: partialText,
          });
          break;
        }

        case 'tool_execution_end': {
          const output = this.toolExecutionToOutput(event.result, event.isError);
          const command = appCliCommands.get(event.toolCallId) || '';
          if (!event.isError && command && this.isImageGenerateCommand(command)) {
            generatedImages.push(...this.extractGeneratedImagesFromToolResult(event.result));
          }
          if (!event.isError && command && this.isVideoGenerateCommand(command)) {
            generatedVideos.push(...this.extractGeneratedVideosFromToolResult(event.result));
          }
          this.maybeRegisterArtifactFromToolResult(event.toolName, event.result, command);
          console.log('[PiChatService] tool:end', {
            sessionId: this.sessionId,
            callId: event.toolCallId,
            name: event.toolName,
            isError: event.isError,
            success: output.success,
            outputPreview: this.previewForLog(output.content),
          });
          this.emitDebugLog(event.isError ? 'error' : 'info', 'tool:end', {
            callId: event.toolCallId,
            name: event.toolName,
            isError: event.isError,
            success: output.success,
            output: output.content,
          });
          this.traceActiveExecution('tool.end', {
            callId: event.toolCallId,
            name: event.toolName,
            isError: event.isError,
            success: output.success,
            command,
            outputPreview: output.content.slice(0, 400),
          }, event.toolName === 'workspace' ? 'retrieve' : 'execute_tools');
          this.sendToUI('chat:tool-end', {
            callId: event.toolCallId,
            name: event.toolName,
            output,
          });
          break;
        }

        case 'turn_end': {
          const msg = event.message as { role?: string; errorMessage?: string } | undefined;
          if (msg?.role === 'assistant' && msg.errorMessage) {
            console.error('[PiChatService] turn_end error:', msg.errorMessage);
            this.emitDebugLog('error', 'turn:end:error', { error: msg.errorMessage });
            this.traceActiveExecution('agent.turn_end_error', { error: msg.errorMessage }, 'execute_tools');
          }
          break;
        }
      }
    });

    try {
      let needsInitialPrompt = true;
      let textualToolRounds = 0;

      while (true) {
        if (needsInitialPrompt) {
          await this.agent.prompt(userInput);
          needsInitialPrompt = false;
        } else {
          await this.agent.continue();
        }
        await this.agent.waitForIdle();

        const recoveredFromState = this.getLastAssistantMessage(this.agent.state.messages as unknown[]);
        const reconciledFromState = this.reconcileAssistantText(runtime.rawResponse, recoveredFromState);
        if (reconciledFromState !== runtime.rawResponse) {
          this.emitDebugLog('info', 'agent:state:reconciled', {
            previousLength: runtime.rawResponse.length,
            recoveredLength: recoveredFromState.length,
            reconciledLength: reconciledFromState.length,
            recoveredPreview: recoveredFromState.slice(0, 160),
          });
          runtime.rawResponse = reconciledFromState;
          const nextVisibleResponse = this.getUiSafeAssistantText(runtime.rawResponse);
          const visibleDelta = this.diffVisibleResponse(runtime.displayResponse, nextVisibleResponse);
          runtime.displayResponse = nextVisibleResponse;
          this.setRuntimeState({ partialResponse: runtime.displayResponse });
          if (visibleDelta) {
            this.sendToUI('chat:response-chunk', { content: visibleDelta });
          }
        }

        if (!sawAnyToolExecution && textualToolRounds < 4) {
          const textualToolFallback = this.extractTextualToolCalls(runtime.rawResponse);
          if (textualToolFallback.calls.length > 0) {
            textualToolRounds += 1;
            runtime.rawResponse = textualToolFallback.visibleText;
            const nextVisibleResponse = this.getUiSafeAssistantText(runtime.rawResponse);
            runtime.displayResponse = nextVisibleResponse;
            this.setRuntimeState({ partialResponse: runtime.displayResponse });
            this.rewriteLastAssistantMessage(nextVisibleResponse);
            const executedAny = await this.executeTextualToolCalls(textualToolFallback.calls, signal, toolGuardState);
            if (executedAny) {
              sawAnyToolExecution = true;
              runtime.rawResponse = '';
              runtime.displayResponse = '';
              this.setRuntimeState({ partialResponse: '' });
              continue;
            }
          }
        }
        break;
      }

      let finalResponse = runtime.displayResponse;
      if (generatedImages.length > 0) {
        finalResponse = this.appendGeneratedImagesMarkdown(finalResponse, generatedImages);
      }
      if (generatedVideos.length > 0) {
        finalResponse = this.appendGeneratedVideosMarkdown(finalResponse, generatedVideos);
      }
      const cleaned = this.cleanupLeakedToolMarkup(finalResponse, sawAnyToolExecution);
      if (cleaned.hasLeakedToolMarkup) {
        this.emitDebugLog('warn', 'agent:run:tool-markup-leaked', {
          leakedToolNames: cleaned.leakedToolNames,
          hadToolExecution: sawAnyToolExecution,
        });
        finalResponse = cleaned.cleanedText;
      }

      const stateError = (this.agent.state as { error?: string }).error;
      const assistantError = this.getLastAssistantError(this.agent.state.messages as unknown[]);
      const finalError = assistantError || stateError;
      if (finalError) {
        this.emitDebugLog('warn', 'agent:run:completed-with-error', { error: finalError });
        this.traceActiveExecution('agent.completed_with_error', { error: finalError }, 'execute_tools');
      } else {
        this.emitDebugLog('info', 'agent:run:completed', {
          responseLength: finalResponse.length,
          streamedChunks: runtime.streamedChunks,
        });
        this.traceActiveExecution('agent.completed', {
          responseLength: finalResponse.length,
          streamedChunks: runtime.streamedChunks,
        }, 'execute_tools');
      }

      return {
        response: finalResponse,
        error: finalError || undefined,
        streamedChunks: runtime.streamedChunks,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      this.emitDebugLog('error', 'agent:run:exception', { error: message });
      this.traceActiveExecution('agent.exception', { error: message }, 'execute_tools');
      return {
        response: runtime.displayResponse,
        error: message,
        streamedChunks: runtime.streamedChunks,
      };
    }
  }

  private async runDirectCompletionFallback(params: {
    modelName: string;
    baseURL: string;
    apiKey: string;
    systemPrompt: string;
    history: Array<{ role: 'user' | 'assistant'; content: Array<{ type: 'text'; text: string }>; timestamp: number }>;
    userInput: string;
    signal: AbortSignal;
  }): Promise<AgentRunResult> {
    const { modelName, baseURL, apiKey, systemPrompt, history, userInput, signal } = params;
    this.emitDebugLog('info', 'fallback:completion:start', {
      modelName,
      baseURL,
      historyCount: history.length,
      userInputLength: userInput.length,
    });
    const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
      { role: 'system', content: systemPrompt },
      ...history.map((item) => ({
        role: item.role,
        content: this.extractText(item.content),
      })),
      { role: 'user', content: userInput },
    ];

    const controller = new AbortController();
    const onAbort = () => controller.abort();
    signal.addEventListener('abort', onAbort);
    const timeout = setTimeout(() => controller.abort(), 90000);

    try {
      const response = await fetch(safeUrlJoin(baseURL, '/chat/completions'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: modelName,
          messages,
          temperature: 0.7,
          stream: false,
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => '');
        this.emitDebugLog('error', 'fallback:completion:http-error', {
          status: response.status,
          statusText: response.statusText,
          errorText,
        });
        return {
          response: '',
          streamedChunks: false,
          error: `Fallback completion failed (${response.status}): ${errorText || response.statusText}`,
        };
      }

      const data = await response.json() as {
        choices?: Array<{ message?: { content?: string | Array<{ text?: string; type?: string }> } }>;
      };
      const rawContent = data?.choices?.[0]?.message?.content;
      const text = typeof rawContent === 'string'
        ? rawContent
        : Array.isArray(rawContent)
          ? rawContent.map((item) => String(item?.text || '')).join('')
          : '';

      this.emitDebugLog('info', 'fallback:completion:decoded', {
        responseLength: text.length,
        responsePreview: text.slice(0, 160),
      });

      if (!text.trim()) {
        this.emitDebugLog('warn', 'fallback:completion:empty-response');
        return {
          response: '',
          streamedChunks: false,
          error: 'Fallback completion returned empty response',
        };
      }

      return {
        response: text,
        streamedChunks: false,
      };
    } catch (error) {
      if (controller.signal.aborted) {
        this.emitDebugLog('warn', 'fallback:completion:aborted');
        return {
          response: '',
          streamedChunks: false,
          error: 'Fallback completion timeout or aborted',
        };
      }
      this.emitDebugLog('error', 'fallback:completion:exception', {
        error: error instanceof Error ? error.message : String(error),
      });
      return {
        response: '',
        streamedChunks: false,
        error: error instanceof Error ? error.message : String(error),
      };
    } finally {
      clearTimeout(timeout);
      signal.removeEventListener('abort', onAbort);
    }
  }

  private createAgent(
    model: Model<any>,
    apiKey: string,
    systemPrompt: string,
    history: Array<{ role: 'user' | 'assistant'; content: Array<{ type: 'text'; text: string }>; timestamp: number }>,
    signal: AbortSignal,
    toolGuardState: ToolGuardState,
  ): Agent {
    const thinkingLevel = this.activeRuntimeExecution?.thinkingBudget || 'low';
    const agent = new Agent({
      initialState: {
        model,
        thinkingLevel,
      },
      sessionId: this.sessionId,
      getApiKey: async () => apiKey,
      convertToLlm: async (messages) => this.convertAgentMessagesToLlm(messages),
      transformContext: async (messages) => messages,
      beforeToolCall: async ({ toolCall, args }): Promise<BeforeToolCallResult | undefined> => {
        return this.guardBeforeToolCall(toolCall?.id || '', toolCall?.name || '', args, toolGuardState);
      },
      afterToolCall: async ({ toolCall, result, isError }): Promise<AfterToolCallResult | undefined> => {
        return this.guardAfterToolCall(toolCall?.name || '', result, isError);
      },
    });

    const agentTools = this.createAgentTools(signal);
    this.emitDebugLog('info', 'agent:tools:registered', {
      pack: 'redclaw',
      count: agentTools.length,
      names: agentTools.map((tool) => tool.name),
      thinkingLevel,
    });
    const requiredTools = ['workspace', 'app_cli'];
    const missingTools = requiredTools.filter((name) => !agentTools.some((tool) => tool.name === name));
    if (!agentTools.length || missingTools.length > 0) {
      this.emitDebugLog('error', 'agent:tools:pack-invalid', {
        pack: 'redclaw',
        count: agentTools.length,
        missingTools,
      });
    }
    agent.setSystemPrompt(systemPrompt);
    agent.setThinkingLevel(thinkingLevel);
    agent.setTools(agentTools);
    agent.replaceMessages(history as any[]);

    return agent;
  }

  private resolveRuntimeMode(metadata: SessionMetadata): RuntimeMode {
    const contextType = String(metadata.contextType || '').trim().toLowerCase();
    if (contextType === 'redclaw') return 'redclaw';
    if (contextType === 'weixin') return 'redclaw';
    if (contextType === 'chatroom') return 'chatroom';
    if (contextType === 'advisor' || contextType === 'discussion') return 'advisor-discussion';
    if (contextType === 'note' || contextType === 'knowledge' || contextType === 'video') return 'knowledge';
    return 'knowledge';
  }

  private traceActiveExecution(eventType: string, payload?: unknown, nodeType?: string): void {
    const taskId = this.activeRuntimeExecution?.task.id;
    if (!taskId) return;
    getTaskGraphRuntime().addTrace(taskId, eventType, payload, nodeType);
  }

  private maybeRegisterArtifactFromToolResult(toolName: string, result: unknown, command?: string): void {
    const taskId = this.activeRuntimeExecution?.task.id;
    if (!taskId) return;

    const wrapped = result as { details?: ToolResult & { data?: unknown } } | undefined;
    const details = wrapped?.details;
    const data = (details?.data || null) as Record<string, unknown> | null;
    if (!details || details.success === false) return;

    if (toolName === 'app_cli' && data?.kind === 'manuscript-write') {
      const relativePath = String(data.path || data.relativePath || '').trim();
      const absolutePath = String(data.absolutePath || '').trim();
      if (relativePath || absolutePath) {
        getTaskGraphRuntime().startNode(taskId, 'save_artifact', '检测到稿件落盘');
        getTaskGraphRuntime().addArtifact(taskId, {
          type: 'manuscript',
          label: relativePath || absolutePath || 'manuscript',
          relativePath: relativePath || undefined,
          absolutePath: absolutePath || undefined,
          metadata: { toolName, command: command || '', data },
        });
      }
      return;
    }

    if (toolName === 'app_cli' && data?.kind === 'generated-images' && Array.isArray(data.assets)) {
      getTaskGraphRuntime().startNode(taskId, 'save_artifact', '检测到图片产物');
      data.assets.forEach((asset, index) => {
        if (!asset || typeof asset !== 'object') return;
        const record = asset as Record<string, unknown>;
        getTaskGraphRuntime().addArtifact(taskId, {
          type: 'image',
          label: String(record.id || `image-${index + 1}`),
          metadata: { toolName, command: command || '', asset: record },
        });
      });
      return;
    }

    if (toolName === 'app_cli' && data?.kind === 'generated-videos' && Array.isArray(data.assets)) {
      getTaskGraphRuntime().startNode(taskId, 'save_artifact', '检测到视频产物');
      data.assets.forEach((asset, index) => {
        if (!asset || typeof asset !== 'object') return;
        const record = asset as Record<string, unknown>;
        getTaskGraphRuntime().addArtifact(taskId, {
          type: 'video',
          label: String(record.id || `video-${index + 1}`),
          metadata: { toolName, command: command || '', asset: record },
        });
      });
    }
  }

  private convertAgentMessagesToLlm(messages: unknown[]) {
    return messages
      .filter((msg) => {
        const role = (msg as { role?: unknown } | undefined)?.role;
        return role === 'user' || role === 'assistant' || role === 'toolResult';
      })
      .map((msg) => {
        const value = msg as { role?: string; content?: unknown };
        if (value.role === 'user') {
          return {
            ...value,
            content: Array.isArray(value.content)
              ? value.content
              : [{ type: 'text', text: this.extractText(value.content) }],
          };
        }
        return value;
      }) as any[];
  }

  private createToolGuardState(metadata?: SessionMetadata): ToolGuardState {
    const isWindowsRedClaw = process.platform === 'win32' && metadata?.contextType === 'redclaw';
    const blockedTools = new Set<string>([
      'bash',
      'workspace',
    ]);

    return {
      totalCalls: 0,
      callsByTool: new Map<string, number>(),
      callsBySignature: new Map<string, number>(),
      restrictToAppCliInRedClaw: isWindowsRedClaw,
      blockedTools,
    };
  }

  private getToolLikeTagNames(): Set<string> {
    const registryNames = this.toolRegistry
      .getAllTools()
      .map((tool) => String(tool.name || '').trim().toLowerCase())
      .filter(Boolean);

    return new Set([
      ...registryNames,
      'workspace',
      'bash',
      'app_cli',
      'skill',
    ]);
  }

  private escapeRegex(text: string): string {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  private sanitizeThoughtDelta(text: string): string {
    const sanitized = this.sanitizePlainText(text)
      .replace(/<thinking>/gi, '')
      .replace(/<\/thinking>/gi, '');
    return this.getUiSafeAssistantText(sanitized);
  }

  private diffVisibleResponse(previous: string, next: string): string {
    if (!next) return '';
    if (!previous) return next;
    if (next.startsWith(previous)) {
      return next.slice(previous.length);
    }
    return next;
  }

  private getUiSafeAssistantText(text: string): string {
    let visible = String(text || '');
    const toolNames = Array.from(this.getToolLikeTagNames());
    if (toolNames.length === 0 || !visible.includes('<')) {
      return this.sanitizePlainText(visible);
    }

    const alternation = toolNames.map((name) => this.escapeRegex(name)).join('|');
    const completeBlockPattern = new RegExp(`<(${alternation})>([\\s\\S]*?)<\\/\\1>`, 'gi');
    const incompleteStartPattern = new RegExp(`<(${alternation})(?:>|\\s|$)`, 'i');
    if (completeBlockPattern.test(visible) || incompleteStartPattern.test(visible)) {
      return '';
    }
    completeBlockPattern.lastIndex = 0;
    visible = visible.replace(completeBlockPattern, '');

    return this.sanitizePlainText(visible).trim();
  }

  private extractTextualToolCalls(text: string): { visibleText: string; calls: TextualToolCall[] } {
    const raw = String(text || '');
    const toolNames = Array.from(this.getToolLikeTagNames());
    if (!raw.trim() || toolNames.length === 0) {
      return { visibleText: raw, calls: [] };
    }

    const alternation = toolNames.map((name) => this.escapeRegex(name)).join('|');
    const blockPattern = new RegExp(`<(${alternation})>([\\s\\S]*?)<\\/\\1>`, 'gi');
    const calls: TextualToolCall[] = [];
    let visibleText = raw;

    visibleText = visibleText.replace(blockPattern, (full, toolName: string, body: string) => {
      calls.push({
        raw: full,
        name: String(toolName || '').toLowerCase(),
        args: this.parseTextualToolArgs(String(body || '')),
      });
      return '';
    });

    return {
      visibleText: calls.length > 0 ? '' : this.sanitizePlainText(visibleText).trim(),
      calls,
    };
  }

  private parseTextualToolArgs(body: string): Record<string, unknown> {
    const text = String(body || '');
    const args: Record<string, unknown> = {};
    const childPattern = /<([a-z_][a-z0-9_-]*)>([\s\S]*?)<\/\1>/gi;
    const matches = [...text.matchAll(childPattern)];

    if (matches.length === 0) {
      const trimmed = text.trim();
      if (trimmed) {
        args.input = this.coerceTextualToolArgValue(trimmed);
      }
      return args;
    }

    for (const match of matches) {
      const key = String(match[1] || '').trim();
      if (!key) continue;
      const value = this.coerceTextualToolArgValue(String(match[2] || '').trim());
      if (Object.prototype.hasOwnProperty.call(args, key)) {
        const previous = args[key];
        args[key] = Array.isArray(previous) ? [...previous, value] : [previous, value];
      } else {
        args[key] = value;
      }
    }
    return args;
  }

  private coerceTextualToolArgValue(value: string): unknown {
    const trimmed = value.trim();
    if (!trimmed) return '';
    if (/^(true|false)$/i.test(trimmed)) {
      return trimmed.toLowerCase() === 'true';
    }
    if (/^-?\d+(?:\.\d+)?$/.test(trimmed)) {
      return Number(trimmed);
    }
    if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
      try {
        return JSON.parse(trimmed);
      } catch {
        return trimmed;
      }
    }
    return trimmed;
  }

  private rewriteLastAssistantMessage(content: string): void {
    if (!this.agent) return;
    const messages = [...this.agent.state.messages] as unknown as Array<Record<string, unknown>>;
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      if (messages[i]?.role === 'assistant') {
        messages[i] = {
          ...messages[i],
          content: [{ type: 'text', text: content }],
        };
        this.agent.replaceMessages(messages as any[]);
        return;
      }
    }
  }

  private async executeTextualToolCalls(
    calls: TextualToolCall[],
    signal: AbortSignal,
    toolGuardState: ToolGuardState,
  ): Promise<boolean> {
    if (!this.agent || calls.length === 0) {
      return false;
    }

    let executedAny = false;

    for (let index = 0; index < calls.length; index += 1) {
      const call = calls[index];
      const callId = `textual_tool_${Date.now()}_${index}`;
      const beforeResult = await this.guardBeforeToolCall(callId, call.name, call.args, toolGuardState);

      this.sendToUI('chat:tool-start', {
        callId,
        name: call.name,
        input: call.args,
        description: `执行工具: ${call.name}`,
      });

      let response: ToolCallResponse;
      if (beforeResult?.block) {
        response = {
          callId,
          name: call.name,
          result: {
            success: false,
            error: {
              message: beforeResult.reason || `Tool "${call.name}" blocked`,
            },
            display: beforeResult.reason || `Tool "${call.name}" blocked`,
            llmContent: beforeResult.reason || `Tool "${call.name}" blocked`,
          } as ToolResult,
          durationMs: 0,
        };
      } else {
        response = await this.toolExecutor.execute(
          {
            callId,
            name: call.name,
            params: call.args,
          },
          signal,
          (chunk) => {
            if (chunk) {
              this.sendToUI('chat:tool-update', {
                callId,
                name: call.name,
                partial: chunk,
              });
            }
          },
        );
      }

      const isError = response.result.success === false;
      const afterResult = await this.guardAfterToolCall(call.name, response.result, isError);
      const effectiveResult: ToolResult = afterResult
        ? {
            ...response.result,
            success: afterResult.isError !== undefined ? !afterResult.isError : response.result.success,
            llmContent: Array.isArray(afterResult.content)
              ? afterResult.content
                  .map((block) => ('text' in block && typeof block.text === 'string' ? block.text : ''))
                  .join('')
              : response.result.llmContent,
            display: typeof afterResult.details === 'string'
              ? afterResult.details
              : response.result.display,
            data: afterResult.details ?? response.result.data,
          }
        : response.result;

      const output = this.toolExecutionToOutput({ details: effectiveResult }, effectiveResult.success === false);
      this.sendToUI('chat:tool-end', {
        callId,
        name: call.name,
        output,
      });

      this.agent.appendMessage({
        role: 'toolResult',
        toolCallId: callId,
        toolName: call.name,
        content: [{
          type: 'text',
          text: effectiveResult.llmContent || effectiveResult.display || effectiveResult.error?.message || '',
        }],
        details: effectiveResult.data,
        isError: effectiveResult.success === false,
        timestamp: Date.now(),
      } as any);
      executedAny = true;
    }

    return executedAny;
  }

  private async guardBeforeToolCall(
    callId: string,
    toolName: string,
    args: unknown,
    state: ToolGuardState,
  ): Promise<BeforeToolCallResult | undefined> {
    const normalizedToolName = (toolName || 'unknown').trim() || 'unknown';
    state.totalCalls += 1;

    const currentToolCount = (state.callsByTool.get(normalizedToolName) || 0) + 1;
    state.callsByTool.set(normalizedToolName, currentToolCount);

    const signature = this.buildToolCallSignature(normalizedToolName, args);
    const currentSignatureCount = (state.callsBySignature.get(signature) || 0) + 1;
    state.callsBySignature.set(signature, currentSignatureCount);

    let blockReason = '';
    if (state.restrictToAppCliInRedClaw && state.blockedTools.has(normalizedToolName)) {
      blockReason = `Windows RedClaw 模式下已限制 ${normalizedToolName}，请改用 app_cli 或 redclaw_* 工具，避免路径兼容问题。`;
    } else if (state.totalCalls > TOOL_GUARD_MAX_TOTAL_CALLS) {
      blockReason = `Tool 调用次数超过上限(${TOOL_GUARD_MAX_TOTAL_CALLS})，已阻止继续调用。请基于现有结果给出结论。`;
    } else if (currentToolCount > TOOL_GUARD_MAX_CALLS_PER_TOOL) {
      blockReason = `工具 ${normalizedToolName} 调用次数超过上限(${TOOL_GUARD_MAX_CALLS_PER_TOOL})，疑似进入循环。请改为总结已有结果。`;
    } else if (currentSignatureCount > TOOL_GUARD_MAX_REPEAT_SIGNATURE) {
      blockReason = `检测到重复工具调用(${normalizedToolName})参数完全一致，已阻止第 ${currentSignatureCount} 次重复。请先分析已有输出。`;
    }

    if (!blockReason) {
      return undefined;
    }

    console.warn('[PiChatService] tool:guard-blocked', {
      sessionId: this.sessionId,
      callId,
      toolName: normalizedToolName,
      totalCalls: state.totalCalls,
      toolCalls: currentToolCount,
      signatureCalls: currentSignatureCount,
      reason: blockReason,
    });

    this.sendToUI('chat:tool-update', {
      callId,
      name: normalizedToolName,
      partial: `[Guard] ${blockReason}`,
    });

    return {
      block: true,
      reason: blockReason,
    };
  }

  private async guardAfterToolCall(
    toolName: string,
    result: unknown,
    isError: boolean,
  ): Promise<AfterToolCallResult | undefined> {
    const sanitized = this.sanitizeToolHookResult(result);
    if (!sanitized.changed) {
      return undefined;
    }

    console.log('[PiChatService] tool:guard-sanitized', {
      sessionId: this.sessionId,
      toolName,
      isError,
      truncated: true,
      contentPreview: this.previewForLog(sanitized.content),
    });

    return {
      content: sanitized.content,
      details: sanitized.details,
      isError,
    };
  }

  private sanitizeToolHookResult(result: unknown): {
    changed: boolean;
    content?: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }>;
    details?: unknown;
  } {
    const wrapped = (result || {}) as { content?: unknown; details?: unknown };
    let changed = false;

    let nextContent = wrapped.content as Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }> | undefined;
    if (Array.isArray(nextContent)) {
      const patched = nextContent.map((block) => {
        if (!block || typeof block !== 'object' || block.type !== 'text' || typeof block.text !== 'string') {
          return block;
        }
        const sanitized = this.sanitizePlainText(block.text);
        const trimmed = this.truncateToolText(sanitized, TOOL_RESULT_MAX_TEXT_CHARS, 'tool content');
        if (trimmed !== block.text) {
          changed = true;
          return {
            ...block,
            text: trimmed,
          };
        }
        return block;
      });
      nextContent = patched;
    }

    let nextDetails: unknown = wrapped.details;
    if (wrapped.details && typeof wrapped.details === 'object') {
      const details = wrapped.details as Record<string, unknown>;
      const patched: Record<string, unknown> = { ...details };

      if (typeof patched.llmContent === 'string') {
        const sanitized = this.sanitizePlainText(patched.llmContent);
        const trimmed = this.truncateToolText(sanitized, TOOL_RESULT_MAX_LLM_CHARS, 'llmContent');
        if (trimmed !== patched.llmContent) {
          changed = true;
          patched.llmContent = trimmed;
        }
      }

      if (typeof patched.display === 'string') {
        const sanitized = this.sanitizePlainText(patched.display);
        const trimmed = this.truncateToolText(sanitized, TOOL_RESULT_MAX_DISPLAY_CHARS, 'display');
        if (trimmed !== patched.display) {
          changed = true;
          patched.display = trimmed;
        }
      }

      if (patched.error && typeof patched.error === 'object') {
        const errorObj = { ...(patched.error as Record<string, unknown>) };
        if (typeof errorObj.message === 'string') {
          const sanitized = this.sanitizePlainText(errorObj.message);
          const trimmed = this.truncateToolText(sanitized, TOOL_RESULT_MAX_ERROR_CHARS, 'error');
          if (trimmed !== errorObj.message) {
            changed = true;
            errorObj.message = trimmed;
          }
        }
        patched.error = errorObj;
      }

      nextDetails = patched;
    } else if (typeof wrapped.details === 'string') {
      const sanitized = this.sanitizePlainText(wrapped.details);
      const trimmed = this.truncateToolText(sanitized, TOOL_RESULT_MAX_LLM_CHARS, 'details');
      if (trimmed !== wrapped.details) {
        changed = true;
        nextDetails = trimmed;
      }
    }

    return {
      changed,
      content: nextContent,
      details: nextDetails,
    };
  }

  private sanitizePlainText(text: string): string {
    return String(text || '')
      .replace(/\u0000/g, '')
      .replace(/\r\n/g, '\n');
  }

  private truncateToolText(text: string, maxChars: number, field: string): string {
    if (text.length <= maxChars) {
      return text;
    }
    const omitted = text.length - maxChars;
    return `${text.slice(0, maxChars)}\n\n[${field} 过长，已截断 ${omitted} 字符]`;
  }

  private buildToolCallSignature(toolName: string, args: unknown): string {
    const normalized = this.stableStringifyForSignature(args);
    return `${toolName}:${normalized.slice(0, 800)}`;
  }

  private stableStringifyForSignature(value: unknown, depth = 0): string {
    if (depth > 5) return '"[depth-limit]"';
    if (value === null) return 'null';
    if (value === undefined) return 'undefined';

    const valueType = typeof value;
    if (valueType === 'string') {
      const text = value as string;
      return JSON.stringify(text.length > 240 ? `${text.slice(0, 240)}...<truncated>` : text);
    }
    if (valueType === 'number' || valueType === 'boolean') {
      return JSON.stringify(value);
    }
    if (Array.isArray(value)) {
      const items = value.slice(0, 16).map((item) => this.stableStringifyForSignature(item, depth + 1));
      const suffix = value.length > 16 ? ', "...<truncated-array>"' : '';
      return `[${items.join(', ')}${suffix}]`;
    }
    if (valueType === 'object') {
      const objectValue = value as Record<string, unknown>;
      const keys = Object.keys(objectValue).sort();
      const limitedKeys = keys.slice(0, 20);
      const segments = limitedKeys.map((key) => `${JSON.stringify(key)}:${this.stableStringifyForSignature(objectValue[key], depth + 1)}`);
      if (keys.length > 20) {
        segments.push('"...<truncated-object>":true');
      }
      return `{${segments.join(',')}}`;
    }

    return JSON.stringify(String(value));
  }

  private async ensureSkillsDiscovered(workspace: string): Promise<void> {
    const normalizedWorkspace = path.resolve(workspace);
    if (this.discoveredWorkspaceForSkills === normalizedWorkspace) {
      return;
    }
    await this.skillManager.discoverSkills(workspace);
    this.discoveredWorkspaceForSkills = normalizedWorkspace;
  }

  private createModelWithBaseUrl(modelName: string, baseURL: string, settings?: Record<string, unknown>): Model<any> {
    const requestedModel = (modelName || 'gpt-4o').trim();
    const resolvedBaseUrl = normalizeApiBaseUrl(baseURL || 'https://api.openai.com/v1', 'https://api.openai.com/v1');
    const isOfficialOpenAI = this.isOfficialOpenAIEndpoint(resolvedBaseUrl);

    if (isOfficialOpenAI) {
      const resolved = getModel('openai', requestedModel as any) as (Model<any> & { baseUrl?: string }) | undefined;
      if (resolved) {
        console.log('[PiChatService] model-resolved', { mode: 'openai-official', modelId: resolved.id, api: resolved.api });
        return {
          ...resolved,
          baseUrl: resolvedBaseUrl || resolved.baseUrl,
        };
      }

      const fallback = getModel('openai', 'gpt-4o' as any) as (Model<any> & { baseUrl?: string }) | undefined;
      if (fallback) {
        console.warn(`[PiChatService] Unknown OpenAI model "${requestedModel}", fallback to gpt-4o`);
        console.log('[PiChatService] model-resolved', { mode: 'openai-fallback', modelId: fallback.id, api: fallback.api });
        return {
          ...fallback,
          baseUrl: resolvedBaseUrl || fallback.baseUrl,
        };
      }
    }

    // OpenAI-compatible endpoint (DashScope/Ollama/vLLM/LiteLLM etc.)
    const lower = `${requestedModel} ${resolvedBaseUrl}`.toLowerCase();
    const isQwenFamily = lower.includes('qwen') || lower.includes('dashscope.aliyuncs.com');
    const isDeepSeekFamily = lower.includes('deepseek');
    const maxTokens = resolveChatMaxTokens(settings, isDeepSeekFamily);
    const compat: Record<string, unknown> = {
      supportsStore: false,
      supportsDeveloperRole: false,
      maxTokensField: 'max_tokens',
      supportsReasoningEffort: !isQwenFamily,
    };

    if (isQwenFamily) {
      compat.thinkingFormat = 'qwen';
    }

    const customModel = {
      id: requestedModel || 'openai-compatible-model',
      name: `OpenAI-Compatible (${requestedModel || 'model'})`,
      api: 'openai-completions',
      provider: 'openai-compatible',
      baseUrl: resolvedBaseUrl,
      reasoning: true,
      input: ['text', 'image'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128000,
      maxTokens,
      compat: compat as any,
    } as Model<any>;

    console.log('[PiChatService] model-resolved', {
      mode: 'openai-compatible',
      modelId: customModel.id,
      api: customModel.api,
      baseUrl: customModel.baseUrl,
      maxTokens: customModel.maxTokens,
      compat: customModel.compat,
    });

    return customModel;
  }

  private isOfficialOpenAIEndpoint(baseURL: string): boolean {
    try {
      const url = new URL(baseURL);
      return url.hostname === 'api.openai.com';
    } catch {
      return false;
    }
  }

  private createAgentTools(signal: AbortSignal): AgentTool[] {
    const schemaMap = new Map<string, unknown>();
    for (const schema of this.toolRegistry.getToolSchemas()) {
      schemaMap.set(schema.function.name, schema.function.parameters);
    }

    const tools = this.toolRegistry.getAllTools().map((tool) => ({
      name: tool.name,
      label: tool.displayName || tool.name,
      description: tool.description,
      parameters: (schemaMap.get(tool.name) || {
        type: 'object',
        properties: {},
        additionalProperties: false,
      }) as any,
      execute: async (toolCallId: string, params: Record<string, unknown>) => {
        const request: ToolCallRequest = {
          callId: toolCallId,
          name: tool.name,
          params,
        };
        const response = await this.toolExecutor.execute(request, signal);
        return this.toolResultToAgentResult(response.result);
      },
    })) as AgentTool[];

    const executeSkillLoad = async (params: Record<string, unknown>) => {
      const skillName = typeof params.skill === 'string'
        ? params.skill
        : (typeof params.name === 'string' ? params.name : '');
      const activated = skillName ? await this.skillManager.activateSkill(skillName) : null;

      if (activated) {
        const skill = this.skillManager.getSkill(skillName);
        this.sendToUI('chat:skill-activated', {
          name: skill?.name || skillName,
          description: skill?.description || `技能 ${skillName} 已激活`,
        });
        return {
          content: [{ type: 'text' as const, text: activated }],
          details: { success: true },
        };
      }

      const available = this.skillManager.getSkills().map((skill) => skill.name).join(', ');
      return {
        content: [{ type: 'text' as const, text: `Skill "${skillName}" not found or disabled. Available skills: ${available || 'none'}.` }],
        details: { success: false },
      };
    };

    return tools;
  }

  private toolResultToAgentResult(result: ToolResult) {
    const text = result.llmContent || result.display || result.error?.message || '';
    return {
      content: [{ type: 'text' as const, text }],
      details: result,
    };
  }

  private toolExecutionToOutput(result: unknown, isError: boolean): { success: boolean; content: string } {
    const wrapped = result as { details?: ToolResult; content?: unknown } | undefined;
    const details = wrapped?.details;

    if (details) {
      return {
        success: !isError && details.success !== false,
        content: details.llmContent || details.display || details.error?.message || '',
      };
    }

    return {
      success: !isError,
      content: this.extractText(wrapped?.content),
    };
  }

  private toolExecutionUpdateToText(partialResult: unknown): string {
    const output = this.toolExecutionToOutput(partialResult, false).content;
    if (output && output.trim()) return output;
    if (typeof partialResult === 'string') return partialResult;
    return '';
  }

  private isImageGenerateCommand(command: string): boolean {
    return /^image\s+generate\b/i.test(String(command || '').trim());
  }

  private isVideoGenerateCommand(command: string): boolean {
    return /^video\s+generate\b/i.test(String(command || '').trim());
  }

  private extractGeneratedImagesFromToolResult(result: unknown): GeneratedImagePreview[] {
    const wrapped = result as { details?: ToolResult } | undefined;
    const details = wrapped?.details as (ToolResult & { data?: unknown }) | undefined;
    const data = details?.data as {
      kind?: string;
      assets?: Array<{ id?: string; previewUrl?: string; prompt?: string }>;
    } | undefined;

    if (data?.kind !== 'generated-images' || !Array.isArray(data.assets)) {
      return [];
    }

    return data.assets
      .map((asset) => ({
        id: String(asset?.id || '').trim(),
        previewUrl: String(asset?.previewUrl || '').trim(),
        prompt: typeof asset?.prompt === 'string' ? asset.prompt : undefined,
      }))
      .filter((asset) => asset.id && asset.previewUrl);
  }

  private appendGeneratedImagesMarkdown(content: string, images: GeneratedImagePreview[]): string {
    const normalized = String(content || '').trim();
    const uniqueImages = images
      .filter((image, index, list) => list.findIndex((item) => item.id === image.id) === index)
      .filter((image) => !this.hasGeneratedMediaEmbed(normalized, image.previewUrl));
    if (uniqueImages.length === 0) {
      return normalized;
    }

    const gallery = [
      '## 生成图片',
      ...uniqueImages.map((image, index) => `![generated-${index + 1}](${image.previewUrl})`),
    ].join('\n\n');

    return normalized ? `${normalized}\n\n${gallery}` : gallery;
  }

  private extractGeneratedVideosFromToolResult(result: unknown): GeneratedVideoPreview[] {
    const wrapped = result as { details?: ToolResult } | undefined;
    const details = wrapped?.details as (ToolResult & { data?: unknown }) | undefined;
    const data = details?.data as {
      kind?: string;
      assets?: Array<{ id?: string; previewUrl?: string; prompt?: string }>;
    } | undefined;

    if (data?.kind !== 'generated-videos' || !Array.isArray(data.assets)) {
      return [];
    }

    return data.assets
      .map((asset) => ({
        id: String(asset?.id || '').trim(),
        previewUrl: String(asset?.previewUrl || '').trim(),
        prompt: typeof asset?.prompt === 'string' ? asset.prompt : undefined,
      }))
      .filter((asset) => asset.id && asset.previewUrl);
  }

  private appendGeneratedVideosMarkdown(content: string, videos: GeneratedVideoPreview[]): string {
    const normalized = String(content || '').trim();
    const uniqueVideos = videos
      .filter((video, index, list) => list.findIndex((item) => item.id === video.id) === index)
      .filter((video) => !this.hasGeneratedMediaEmbed(normalized, video.previewUrl));
    if (uniqueVideos.length === 0) {
      return normalized;
    }

    const gallery = [
      '## 生成视频',
      ...uniqueVideos.map((video, index) => `![generated-video-${index + 1}](${video.previewUrl})`),
    ].join('\n\n');

    return normalized ? `${normalized}\n\n${gallery}` : gallery;
  }

  private hasGeneratedMediaEmbed(content: string, previewUrl: string): boolean {
    const normalized = String(content || '').trim();
    const url = String(previewUrl || '').trim();
    if (!normalized || !url) {
      return false;
    }
    return normalized.includes(`](${url})`) || normalized.includes(`src="${url}"`) || normalized.includes(`src='${url}'`);
  }

  private cleanupLeakedToolMarkup(response: string, hadRealToolExecution: boolean): ToolMarkupCleanupResult {
    const text = String(response || '');
    if (!text.trim() || hadRealToolExecution) {
      return { hasLeakedToolMarkup: false, cleanedText: text, leakedToolNames: [] };
    }

    const toolNameSet = new Set(
      this.toolRegistry.getAllTools().map((tool) => String(tool.name || '').trim().toLowerCase()).filter(Boolean)
    );
    const explicitToolLikeTags = new Set([
      'workspace',
      'bash',
      'app_cli',
      'skill',
    ]);

    const mergedToolSet = new Set([...toolNameSet, ...explicitToolLikeTags]);
    const leakedToolNames: string[] = [];
    const blockPattern = /<([a-z_][a-z0-9_]*)>([\s\S]*?)<\/\1>/gi;
    const matches = [...text.matchAll(blockPattern)];

    if (matches.length === 0) {
      return { hasLeakedToolMarkup: false, cleanedText: text, leakedToolNames: [] };
    }

    const leakedBlocks = matches.filter((match) => mergedToolSet.has(String(match[1] || '').toLowerCase()));
    if (leakedBlocks.length === 0) {
      return { hasLeakedToolMarkup: false, cleanedText: text, leakedToolNames: [] };
    }

    leakedBlocks.forEach((match) => {
      const toolName = String(match[1] || '').toLowerCase();
      if (toolName && !leakedToolNames.includes(toolName)) {
        leakedToolNames.push(toolName);
      }
    });

    const cleanedText = text.replace(blockPattern, (full, tagName: string) => {
      return mergedToolSet.has(String(tagName || '').toLowerCase()) ? '' : full;
    }).trim();

    if (cleanedText) {
      return {
        hasLeakedToolMarkup: true,
        cleanedText,
        leakedToolNames,
      };
    }

    return {
      hasLeakedToolMarkup: true,
      cleanedText: '当前模型返回了内部工具调用标记，未产出可读结果。请切换到更稳定的工具调用模型后重试（如 DeepSeek / OpenAI / Claude）。',
      leakedToolNames,
    };
  }

  private getSessionMetadata(sessionId: string): SessionMetadata {
    const session = getChatSession(sessionId);
    if (!session?.metadata) {
      return {};
    }

    try {
      return JSON.parse(session.metadata) as SessionMetadata;
    } catch {
      return {};
    }
  }

  private getHistoryMessages(sessionId: string, currentInput: string): HistoryMessage[] {
    const history = getChatMessages(sessionId)
      .filter((msg) => msg.role === 'user' || msg.role === 'assistant')
      .map((msg) => ({
        role: msg.role as 'user' | 'assistant',
        content: msg.content,
        timestamp: msg.timestamp || Date.now(),
      }));

    if (history.length > 0) {
      const last = history[history.length - 1];
      if (last.role === 'user' && last.content === currentInput) {
        history.pop();
      }
    }

    return history;
  }

  private historyToAgentMessages(
    sessionId: string,
    currentInput: string,
    metadata?: SessionMetadata
  ): Array<{ role: 'user' | 'assistant'; content: Array<{ type: 'text'; text: string }>; timestamp: number }> {
    const history = this.getHistoryMessages(sessionId, currentInput);
    let selected: HistoryMessage[] = history.slice(-30);

    if (metadata?.contextType === 'redclaw') {
      const compactBase = Math.max(0, Math.min(history.length, metadata.compactBaseMessageCount || 0));
      selected = history.slice(compactBase).slice(-80);
    }

    return selected.map((msg) => ({
      role: msg.role,
      content: [{ type: 'text' as const, text: msg.content }],
      timestamp: msg.timestamp,
    }));
  }

  private historyToRuntimeMessages(
    sessionId: string,
    currentInput: string,
    metadata?: SessionMetadata,
  ): Array<{ role: 'user' | 'assistant'; content: string }> {
    return this.historyToAgentMessages(sessionId, currentInput, metadata).map((message) => ({
      role: message.role,
      content: message.content.map((item) => item.text).join(''),
    }));
  }

  private estimateTokenCountFromText(text: string): number {
    return Math.ceil(text.length / 4);
  }

  private estimateTokenCountForHistory(messages: HistoryMessage[]): number {
    return messages.reduce((acc, msg) => acc + this.estimateTokenCountFromText(msg.content), 0);
  }

  private getModelContextWindow(model: Model<any>): number {
    const contextWindow = Number((model as { contextWindow?: number }).contextWindow);
    if (Number.isFinite(contextWindow) && contextWindow > 0) {
      return contextWindow;
    }
    return DEFAULT_MODEL_CONTEXT_WINDOW_FALLBACK;
  }

  private async maybeCompactContext(params: {
    sessionId: string;
    currentInput: string;
    metadata: SessionMetadata;
    apiKey: string;
    baseURL: string;
    modelName: string;
    contextWindow: number;
    redClawCompactTargetTokens?: number;
    force?: boolean;
  }): Promise<SessionMetadata> {
    const {
      sessionId,
      currentInput,
      apiKey,
      baseURL,
      modelName,
      contextWindow,
      redClawCompactTargetTokens,
      force = false,
    } = params;
    const metadata = { ...params.metadata };

    if (metadata.contextType !== 'redclaw') {
      return metadata;
    }

    const history = this.getHistoryMessages(sessionId, currentInput);
    if (!force && history.length < 20) {
      return metadata;
    }
    if (force && history.length < 2) {
      return metadata;
    }

    const compactBaseCount = Math.max(0, Math.min(history.length, metadata.compactBaseMessageCount || 0));
    const compactSummaryTokens = metadata.compactSummary ? this.estimateTokenCountFromText(metadata.compactSummary) : 0;
    const activeHistory = history.slice(compactBaseCount);
    const activeHistoryChars = activeHistory.reduce((acc, msg) => acc + String(msg.content || '').length, 0);
    const estimatedTotal = this.estimateTokenCountForHistory(activeHistory) + compactSummaryTokens;
    const compactThreshold = this.getRedClawCompactThreshold(contextWindow, redClawCompactTargetTokens);
    const shouldCompactByTokens = estimatedTotal >= compactThreshold;
    const shouldCompactByMessageCount = activeHistory.length >= 48;
    const shouldCompactByChars = activeHistoryChars >= 28000;

    if (!force && !shouldCompactByTokens && !shouldCompactByMessageCount && !shouldCompactByChars) {
      return metadata;
    }

    const recentKeepCount = force ? 8 : 16;
    let compactUntil = Math.max(0, history.length - recentKeepCount);
    if (force && compactUntil <= compactBaseCount) {
      compactUntil = Math.max(compactBaseCount + 1, history.length - 2);
    }
    if (compactUntil <= compactBaseCount) {
      return metadata;
    }

    const deltaMessages = history.slice(compactBaseCount, compactUntil);
    if (deltaMessages.length < (force ? 1 : 6)) {
      return metadata;
    }

    const messagesForCompression = [
      ...(metadata.compactSummary ? [{ role: 'system', content: `Previous compact summary:\n${metadata.compactSummary}` }] : []),
      ...deltaMessages.map((msg) => ({ role: msg.role, content: msg.content })),
    ];

    const compressor = createCompressionService({
      apiKey,
      baseURL,
      model: modelName,
      threshold: 1,
    });

    try {
      const result = await compressor.compress(messagesForCompression);
      const summary = result.summary?.trim();
      if (!summary) {
        return metadata;
      }

      const nextMetadata: SessionMetadata = {
        ...metadata,
        compactSummary: summary,
        compactBaseMessageCount: compactUntil,
        compactRounds: (metadata.compactRounds || 0) + 1,
        compactUpdatedAt: new Date().toISOString(),
      };
      updateChatSessionMetadata(sessionId, nextMetadata as Record<string, unknown>);
      console.log('[PiChatService] context-compacted', {
        sessionId,
        compactUntil,
        compactRounds: nextMetadata.compactRounds,
      });
      return nextMetadata;
    } catch (error) {
      console.error('[PiChatService] context compact failed:', error);
      return metadata;
    }
  }

  private getRedClawCompactTargetTokens(settings: Record<string, unknown>): number {
    const raw = settings.redclaw_compact_target_tokens ?? settings.redclawCompactTargetTokens;
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed > 0) {
      return Math.floor(parsed);
    }
    return DEFAULT_REDCLAW_AUTO_COMPACT_TOKENS;
  }

  private getRedClawCompactThreshold(contextWindow: number, targetTokens?: number): number {
    const target = Number.isFinite(Number(targetTokens)) && Number(targetTokens) > 0
      ? Math.floor(Number(targetTokens))
      : DEFAULT_REDCLAW_AUTO_COMPACT_TOKENS;

    // 留出安全余量，避免接近模型极限触发 provider 上下文超限。
    const safeUpperBound = Math.max(24000, Math.floor(contextWindow * 0.88));
    return Math.max(16000, Math.min(target, safeUpperBound));
  }

  private getLastAssistantMessage(messages: unknown[]): string {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const msg = messages[i] as { role?: string; content?: unknown };
      if (msg.role === 'assistant') {
        const text = this.extractText(msg.content);
        if (text) return text;
      }
    }
    return '';
  }

  private getLastAssistantError(messages: unknown[]): string {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const msg = messages[i] as { role?: string; errorMessage?: string };
      if (msg.role === 'assistant' && typeof msg.errorMessage === 'string' && msg.errorMessage.trim()) {
        return msg.errorMessage;
      }
    }
    return '';
  }

  private handleQueryRuntimeEvent(
    event: RuntimeEvent,
    generatedImages: GeneratedImagePreview[],
    generatedVideos: GeneratedVideoPreview[],
  ): void {
    switch (event.type) {
      case 'thinking':
        this.sendToUI('chat:thought-delta', { content: event.content });
        this.traceActiveExecution(`runtime.${event.phase}`, { content: event.content }, event.phase === 'tooling' ? 'execute_tools' : 'plan');
        break;
      case 'response_chunk':
        this.setRuntimeState({ partialResponse: event.content });
        this.sendToUI('chat:response-chunk', { content: event.content });
        break;
      case 'response_end':
        this.setRuntimeState({ partialResponse: event.content });
        break;
      case 'tool_start':
        this.emitDebugLog('info', 'runtime:tool:start', {
          callId: event.callId,
          name: event.name,
          params: event.params,
        });
        this.sendToUI('chat:tool-start', {
          callId: event.callId,
          name: event.name,
          input: event.params,
          description: event.description,
        });
        this.traceActiveExecution('tool.start', {
          callId: event.callId,
          name: event.name,
          args: event.params,
        }, event.name === 'workspace' ? 'retrieve' : 'execute_tools');
        break;
      case 'tool_output':
        this.sendToUI('chat:tool-update', {
          callId: event.callId,
          name: event.name,
          partial: event.chunk,
        });
        break;
      case 'tool_end':
        if (event.name === 'app_cli') {
          const data = (event.result.data || null) as Record<string, unknown> | null;
          if (data?.kind === 'generated-images' && Array.isArray(data.assets)) {
            generatedImages.push(...this.extractGeneratedImagesFromToolResult({
              details: event.result,
            }));
          }
          if (data?.kind === 'generated-videos' && Array.isArray(data.assets)) {
            generatedVideos.push(...this.extractGeneratedVideosFromToolResult({
              details: event.result,
            }));
          }
        }
        this.sendToUI('chat:tool-end', {
          callId: event.callId,
          name: event.name,
          output: {
            success: event.result.success,
            content: event.result.display || event.result.llmContent || event.result.error?.message || '',
          },
        });
        this.traceActiveExecution('tool.end', {
          callId: event.callId,
          name: event.name,
          success: event.result.success,
          outputPreview: String(event.result.llmContent || '').slice(0, 400),
        }, event.name === 'workspace' ? 'retrieve' : 'execute_tools');
        break;
      case 'compact_start':
        this.sendToUI('chat:thought-delta', { content: `上下文整理中（${event.strategy}）...` });
        break;
      case 'compact_end':
        this.emitDebugLog('info', 'runtime:compact:end', event);
        break;
      case 'hook_start':
      case 'hook_end':
        this.emitDebugLog('info', `runtime:${event.type}`, event);
        break;
      case 'checkpoint':
        this.traceActiveExecution('runtime.checkpoint', {
          checkpointType: event.checkpointType,
          summary: event.summary,
        }, 'execute_tools');
        break;
      case 'error':
        this.emitDebugLog('error', 'runtime:error', { message: event.message });
        break;
      case 'done':
        this.emitDebugLog('info', 'runtime:done', { responseLength: event.response.length });
        break;
      case 'tool_summary':
      case 'query_start':
        break;
    }
  }

  private maybeRegisterArtifactFromRuntimeToolResult(toolName: string, result: ToolResult, command?: string): void {
    this.maybeRegisterArtifactFromToolResult(toolName, { details: result }, command);
  }

  private extractText(content: unknown): string {
    if (!content) return '';

    if (typeof content === 'string') {
      return content;
    }

    if (Array.isArray(content)) {
      return content
        .map((item) => {
          if (!item || typeof item !== 'object') return '';
          const value = item as Record<string, unknown>;
          if (typeof value.text === 'string') return value.text;
          if (typeof value.content === 'string') return value.content;
          if (typeof value.delta === 'string') return value.delta;
          return '';
        })
        .join('');
    }

    if (typeof content === 'object') {
      const value = content as Record<string, unknown>;
      if (typeof value.text === 'string') return value.text;
      if (typeof value.content === 'string') return value.content;
      if (typeof value.delta === 'string') return value.delta;
      try {
        return JSON.stringify(content);
      } catch {
        return '';
      }
    }

    return String(content);
  }

  private truncate(text: string, maxLength: number): string {
    if (text.length <= maxLength) {
      return text;
    }
    return `${text.slice(0, maxLength)}\n\n[内容过长，已截断]`;
  }

  private buildAvailableToolsSummary(): string {
    const toolNames = new Set(this.toolRegistry.getAllTools().map((tool) => String(tool.name || '').trim()));
    if (!toolNames.size) {
      return '- (no tools registered)';
    }

    const lines: string[] = [];
    if (toolNames.has('app_cli')) {
      lines.push('- `app_cli`: app-managed data and business actions');
    }
    if (toolNames.has('workspace')) {
      lines.push('- `workspace`: controlled workspace mutator (`write` / `edit`)');
    }
    if (toolNames.has('bash')) {
      lines.push('- `bash`: preferred for inspection, search, listing, and reading absolute paths');
    }
    if (toolNames.has('skill')) {
      lines.push('- `skill`: load specialized workflows only when clearly relevant');
    }

    const remaining = Array.from(toolNames).filter((name) => !['app_cli', 'workspace', 'bash', 'skill'].includes(name));
    if (remaining.length) {
      lines.push(`- other_tools: ${remaining.join(', ')}`);
    }

    return lines.join('\n');
  }

  private buildPiDocumentationSection(
    workspacePaths: ReturnType<typeof getWorkspacePaths>,
    redClawProfileBundle?: RedClawProfilePromptBundle | null,
  ): string {
    const memoryPath = path.join(workspacePaths.base, 'memory', 'MEMORY.md');
    const profileRoot = redClawProfileBundle?.profileRoot || path.join(workspacePaths.redclaw, 'profile');
    const agentPath = path.join(profileRoot, 'Agent.md');
    const soulPath = path.join(profileRoot, 'Soul.md');
    const identityPath = path.join(profileRoot, 'identity.md');
    const userPath = path.join(profileRoot, 'user.md');
    const creatorProfilePath = path.join(profileRoot, 'CreatorProfile.md');
    const subjectsPath = path.join(workspacePaths.base, 'subjects');
    const appCliPath = path.join(process.cwd(), 'archive', 'desktop-electron', 'electron', 'core', 'tools', 'appCliTool.ts');
    const promptsLibraryPath = path.join(process.cwd(), 'archive', 'desktop-electron', 'electron', 'prompts', 'library');

    return [
      `- Main documentation: app_cli tool usage (${appCliPath})`,
      `- Additional docs: prompt library (${promptsLibraryPath})`,
      '- Discovery-first: use `app_cli(command="help")` or `app_cli(command="help <namespace>")` before niche commands',
      `- Memory document: ${memoryPath}`,
      `- Agent document: ${agentPath}`,
      `- Soul document: ${soulPath}`,
      `- Identity document: ${identityPath}`,
      `- User profile document: ${userPath}`,
      `- Creator strategy document: ${creatorProfilePath}`,
      `- Subjects library root: ${subjectsPath}`,
    ].join('\n');
  }

  private buildProjectContextSection(workspacePaths: ReturnType<typeof getWorkspacePaths>): string {
    const candidateDirs = new Set<string>([
      workspacePaths.base,
      workspacePaths.workspaceRoot,
      process.cwd(),
    ]);

    let currentDir = workspacePaths.base;
    for (let i = 0; i < 5; i += 1) {
      candidateDirs.add(currentDir);
      const parent = path.dirname(currentDir);
      if (parent === currentDir) break;
      currentDir = parent;
    }

    const blocks: string[] = [];
    const seen = new Set<string>();
    for (const dir of candidateDirs) {
      const agentsPath = path.join(dir, 'AGENTS.md');
      if (seen.has(agentsPath)) continue;
      seen.add(agentsPath);
      if (!fs.existsSync(agentsPath)) continue;
      try {
        const content = fs.readFileSync(agentsPath, 'utf-8').trim();
        if (!content) continue;
        blocks.push(`## ${agentsPath}\n${this.truncate(content, 5000)}`);
      } catch (error) {
        blocks.push(`## ${agentsPath}\n(读取失败: ${String(error)})`);
      }
    }

    if (!blocks.length) {
      return '## (No AGENTS.md found in current workspace scope)\nUse default repo and system instructions.';
    }
    return blocks.join('\n\n');
  }

  private buildSkillsSection(skillsXml: string, activeSkillContents: string[]): string {
    const parts: string[] = [];
    if (skillsXml) {
      parts.push('## Available Skills (XML)');
      parts.push(skillsXml);
    }
    if (activeSkillContents.length > 0) {
      parts.push('## Active Skill Instructions');
      for (const skillContent of activeSkillContents) {
        parts.push(skillContent);
      }
    }
    if (!parts.length) {
      parts.push('(No skill metadata available)');
    }
    return parts.join('\n\n');
  }

  private buildSubjectsSection(workspacePaths: ReturnType<typeof getWorkspacePaths>): string {
    const subjectsRoot = path.join(workspacePaths.base, 'subjects');
    const catalogPath = path.join(subjectsRoot, 'catalog.json');
    const categoriesPath = path.join(subjectsRoot, 'categories.json');

    try {
      const categoriesRaw = fs.existsSync(categoriesPath) ? fs.readFileSync(categoriesPath, 'utf-8') : '';
      const categoriesParsed = categoriesRaw ? JSON.parse(categoriesRaw) as { categories?: Array<{ id?: string; name?: string }> } : {};
      const categoryMap = new Map(
        Array.isArray(categoriesParsed.categories)
          ? categoriesParsed.categories.map((item) => [String(item?.id || '').trim(), String(item?.name || '').trim()])
          : [],
      );

      const catalogRaw = fs.existsSync(catalogPath) ? fs.readFileSync(catalogPath, 'utf-8') : '';
      const catalogParsed = catalogRaw ? JSON.parse(catalogRaw) as {
        subjects?: Array<{
          id?: string;
          name?: string;
          categoryId?: string;
          tags?: string[];
          attributes?: Array<{ key?: string; value?: string }>;
          imagePaths?: string[];
        }>;
      } : {};
      const subjects = Array.isArray(catalogParsed.subjects) ? catalogParsed.subjects : [];
      if (!subjects.length) {
        return [
          '当前空间还没有注册主体。',
          `Subjects root: ${subjectsRoot}`,
          '如果用户提到具体人物、商品、场景，仍应优先查询主体库；若结果为空，再明确说明未找到。',
        ].join('\n');
      }

      const subjectNodes = subjects
        .slice(0, 200)
        .map((subject) => {
          const id = String(subject?.id || '').trim();
          const name = String(subject?.name || '').trim();
          const categoryId = String(subject?.categoryId || '').trim();
          const categoryName = categoryMap.get(categoryId) || (categoryId ? categoryId : '未分类');
          const tags = Array.isArray(subject?.tags) ? subject.tags.map((item) => String(item || '').trim()).filter(Boolean) : [];
          const attributeKeys = Array.isArray(subject?.attributes)
            ? subject.attributes.map((item) => String(item?.key || '').trim()).filter(Boolean)
            : [];
          const hasImages = Array.isArray(subject?.imagePaths) && subject.imagePaths.length > 0 ? 'true' : 'false';
          const location = id ? path.join(subjectsRoot, id, 'subject.json') : '';
          return [
            '  <subject>',
            `    <id>${id}</id>`,
            `    <name>${name}</name>`,
            `    <category>${categoryName}</category>`,
            `    <tags>${tags.join(', ')}</tags>`,
            `    <attribute_keys>${attributeKeys.join(', ')}</attribute_keys>`,
            `    <has_images>${hasImages}</has_images>`,
            `    <location>${location}</location>`,
            '  </subject>',
          ].join('\n');
        })
        .join('\n');

      return [
        'These subject names have reference materials in the current space.',
        'When the user mentions one of these names or a close combination of them, use `app_cli subjects search/get` before answering.',
        '<available_subjects>',
        subjectNodes,
        '</available_subjects>',
      ].join('\n');
    } catch (error) {
      return [
        `Subjects root: ${subjectsRoot}`,
        `读取主体索引失败: ${String(error)}`,
      ].join('\n');
    }
  }

  private async loadLongTermMemoryContext(): Promise<string> {
    try {
      return await getLongTermMemoryPrompt(40, this.workspacePathsOverride?.base);
    } catch (error) {
      console.warn('[PiChatService] Failed to load long-term memory:', error);
      return '';
    }
  }

  private async loadRedClawProjectContext(metadata: SessionMetadata): Promise<string> {
    if (metadata.contextType !== 'redclaw') return '';
    try {
      const [projectsPrompt, workboardPrompt] = await Promise.all([
        getRedClawProjectContextPrompt(10),
        getWorkItemStore().buildContextPrompt(10),
      ]);
      return [workboardPrompt, projectsPrompt].filter(Boolean).join('\n');
    } catch (error) {
      console.warn('[PiChatService] Failed to load RedClaw projects context:', error);
      return '';
    }
  }

  private buildSystemPrompt(
    workspacePaths: ReturnType<typeof getWorkspacePaths>,
    metadata: SessionMetadata,
    longTermMemory: string,
    redClawProjectContext: string,
    redClawProfileBundle?: RedClawProfilePromptBundle | null,
  ): string {
    const workspace = workspacePaths.base;
    const skillsXml = this.skillManager.getSkillsXml();
    const activeSkillContents = this.skillManager.getActiveSkillContents();
    const promptParts: string[] = [
      renderPrompt(PI_CHAT_SYSTEM_BASE_TEMPLATE, {
        available_tools: this.buildAvailableToolsSummary(),
        pi_documentation: this.buildPiDocumentationSection(workspacePaths, redClawProfileBundle),
        project_context: this.buildProjectContextSection(workspacePaths),
        skills_section: this.buildSkillsSection(skillsXml, activeSkillContents),
        subjects_section: this.buildSubjectsSection(workspacePaths),
        current_date: new Date().toISOString(),
        current_working_directory: workspace,
        workspace,
        platform: process.platform,
        workspace_root: workspacePaths.workspaceRoot,
        current_space_root: workspacePaths.base,
        skills_path: workspacePaths.skills,
        knowledge_path: workspacePaths.knowledge,
        knowledge_redbook_path: workspacePaths.knowledgeRedbook,
        knowledge_youtube_path: workspacePaths.knowledgeYoutube,
        advisors_path: workspacePaths.advisors,
        manuscripts_path: workspacePaths.manuscripts,
        media_path: workspacePaths.media,
        subjects_path: `${workspacePaths.base}/subjects`,
        redclaw_path: workspacePaths.redclaw,
        redclaw_profile_path: `${workspacePaths.redclaw}/profile`,
        memory_path: `${workspacePaths.base}/memory`,
      }),
    ];

    const mcpPromptSection = buildMcpPromptSection({
      maxVisibleServers: 4,
      maxChars: 1200,
      includeDiscoveryGuide: true,
    });
    if (mcpPromptSection) {
      promptParts.push('', mcpPromptSection);
    }

    if (longTermMemory) {
      promptParts.push(
        '',
        '## 用户长期记忆（文件存储）',
        '<long_term_memory>',
        this.truncate(longTermMemory, 12000),
        '</long_term_memory>',
        '回答应优先与长期记忆保持一致；若用户新指令与旧记忆冲突，以最新明确指令为准，并优先用 `app_cli` 的 `memory add` / `memory update` 子命令更新。',
      );
    }

    if (metadata.contextType === 'redclaw' && redClawProfileBundle) {
      promptParts.push(
        '',
        '## RedClaw 个性化档案（空间隔离）',
        `- ProfileRoot: ${redClawProfileBundle.profileRoot}`,
        '- 档案文件: Agent.md / Soul.md / identity.md / user.md / CreatorProfile.md',
        '<redclaw_agent_md>',
        this.truncate(redClawProfileBundle.files.agent || '', 6000),
        '</redclaw_agent_md>',
        '<redclaw_soul_md>',
        this.truncate(redClawProfileBundle.files.soul || '', 6000),
        '</redclaw_soul_md>',
        '<redclaw_identity_md>',
        this.truncate(redClawProfileBundle.files.identity || '', 4000),
        '</redclaw_identity_md>',
        '<redclaw_user_md>',
        this.truncate(redClawProfileBundle.files.user || '', 8000),
        '</redclaw_user_md>',
        '<redclaw_creator_profile_md>',
        this.truncate(redClawProfileBundle.files.creatorProfile || '', 10000),
        '</redclaw_creator_profile_md>',
        '文档职责与更新规则：',
        '- Agent.md：RedClaw 的工作契约、执行规则、标准流程。只有当用户明确要求修改 RedClaw 的工作方式、流程、约束、职责边界时才更新，避免为临时任务改写。',
        '- Soul.md：RedClaw 的协作语气、反馈风格、人格倾向。用户明确调整沟通风格、批判力度、表达方式时更新。',
        '- user.md：用户稳定画像与长期事实，例如目标、受众、内容赛道、发布节奏、成功指标。用户明确给出新的长期事实时更新。',
        '- CreatorProfile.md：用户长期自媒体定位与策略主档案，包括定位、目标群体、内容风格、商业目标、运营边界。用户明确给出这类长期变化时更新。',
        '- 如果只是一次性任务要求、单篇稿件偏好或临时实验，不要改这些长期文档；优先体现在当前任务执行里，必要时写入普通长期记忆。',
        '- 更新这些文档时，优先先读目标 Markdown 文件，再使用 `workspace(action="edit" ...)` 或 `workspace(action="write" ...)` 做精确修改。',
      );

      if (!redClawProfileBundle.onboardingState.completedAt && redClawProfileBundle.files.bootstrap) {
        promptParts.push(
          '',
          '## RedClaw 首次设定引导状态',
          `- completed: false`,
          `- stepIndex: ${redClawProfileBundle.onboardingState.stepIndex || 0}`,
          '<redclaw_bootstrap>',
          this.truncate(redClawProfileBundle.files.bootstrap, 3000),
          '</redclaw_bootstrap>',
          '当前空间尚未完成首次设定。优先完成偏好采集后再推进复杂任务。',
        );
      }
    }

    if (metadata.associatedFilePath) {
      promptParts.push(
        '',
        '## 当前会话绑定文件',
        `- 文件路径: ${metadata.associatedFilePath}`,
        '- 当用户要求分析/修改当前稿件时，优先围绕该文件操作。',
      );
      const packageAgentPrompt = this.buildPackageAgentPrompt(metadata);
      if (packageAgentPrompt) {
        promptParts.push('', packageAgentPrompt);
      }
      if (metadata.agentProfile && metadata.agentProfile !== 'default') {
        promptParts.push(`- 当前编辑 Agent: ${metadata.agentProfile}`);
      }
      if (metadata.associatedPackageKind) {
        promptParts.push(`- 当前工程类型: ${metadata.associatedPackageKind}`);
      }
      if (metadata.associatedPackageTitle) {
        promptParts.push(`- 当前工程标题: ${metadata.associatedPackageTitle}`);
      }
      if (typeof metadata.associatedPackageAssetCount === 'number') {
        promptParts.push(`- 已关联素材数: ${metadata.associatedPackageAssetCount}`);
      }
      if (typeof metadata.associatedPackageClipCount === 'number') {
        promptParts.push(`- 当前时间线片段数: ${metadata.associatedPackageClipCount}`);
      }
      if (Array.isArray(metadata.associatedPackageTrackNames) && metadata.associatedPackageTrackNames.length > 0) {
        promptParts.push(`- 当前轨道: ${metadata.associatedPackageTrackNames.join(', ')}`);
      }
      if (Array.isArray(metadata.associatedPackageClips) && metadata.associatedPackageClips.length > 0) {
        const clipLines = metadata.associatedPackageClips
          .slice(0, 12)
          .map((clip, index) => {
            const name = String(clip.name || clip.assetId || `片段 ${index + 1}`);
            const track = String(clip.track || 'unknown');
            const order = Number.isFinite(Number(clip.order)) ? `#${Number(clip.order)}` : `#${index}`;
            const duration = Number.isFinite(Number(clip.durationMs)) ? `${Number(clip.durationMs)}ms` : 'unknown';
            const enabled = clip.enabled === false ? 'disabled' : 'enabled';
            const trimIn = Number.isFinite(Number(clip.trimInMs)) ? `${Number(clip.trimInMs)}ms` : 'na';
            const trimOut = Number.isFinite(Number(clip.trimOutMs)) ? `${Number(clip.trimOutMs)}ms` : 'na';
            return `  - ${order} ${name} | track=${track} | duration=${duration} | trimIn=${trimIn} | trimOut=${trimOut} | ${enabled}`;
          });
        promptParts.push(
          '- 当前时间线片段摘要:',
          ...clipLines,
        );
      }
    }

    if (metadata.isContextBound && metadata.contextContent) {
      promptParts.push(
        '',
        '## 当前知识库上下文（重点）',
        `上下文类型: ${metadata.contextType || 'unknown'}`,
        `上下文ID: ${metadata.contextId || 'unknown'}`,
        '<knowledge_context>',
        this.truncate(metadata.contextContent, 12000),
        '</knowledge_context>',
        '回答时优先依据以上上下文，不要忽略。若上下文不足，再明确说明缺失信息。',
      );
    }

    if (metadata.contextType === 'redclaw') {
      promptParts.push(
        '',
        '## RedClaw 执行模式（自媒体 AI 工作台）',
        '- 你要以“目标->策略->文案->配图->发布计划->复盘”的流程推进，不要只给泛泛建议。',
        '- 处理 RedClaw 业务时，统一优先使用 `app_cli`，不要假设存在单独的 `redclaw_*` 业务工具。若不确定动作名，先 `app_cli(command="help redclaw")`。',
        '- RedClaw 的默认起手式不再是直接建项目；先查看或创建工作项：`app_cli(command="work ready")`、`app_cli(command="work create --title ... --type redclaw-note")`。',
        '- 只有满足以下任一条件时，才把工作项升级成 RedClaw 项目：需要持续多轮跟进、需要配图包/复盘闭环、需要后台自动化、用户明确要求建项目。升级时用 `app_cli(command="work promote-redclaw --id ...")`。',
        '- 工作推进过程中，要持续更新工作项状态与关联：例如 `work update --id ... --status active`、`work link --id ... --file-path ... --project-id ...`。',
        '- 默认优先单代理完成任务，不要因为任务比较正式就自动进入 planner / researcher / reviewer 流水线。',
        '- 只有在用户明确要求多人协作，或任务同时具备多阶段强依赖、严格验收、长期跟进、高风险保存/发布等特征时，才升级成多 subagent。',
        '- 一般性的单篇文案、单次改稿、一次性素材读取、简单保存，优先由当前代理直接完成。',
        '- reviewer 不是默认必经步骤；只有在明确需要独立复核、严格审校、发布前验收时，才应单独拉 reviewer。',
        '- 当用户要求定时执行、周期巡检、长期跟进、每天/每周推进时，不要只回答计划；要用 `work schedule-add` 或 `work cycle-add` 创建自动化工作项，并为复杂任务配置 `subagentRoles`。',
        '- 对复杂长周期任务，主代理负责调度和汇报，实际执行优先交给子角色链路，例如 `planner -> researcher -> copywriter -> reviewer` 或 `planner -> ops-coordinator -> reviewer`。',
        '- 若当前任务已经绑定了 RedClaw 项目，产出文案后必须调用 `app_cli(command="redclaw save-copy ...")` 保存标题候选、正文、标签、封面文案、发布计划。',
        '- 若当前任务已经绑定了 RedClaw 项目，产出配图策略后必须调用 `app_cli(command="redclaw save-image ...")` 保存封面图和多张配图提示词。',
        '- 若用户给出发布后数据，必须调用 `app_cli(command="redclaw save-retro ...")` 形成复盘并给出下一轮假设与动作。',
        '- 若当前任务没有明确 projectId，例如“根据随机漫步结果开始创作”，默认将完整稿件写入 `manuscripts/`，并使用 `app_cli(command="manuscripts write --path ...", payload={ content: "完整 markdown" })` 落盘。',
        '- 不能只在聊天里展示最终文案；完整内容产出后必须保存，并在回复中明确回显工具返回的真实保存路径。',
        '- 未收到工具成功返回前，禁止声称“已保存”“已写入稿件”“文件路径是 ...”。若保存失败或尚未执行，必须明确说明未保存。',
        '- 在继续历史任务前，可先调用 `app_cli(command="redclaw list")` 或 `app_cli(command="redclaw get --project-id ...")` 确认项目状态。',
        '- 当用户提到具体人物、商品、场景、道具、品牌款式时，先查询主体库：不确定命令时先 `app_cli(command="help subjects")`；通常先 `subjects search`，命中后再 `subjects get --id ...`。',
        '- 如果主体库没有结果，必须明确说未找到，不要自行臆测主体长相、服饰、商品款式或细节。',
        '- 当生图任务存在用户上传参考图、主体库图片、模板图、人物图、商品图时，必须优先使用 `app_cli(command="image generate ...")` 的参考图模式，不要退回纯文生图。',
        '- 若任务是在已有图片上加标题、加字、补局部元素、替换局部内容或延续上一张图做修改，必须优先使用 `image-to-image` 模式，并先确认上一张图的真实路径，再把该图片作为 `referenceImages` 传入。',
        '- 在 `image-to-image` 模式下，提示词只写“本次要修改的部分”；不要重新长篇描述整张图的风格、构图、氛围和主体，否则容易过拟合并破坏原图。',
        '- 当用户要求生成短视频、动态镜头、运镜片段、首尾帧过渡时，先加载 `redbox-video-director` 技能，再优先使用 `app_cli(command="video generate ...")`，不要把视频需求错误降级成静态图片。',
        '- 正式调用生视频工具前，必须先给用户一版视频脚本并等待确认；不要一上来直接生成视频。',
        '- 在脚本确认阶段，必须明确回显 `视频时长` 和 `视频比例`，让用户一起确认。',
        '- 视频脚本必须用 Markdown 表格展示，至少包含：`时间`、`画面`、`声音`、`景别` 四列。',
        '- 对多镜头视频、长上下文视频、多人/多主体视频、需要分镜图或需要反复修改的视频，默认先创建视频项目包：`app_cli(command="video project-create --title ... --duration ... --aspect-ratio ... --mode ...")`。',
        '- 视频项目包放在 `media/video-projects/<id>/` 下，至少要维护 `manifest.json`、`brief.md`、`script.md`。后续参考图、声音参考、关键帧、片段和成片都应尽量归档到同一个项目包里。',
        '- 创建项目包后，应把用户需求写入 `brief.md`，把确认后的脚本表格写入 `script.md`，并在后续回复中优先基于项目包内资料推进，而不是反复依赖超长聊天上下文。',
        '- 除非用户有明确要求，否则脚本里的单个镜头通常控制在 1 到 3 秒，单个镜头最长不得超过 5 秒。',
        '- 如果用户要求修改视频方案，先改表格脚本，再等待确认，不要跳过确认直接重生。',
        '- 只有当用户明确确认脚本后，才调用 `app_cli(command="video generate ...")`。',
        '- 如果需求简单且完整内容能稳定落在一个视频里，优先单视频模式；单个视频长度上限为 15 秒。',
        '- 如果需求复杂、镜头很多、场景切换频繁或叙事明显超出单视频稳定范围，应改用多视频模式：先拆成多个视频片段生成，再用 ffmpeg 工具按顺序拼接成最终成片。',
        '- RedBox 官方视频模式选择规则：无参考图时用 `text-to-video`，并且不要传 `referenceImages`；当任务是“参考这些图片中的主体、元素、风格、道具、场景线索来做视频”时，用 `reference-guided`，可传 1 到 5 张参考图；只有当用户明确强调起始状态、结束状态、首尾帧、从图A过渡到图B时，才用 `first-last-frame`，并按“首帧,尾帧”顺序传 2 张图。',
        '- RedBox 官方视频模型固定映射：`text-to-video -> wan2.7-t2v-video`，`reference-guided -> wan2.7-r2v-video`，`first-last-frame -> wan2.7-i2v-video`。不要自行改成别的视频模型。',
        '- 如果用户给了两张图，但意图只是“参考这两张图做视频”或“融合两张图元素”，不要直接用 `first-last-frame`；只有两张图分别承担首帧和尾帧语义时，才使用该模式。',
        '- 若当前模式不满足输入条件，必须明确说明原因；禁止静默改成别的模式后假装成功。',
        '- 当视频任务带有多张参考图或声音参考时，最终生成提示词必须先明确说明各参考资产的角色，例如“图1是人物主体，图2是场景氛围，音频1是人物声音参考”，再写镜头与动作描述。',
        '- 如果命中的主体带有声音参考，且当前视频模式支持音频条件输入，应优先把这条声音参考一并传入；不要擅自告诉用户“官方不支持上传声音参考”。',
        '- 只要本轮视频任务明确使用了主体库中的角色，就默认应当使用该角色的声音参考作为音频参考；除非用户明确要求不用，或明确指定使用别的声音。',
        '- 只要脚本存在多镜头、命名角色、重要环境、连续动作或明显的一致性风险，在脚本表格之后都必须主动询问用户：是否需要先使用生图工具生成分镜图/关键帧；不要等用户自己提起这一步。',
        '- 如果先生成了分镜图，后续视频生成应优先使用基于图片的模式，涉及明确起止过渡时优先 `first-last-frame`。',
        '- 一旦进入“先生成分镜图”的流程，必须先生成一张核心环境图。核心环境图必须是整体视图，包含完整空间布局、关键环境元素、主体站位、主要道具和光线逻辑，用来作为后续关键帧的环境锚点。',
        '- 使用生图工具生成视频关键帧时，必须先定义一份稳定的“人物锚点描述”和一份稳定的“环境锚点描述”，后续每一张关键帧都复用同一套描述语句，确保人物一致性和环境一致性。',
        '- 关键帧必须逐张生成，不要一次性并发生成多张易漂移的分镜图。先生成核心环境图，再让后续关键帧把核心环境图作为参考图，只描述该镜头相对于基线发生的变化。',
        '- 若已经创建视频项目包，调用 `image generate` 生成关键帧时应优先附带 `video-project-id`，让关键帧自动归档到项目包的 `keyframes/` 下。',
        '- 若已经创建视频项目包，生成出的关键帧、视频片段和最终成片都应继续归档回该项目包，保持同一项目下的资产、脚本、参考资料一致。',
        '- 若视频项目包里已经有关键帧，后续 `video generate` 应优先使用这些关键帧作为主视觉参考，不要继续把主体库人物图或商品图重复当成主要参考图；主体库此时主要用于声音参考或缺失角度补充。',
        '- 如果已经命中主体库且主体含图片，优先通过 `payload.subjectIds` 或 `referenceImages` 把主体图片传进生图工具。',
        '- 多图参考时，提示词必须明确写出“图1/图2/图3 各自代表什么”，例如：图1是人物主体，图2是商品主体，图3是场景氛围参考。',
        '- 若本轮生图调用有参考图，但工具返回 `referenceImageCount = 0`，不能宣称“已按参考图生成成功”，必须说明参考图没有真正带入。',
        '',
        '### RedClaw 自动化能力（强约束）',
        '- 你具备后台自动化能力：可以创建/修改/删除/执行 定时任务、长周期任务、心跳与后台轮询。',
        '- 当用户提出“在某时间提醒/报时/定时执行”这类请求时，禁止回答“我无法定时/无法主动发送消息”。必须通过 `app_cli` 配置自动化任务。',
        '- 标准流程：先 `app_cli(command="redclaw runner-status")` 检查后台状态；若未开启则 `app_cli(command="redclaw runner-start --interval 20")`；不确定自动化动作名时先 `app_cli(command="help redclaw")`，再用 `schedule-add`/`schedule-update` 完成任务。',
        '- 配置完成后必须回显：任务名、模式、时间（或间隔）、enabled 状态、nextRunAt（若工具有返回）。',
        '- 若任务实际回执可能写入任务会话，仍需在当前会话明确说明结果同步策略，避免用户误判“未执行”。',
      );
    }

    if (metadata.compactSummary) {
      console.log('[PiChatService] compact-memory-injected', {
        sessionId: this.sessionId,
        compactRounds: metadata.compactRounds || 1,
        compactUpdatedAt: metadata.compactUpdatedAt || '',
      });
      promptParts.push(
        '',
        '## 对话压缩记忆（自动维护）',
        `压缩轮次: ${metadata.compactRounds || 1}`,
        '<compact_memory>',
        this.truncate(metadata.compactSummary, 14000),
        '</compact_memory>',
        '你必须把该压缩记忆视为此前对话事实，与当前轮最近消息一起综合推理。',
      );
    }

    if (metadata.contextType === 'redclaw' && redClawProjectContext) {
      promptParts.push(
        '',
        '## RedClaw 最近项目',
        '<redclaw_projects>',
        this.truncate(redClawProjectContext, 8000),
        '</redclaw_projects>',
      );
    }

    return promptParts.join('\n');
  }

  private buildPackageAgentPrompt(metadata: SessionMetadata): string {
    if (metadata.agentProfile === 'video-editor') {
      return renderPrompt(PI_CHAT_VIDEO_EDITOR_TEMPLATE, {});
    }
    if (metadata.agentProfile === 'audio-editor') {
      return renderPrompt(PI_CHAT_AUDIO_EDITOR_TEMPLATE, {});
    }

    const associatedFilePath = String(metadata.associatedFilePath || '').trim().toLowerCase();
    if (associatedFilePath.endsWith('.redvideo') || metadata.associatedPackageKind === 'video') {
      return renderPrompt(PI_CHAT_VIDEO_EDITOR_TEMPLATE, {});
    }
    if (associatedFilePath.endsWith('.redaudio') || metadata.associatedPackageKind === 'audio') {
      return renderPrompt(PI_CHAT_AUDIO_EDITOR_TEMPLATE, {});
    }
    return '';
  }
}

export default PiChatService;
