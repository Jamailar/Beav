/**
 * DiscussionFlowService - 讨论流程控制服务
 *
 * 管理群聊中的讨论流程：
 * 1. 总监开场分析
 * 2. 成员随机顺序发言（每个人看到之前所有发言）
 * 3. 总监总结对比
 *
 * 当前版本已接入统一 runtime 事实层：
 * - room session
 * - task graph
 * - background task registry
 *
 * 群聊发言保持轻量单代理路径：
 * - 总监直接开场
 * - 每位成员各自完成一次 agent 工作流
 * - 总监直接总结
 * 不再在群聊中默认插入 planner / reviewer 子代理。
 */

import { EventEmitter } from 'events';
import { BrowserWindow } from 'electron';
import {
    addChatMessage,
    createChatSession,
    getChatSession,
} from '../../db';
import {
    DirectorAgent,
    createDirectorAgent,
    DIRECTOR_ID,
    DIRECTOR_NAME,
    DIRECTOR_AVATAR,
    type ConversationMessage,
    type DirectorConfig,
} from './DirectorAgent';
import {
    createAdvisorChatService,
    type AdvisorChatConfig,
} from '../AdvisorChatService';
import { getBackgroundTaskRegistry } from '../backgroundTaskRegistry';
import { resolveScopedModelName, type ModelScope } from '../modelScopeSettings';
import { normalizeApiBaseUrl } from '../urlUtils';
import { getAgentRuntime } from '../ai/agentRuntime';
import { getTaskGraphRuntime } from '../ai/taskGraphRuntime';
import type { SubagentOutput } from '../ai/subagentRuntime';
import type { IntentRoute, RoleId } from '../ai/types';

// ========== Types ==========

export interface DiscussionConfig {
    apiKey: string;
    baseURL: string;
    model: string;
    roomName?: string;
}

export interface AdvisorInfo {
    id: string;
    name: string;
    avatar: string;
    systemPrompt: string;
    knowledgeDir: string;
    knowledgeLanguage?: string;
}

export interface DiscussionMessage {
    id: string;
    role: 'user' | 'advisor' | 'director';
    advisorId?: string;
    advisorName?: string;
    advisorAvatar?: string;
    content: string;
    timestamp: string;
    phase?: 'introduction' | 'discussion' | 'summary';
}

type DiscussionRuntimeState = {
    sessionId: string;
    taskId: string | null;
    backgroundTaskId: string | null;
    route: IntentRoute | null;
    plannerOutput: SubagentOutput | null;
    shouldUseCoordinator: boolean;
};

type AdvisorAssignment = {
    advisorId: string;
    advisorName: string;
    task: string;
    order: number;
};

// ========== DiscussionFlowService Class ==========

export class DiscussionFlowService extends EventEmitter {
    private config: DiscussionConfig;
    private win: BrowserWindow | null;
    private abortController: AbortController | null = null;
    private currentRoomId: string | null = null;

    constructor(config: DiscussionConfig, win: BrowserWindow | null = null) {
        super();
        this.config = config;
        this.win = win;
    }

    private ensureRoomSession(roomId: string): string {
        const sessionId = `chatroom_${roomId}`;
        if (!getChatSession(sessionId)) {
            createChatSession(sessionId, this.config.roomName || `群聊 ${roomId}`, {
                contextType: 'chatroom',
                contextId: roomId,
            });
        }
        return sessionId;
    }

    private resolveLlmConfig() {
        const modelScope: ModelScope = 'chatroom';
        return {
            apiKey: this.config.apiKey,
            baseURL: normalizeApiBaseUrl(this.config.baseURL, 'https://api.openai.com/v1'),
            model: resolveScopedModelName({ model_name: this.config.model }, modelScope, this.config.model || 'gpt-4o'),
            timeoutMs: 45000,
        };
    }

    private buildDiscussionHistoryText(history: { role: 'user' | 'assistant'; content: string }[]): string {
        return history.map((item) => `${item.role === 'user' ? '用户' : '历史回复'}：${item.content}`).join('\n\n');
    }

