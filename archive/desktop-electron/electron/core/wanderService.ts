import path from 'node:path';
import fs from 'node:fs/promises';
import {
    addChatMessage,
    createChatSession,
    getChatMessages,
    getChatSession,
    getSettings,
    getWorkspacePaths,
    saveWanderHistory,
    updateChatSessionMetadata,
} from '../db';
import { getAllKnowledgeItems, type WanderItem } from './knowledgeLoader';
import { resolveScopedModelName } from './modelScopeSettings';
import { normalizeApiBaseUrl, safeUrlJoin } from './urlUtils';
import { PiChatService } from '../pi/PiChatService';

type WanderBrainstormInternalResult = {
    content_direction: string;
    thinking_process?: string[];
    topic: {
        title: string;
        connections: number[];
    };
    options?: Array<{
        content_direction: string;
        topic: {
            title: string;
            connections: number[];
        };
    }>;
    selected_index?: number;
};

export type WanderRunOptions = {
    items?: WanderItem[];
    count?: number;
    multiChoice?: boolean;
    deepThink?: boolean;
    requestId?: string;
    persistHistory?: boolean;
    reportProgress?: (status: string) => void;
};

export type WanderRunResult = {
    requestId: string;
    items: WanderItem[];
    result: WanderBrainstormInternalResult;
    rawResult: string;
    historyId?: string;
};