    private async prepareDiscussionRuntime(params: {
        roomId: string;
        roomName: string;
        userMessage: string;
        advisors: AdvisorInfo[];
        isSixHatsMode: boolean;
        discussionGoal: string;
        historyContext: { role: 'user' | 'assistant'; content: string }[];
        fileContext?: { filePath: string; fileContent: string };
    }): Promise<DiscussionRuntimeState> {
        const sessionId = this.ensureRoomSession(params.roomId);
        addChatMessage({
            id: `chatroom_user_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
            session_id: sessionId,
            role: 'user',
            content: params.userMessage,
        });

        const routeAnalysis = getAgentRuntime().analyzeRuntimeContext({
            runtimeContext: {
                sessionId,
                runtimeMode: 'chatroom',
                userInput: params.userMessage,
                metadata: {
                    contextType: 'chatroom',
                    contextId: params.roomId,
                    roomName: params.roomName,
                    discussionGoal: params.discussionGoal,
                    advisorCount: params.advisors.length,
                    advisorNames: params.advisors.map((advisor) => advisor.name),
                    isSixHatsMode: params.isSixHatsMode,
                    filePath: params.fileContext?.filePath,
                },
            },
        });

        const task = getTaskGraphRuntime().createInteractiveTask({
            runtimeMode: 'chatroom',
            ownerSessionId: sessionId,
            userInput: params.userMessage,
            route: routeAnalysis.route,
            roleId: routeAnalysis.role.roleId as RoleId,
            metadata: {
                roomId: params.roomId,
                roomName: params.roomName,
                discussionGoal: params.discussionGoal,
                advisorIds: params.advisors.map((advisor) => advisor.id),
                filePath: params.fileContext?.filePath,
            },
        });

        const runtime = getTaskGraphRuntime();
        runtime.startNode(task.id, 'route', `intent=${routeAnalysis.route.intent}`);
        runtime.completeNode(task.id, 'route', `intent=${routeAnalysis.route.intent}`);

        const backgroundTask = await getBackgroundTaskRegistry().registerTask({
            kind: 'headless-runtime',
            title: `Chatroom · ${params.roomName || params.discussionGoal || params.userMessage.slice(0, 40)}`,
            contextId: params.roomId,
            sessionId,
        });
        await getBackgroundTaskRegistry().attachSession(backgroundTask.id, sessionId);
        await getBackgroundTaskRegistry().appendTurn(backgroundTask.id, {
            source: 'system',
            text: '[chatroom] discussion orchestration started',
        });

        const plannerOutput: SubagentOutput | null = null;
        const shouldUseCoordinator = false;
        if (runtime.getTask(task.id)?.graph.some((node) => node.type === 'plan')) {
            runtime.skipNode(task.id, 'plan', 'chatroom fast-path: director starts immediately');
        }

        return {
            sessionId,
            taskId: task.id,
            backgroundTaskId: backgroundTask.id,
            route: routeAnalysis.route,
            plannerOutput,
            shouldUseCoordinator,
        };
    }

    private parseDirectorAssignments(directorIntro: string, advisors: AdvisorInfo[]): AdvisorAssignment[] {
        const lines = String(directorIntro || '')
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter(Boolean);
        const assignments: AdvisorAssignment[] = [];
        const seen = new Set<string>();

        for (const [index, line] of lines.entries()) {
            const normalizedLine = line
                .replace(/^[-*•\d.\)\s]+/, '')
                .replace(/\*\*/g, '')
                .replace(/`/g, '')
                .trim();
            for (const advisor of advisors) {
                if (seen.has(advisor.id)) continue;
                const escapedName = advisor.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                const match = normalizedLine.match(new RegExp(`(?:^|\\s)@?${escapedName}\\s*[：:]\\s*(.+)$`, 'i'));
                if (!match) continue;
                const task = String(match[1] || '').trim();
                if (!task) continue;
                assignments.push({
                    advisorId: advisor.id,
                    advisorName: advisor.name,
                    task,
                    order: index,
                });
                seen.add(advisor.id);
            }
        }

        return assignments.sort((left, right) => left.order - right.order);
    }

    private completeDirectorAssignments(
        assignments: AdvisorAssignment[],
        advisors: AdvisorInfo[],
        userMessage: string,
        discussionGoal: string,
    ): AdvisorAssignment[] {
        if (assignments.length >= advisors.length) {
            return assignments;
        }

        const focus = discussionGoal || userMessage;
        const fallbackTemplates = [
            '先判断这个问题最关键的根因，并给出你最明确的结论；期望产出：结论 + 2条判断依据。',
            '从你的专业视角给出最值得执行的策略；期望产出：行动方案或步骤清单。',
            '把执行层细节说清楚；期望产出：可直接落地的操作建议、脚本方向或话术框架。',
            '补充风险、边界和最容易翻车的地方；期望产出：风险清单 + 规避建议。',
            '给出验证方式和复盘指标；期望产出：判断成效的方法 + 下一步。',
        ];
        const completed = [...assignments];
        const seen = new Set(assignments.map((item) => item.advisorId));

        advisors.forEach((advisor, index) => {
            if (seen.has(advisor.id)) {
                return;
            }
            const template = fallbackTemplates[index % fallbackTemplates.length];
            completed.push({
                advisorId: advisor.id,
                advisorName: advisor.name,
                task: `${template} 所有内容都必须围绕“${focus}”。如果你有自己的知识库，先检索再回答。`,
                order: assignments.length + index,
            });
        });

        return completed.sort((left, right) => left.order - right.order);
    }

    private orderAdvisorsByAssignments(advisors: AdvisorInfo[], assignments: AdvisorAssignment[]): AdvisorInfo[] {
        if (!assignments.length) {
            return this.shuffleArray([...advisors]);
        }

        const advisorMap = new Map(advisors.map((advisor) => [advisor.id, advisor]));
        const ordered: AdvisorInfo[] = [];
        const seen = new Set<string>();

        for (const assignment of assignments) {
            const advisor = advisorMap.get(assignment.advisorId);
            if (!advisor || seen.has(advisor.id)) continue;
            ordered.push(advisor);
            seen.add(advisor.id);
        }

        for (const advisor of advisors) {
            if (seen.has(advisor.id)) continue;
            ordered.push(advisor);
        }

        return ordered;
    }