export async function getRandomWanderItems(count = 3): Promise<WanderItem[]> {
    const items = await getAllKnowledgeItems();
    if (items.length <= count) {
        return items;
    }
    const shuffled = [...items];
    for (let i = shuffled.length - 1; i > 0; i -= 1) {
        const j = Math.floor(Math.random() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    return shuffled.slice(0, Math.max(1, Math.floor(count)));
}

function buildWanderItemsText(items: WanderItem[]): string {
    return items.map((item, index) => (
        `Item ${index + 1}:
Title: ${item.title}
Type: ${item.type}
Content Summary: ${item.content?.slice(0, 500) || ''}...`
    )).join('\n\n');
}

async function readTextFileSnippet(filePath: string, maxChars = 1800): Promise<string> {
    try {
        const raw = await fs.readFile(filePath, 'utf-8');
        return String(raw || '').trim().slice(0, maxChars);
    } catch {
        return '';
    }
}

function toTwoLinePreview(raw: string): string {
    const normalized = String(raw || '')
        .replace(/\r\n/g, '\n')
        .replace(/\r/g, '\n')
        .trim();
    if (!normalized) return '';
    const lines = normalized
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean);
    if (!lines.length) return '';
    const picked = lines.slice(0, 2).map((line) => (line.length > 120 ? `${line.slice(0, 120)}…` : line));
    const hasMore = lines.length > 2 || picked.some((line) => line.endsWith('…'));
    const joined = picked.join('\n');
    return hasMore && !joined.endsWith('…') ? `${joined}…` : joined;
}

async function buildWanderLongTermContext(): Promise<string> {
    const workspacePaths = getWorkspacePaths();
    const profileRoot = path.join(workspacePaths.redclaw, 'profile');
    const memoryPath = path.join(workspacePaths.base, 'memory', 'MEMORY.md');
    const userProfilePath = path.join(profileRoot, 'user.md');
    const creatorProfilePath = path.join(profileRoot, 'CreatorProfile.md');
    const soulPath = path.join(profileRoot, 'Soul.md');

    const [memorySnippet, userProfileSnippet, creatorProfileSnippet, soulSnippet] = await Promise.all([
        readTextFileSnippet(memoryPath, 2200),
        readTextFileSnippet(userProfilePath, 1800),
        readTextFileSnippet(creatorProfilePath, 2200),
        readTextFileSnippet(soulPath, 1200),
    ]);

    const sections: string[] = [];
    if (userProfileSnippet) sections.push(`### user.md\n${userProfileSnippet}`);
    if (creatorProfileSnippet) sections.push(`### CreatorProfile.md\n${creatorProfileSnippet}`);
    if (memorySnippet) sections.push(`### MEMORY.md\n${memorySnippet}`);
    if (soulSnippet) sections.push(`### Soul.md\n${soulSnippet}`);
    return sections.join('\n\n');
}

function buildWanderDeepAgentPrompt(params: {
    itemsText: string;
    longTermContextSection: string;
    multiChoice: boolean;
}): string {
    const outputRequirement = params.multiChoice
        ? [
            '硬性输出要求（多选题模式）：',
            '1) 仅输出 JSON，不要输出 Markdown、解释、前后缀文本；',
            '2) JSON 顶层必须包含：thinking_process, options；',
            '3) options 必须是长度为 3 的数组；',
            '4) 每个 option 必须包含：content_direction, topic；',
            '5) topic 必须包含：title, connections（数组，取值只能是 1-3）；',
            '6) thinking_process 为 3-6 条简洁思考要点。',
        ].join('\n')
        : [
            '硬性输出要求（单选题模式）：',
            '1) 仅输出 JSON，不要输出 Markdown、解释、前后缀文本；',
            '2) JSON 顶层必须包含：content_direction, thinking_process, topic；',
            '3) topic 必须包含：title, connections（数组，取值只能是 1-3）；',
            '4) thinking_process 为 3-6 条简洁思考要点；',
            '5) content_direction 必须是可直接创作的内容方向说明。',
        ].join('\n');

    return [
        '你现在处于 RedBox 的「漫步深度思考」Agent 模式。',
        '你需要自主完成：分析素材 -> 发散选题 -> 收敛方向 -> 产出最终结构化结果。',
        '你必须先调用工具补充上下文，再给结论。',
        '',
        '工具调用要求（必须满足）：',
        '1) 至少发起 1 次工具调用；',
        '2) 优先使用 app_cli 读取素材目录或相关文档；',
        '3) 如果 app_cli 不可用，可回退 bash（cat/rg/find 等）；',
        '4) 未发生工具调用时，不允许直接输出最终结论。',
        '',
        outputRequirement,
        '',
        '你收到的随机素材如下：',
        params.itemsText,
        '',
        params.longTermContextSection ? `补充上下文：\n${params.longTermContextSection}` : '',
    ].join('\n');
}

async function runWanderDeepThinkWithAgent(params: {
    requestId: string;
    items: WanderItem[];
    longTermContextSection: string;
    multiChoice: boolean;
    reportProgress?: (status: string) => void;
}): Promise<string> {
    const safeRequestId = params.requestId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64) || `${Date.now()}`;
    const sessionId = `session_wander_${safeRequestId}`;
    const contextId = `wander:${safeRequestId}`;
    const itemsText = buildWanderItemsText(params.items);
    const prompt = buildWanderDeepAgentPrompt({
        itemsText,
        longTermContextSection: params.longTermContextSection,
        multiChoice: params.multiChoice,
    });

    const existingSession = getChatSession(sessionId);
    const metadata = {
        contextId,
        contextType: 'redclaw',
        contextContent: itemsText,
        isContextBound: true,
    };
    if (!existingSession) {
        createChatSession(sessionId, 'Wander Deep Think', metadata);
    } else {
        updateChatSessionMetadata(sessionId, {
            ...(existingSession.metadata ? (() => {
                try {
                    return JSON.parse(existingSession.metadata);
                } catch {
                    return {};
                }
            })() : {}),
            ...metadata,
        });
    }

    const service = new PiChatService();
    let responseBuffer = '';
    let lastPreview = '';
    let lastToolName = '';
    let upstreamError = '';
    let sawAnyToolCall = false;
    let toolCallCount = 0;
    const startedAt = Date.now();
    params.reportProgress?.(params.multiChoice ? '多选题 Agent 已启动...' : '漫步 Agent 已启动...');

    addChatMessage({
        id: `msg_wander_user_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        session_id: sessionId,
        role: 'user',
        content: prompt,
    });

    const emitPreview = (raw: string) => {
        const preview = toTwoLinePreview(raw);
        if (!preview || preview === lastPreview) return;
        lastPreview = preview;
        params.reportProgress?.(preview);
    };

    service.setEventSink((channel, payload) => {
        if (channel === 'chat:thought-delta') {
            const text = String((payload as { content?: unknown } | null)?.content || '').trim();
            if (text) emitPreview(text);
            return;
        }
        if (channel === 'chat:tool-start') {
            const toolName = String((payload as { name?: unknown } | null)?.name || '').trim();
            sawAnyToolCall = true;
            toolCallCount += 1;
            lastToolName = toolName;
            if (toolName) params.reportProgress?.(`调用工具：${toolName}`);
            return;
        }
        if (channel === 'chat:tool-update') {
            const partial = String((payload as { partial?: unknown } | null)?.partial || '').trim();
            if (partial) emitPreview(partial);
            return;
        }
        if (channel === 'chat:tool-end') {
            if (lastToolName) params.reportProgress?.(`工具完成：${lastToolName}`);
            return;
        }
        if (channel === 'chat:response-chunk') {
            const chunk = String((payload as { content?: unknown } | null)?.content || '');
            if (!chunk) return;
            responseBuffer += chunk;
            emitPreview(responseBuffer);
            return;
        }
        if (channel === 'chat:error') {
            const data = payload as { message?: unknown; hint?: unknown; raw?: unknown } | null;
            const message = String(data?.message || '').trim();
            const hint = String(data?.hint || '').trim();
            const raw = String(data?.raw || '').trim();
            upstreamError = [message, hint, raw].filter(Boolean).join(' | ').slice(0, 2000);
            if (upstreamError) params.reportProgress?.(upstreamError);
        }
    });

    try {
        await service.sendMessage(prompt, sessionId);
        if (!sawAnyToolCall) {
            const retryPrompt = [
                '你上一轮没有调用工具，这不符合要求。',
                '请先调用至少 1 次工具（优先 app_cli）读取素材或文档，再重新输出最终 JSON。',
                '注意：最终回复仍然只能是 JSON。',
            ].join('\n');
            params.reportProgress?.('检测到未调用工具，正在触发强制工具轮次...');
            addChatMessage({
                id: `msg_wander_user_retry_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
                session_id: sessionId,
                role: 'user',
                content: retryPrompt,
            });
            await service.sendMessage(retryPrompt, sessionId);
        }
    } finally {
        service.setEventSink(null);
    }

    const assistantMessages = getChatMessages(sessionId)
        .filter((msg) => msg.role === 'assistant' && Number(msg.timestamp || 0) >= startedAt)
        .map((msg) => String(msg.content || '').trim())
        .filter(Boolean);
    const finalContent = assistantMessages.length > 0
        ? assistantMessages[assistantMessages.length - 1]
        : String(responseBuffer || '').trim();
    if (!finalContent) {
        if (upstreamError) throw new Error(upstreamError);
        throw new Error('深度思考未返回有效内容');
    }
    console.log('[wander:brainstorm][agent-mode] completed', {
        requestId: params.requestId,
        toolCallCount,
        sawAnyToolCall,
        responseLength: finalContent.length,
    });
    return finalContent;
}

function normalizeWanderConnections(raw: unknown): number[] {
    if (!Array.isArray(raw)) return [1];
    const normalized = raw
        .map((item) => Number(item))
        .filter((item) => Number.isFinite(item))
        .map((item) => Math.max(1, Math.min(3, Math.floor(item))));
    const unique = Array.from(new Set(normalized));
    return unique.length ? unique : [1];
}

function parseWanderJsonPayload(payload: string): Record<string, unknown> | null {
    const trimmed = String(payload || '').trim();
    if (!trimmed) return null;
    const stripCodeFence = (text: string) => text
        .replace(/^```json\s*/i, '')
        .replace(/^```\s*/i, '')
        .replace(/```$/i, '')
        .trim();
    const tryParse = (text: string) => {
        try {
            const parsed = JSON.parse(text) as unknown;
            return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
                ? parsed as Record<string, unknown>
                : null;
        } catch {
            return null;
        }
    };
    const direct = tryParse(trimmed);
    if (direct) return direct;
    const noFence = tryParse(stripCodeFence(trimmed));
    if (noFence) return noFence;
    const normalized = stripCodeFence(trimmed);
    const firstBrace = normalized.indexOf('{');
    const lastBrace = normalized.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
        return tryParse(normalized.slice(firstBrace, lastBrace + 1));
    }
    return null;
}

function normalizeWanderOption(raw: any): { content_direction: string; topic: { title: string; connections: number[] } } {
    const topic = raw?.topic && typeof raw.topic === 'object' ? raw.topic : {};
    const title = String(topic?.title || raw?.title || '').trim() || '未命名选题';
    const contentDirection = String(raw?.content_direction || raw?.direction || raw?.contentDirection || '').trim()
        || '围绕素材提炼一个可执行的内容方向。';
    return {
        content_direction: contentDirection,
        topic: {
            title,
            connections: normalizeWanderConnections(topic?.connections || raw?.connections),
        },
    };
}

function normalizeWanderResult(raw: any, multiChoice: boolean): WanderBrainstormInternalResult {
    const thinkingProcess = Array.isArray(raw?.thinking_process)
        ? raw.thinking_process.map((item: unknown) => String(item || '').trim()).filter(Boolean).slice(0, 6)
        : [];

    if (multiChoice) {
        const candidateOptions = Array.isArray(raw?.options)
            ? raw.options
            : Array.isArray(raw?.choices)
                ? raw.choices
                : [];
        const normalizedOptions = candidateOptions
            .map((item: unknown) => normalizeWanderOption(item))
            .filter((item: { content_direction: string; topic: { title: string } }) => Boolean(item.topic.title))
            .slice(0, 3);
        if (!normalizedOptions.length) {
            normalizedOptions.push(normalizeWanderOption(raw));
        }
        while (normalizedOptions.length < 3) {
            normalizedOptions.push({ ...normalizedOptions[normalizedOptions.length - 1] });
        }
        return {
            thinking_process: thinkingProcess,
            options: normalizedOptions,
            content_direction: normalizedOptions[0].content_direction,
            topic: normalizedOptions[0].topic,
            selected_index: 0,
        };
    }

    const single = normalizeWanderOption(raw);
    return {
        content_direction: single.content_direction,
        thinking_process: thinkingProcess,
        topic: single.topic,
    };
}

async function requestWanderCompletion(params: {
    baseURL: string;
    apiKey: string;
    model: string;
    temperature: number;
    messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
    requireJson?: boolean;
    allowJsonFallback?: boolean;
    enableThinking?: boolean;
    timeoutMs?: number;
    retryOnTimeout?: boolean;
    retryTimeoutMs?: number;
    streamPreview?: boolean;
    onProgress?: (previewText: string) => void;
}): Promise<string> {
    const sendRequest = async (withResponseFormat: boolean, effectiveTimeoutMs: number, useStream: boolean) => {
        const startedAt = Date.now();
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), effectiveTimeoutMs);
        const lower = `${params.model} ${params.baseURL}`.toLowerCase();
        const isQwenFamily = lower.includes('qwen') || lower.includes('dashscope.aliyuncs.com');
        const payload = {
            model: params.model,
            temperature: params.temperature,
            messages: params.messages,
            response_format: withResponseFormat ? { type: 'json_object' } : undefined,
            stream: useStream ? true : undefined,
            enable_thinking: isQwenFamily && typeof params.enableThinking === 'boolean' ? params.enableThinking : undefined,
        };

        const response = await fetch(safeUrlJoin(params.baseURL, '/chat/completions'), {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${params.apiKey}`,
            },
            body: JSON.stringify(payload),
            signal: controller.signal,
        }).catch((error) => {
            clearTimeout(timeout);
            if (controller.signal.aborted) {
                throw new Error(`OpenAI API timeout after ${effectiveTimeoutMs}ms`);
            }
            throw error;
        });
        clearTimeout(timeout);

        if (!response.ok) {
            const errorText = await response.text().catch(() => '');
            throw new Error(`OpenAI API error: ${response.status} ${response.statusText}${errorText ? ` - ${errorText}` : ''}`);
        }

        if (useStream) {
            if (!response.body) {
                throw new Error('OpenAI API stream response body is empty');
            }
            const reader = response.body.getReader();
            const decoder = new TextDecoder('utf-8');
            let buffered = '';
            let assembled = '';
            let lastEmitAt = 0;
            while (true) {
                const { value, done } = await reader.read();
                if (done) break;
                buffered += decoder.decode(value, { stream: true });
                const lines = buffered.split('\n');
                buffered = lines.pop() || '';
                for (const lineRaw of lines) {
                    const line = lineRaw.trim();
                    if (!line.startsWith('data:')) continue;
                    const chunk = line.slice(5).trim();
                    if (!chunk || chunk === '[DONE]') continue;
                    let parsed: any = null;
                    try {
                        parsed = JSON.parse(chunk);
                    } catch {
                        continue;
                    }
                    const delta = parsed?.choices?.[0]?.delta;
                    const content = typeof delta?.content === 'string'
                        ? delta.content
                        : Array.isArray(delta?.content)
                            ? delta.content.map((part: any) => typeof part?.text === 'string' ? part.text : '').join('')
                            : '';
                    if (!content) continue;
                    assembled += content;
                    const now = Date.now();
                    if (now - lastEmitAt > 280) {
                        lastEmitAt = now;
                        const preview = toTwoLinePreview(assembled);
                        if (preview) params.onProgress?.(preview);
                    }
                }
            }
            const finalPreview = toTwoLinePreview(assembled);
            if (finalPreview) params.onProgress?.(finalPreview);
            return assembled;
        }

        const data = await response.json() as { choices?: { message?: { content?: string } }[] };
        return data.choices?.[0]?.message?.content || '';
    };

    try {
        return await sendRequest(Boolean(params.requireJson), params.timeoutMs || 90000, Boolean(params.streamPreview));
    } catch (error) {
        const errorMessage = String(error || '');
        const timeoutMs = params.timeoutMs || 90000;
        const isTimeout = /timeout after \d+ms/i.test(errorMessage);
        const isResponseFormatUnsupported = /response[_\s-]?format|json_object|unsupported|not supported|invalid parameter/i.test(errorMessage);
        if (params.retryOnTimeout !== false && isTimeout) {
            const nextTimeoutMs = Math.max(params.retryTimeoutMs || timeoutMs, timeoutMs + 45000);
            return await sendRequest(Boolean(params.requireJson), nextTimeoutMs, Boolean(params.streamPreview));
        }
        if (params.requireJson && params.allowJsonFallback !== false && isResponseFormatUnsupported) {
            return await sendRequest(false, timeoutMs, Boolean(params.streamPreview));
        }
        if (params.streamPreview && /stream|sse|event-stream|not supported|invalid parameter/i.test(errorMessage)) {
            return await sendRequest(Boolean(params.requireJson), timeoutMs, false);
        }
        throw error;
    }
}