    private async finalizeDiscussionRuntime(params: {
        taskId: string | null;
        backgroundTaskId: string | null;
        sessionId: string;
        userMessage: string;
        discussionGoal: string;
        plannerOutput: SubagentOutput | null;
        conversationHistory: ConversationMessage[];
        summaryMessage?: string;
        fileContext?: { filePath: string; fileContent: string };
    }): Promise<void> {
        if (!params.taskId || !params.backgroundTaskId) {
            return;
        }

        const runtime = getTaskGraphRuntime();
        const backgroundRegistry = getBackgroundTaskRegistry();
        const task = runtime.getTask(params.taskId);

        if (params.summaryMessage) {
            addChatMessage({
                id: `chatroom_summary_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
                session_id: params.sessionId,
                role: 'assistant',
                content: params.summaryMessage,
            });
        }

        if (task?.graph.some((node) => node.type === 'review')) {
            runtime.skipNode(params.taskId, 'review', 'chatroom fast-path: no reviewer in group discussion');
        }

        if (task?.graph.some((node) => node.type === 'save_artifact')) {
            runtime.completeNode(params.taskId, 'save_artifact', 'chatroom discussion persisted');
        }
        runtime.completeTask(params.taskId, 'Chatroom discussion completed');
        await backgroundRegistry.completeTask(params.backgroundTaskId, params.summaryMessage?.slice(0, 240) || 'Chatroom discussion completed');
    }

    /**
     * 执行完整的讨论流程
     * @param isSixHatsMode 是否为六顶思考帽模式（按固定顺序，无总监）
     * @param discussionGoal 群聊目标（所有成员围绕此目标讨论）
     */
    async orchestrateDiscussion(
        roomId: string,
        userMessage: string,
        advisors: AdvisorInfo[],
        existingHistory: DiscussionMessage[] = [],
        isSixHatsMode: boolean = false,
        discussionGoal: string = '',
        fileContext?: { filePath: string; fileContent: string }
    ): Promise<DiscussionMessage[]> {
        this.abortController = new AbortController();
        this.currentRoomId = roomId;
        const newMessages: DiscussionMessage[] = [];
        const conversationHistory: ConversationMessage[] = [];

        if (!isSixHatsMode) {
            this.sendToFrontend('creative-chat:advisor-start', {
                advisorId: DIRECTOR_ID,
                advisorName: DIRECTOR_NAME,
                advisorAvatar: DIRECTOR_AVATAR,
                phase: 'introduction',
            });
            this.sendToFrontend('creative-chat:thinking', {
                advisorId: DIRECTOR_ID,
                advisorName: DIRECTOR_NAME,
                advisorAvatar: DIRECTOR_AVATAR,
                type: 'thinking_chunk',
                content: '总监已收到问题，正在快速定调...',
            });
        }

        const historyContext = existingHistory.map(msg => {
            if (msg.role === 'user') {
                return { role: 'user' as const, content: msg.content };
            } else if (msg.role === 'director') {
                return { role: 'assistant' as const, content: `[总监]：${msg.content}` };
            } else if (msg.role === 'advisor') {
                return { role: 'assistant' as const, content: `[${msg.advisorName || '顾问'}]：${msg.content}` };
            }
            return null;
        }).filter(Boolean) as { role: 'user' | 'assistant'; content: string }[];

        const runtimeContext = await this.prepareDiscussionRuntime({
            roomId,
            roomName: this.config.roomName || discussionGoal || roomId,
            userMessage,
            advisors,
            isSixHatsMode,
            discussionGoal,
            historyContext,
            fileContext,
        });

        try {
            const advisorNames = advisors.map(a => a.name);
            const coordinationBrief = runtimeContext.plannerOutput?.summary || runtimeContext.plannerOutput?.handoff;

            if (isSixHatsMode) {
                for (let i = 0; i < advisors.length; i++) {
                    const advisor = advisors[i];
                    if (this.abortController?.signal.aborted) break;

                    const fullHistory = [
                        ...historyContext,
                        { role: 'user' as const, content: userMessage },
                        ...conversationHistory
                            .filter(m => m.role === 'assistant')
                            .map(m => ({
                                role: 'assistant' as const,
                                content: `[${m.advisorName}的观点]\n${m.content}`,
                            })),
                    ];

                    const response = await this.advisorSpeak(
                        advisor,
                        userMessage,
                        fullHistory,
                        discussionGoal,
                        fileContext,
                        coordinationBrief,
                    );

                    const advisorMessage: DiscussionMessage = {
                        id: `msg_${Date.now()}_${advisor.id}`,
                        role: 'advisor',
                        advisorId: advisor.id,
                        advisorName: advisor.name,
                        advisorAvatar: advisor.avatar,
                        content: response,
                        timestamp: new Date().toISOString(),
                        phase: 'discussion',
                    };
                    newMessages.push(advisorMessage);
                    addChatMessage({
                        id: `chatroom_advisor_${advisor.id}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
                        session_id: runtimeContext.sessionId,
                        role: 'assistant',
                        content: `[${advisor.name}]\n${response}`,
                    });
                    conversationHistory.push({
                        role: 'assistant',
                        advisorId: advisor.id,
                        advisorName: advisor.name,
                        content: response,
                    });

                    if (runtimeContext.taskId && runtimeContext.backgroundTaskId) {
                        getTaskGraphRuntime().addTrace(runtimeContext.taskId, 'chatroom.advisor.completed', {
                            advisorId: advisor.id,
                            advisorName: advisor.name,
                            summary: response.slice(0, 300),
                        }, 'spawn_agents');
                        await getBackgroundTaskRegistry().appendTurn(runtimeContext.backgroundTaskId, {
                            source: 'response',
                            text: `[${advisor.name}] ${response.slice(0, 240)}`,
                        });
                    }
                }

                await this.finalizeDiscussionRuntime({
                    taskId: runtimeContext.taskId,
                    backgroundTaskId: runtimeContext.backgroundTaskId,
                    sessionId: runtimeContext.sessionId,
                    userMessage,
                    discussionGoal,
                    plannerOutput: runtimeContext.plannerOutput,
                    conversationHistory,
                    fileContext,
                });
                this.emit('discussion_complete', { roomId, messages: newMessages });
                return newMessages;
            }