export async function runWanderBrainstorm(options: WanderRunOptions = {}): Promise<WanderRunResult> {
    const requestId = String(options.requestId || '').trim() || `wander-${Date.now()}`;
    const reportProgress = options.reportProgress;
    reportProgress?.('正在初始化漫步任务...');

    const settings = getSettings() as {
        api_key?: string;
        api_endpoint?: string;
        model_name?: string;
        model_name_wander?: string;
        wander_deep_think_enabled?: boolean;
    } | undefined;
    if (!settings?.api_key) {
        throw new Error('API Key not configured');
    }

    const items = Array.isArray(options.items) && options.items.length
        ? options.items
        : await getRandomWanderItems(options.count || 3);
    const baseURL = normalizeApiBaseUrl(settings.api_endpoint || 'https://api.openai.com/v1', 'https://api.openai.com/v1');
    const model = resolveScopedModelName((settings || {}) as Record<string, unknown>, 'wander', 'gpt-4o');
    const multiChoice = typeof options.multiChoice === 'boolean'
        ? options.multiChoice
        : typeof options.deepThink === 'boolean'
            ? options.deepThink
            : Boolean(settings.wander_deep_think_enabled);

    reportProgress?.(`已准备模型与参数（${model}）`);
    reportProgress?.(`已装载 ${items.length} 条随机素材`);
    reportProgress?.('正在加载用户档案与长期记忆...');

    const longTermContext = await buildWanderLongTermContext();
    const longTermContextSection = longTermContext
        ? `\n\n## 用户长期上下文（供你参考）\n${longTermContext}\n\n使用要求：\n- 与长期定位保持一致；\n- 若素材与长期定位冲突，优先选择可落地、可执行的方向。`
        : '';

    let rawResult = '';
    if (options.deepThink !== false) {
        rawResult = await runWanderDeepThinkWithAgent({
            requestId,
            items,
            longTermContextSection,
            multiChoice,
            reportProgress,
        });
    } else {
        const itemsText = buildWanderItemsText(items);
        const systemPrompt = [
            '你在执行 RedBox 的随机漫步任务。',
            multiChoice
                ? '请输出 3 个不同内容方向，最终只输出 JSON，字段包含 thinking_process 和 options。'
                : '请输出 1 个内容方向，最终只输出 JSON，字段包含 content_direction、thinking_process、topic。',
        ].join('\n');
        rawResult = await requestWanderCompletion({
            baseURL,
            apiKey: settings.api_key,
            model,
            temperature: 0.8,
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: `${itemsText}\n\n${longTermContextSection}` },
            ],
            requireJson: true,
            allowJsonFallback: true,
            enableThinking: false,
            streamPreview: true,
            onProgress: reportProgress,
        });
    }

    reportProgress?.('正在解析结果并写入历史...');
    let result: WanderBrainstormInternalResult;
    const parsedPayload = parseWanderJsonPayload(rawResult);
    result = parsedPayload
        ? normalizeWanderResult(parsedPayload, multiChoice)
        : normalizeWanderResult({ content_direction: rawResult }, multiChoice);

    let historyId: string | undefined;
    if (options.persistHistory !== false) {
        historyId = `wander-${Date.now()}`;
        saveWanderHistory(historyId, items, result);
    }
    reportProgress?.('漫步完成');

    return {
        requestId,
        items,
        result,
        rawResult,
        historyId,
    };
}