            const directorIntro = await this.directorIntroduction(
                userMessage,
                advisorNames,
                discussionGoal,
                historyContext,
                fileContext,
                coordinationBrief,
            );
            const parsedAssignments = this.completeDirectorAssignments(
                this.parseDirectorAssignments(directorIntro, advisors),
                advisors,
                userMessage,
                discussionGoal,
            );

            const introMessage: DiscussionMessage = {
                id: `msg_${Date.now()}_director_intro`,
                role: 'director',
                advisorId: DIRECTOR_ID,
                advisorName: DIRECTOR_NAME,
                advisorAvatar: DIRECTOR_AVATAR,
                content: directorIntro,
                timestamp: new Date().toISOString(),
                phase: 'introduction',
            };
            newMessages.push(introMessage);
            addChatMessage({
                id: `chatroom_director_intro_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
                session_id: runtimeContext.sessionId,
                role: 'assistant',
                content: `[总监开场]\n${directorIntro}`,
            });
            conversationHistory.push({
                role: 'director',
                advisorId: DIRECTOR_ID,
                advisorName: DIRECTOR_NAME,
                content: directorIntro,
            });

            if (runtimeContext.taskId && runtimeContext.backgroundTaskId) {
                getTaskGraphRuntime().addTrace(runtimeContext.taskId, 'chatroom.director.introduction', {
                    summary: directorIntro.slice(0, 300),
                }, 'plan');
                await getBackgroundTaskRegistry().appendTurn(runtimeContext.backgroundTaskId, {
                    source: 'response',
                    text: `[总监] ${directorIntro.slice(0, 240)}`,
                });
            }

            const orderedAdvisors = this.orderAdvisorsByAssignments(advisors, parsedAssignments);
            if (runtimeContext.taskId && getTaskGraphRuntime().getTask(runtimeContext.taskId)?.graph.some((node) => node.type === 'spawn_agents')) {
                getTaskGraphRuntime().startNode(runtimeContext.taskId, 'spawn_agents', `room speakers=${orderedAdvisors.map((item) => item.name).join('、')}`);
            }

            for (const advisor of orderedAdvisors) {
                if (this.abortController?.signal.aborted) break;
                const assignment = parsedAssignments.find((item) => item.advisorId === advisor.id)?.task || '';

                const fullHistory = [
                    ...historyContext,
                    { role: 'user' as const, content: userMessage },
                    { role: 'assistant' as const, content: `[总监分析]\n${directorIntro}` },
                    ...(assignment ? [{ role: 'assistant' as const, content: `[总监给${advisor.name}的分工]\n${assignment}` }] : []),
                    ...conversationHistory
                        .filter(m => m.role === 'assistant')
                        .map(m => ({
                            role: 'assistant' as const,
                            content: `[${m.advisorName}的观点]\n${m.content}`,
                        })),
                ];

                const response = await this.advisorSpeak(
                    advisor,
                    userMessage,
                        fullHistory,
                        discussionGoal,
                        fileContext,
                        coordinationBrief,
                        assignment,
                    );

                const advisorMessage: DiscussionMessage = {
                    id: `msg_${Date.now()}_${advisor.id}`,
                    role: 'advisor',
                    advisorId: advisor.id,
                    advisorName: advisor.name,
                    advisorAvatar: advisor.avatar,
                    content: response,
                    timestamp: new Date().toISOString(),
                    phase: 'discussion',
                };
                newMessages.push(advisorMessage);
                addChatMessage({
                    id: `chatroom_advisor_${advisor.id}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
                    session_id: runtimeContext.sessionId,
                    role: 'assistant',
                    content: `[${advisor.name}]\n${response}`,
                });
                conversationHistory.push({
                    role: 'assistant',
                    advisorId: advisor.id,
                    advisorName: advisor.name,
                    content: response,
                });

                if (runtimeContext.taskId && runtimeContext.backgroundTaskId) {
                    getTaskGraphRuntime().addTrace(runtimeContext.taskId, 'chatroom.advisor.completed', {
                        advisorId: advisor.id,
                        advisorName: advisor.name,
                        summary: response.slice(0, 300),
                    }, 'spawn_agents');
                    await getBackgroundTaskRegistry().appendTurn(runtimeContext.backgroundTaskId, {
                        source: 'response',
                        text: `[${advisor.name}] ${response.slice(0, 240)}`,
                    });
                }
            }

            if (runtimeContext.taskId && getTaskGraphRuntime().getTask(runtimeContext.taskId)?.graph.some((node) => node.type === 'spawn_agents')) {
                getTaskGraphRuntime().completeNode(runtimeContext.taskId, 'spawn_agents', `room advisors=${orderedAdvisors.map((item) => item.name).join('、')}`);
            }

            if (!this.abortController?.signal.aborted) {
                const directorSummary = await this.directorSummarize(
                    userMessage,
                    conversationHistory,
                    discussionGoal,
                    fileContext,
                    coordinationBrief,
                );

                const summaryMessage: DiscussionMessage = {
                    id: `msg_${Date.now()}_director_summary`,
                    role: 'director',
                    advisorId: DIRECTOR_ID,
                    advisorName: DIRECTOR_NAME,
                    advisorAvatar: DIRECTOR_AVATAR,
                    content: directorSummary,
                    timestamp: new Date().toISOString(),
                    phase: 'summary',
                };
                newMessages.push(summaryMessage);

                await this.finalizeDiscussionRuntime({
                    taskId: runtimeContext.taskId,
                    backgroundTaskId: runtimeContext.backgroundTaskId,
                    sessionId: runtimeContext.sessionId,
                    userMessage,
                    discussionGoal,
                    plannerOutput: runtimeContext.plannerOutput,
                    conversationHistory,
                    summaryMessage: directorSummary,
                    fileContext,
                });
            }

            this.emit('discussion_complete', { roomId, messages: newMessages });
            return newMessages;

        } catch (error) {
            if (runtimeContext.taskId) {
                getTaskGraphRuntime().failTask(runtimeContext.taskId, error instanceof Error ? error.message : String(error));
            }
            if (runtimeContext.backgroundTaskId) {
                void getBackgroundTaskRegistry().failTask(runtimeContext.backgroundTaskId, error instanceof Error ? error.message : String(error));
            }
            this.emit('discussion_error', { roomId, error });
            throw error;
        } finally {
            this.abortController = null;
            this.currentRoomId = null;
        }
    }

    /**
     * 总监开场分析
     */
    private async directorIntroduction(
        userMessage: string,
        advisorNames: string[],
        discussionGoal: string = '',
        historyContext: { role: 'user' | 'assistant'; content: string }[] = [],
        fileContext?: { filePath: string; fileContent: string },
        coordinationBrief?: string,
    ): Promise<string> {
        const directorConfig: DirectorConfig = {
            apiKey: this.config.apiKey,
            baseURL: this.config.baseURL,
            model: this.config.model,
            temperature: 0.7,
        };

        const director = createDirectorAgent(directorConfig);
        director.on('event', (event) => {
            this.forwardEventToFrontend('director', event);
        });

        return await director.introduceDiscussion(userMessage, advisorNames, discussionGoal, historyContext, fileContext, coordinationBrief);
    }

    /**
     * 成员发言
     */
    private async advisorSpeak(
        advisor: AdvisorInfo,
        userMessage: string,
        history: { role: 'user' | 'assistant'; content: string }[],
        discussionGoal: string = '',
        fileContext?: { filePath: string; fileContent: string },
        coordinationBrief?: string,
        assignment: string = '',
    ): Promise<string> {
        const advisorConfig: AdvisorChatConfig = {
            apiKey: this.config.apiKey,
            baseURL: this.config.baseURL,
            model: this.config.model,
            advisorId: advisor.id,
            advisorName: advisor.name,
            advisorAvatar: advisor.avatar,
            systemPrompt: this.enhanceSystemPrompt(advisor.systemPrompt, history, discussionGoal, fileContext, coordinationBrief, assignment),
            knowledgeDir: advisor.knowledgeDir,
            knowledgeLanguage: advisor.knowledgeLanguage,
            maxTurns: 3,
            temperature: 0.7,
        };

        const advisorService = createAdvisorChatService(advisorConfig);
        advisorService.on('event', (event) => {
            this.forwardEventToFrontend('advisor', event);
        });

        this.sendToFrontend('creative-chat:advisor-start', {
            advisorId: advisor.id,
            advisorName: advisor.name,
            advisorAvatar: advisor.avatar,
            phase: 'discussion',
        });

        const ragQuery = [
            `用户问题：${userMessage}`,
            discussionGoal ? `群聊目标：${discussionGoal}` : '',
            assignment ? `我的分工：${assignment}` : '',
            fileContext?.filePath ? `当前文件：${fileContext.filePath}` : '',
            `成员身份：${advisor.name}`,
        ].filter(Boolean).join('\n');

        return await advisorService.sendMessage(userMessage, history, {
            ragQuery,
            discussionTask: assignment
                ? `总监给你的分工：${assignment}`
                : `请围绕群聊目标“${discussionGoal || userMessage}”从你的专业视角补充关键判断。`,
        });
    }

    /**
     * 总监总结
     */
    private async directorSummarize(
        userMessage: string,
        conversationHistory: ConversationMessage[],
        discussionGoal: string = '',
        fileContext?: { filePath: string; fileContent: string },
        coordinationBrief?: string,
    ): Promise<string> {
        const directorConfig: DirectorConfig = {
            apiKey: this.config.apiKey,
            baseURL: this.config.baseURL,
            model: this.config.model,
            temperature: 0.7,
        };

        const director = createDirectorAgent(directorConfig);
        director.on('event', (event) => {
            this.forwardEventToFrontend('director', event);
        });

        this.sendToFrontend('creative-chat:advisor-start', {
            advisorId: DIRECTOR_ID,
            advisorName: DIRECTOR_NAME,
            advisorAvatar: DIRECTOR_AVATAR,
            phase: 'summary',
        });

        return await director.summarizeDiscussion(userMessage, conversationHistory, discussionGoal, fileContext, coordinationBrief);
    }

    /**
     * 增强系统提示词，加入上下文感知和群聊目标
     */
    private enhanceSystemPrompt(
        basePrompt: string,
        history: { role: 'user' | 'assistant'; content: string }[],
        discussionGoal: string = '',
        fileContext?: { filePath: string; fileContent: string },
        coordinationBrief?: string,
        assignment: string = '',
    ): string {
        let prompt = basePrompt;

        if (fileContext) {
            prompt += `\n\n## 当前文件上下文\n文件名: ${fileContext.filePath}\n内容:\n\`\`\`\n${fileContext.fileContent}\n\`\`\``;
        }
        if (coordinationBrief) {
            prompt += `\n\n## 协调规划\n请在发言时参考这份讨论框架，但保留你的角色特色：\n${coordinationBrief}`;
        }
        if (assignment) {
            prompt += `\n\n## 总监分工\n你本轮必须优先完成这项任务：\n${assignment}`;
        }

        const contextInfo = history.length > 1
            ? `\n\n## 讨论上下文\n\n在你之前，已有其他成员发表了观点。请参考他们的观点，提出你独特的见解，可以补充、支持或提出不同看法。`
            : '';

        const goalInfo = discussionGoal
            ? `\n\n## 🎯 群聊目标\n\n本次讨论的核心目标是：**${discussionGoal}**\n\n请务必围绕此目标展开分析和讨论，你的所有观点和建议都应该服务于这个目标。`
            : '';

        const isSixHatsMode = basePrompt.includes('六顶思考帽');

        if (isSixHatsMode) {
            return `${prompt}${goalInfo}${contextInfo}

## 重要提示
- 你是群聊讨论中的一员，请根据你的帽子角色发表观点
- **紧扣目标**：你的分析必须围绕群聊目标"${discussionGoal || '用户提出的问题'}"展开
- **主动使用工具**：当需要数据支撑、案例佐证时，请使用可用的联网能力进行检索
- **深度思考**：按照你的"深度思考流程"逐步分析
- 如果有其他帽子的观点，请适当回应或对比
- 突出你的独特视角，与其他帽子形成互补`;
        }

        return `${prompt}${goalInfo}${contextInfo}

# 核心指令 (Core Directive)
你不是一个只会搜索资料的AI，你是一个有血有肉的**行业专家**。
1. **拒绝平庸**：不要给出那种"正确的废话"。如果用户的想法很烂，请用符合你性格的方式（委婉或犀利）指出来。
2. **第一人称**：所有观点必须带入"我"的视角（"我看过很多类似的号..."，"我觉得..."）。
3. **经验内化**：你即将收到的【参考资料/知识库】是你的**过往经验**。不要说"根据资料显示"，要说"根据我的经验"。
4. **行动导向**：不要只分析问题，要给方案。
5. **服从分工**：如果总监已经给你明确任务，你必须先把这项任务回答清楚，不要偏题。

# 语言风格
口语化，像在微信群里聊天。禁止使用"综上所述"、"总而言之"等翻译腔。`;
    }

    private shuffleArray<T>(array: T[]): T[] {
        const shuffled = [...array];
        for (let i = shuffled.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
        }
        return shuffled;
    }

    private forwardEventToFrontend(source: 'director' | 'advisor', event: any): void {
        switch (event.type) {
            case 'thinking_start':
            case 'thinking_chunk':
            case 'thinking_end':
                this.sendToFrontend('creative-chat:thinking', {
                    advisorId: event.advisorId,
                    advisorName: event.advisorName,
                    advisorAvatar: event.advisorAvatar,
                    type: event.type,
                    content: event.content,
                });
                break;

            case 'rag_start':
            case 'rag_result':
                this.sendToFrontend('creative-chat:rag', {
                    advisorId: event.advisorId,
                    type: event.type,
                    content: event.content,
                    sources: event.sources,
                });
                break;

            case 'tool_start':
            case 'tool_end':
                this.sendToFrontend('creative-chat:tool', {
                    advisorId: event.advisorId,
                    type: event.type,
                    tool: event.tool,
                });
                break;

            case 'response_chunk':
                this.sendToFrontend('creative-chat:stream', {
                    advisorId: event.advisorId,
                    advisorName: event.advisorName,
                    advisorAvatar: event.advisorAvatar,
                    content: event.content,
                    done: false,
                });
                break;

            case 'response_end':
                this.sendToFrontend('creative-chat:stream', {
                    advisorId: event.advisorId,
                    advisorName: event.advisorName,
                    advisorAvatar: event.advisorAvatar,
                    content: event.content || '',
                    done: true,
                });
                break;

            case 'error':
                console.error(`[${source}] Error:`, event.content);
                break;
        }
    }

    private sendToFrontend(channel: string, data: any): void {
        const payload = this.currentRoomId ? { ...data, roomId: this.currentRoomId } : data;
        this.win?.webContents.send(channel, payload);
    }

    cancel(): void {
        if (this.abortController) {
            this.abortController.abort();
        }
    }
}

export function createDiscussionFlowService(
    config: DiscussionConfig,
    win: BrowserWindow | null = null,
): DiscussionFlowService {
    return new DiscussionFlowService(config, win);
}
