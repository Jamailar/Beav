import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { Bot, Image as ImageIcon, Loader2, MessageSquarePlus, Heart, Plus, Sparkles, SlidersHorizontal, X } from 'lucide-react';
import { clsx } from 'clsx';
import { Chat } from './Chat';
import { AdvisorModal, type Advisor, type AdvisorProfile } from './Advisors';
import { TeamWorkbench } from './team-workbench/TeamWorkbench';
import type { TeamWorkbenchSession } from './team-workbench/teamWorkbenchTypes';
import type { PendingChatMessage } from '../App';
import { type ChatMessageLinkKind, type ChatMessageLinkTarget } from '../components/MessageItem';
import { useMediaJobSubscription } from '../features/media-jobs/useMediaJobSubscription';
import { useMediaJobsStore } from '../features/media-jobs/useMediaJobsStore';
import { isMediaJobTerminal, isMediaJobSuccessful, type MediaJobProjection } from '../features/media-jobs/types';
import { hasRenderableAssetUrl, resolveAssetUrl } from '../utils/pathManager';
import { uiMeasure, uiTraceInteraction } from '../utils/uiDebug';
import { subscribeRuntimeEventStream } from '../runtime/runtimeEventStream';
import {
    HEARTBEAT_INTERVAL_OPTIONS,
    LONG_TEMPLATES,
    REDCLAW_CONTEXT_TYPE,
    REDCLAW_DISPLAY_NAME,
    REDCLAW_WELCOME_ICON_SRC,
    RUNNER_INTERVAL_OPTIONS,
    RUNNER_MAX_AUTOMATION_OPTIONS,
    SCHEDULE_TEMPLATES,
    createRedClawComposerShortcuts,
    createRedClawComposerShortcutsForContext,
    longDraftFromTemplate,
    pickLongTemplate,
    pickScheduleTemplate,
    scheduleDraftFromTemplate,
    type RedClawComposerShortcutInput,
} from './redclaw/config';
import {
    buildRedClawContextId,
    buildRedClawInitialContext,
    buildRedClawSessionTitle,
    createContextSessionListItem,
    normalizeClawHubSlug,
    sortContextSessionItems,
} from './redclaw/helpers';
import { RedClawHistorySidebarSection, type RedClawHistoryListItem, type RedClawHistorySessionActivity } from './redclaw/RedClawHistoryDrawer';
import { RedClawFilePreviewPane } from './redclaw/RedClawFilePreviewPane';
import {
    isRedClawOnboardingCompleted,
    type RedclawOnboardingState,
} from './redclaw/onboardingState';
import { RedClawSidebar } from './redclaw/RedClawSidebar';
import type {
    LongDraft,
    RunnerLongCycleTask,
    RunnerScheduledTask,
    RunnerStatus,
    ScheduleDraft,
    SidebarTab,
} from './redclaw/types';

interface FilePreviewResolveResult {
    success?: boolean;
    error?: string;
    isLocal?: boolean;
    exists?: boolean;
    isDirectory?: boolean;
    absolutePath?: string | null;
    localPathCandidate?: string | null;
    resolvedUrl?: string | null;
    title?: string | null;
    extension?: string | null;
    kind?: string | null;
    mimeType?: string | null;
    sizeBytes?: number | null;
    previewText?: string | null;
}

type RedClawAiSurface = 'redclaw' | 'advisor' | 'room';

interface RedClawTeamRoom {
    id: string;
    name: string;
    advisorIds?: string[];
    session?: TeamWorkbenchSession;
    createdAt?: string;
    isSystem?: boolean;
    systemType?: string;
}

const REDCLAW_AI_SURFACE_STORAGE_KEY = 'redbox:redclaw-ai-surface:v1';
const ADVISOR_CHAT_CONTEXT_TYPE = 'advisor-discussion';

function readInitialRedClawAiSurface(): RedClawAiSurface {
    if (typeof window === 'undefined') return 'redclaw';
    const saved = String(window.localStorage.getItem(REDCLAW_AI_SURFACE_STORAGE_KEY) || '').trim();
    return saved === 'advisor' || saved === 'room' ? saved : 'redclaw';
}

function visibleTeamSessions(sessions: TeamWorkbenchSession[]): TeamWorkbenchSession[] {
    return sessions.filter((session) => !['archived', 'completed'].includes(String(session.status || '').toLowerCase()));
}

function teamRoomFromSession(session: TeamWorkbenchSession): RedClawTeamRoom {
    const metadata = session.metadata && typeof session.metadata === 'object'
        ? session.metadata as Record<string, unknown>
        : {};
    const advisorIds = Array.isArray(metadata.advisorIds)
        ? metadata.advisorIds.map((id) => String(id || '').trim()).filter(Boolean)
        : [];
    return {
        id: session.id,
        name: session.title || '未命名团队',
        advisorIds,
        session,
        createdAt: session.createdAt ? new Date(session.createdAt).toISOString() : undefined,
    };
}

function advisorAvatarText(advisor: AdvisorProfile): string {
    const avatar = String(advisor.avatar || '').trim();
    if (avatar) return avatar.slice(0, 2);
    return String(advisor.name || '成').trim().slice(0, 2);
}

function isRenderableAdvisorAvatar(advisor: AdvisorProfile): boolean {
    return hasRenderableAssetUrl(advisor.avatar);
}

function advisorRedClawOrder(advisor: AdvisorProfile, index: number): number {
    return Number.isFinite(advisor.redclawOrder) ? Number(advisor.redclawOrder) : index;
}

function buildAdvisorInitialContext(advisor: AdvisorProfile): string {
    const sections = [
        `当前对话绑定成员：${advisor.name}`,
        advisor.personality ? `成员定位：${advisor.personality}` : null,
        `知识库语言：${advisor.knowledgeLanguage || '中文'}`,
        Array.isArray(advisor.knowledgeFiles) && advisor.knowledgeFiles.length > 0 ? `已接入知识文件：${advisor.knowledgeFiles.length} 个` : '当前暂无知识文件',
        advisor.memberSkillRef ? `成员技能：${advisor.memberSkillRef}（${advisor.memberSkillStatus || 'ready'}）` : null,
        '请始终以该成员身份回答，保持表达风格、专业倾向和角色设定一致。',
        advisor.systemPrompt ? `系统设定：\n${advisor.systemPrompt}` : null,
    ];
    return sections.filter(Boolean).join('\n\n');
}

function buildAdvisorSessionMetadata(advisor: AdvisorProfile): Record<string, unknown> {
    const metadata: Record<string, unknown> = { advisorId: advisor.id };
    if (advisor.memberSkillRef) {
        metadata.memberSkillRef = advisor.memberSkillRef;
        metadata.activeSkills = [advisor.memberSkillRef];
    }
    return metadata;
}

function sessionTimestampMs(value: unknown): number {
    if (typeof value === 'number' && Number.isFinite(value)) {
        return value > 1_000_000_000_000 ? value : value * 1000;
    }
    const text = String(value || '').trim();
    if (!text) return 0;
    if (/^\d+$/.test(text)) {
        const numeric = Number(text);
        if (!Number.isFinite(numeric)) return 0;
        return numeric > 1_000_000_000_000 ? numeric : numeric * 1000;
    }
    const time = Date.parse(text);
    return Number.isFinite(time) ? time : 0;
}

function sessionIdTimestampMs(sessionId: string): number {
    const matches = String(sessionId || '').match(/\d{10,}/g);
    if (!matches || matches.length === 0) return 0;
    return Math.max(...matches.map(sessionTimestampMs));
}

function sessionUpdatedAtMs(item: ContextChatSessionListItem): number {
    return Math.max(
        sessionTimestampMs(item.chatSession?.updatedAt),
        sessionTimestampMs(item.chatSession?.createdAt),
        sessionIdTimestampMs(item.id),
    );
}

const PREVIEW_KIND_SET = new Set<ChatMessageLinkKind>([
    'image',
    'video',
    'audio',
    'pdf',
    'html',
    'text',
    'archive',
    'web',
    'unknown',
]);

const REDCLAW_DIRECT_GOALS = new Set([
    'hi',
    'hello',
    'hey',
    '你好',
    '嗨',
    '哈喽',
    '在吗',
    'ok',
    '好的',
    '收到',
    '谢谢',
    'thanks',
    '辛苦了',
    '嗯',
    '啊',
]);

const REDCLAW_TEAM_TRIGGER_TERMS = [
    '团队',
    '组队',
    '协作',
    '多agent',
    'multi-agent',
    '全流程',
    '端到端',
    '一站式',
    '工作流',
    '发布包',
    '复盘',
    '质检',
    '合规',
    '知识库',
    '研究',
    '资料',
    '素材匹配',
    '分镜',
    '粗剪',
    '剪辑计划',
];

const REDCLAW_DELIVERABLE_TERMS = [
    '选题',
    '标题',
    '封面',
    '正文',
    '脚本',
    '文案',
    '标签',
    '配图',
    '图片',
    '分镜',
    '素材',
    '发布',
    '质检',
    '复盘',
];

const REDCLAW_SIMPLE_DIRECT_PATTERNS = [
    '改一下',
    '润色',
    '优化',
    '缩短',
    '扩写',
    '翻译',
    '总结',
    '起个标题',
    '写个标题',
    '给我标题',
    '写一句',
    '写一段',
    '简单写',
    '帮我看看',
];

const normalizeRedClawRoutingText = (value: string) => value.replace(/\s+/g, ' ').trim().toLowerCase();

const shouldUseRedClawTeam = (goal: string): boolean => {
    const normalized = normalizeRedClawRoutingText(goal);
    if (!normalized) return false;

    const compact = normalized.replace(/[,.!?;:'"`~，。！？；：、“”‘’（）()\[\]【】\s]/g, '');
    if (REDCLAW_DIRECT_GOALS.has(compact)) return false;
    if (compact.length <= 8 && !compact.includes('全流程') && !compact.includes('发布包')) return false;

    const hasExplicitTeamTrigger = REDCLAW_TEAM_TRIGGER_TERMS.some((term) => normalized.includes(term));
    const hasEndToEndShape = /从.+到/.test(normalized) || /包含.+(发布|质检|复盘|配图|分镜|素材)/.test(normalized);
    const deliverableCount = REDCLAW_DELIVERABLE_TERMS.filter((term) => normalized.includes(term)).length;
    const hasSourceGrounding = /(基于|根据|结合).+(收藏|知识库|资料|素材|文章|笔记|链接|文件)/.test(normalized);
    const hasComplexCreationTarget = /(小红书|视频|图文|文章|笔记|发布)/.test(normalized)
        && /(完整|一套|一条|生成|创作|策划|制作|发布)/.test(normalized);

    if (hasExplicitTeamTrigger || hasEndToEndShape || hasSourceGrounding) return true;
    if (deliverableCount >= 3) return true;
    if (hasComplexCreationTarget && deliverableCount >= 2) return true;
    if (normalized.length >= 120 && deliverableCount >= 2) return true;

    const isSimpleDirect = normalized.length <= 80
        && REDCLAW_SIMPLE_DIRECT_PATTERNS.some((term) => normalized.includes(term))
        && deliverableCount <= 1;
    if (isSimpleDirect) return false;

    return false;
};

const normalizePreviewKind = (value: unknown, fallback: ChatMessageLinkKind): ChatMessageLinkKind => {
    const normalized = String(value || '').trim().toLowerCase() as ChatMessageLinkKind;
    return PREVIEW_KIND_SET.has(normalized) ? normalized : fallback;
};

interface RedClawProps {
    pendingMessage?: PendingChatMessage | null;
    onPendingMessageConsumed?: () => void;
    navigationAction?: { action: 'new' | 'open-team'; sessionId?: string; nonce: number } | null;
    onNavigationActionConsumed?: () => void;
    isActive?: boolean;
    onExecutionStateChange?: (active: boolean) => void;
    onOpenRedClawOnboarding?: () => void;
    redclawOnboardingVersion?: number;
    composerShortcutInputs?: RedClawComposerShortcutInput[];
    welcomeShortcutInputs?: RedClawComposerShortcutInput[];
    onGlobalSidebarContentChange?: (content: ReactNode | null) => void;
    onOpenChatSurface?: () => void;
    onOpenManuscript?: (filePath: string) => void;
}

interface RedClawSpaceListPayload {
    activeSpaceId: string;
    spaces: Array<{ id: string; name: string }>;
}

const normalizeRedClawSpaceListPayload = (value: unknown): RedClawSpaceListPayload => {
    const raw = (value && typeof value === 'object') ? value as {
        activeSpaceId?: unknown;
        spaces?: unknown;
    } : {};
    const spaces = Array.isArray(raw.spaces)
        ? raw.spaces
            .map((space) => {
                if (!space || typeof space !== 'object') return null;
                const record = space as Record<string, unknown>;
                const id = String(record.id || '').trim();
                if (!id) return null;
                const name = String(record.name || id).trim() || id;
                return { id, name };
            })
            .filter((space): space is { id: string; name: string } => Boolean(space))
        : [];
    const activeSpaceId = String(raw.activeSpaceId || spaces[0]?.id || 'default').trim() || 'default';
    return {
        activeSpaceId,
        spaces: spaces.length > 0 ? spaces : [{ id: 'default', name: '默认空间' }],
    };
};

function redClawLastSessionStorageKey(spaceId: string): string {
    const normalized = String(spaceId || 'default').trim() || 'default';
    return `redclaw:lastSession:${normalized}`;
}

function readRedClawLastSessionId(spaceId: string): string | null {
    if (typeof window === 'undefined') return null;
    const raw = localStorage.getItem(redClawLastSessionStorageKey(spaceId));
    const sessionId = String(raw || '').trim();
    return sessionId || null;
}

function getRedClawImageJobExpectedCount(job: MediaJobProjection): number {
    const resultProgress = job.result && typeof job.result === 'object'
        ? job.result.progress as Record<string, unknown> | undefined
        : undefined;
    const expectedFromProgress = Number(resultProgress?.expectedImages);
    if (Number.isFinite(expectedFromProgress) && expectedFromProgress > 0) {
        return Math.max(1, Math.floor(expectedFromProgress));
    }
    const planItems = Array.isArray(job.request?.imagePlanItems) ? job.request?.imagePlanItems : [];
    if (planItems.length > 0) return planItems.length;
    const count = Number(job.request?.count);
    return Number.isFinite(count) && count > 0 ? Math.max(1, Math.floor(count)) : 1;
}

function getRedClawImageJobCompletedCount(job: MediaJobProjection): number {
    const resultProgress = job.result && typeof job.result === 'object'
        ? job.result.progress as Record<string, unknown> | undefined
        : undefined;
    const completedFromProgress = Number(resultProgress?.completedImages);
    if (Number.isFinite(completedFromProgress) && completedFromProgress >= 0) {
        return Math.max(0, Math.floor(completedFromProgress));
    }
    return job.artifacts.length;
}

function getRedClawImageJobTitle(job: MediaJobProjection): string {
    const title = String(job.request?.title || '').trim();
    if (title) return title;
    const expected = getRedClawImageJobExpectedCount(job);
    return expected > 1 ? `批量生图 · ${expected} 张` : '图片生成';
}

function getRedClawImageJobOverallProgress(job: MediaJobProjection): number {
    const expected = getRedClawImageJobExpectedCount(job);
    const completed = Math.min(getRedClawImageJobCompletedCount(job), expected);
    if (isMediaJobSuccessful(job.status)) return 100;
    if (completed >= expected) return 96;
    if (completed > 0) return Math.max(8, Math.round((completed / expected) * 100));
    if (['submitting', 'submitted', 'polling', 'downloading', 'persisting', 'binding'].includes(String(job.status))) return 12;
    return 4;
}

function RedClawImageGenerationPlaceholder({
    index,
    job,
}: {
    index: number;
    job: MediaJobProjection;
}) {
    const expected = getRedClawImageJobExpectedCount(job);
    const completed = Math.min(getRedClawImageJobCompletedCount(job), expected);
    const overallProgress = getRedClawImageJobOverallProgress(job);
    const artifact = job.artifacts[index];
    const preview = artifact?.previewUrl || artifact?.absolutePath || artifact?.relativePath || '';
    const slotProgress = artifact || index < completed
        ? 100
        : index === completed
            ? overallProgress
            : 0;
    const barTone = isMediaJobTerminal(job.status) && !isMediaJobSuccessful(job.status)
        ? 'bg-brand-red'
        : 'bg-[linear-gradient(90deg,rgb(var(--color-brand-red)/1)_0%,rgb(var(--color-accent-primary)/1)_100%)]';

    return (
        <div className="relative aspect-square min-w-0 overflow-hidden rounded-[12px] border border-border bg-surface-secondary">
            <div className="absolute left-1.5 right-1.5 top-1.5 z-20 h-1.5 overflow-hidden rounded-full bg-black/10">
                <div
                    className={clsx('h-full rounded-full transition-[width] duration-700 ease-out', barTone)}
                    style={{ width: `${Math.max(0, Math.min(100, slotProgress))}%` }}
                />
            </div>

            {preview ? (
                <img
                    src={resolveAssetUrl(preview)}
                    alt={`生成图片 ${index + 1}`}
                    className="h-full w-full object-cover"
                />
            ) : (
                <>
                    <div
                        className="absolute inset-0"
                        style={{ background: 'linear-gradient(180deg, rgb(var(--color-surface-primary) / 0.92) 0%, rgb(var(--color-surface-secondary) / 0.98) 100%)' }}
                    />
                    <div
                        className="absolute -left-[18%] top-[-20%] h-[58%] w-[64%] rounded-full blur-[22px] animate-[pulse_2.1s_ease-in-out_infinite]"
                        style={{ background: 'radial-gradient(circle, rgb(var(--color-brand-red) / 0.28) 0%, rgb(var(--color-brand-red) / 0.12) 34%, rgb(var(--color-brand-red) / 0) 74%)' }}
                    />
                    <div
                        className="absolute right-[-18%] top-[12%] h-[50%] w-[54%] rounded-full blur-[20px] animate-[pulse_1.7s_ease-in-out_infinite]"
                        style={{ background: 'radial-gradient(circle, rgb(var(--color-accent-primary) / 0.24) 0%, rgb(var(--color-accent-primary) / 0.1) 36%, rgb(var(--color-accent-primary) / 0) 74%)' }}
                    />
                    <div
                        className="absolute bottom-[-18%] left-[16%] h-[48%] w-[54%] rounded-full blur-[22px] animate-[pulse_2.4s_ease-in-out_infinite]"
                        style={{ background: 'radial-gradient(circle, rgb(var(--color-brand-red) / 0.18) 0%, rgb(var(--color-brand-red) / 0.08) 34%, rgb(var(--color-brand-red) / 0) 76%)' }}
                    />
                    <div
                        className="absolute inset-0 opacity-90 animate-[pulse_1.35s_linear_infinite]"
                        style={{
                            backgroundImage: 'radial-gradient(circle, rgb(var(--color-brand-red) / 0.30) 1px, transparent 1.5px)',
                            backgroundSize: '16px 16px',
                            maskImage: 'linear-gradient(180deg, transparent 2%, rgba(0,0,0,0.86) 24%, rgba(0,0,0,0.94) 62%, transparent 98%)',
                            WebkitMaskImage: 'linear-gradient(180deg, transparent 2%, rgba(0,0,0,0.86) 24%, rgba(0,0,0,0.94) 62%, transparent 98%)',
                        }}
                    />
                    <div
                        className="absolute inset-0 opacity-70 animate-[pulse_0.9s_ease-in-out_infinite]"
                        style={{
                            background: 'linear-gradient(110deg, transparent 12%, rgb(var(--color-surface-primary) / 0.24) 34%, rgb(var(--color-brand-red) / 0.16) 50%, rgb(var(--color-surface-primary) / 0.18) 63%, transparent 82%)',
                            mixBlendMode: 'screen',
                        }}
                    />
                    <div className="absolute inset-0 flex items-center justify-center">
                        <ImageIcon className="h-5 w-5 text-text-tertiary/45" />
                    </div>
                </>
            )}
        </div>
    );
}

function RedClawImageGenerationProgressPanel({
    jobs,
}: {
    jobs: MediaJobProjection[];
}) {
    if (jobs.length === 0) return null;

    return (
        <div className="space-y-3">
            {jobs.map((job) => {
                const expected = getRedClawImageJobExpectedCount(job);
                const completed = Math.min(getRedClawImageJobCompletedCount(job), expected);
                const progress = getRedClawImageJobOverallProgress(job);
                const failed = isMediaJobTerminal(job.status) && !isMediaJobSuccessful(job.status);
                return (
                    <div key={job.jobId} className="rounded-[18px] border border-border bg-surface-secondary/80 p-3 shadow-sm">
                        <div className="mb-2.5 flex items-center justify-between gap-3">
                            <div className="min-w-0">
                                <div className="truncate text-[12px] font-semibold text-text-primary">
                                    {getRedClawImageJobTitle(job)}
                                </div>
                                <div className="mt-0.5 text-[11px] text-text-tertiary">
                                    {failed ? '生成失败' : `已生成 ${completed}/${expected} 张 · ${progress}%`}
                                </div>
                            </div>
                            <div className={clsx('shrink-0 text-[11px] font-medium', failed ? 'text-brand-red' : 'text-text-tertiary')}>
                                {failed ? '失败' : '生成中'}
                            </div>
                        </div>
                        <div className="grid max-w-[460px] grid-cols-5 gap-2">
                            {Array.from({ length: expected }).map((_, index) => (
                                <RedClawImageGenerationPlaceholder
                                    key={`${job.jobId}-${index}`}
                                    index={index}
                                    job={job}
                                />
                            ))}
                        </div>
                    </div>
                );
            })}
        </div>
    );
}

function RedClawAiSwitchBar({
    activeSurface,
    advisors,
    selectedAdvisorId,
    onSelectRedClaw,
    onSelectAdvisor,
    onCreateAdvisor,
}: {
    activeSurface: RedClawAiSurface;
    advisors: AdvisorProfile[];
    selectedAdvisorId: string | null;
    onSelectRedClaw: () => void;
    onSelectAdvisor: (advisorId: string) => void;
    onCreateAdvisor: () => void;
}) {
    const visibleAdvisors = advisors
        .map((advisor, index) => ({ advisor, index }))
        .filter(({ advisor }) => advisor.redclawVisible !== false)
        .sort((left, right) => {
            const orderDelta = advisorRedClawOrder(left.advisor, left.index) - advisorRedClawOrder(right.advisor, right.index);
            return orderDelta || left.index - right.index;
        })
        .map(({ advisor }) => advisor)
        .slice(0, 6);
    return (
        <div>
            <div className="flex max-w-[min(84vw,32rem)] items-center gap-1.5 overflow-visible rounded-[22px] bg-surface-elevated/95 px-2 py-2 shadow-sm backdrop-blur-xl">
                <button
                    type="button"
                    onClick={onSelectRedClaw}
                    className={clsx(
                        'inline-flex h-9 shrink-0 items-center gap-2 rounded-2xl px-3 text-[12px] font-bold transition-colors',
                        activeSurface === 'redclaw'
                            ? 'bg-surface-primary text-text-primary shadow-sm'
                            : 'text-text-tertiary hover:bg-surface-primary/70 hover:text-text-primary'
                    )}
                    title={REDCLAW_DISPLAY_NAME}
                    aria-label={REDCLAW_DISPLAY_NAME}
                >
                    <Bot className="h-4 w-4" />
                    <span>{REDCLAW_DISPLAY_NAME}</span>
                </button>
                {visibleAdvisors.length > 0 && <div className="h-5 w-px bg-border" />}
                {visibleAdvisors.map((advisor) => {
                    const active = activeSurface === 'advisor' && selectedAdvisorId === advisor.id;
                    return (
                        <button
                            key={advisor.id}
                            type="button"
                            onClick={() => onSelectAdvisor(advisor.id)}
                            className={clsx(
                                'flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-full text-[13px] font-semibold transition-all duration-200 ease-out hover:scale-125 active:scale-110',
                                active
                                    ? 'bg-accent-primary/10 text-accent-primary'
                                    : 'text-text-tertiary hover:bg-surface-primary/70 hover:text-text-primary'
                            )}
                            title={advisor.name}
                            aria-label={advisor.name}
                        >
                            {isRenderableAdvisorAvatar(advisor) ? (
                                <img src={resolveAssetUrl(advisor.avatar)} alt="" className="h-full w-full object-cover" />
                            ) : (
                                advisorAvatarText(advisor)
                            )}
                        </button>
                    );
                })}
                <div className="h-5 w-px bg-border" />
                <button
                    type="button"
                    onClick={onCreateAdvisor}
                    className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-text-tertiary transition-colors hover:bg-surface-primary/70 hover:text-text-primary"
                    title="创建成员"
                    aria-label="创建成员"
                >
                    <Plus className="h-4 w-4" />
                </button>
            </div>
        </div>
    );
}

export function RedClaw({
    pendingMessage,
    onPendingMessageConsumed,
    navigationAction,
    onNavigationActionConsumed,
    isActive = true,
    onExecutionStateChange,
    onOpenRedClawOnboarding,
    redclawOnboardingVersion = 0,
    composerShortcutInputs,
    welcomeShortcutInputs,
    onGlobalSidebarContentChange,
    onOpenChatSurface,
    onOpenManuscript,
}: RedClawProps) {
    const debugUi = useCallback((event: string, extra?: Record<string, unknown>) => {
        if (!import.meta.env.DEV) return;
        console.debug(`[ui][redclaw] ${event}`, extra || {});
    }, []);
    const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
    const [sessionList, setSessionList] = useState<ContextChatSessionListItem[]>([]);
    const [advisorHistorySessions, setAdvisorHistorySessions] = useState<RedClawHistoryListItem[]>([]);
    const [sessionActivityById, setSessionActivityById] = useState<Record<string, RedClawHistorySessionActivity>>({});
    const [isSessionLoading, setIsSessionLoading] = useState(true);
    const [historyLoading, setHistoryLoading] = useState(false);
    const [activeSpaceName, setActiveSpaceName] = useState<string>('默认空间');
    const [activeSpaceId, setActiveSpaceId] = useState<string>('default');
    const [chatRefreshKey, setChatRefreshKey] = useState(0);
    const [chatActionLoading, setChatActionLoading] = useState<'clear' | 'compact' | null>(null);
    const [chatActionMessage, setChatActionMessage] = useState('');
    const [previewTarget, setPreviewTarget] = useState<ChatMessageLinkTarget | null>(null);
    const [activeAiSurface, setActiveAiSurface] = useState<RedClawAiSurface>(readInitialRedClawAiSurface);
    const [teamRooms, setTeamRooms] = useState<RedClawTeamRoom[]>([]);
    const [advisors, setAdvisors] = useState<AdvisorProfile[]>([]);
    const [selectedRoomId, setSelectedRoomId] = useState<string | null>(null);
    const [selectedAdvisorId, setSelectedAdvisorId] = useState<string | null>(null);
    const [advisorSessionIds, setAdvisorSessionIds] = useState<Record<string, string>>({});
    const [speakerSessionLoading, setSpeakerSessionLoading] = useState(false);
    const [advisorCreateModalOpen, setAdvisorCreateModalOpen] = useState(false);
    const [roomCreateModalOpen, setRoomCreateModalOpen] = useState(false);
    const [roomCreateName, setRoomCreateName] = useState('');
    const [roomCreateAdvisorIds, setRoomCreateAdvisorIds] = useState<string[]>([]);
    const [isCreatingRoom, setIsCreatingRoom] = useState(false);
    const [roomCreateError, setRoomCreateError] = useState('');
    const [isRedClawChatExecuting, setIsRedClawChatExecuting] = useState(false);

    const [sidebarCollapsed, setSidebarCollapsed] = useState(true);
    const [sidebarTab, setSidebarTab] = useState<SidebarTab>('skills');

    const [skills, setSkills] = useState<SkillDefinition[]>([]);
    const [isSkillsLoading, setIsSkillsLoading] = useState(false);
    const [skillsMessage, setSkillsMessage] = useState('');
    const [installSource, setInstallSource] = useState('');
    const [isInstallingSkill, setIsInstallingSkill] = useState(false);

    const [runnerStatus, setRunnerStatus] = useState<RunnerStatus | null>(null);
    const [automationLoading, setAutomationLoading] = useState(false);
    const [automationMessage, setAutomationMessage] = useState('');
    const [onboardingState, setOnboardingState] = useState<RedclawOnboardingState | undefined>(undefined);
    const [hideOnboardingPrompt, setHideOnboardingPrompt] = useState(false);
    const [resolvedPendingMessage, setResolvedPendingMessage] = useState<PendingChatMessage | null>(null);
    const trackedJobsById = useMediaJobsStore((state) => state.jobsById);
    const trackedImageJobs = useMemo(() => (
        Object.values(trackedJobsById)
            .filter((job) => job.kind === 'image' && job.ownerSessionId === activeSessionId)
            .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))
    ), [activeSessionId, trackedJobsById]);
    const visibleImageJobs = useMemo(() => {
        const now = Date.now();
        return trackedImageJobs.filter((job) => {
            if (isMediaJobSuccessful(job.status)) return false;
            if (!isMediaJobTerminal(job.status)) return true;
            const updatedAt = Date.parse(job.updatedAt || job.completedAt || job.createdAt);
            return Number.isFinite(updatedAt) && now - updatedAt < 10 * 60_000;
        }).slice(0, 3);
    }, [trackedImageJobs]);
    const imageJobSubscriptionIds = useMemo(() => [], []);
    const imageJobBootstrapFilter = useMemo(() => activeSessionId ? {
        kind: 'image' as const,
        ownerSessionId: activeSessionId,
        limit: 12,
    } : null, [activeSessionId]);
    useMediaJobSubscription(imageJobSubscriptionIds, {
        enabled: Boolean(activeSessionId),
        bootstrapFilter: imageJobBootstrapFilter,
    });
    const composerShortcuts = useMemo(
        () => composerShortcutInputs
            ? createRedClawComposerShortcuts(composerShortcutInputs)
            : createRedClawComposerShortcutsForContext,
        [composerShortcutInputs],
    );
    const welcomeShortcuts = useMemo(
        () => welcomeShortcutInputs
            ? createRedClawComposerShortcuts(welcomeShortcutInputs)
            : createRedClawComposerShortcutsForContext,
        [welcomeShortcutInputs],
    );

    const [runnerIntervalMinutes, setRunnerIntervalMinutes] = useState<number>(20);
    const [runnerMaxAutomationPerTick, setRunnerMaxAutomationPerTick] = useState<number>(2);

    const [heartbeatEnabled, setHeartbeatEnabled] = useState(true);
    const [heartbeatIntervalMinutes, setHeartbeatIntervalMinutes] = useState<number>(30);
    const [heartbeatSuppressEmpty, setHeartbeatSuppressEmpty] = useState(true);
    const [heartbeatReportToMainSession, setHeartbeatReportToMainSession] = useState(true);

    const [scheduleAdvanced, setScheduleAdvanced] = useState(false);
    const [scheduleDraft, setScheduleDraft] = useState<ScheduleDraft>(() => scheduleDraftFromTemplate(SCHEDULE_TEMPLATES[0]));
    const [isAddingSchedule, setIsAddingSchedule] = useState(false);

    const [longAdvanced, setLongAdvanced] = useState(false);
    const [longDraft, setLongDraft] = useState<LongDraft>(() => longDraftFromTemplate(LONG_TEMPLATES[0]));
    const [isAddingLong, setIsAddingLong] = useState(false);
    const shouldSyncGlobalHistory = Boolean(onGlobalSidebarContentChange);
    const shouldLoadHistory = isActive || shouldSyncGlobalHistory;
    const sessionRequestIdRef = useRef(0);
    const isActiveRef = useRef(isActive);
    const activeSessionIdRef = useRef<string | null>(null);
    const activeSpeakerSessionIdRef = useRef<string | null>(null);
    const sessionListRef = useRef<ContextChatSessionListItem[]>([]);
    const runnerStatusRequestIdRef = useRef(0);
    const skillsRequestIdRef = useRef(0);
    const onboardingRequestIdRef = useRef(0);
    const hasSessionSnapshotRef = useRef(false);
    const hasRunnerSnapshotRef = useRef(false);
    const hasSkillsSnapshotRef = useRef(false);
    const routedPendingMessageRef = useRef<PendingChatMessage | null>(null);
    const consumedNavigationActionNonceRef = useRef<number | null>(null);
    const pendingRoomSelectionRef = useRef<string | null>(null);

    const markSessionRunning = useCallback((sessionId: string | null | undefined) => {
        const safeSessionId = String(sessionId || '').trim();
        if (!safeSessionId) return;
        setSessionActivityById((prev) => (
            prev[safeSessionId] === 'running' ? prev : { ...prev, [safeSessionId]: 'running' }
        ));
    }, []);

    const markSessionComplete = useCallback((sessionId: string | null | undefined) => {
        const safeSessionId = String(sessionId || '').trim();
        if (!safeSessionId) return;
        setSessionActivityById((prev) => {
            const next = { ...prev };
            if (isActiveRef.current && activeSpeakerSessionIdRef.current === safeSessionId) {
                delete next[safeSessionId];
            } else {
                next[safeSessionId] = 'unread-complete';
            }
            return next;
        });
    }, []);

    const clearSessionActivity = useCallback((sessionId: string | null | undefined) => {
        const safeSessionId = String(sessionId || '').trim();
        if (!safeSessionId) return;
        setSessionActivityById((prev) => {
            if (!prev[safeSessionId]) return prev;
            const next = { ...prev };
            delete next[safeSessionId];
            return next;
        });
    }, []);

    const clearRunningSessionActivity = useCallback((sessionId: string | null | undefined) => {
        const safeSessionId = String(sessionId || '').trim();
        if (!safeSessionId) return;
        setSessionActivityById((prev) => {
            if (prev[safeSessionId] !== 'running') return prev;
            const next = { ...prev };
            delete next[safeSessionId];
            return next;
        });
    }, []);

    useEffect(() => {
        isActiveRef.current = isActive;
    }, [isActive]);

    useEffect(() => {
        activeSessionIdRef.current = activeSessionId;
    }, [activeSessionId]);

    useEffect(() => {
        setPreviewTarget(null);
    }, [activeSessionId, activeSpaceId]);

    useEffect(() => {
        if (typeof window === 'undefined') return;
        if (!activeSpaceId || !activeSessionId) return;
        localStorage.setItem(redClawLastSessionStorageKey(activeSpaceId), activeSessionId);
    }, [activeSessionId, activeSpaceId]);

    useEffect(() => {
        if (typeof window !== 'undefined') {
            localStorage.setItem(REDCLAW_AI_SURFACE_STORAGE_KEY, activeAiSurface);
        }
    }, [activeAiSurface]);

    useEffect(() => {
        if (!shouldLoadHistory) return;
        let cancelled = false;

        const loadTeamData = async () => {
            try {
                const [teamSessionList, advisorList] = await Promise.all([
                    window.ipcRenderer.teamRuntime.listSessions() as Promise<TeamWorkbenchSession[]>,
                    window.ipcRenderer.advisors.list<AdvisorProfile>(),
                ]);
                if (cancelled) return;
                const sessions = Array.isArray(teamSessionList) ? visibleTeamSessions(teamSessionList) : [];
                setTeamRooms(sessions.map(teamRoomFromSession));
                const pendingRoomId = pendingRoomSelectionRef.current;
                if (pendingRoomId && sessions.some((session) => session.id === pendingRoomId)) {
                    pendingRoomSelectionRef.current = null;
                    setSelectedRoomId(pendingRoomId);
                    setActiveAiSurface('room');
                }
                setAdvisors(Array.isArray(advisorList) ? advisorList : []);
            } catch (error) {
                if (cancelled) return;
                console.error('Failed to load RedClaw team surfaces:', error);
            }
        };

        void loadTeamData();
        const handleTeamSettingsChanged = () => {
            void loadTeamData();
        };
        const handleTeamRuntimeEvent = (event: { eventType?: string }) => {
            if (!String(event?.eventType || '').startsWith('runtime:collab-')) return;
            void loadTeamData();
        };
        window.addEventListener('redclaw:team-settings-changed', handleTeamSettingsChanged);
        window.ipcRenderer.teamRuntime.onEvent(handleTeamRuntimeEvent);
        return () => {
            cancelled = true;
            window.removeEventListener('redclaw:team-settings-changed', handleTeamSettingsChanged);
            window.ipcRenderer.teamRuntime.offEvent(handleTeamRuntimeEvent);
        };
    }, [shouldLoadHistory]);

    useEffect(() => {
        onExecutionStateChange?.(isRedClawChatExecuting);
    }, [isRedClawChatExecuting, onExecutionStateChange]);

    useEffect(() => {
        sessionListRef.current = sessionList;
    }, [sessionList]);

    useEffect(() => {
        return subscribeRuntimeEventStream({
            onPhaseStart: ({ sessionId }) => markSessionRunning(sessionId),
            onResponseDelta: ({ sessionId }) => markSessionRunning(sessionId),
            onToolRequest: ({ sessionId }) => markSessionRunning(sessionId),
            onTaskNodeChanged: ({ sessionId, status }) => {
                if (status === 'running' || status === 'pending') {
                    markSessionRunning(sessionId);
                }
            },
            onCliInstallStarted: ({ sessionId }) => markSessionRunning(sessionId),
            onCliExecutionStarted: ({ sessionId }) => markSessionRunning(sessionId),
            onCliEscalationRequested: ({ sessionId }) => markSessionRunning(sessionId),
            onChatDone: ({ sessionId, status }) => {
                if (status === 'completed') {
                    markSessionComplete(sessionId);
                } else {
                    clearRunningSessionActivity(sessionId);
                }
            },
            onChatResponseEnd: ({ sessionId }) => markSessionComplete(sessionId),
            onChatCancelled: ({ sessionId }) => clearRunningSessionActivity(sessionId),
            onChatError: ({ sessionId }) => clearRunningSessionActivity(sessionId),
        });
    }, [clearRunningSessionActivity, markSessionComplete, markSessionRunning]);

    useEffect(() => {
        if (teamRooms.length === 0) {
            if (pendingRoomSelectionRef.current) return;
            setSelectedRoomId(null);
            return;
        }
        if (!selectedRoomId || !teamRooms.some((room) => room.id === selectedRoomId)) {
            setSelectedRoomId(teamRooms[0].id);
        }
    }, [selectedRoomId, teamRooms]);

    useEffect(() => {
        if (advisors.length === 0) {
            setSelectedAdvisorId(null);
            setAdvisorHistorySessions([]);
            return;
        }
        if (!selectedAdvisorId || !advisors.some((advisor) => advisor.id === selectedAdvisorId)) {
            setSelectedAdvisorId(advisors[0].id);
        }
    }, [advisors, selectedAdvisorId]);

    useEffect(() => {
        if (!shouldLoadHistory || advisors.length === 0) return;
        let cancelled = false;

        const loadAdvisorHistories = async () => {
            try {
                const results = await Promise.all(advisors.map(async (advisor) => {
                    const list = await window.ipcRenderer.invokeGuarded<ContextChatSessionListItem[] | null>('chat:list-context-sessions', {
                        contextId: advisor.id,
                        contextType: ADVISOR_CHAT_CONTEXT_TYPE,
                    }, {
                        timeoutMs: 3200,
                        fallback: null,
                        normalize: (value) => Array.isArray(value) ? value as ContextChatSessionListItem[] : [],
                    });
                    return (Array.isArray(list) ? list : []).map((session): RedClawHistoryListItem => ({
                        ...session,
                        surface: 'advisor',
                        speakerLabel: advisor.name || '成员',
                        advisorId: advisor.id,
                    }));
                }));
                if (cancelled) return;
                const items = results.flat();
                setAdvisorHistorySessions(items);
                setAdvisorSessionIds((prev) => {
                    const next = { ...prev };
                    items.forEach((item) => {
                        if (item.advisorId && item.id && !next[item.advisorId]) {
                            next[item.advisorId] = item.id;
                        }
                    });
                    return next;
                });
            } catch (error) {
                if (cancelled) return;
                console.error('Failed to load RedClaw advisor histories:', error);
            }
        };

        void loadAdvisorHistories();
        return () => {
            cancelled = true;
        };
    }, [advisors, shouldLoadHistory]);

    const selectedAdvisor = useMemo(
        () => advisors.find((advisor) => advisor.id === selectedAdvisorId) || null,
        [advisors, selectedAdvisorId],
    );
    const selectedRoom = useMemo(
        () => teamRooms.find((room) => room.id === selectedRoomId) || null,
        [selectedRoomId, teamRooms],
    );
    const unifiedHistorySessions = useMemo<RedClawHistoryListItem[]>(() => (
        [
            ...sessionList.map((session): RedClawHistoryListItem => ({
                ...session,
                surface: 'redclaw',
                speakerLabel: REDCLAW_DISPLAY_NAME,
            })),
            ...advisorHistorySessions,
        ].sort((left, right) => sessionUpdatedAtMs(right) - sessionUpdatedAtMs(left))
    ), [advisorHistorySessions, sessionList]);
    const activeSpeakerSessionId = activeAiSurface === 'advisor' && selectedAdvisorId
        ? advisorSessionIds[selectedAdvisorId] || null
        : activeSessionId;
    useEffect(() => {
        activeSpeakerSessionIdRef.current = activeSpeakerSessionId;
        if (isActive && activeSpeakerSessionId) {
            clearSessionActivity(activeSpeakerSessionId);
        }
    }, [activeSpeakerSessionId, clearSessionActivity, isActive]);
    const activeSpeakerMention = activeAiSurface === 'advisor' && selectedAdvisor ? {
        id: selectedAdvisor.id,
        name: selectedAdvisor.name,
        avatar: selectedAdvisor.avatar,
        personality: selectedAdvisor.personality,
    } : null;
    const activeWelcomeTitle = activeAiSurface === 'advisor' && selectedAdvisor
        ? selectedAdvisor.name
        : activeAiSurface === 'room' && selectedRoom
            ? selectedRoom.name || '未命名团队'
            : `${REDCLAW_DISPLAY_NAME} 自媒体AI工作台`;
    const activeWelcomeIconSrc = activeAiSurface === 'advisor' && selectedAdvisor && isRenderableAdvisorAvatar(selectedAdvisor)
        ? resolveAssetUrl(selectedAdvisor.avatar)
        : REDCLAW_WELCOME_ICON_SRC;
    const activeWelcomeAvatarText = activeAiSurface === 'advisor' && selectedAdvisor && !isRenderableAdvisorAvatar(selectedAdvisor)
        ? advisorAvatarText(selectedAdvisor)
        : undefined;
    const activeWelcomeIconVariant = activeAiSurface === 'advisor' ? 'avatar' as const : 'default' as const;
    useEffect(() => {
        if (!pendingMessage) {
            routedPendingMessageRef.current = null;
            setResolvedPendingMessage(null);
            return;
        }
        setActiveAiSurface('redclaw');

        if (routedPendingMessageRef.current === pendingMessage) {
            setResolvedPendingMessage(pendingMessage);
            return;
        }

        const routing = pendingMessage.sessionRouting || 'current';
        if (routing !== 'new') {
            routedPendingMessageRef.current = pendingMessage;
            setResolvedPendingMessage(pendingMessage);
            return;
        }

        if (!hasSessionSnapshotRef.current || isSessionLoading) {
            setResolvedPendingMessage(null);
            return;
        }

        let cancelled = false;
        setResolvedPendingMessage(null);

        const prepareFreshSession = async () => {
            const nextActiveSpaceId = activeSpaceId || 'default';
            const nextSpaceName = activeSpaceName || nextActiveSpaceId;
            const contextId = buildRedClawContextId(nextActiveSpaceId);
            try {
                const session = await uiMeasure('redclaw', 'sessions:create_for_pending_message', async () => (
                    window.ipcRenderer.invokeGuarded<ChatSession | null>('chat:create-context-session', {
                        contextId,
                        contextType: REDCLAW_CONTEXT_TYPE,
                        title: buildRedClawSessionTitle(nextSpaceName),
                        initialContext: buildRedClawInitialContext(nextSpaceName, nextActiveSpaceId),
                    }, {
                        timeoutMs: 3200,
                        fallback: null,
                    })
                ), { activeSpaceId: nextActiveSpaceId, spaceName: nextSpaceName });

                if (!session) {
                    throw new Error('create context session timed out');
                }
                if (cancelled) return;

                const nextItem = createContextSessionListItem(session);
                setSessionList((prev) => sortContextSessionItems([nextItem, ...prev.filter((item) => item.id !== session.id)]));
                sessionListRef.current = sortContextSessionItems([nextItem, ...sessionListRef.current.filter((item) => item.id !== session.id)]);
                activeSessionIdRef.current = session.id;
                activeSpeakerSessionIdRef.current = session.id;
                setActiveSessionId(session.id);
                hasSessionSnapshotRef.current = true;
                routedPendingMessageRef.current = pendingMessage;
                setResolvedPendingMessage(pendingMessage);
                debugUi('sessions:create_for_pending_message_done', {
                    sessionId: session.id,
                    activeSpaceId: nextActiveSpaceId,
                });
            } catch (error) {
                console.error('Failed to create RedClaw context session for pending message:', error);
                if (!cancelled) {
                    setChatActionMessage('为创作任务创建新对话失败，请稍后重试');
                }
            }
        };

        void prepareFreshSession();

        return () => {
            cancelled = true;
        };
    }, [
        activeSpaceId,
        activeSpaceName,
        debugUi,
        isSessionLoading,
        pendingMessage,
    ]);

    const loadContextSessions = useCallback(async (
        nextActiveSpaceId: string,
        nextSpaceName: string,
        options?: {
            preferredSessionId?: string | null;
            createIfEmpty?: boolean;
            silent?: boolean;
        },
    ) => {
        const requestId = ++sessionRequestIdRef.current;
        const shouldCreateIfEmpty = options?.createIfEmpty === true;
        if (!hasSessionSnapshotRef.current && !options?.silent) {
            setIsSessionLoading(true);
        }
        if (!options?.silent) {
            setHistoryLoading(true);
        }

        try {
            const contextId = buildRedClawContextId(nextActiveSpaceId);
            const listResult = await uiMeasure('redclaw', 'sessions:list_context', async () => (
                window.ipcRenderer.invokeGuarded<ContextChatSessionListItem[] | null>('chat:list-context-sessions', {
                    contextId,
                    contextType: REDCLAW_CONTEXT_TYPE,
                }, {
                    timeoutMs: 3200,
                    fallback: null,
                    normalize: (value) => Array.isArray(value) ? value as ContextChatSessionListItem[] : [],
                })
            ), { activeSpaceId: nextActiveSpaceId, spaceName: nextSpaceName }) as ContextChatSessionListItem[];

            if (requestId !== sessionRequestIdRef.current) return;
            if (listResult == null) {
                if (!hasSessionSnapshotRef.current) {
                    setActiveSpaceId(nextActiveSpaceId);
                    setActiveSpaceName(nextSpaceName);
                    setSessionList([]);
                    sessionListRef.current = [];
                    activeSessionIdRef.current = null;
                    activeSpeakerSessionIdRef.current = null;
                    setActiveSessionId(null);
                }
                return;
            }

            let items = sortContextSessionItems(listResult);
            const rememberedSessionId = readRedClawLastSessionId(nextActiveSpaceId);

            let nextActiveSessionId =
                options?.preferredSessionId && items.some((item) => item.id === options.preferredSessionId)
                    ? options.preferredSessionId
                    : activeSessionIdRef.current && items.some((item) => item.id === activeSessionIdRef.current)
                        ? activeSessionIdRef.current
                        : rememberedSessionId && items.some((item) => item.id === rememberedSessionId)
                            ? rememberedSessionId
                        : items[0]?.id || null;

            if (items.length === 0 && shouldCreateIfEmpty) {
                const created = await uiMeasure('redclaw', 'sessions:create_context', async () => (
                    window.ipcRenderer.invokeGuarded<ChatSession | null>('chat:create-context-session', {
                        contextId,
                        contextType: REDCLAW_CONTEXT_TYPE,
                        title: buildRedClawSessionTitle(nextSpaceName),
                        initialContext: buildRedClawInitialContext(nextSpaceName, nextActiveSpaceId),
                    }, {
                        timeoutMs: 3200,
                        fallback: null,
                    })
                ), { activeSpaceId: nextActiveSpaceId, spaceName: nextSpaceName });
                if (!created) {
                    if (!hasSessionSnapshotRef.current) {
                        setSessionList([]);
                        sessionListRef.current = [];
                        activeSessionIdRef.current = null;
                        activeSpeakerSessionIdRef.current = null;
                        setActiveSessionId(null);
                    }
                    return;
                }
                items = [createContextSessionListItem(created)];
                nextActiveSessionId = created.id;
            }

            if (requestId !== sessionRequestIdRef.current) return;

            setActiveSpaceId(nextActiveSpaceId);
            setActiveSpaceName(nextSpaceName);
            setSessionList(items);
            sessionListRef.current = items;
            activeSessionIdRef.current = nextActiveSessionId;
            activeSpeakerSessionIdRef.current = nextActiveSessionId;
            setActiveSessionId(nextActiveSessionId);
            hasSessionSnapshotRef.current = true;
            debugUi('sessions:loaded', {
                activeSessionId: nextActiveSessionId,
                count: items.length,
                activeSpaceId: nextActiveSpaceId,
                spaceName: nextSpaceName,
            });
        } catch (error) {
            console.error('Failed to load RedClaw context sessions:', error);
            if (!hasSessionSnapshotRef.current) {
                setSessionList([]);
                sessionListRef.current = [];
                activeSessionIdRef.current = null;
                activeSpeakerSessionIdRef.current = null;
                setActiveSessionId(null);
            }
        } finally {
            if (requestId === sessionRequestIdRef.current) {
                setIsSessionLoading(false);
                setHistoryLoading(false);
            }
        }
    }, [debugUi]);

    const initSession = useCallback(async () => {
        if (!hasSessionSnapshotRef.current) {
            setIsSessionLoading(true);
        }
        try {
            const spaceInfo = await uiMeasure('redclaw', 'init_session:spaces', async () => (
                window.ipcRenderer.spaces.list()
            )) as RedClawSpaceListPayload;
            const normalizedSpaceInfo = normalizeRedClawSpaceListPayload(spaceInfo);
            const nextActiveSpaceId = normalizedSpaceInfo.activeSpaceId || 'default';
            const nextSpaceName = normalizedSpaceInfo.spaces.find((space) => space.id === nextActiveSpaceId)?.name || nextActiveSpaceId;
            await loadContextSessions(nextActiveSpaceId, nextSpaceName, { createIfEmpty: false });
        } catch (error) {
            console.error('Failed to initialize RedClaw session list:', error);
            if (!hasSessionSnapshotRef.current) {
                setSessionList([]);
                setActiveSessionId(null);
                setIsSessionLoading(false);
            }
        }
    }, [loadContextSessions]);

    const applyRunnerForm = useCallback((status: RunnerStatus) => {
        setRunnerIntervalMinutes(status.intervalMinutes || 20);
        setRunnerMaxAutomationPerTick(status.maxAutomationPerTick || 2);
        setHeartbeatEnabled(status.heartbeat?.enabled !== false);
        setHeartbeatIntervalMinutes(status.heartbeat?.intervalMinutes || 30);
        setHeartbeatSuppressEmpty(status.heartbeat?.suppressEmptyReport !== false);
        setHeartbeatReportToMainSession(status.heartbeat?.reportToMainSession !== false);
    }, []);

    const loadRunnerStatus = useCallback(async (syncForm = false) => {
        const requestId = ++runnerStatusRequestIdRef.current;
        if (!hasRunnerSnapshotRef.current) {
            setAutomationLoading(true);
        }
        try {
            const status = await uiMeasure('redclaw', 'load_runner_status', async () => (
                window.ipcRenderer.invokeGuarded<RunnerStatus | null>('redclaw:runner-status', undefined, {
                    timeoutMs: 2800,
                    fallback: null,
                })
            ), { syncForm }) as RunnerStatus | null;
            if (requestId !== runnerStatusRequestIdRef.current) return;
            if (!status) {
                if (!hasRunnerSnapshotRef.current) {
                    setRunnerStatus(null);
                }
                return;
            }
            setRunnerStatus(status);
            hasRunnerSnapshotRef.current = true;
            if (syncForm) {
                applyRunnerForm(status);
            }
        } catch (error) {
            console.error('Failed to load runner status:', error);
            setAutomationMessage('加载自动化状态失败');
        } finally {
            if (requestId === runnerStatusRequestIdRef.current) {
                setAutomationLoading(false);
            }
        }
    }, [applyRunnerForm]);

    const loadSkills = useCallback(async () => {
        const requestId = ++skillsRequestIdRef.current;
        if (!hasSkillsSnapshotRef.current) {
            setIsSkillsLoading(true);
        }
        try {
            const list = await uiMeasure('redclaw', 'load_skills', async () => (
                window.ipcRenderer.invokeGuarded<SkillDefinition[] | null>('skills:list', undefined, {
                    timeoutMs: 2800,
                    fallback: null,
                    normalize: (value) => Array.isArray(value) ? value as SkillDefinition[] : [],
                })
            ));
            if (requestId !== skillsRequestIdRef.current) return;
            if (list == null) {
                if (!hasSkillsSnapshotRef.current) {
                    setSkills([]);
                }
                return;
            }
            setSkills(list as SkillDefinition[]);
            hasSkillsSnapshotRef.current = true;
        } catch (error) {
            console.error('Failed to load skills:', error);
        } finally {
            if (requestId === skillsRequestIdRef.current) {
                setIsSkillsLoading(false);
            }
        }
    }, []);

    const loadOnboardingBundle = useCallback(async () => {
        const requestId = ++onboardingRequestIdRef.current;
        try {
            const bundle = await uiMeasure('redclaw', 'load_onboarding_bundle', async () => (
                window.ipcRenderer.redclawProfile.getBundle()
            )) as {
                onboardingState?: Record<string, unknown>;
            } | null;
            if (requestId !== onboardingRequestIdRef.current) return;
            setOnboardingState(
                bundle?.onboardingState && typeof bundle.onboardingState === 'object'
                    ? bundle.onboardingState
                    : null
            );
        } catch (error) {
            console.error('Failed to load RedClaw onboarding bundle:', error);
            if (requestId === onboardingRequestIdRef.current) {
                setOnboardingState(null);
            }
        }
    }, []);

    useEffect(() => {
        debugUi(isActive ? 'view_activate' : 'view_deactivate', { sessionId: activeSessionId });
        if (!isActive) {
            return;
        }
    }, [activeSessionId, debugUi, isActive]);

    useEffect(() => {
        if (!import.meta.env.DEV) return;
        debugUi('view_mount');
        return () => {
            debugUi('view_unmount');
        };
    }, [debugUi]);

    useEffect(() => {
        if (!shouldLoadHistory) return;
        void initSession();
        if (isActive) {
            void loadRunnerStatus(true);
        }
    }, [initSession, isActive, loadRunnerStatus, shouldLoadHistory]);

    useEffect(() => {
        if (!isActive || !activeSessionId) return;
        void loadOnboardingBundle();
    }, [activeSessionId, isActive, loadOnboardingBundle]);

    useEffect(() => {
        if (!redclawOnboardingVersion) return;
        void loadOnboardingBundle();
        void loadSkills();
        setHideOnboardingPrompt(true);
        setChatActionMessage('已完成这个空间的风格定义');
    }, [loadOnboardingBundle, loadSkills, redclawOnboardingVersion]);

    useEffect(() => {
        if (!shouldLoadHistory) return;
        const onSpaceChanged = () => {
            setOnboardingState(undefined);
            void initSession();
            if (isActive) {
                void loadRunnerStatus(true);
                void loadSkills();
                void loadOnboardingBundle();
            }
            setHideOnboardingPrompt(false);
        };
        window.ipcRenderer.on('space:changed', onSpaceChanged);
        return () => {
            window.ipcRenderer.off('space:changed', onSpaceChanged);
        };
    }, [initSession, isActive, loadOnboardingBundle, loadRunnerStatus, loadSkills, shouldLoadHistory]);

    useEffect(() => {
        setOnboardingState(undefined);
        setHideOnboardingPrompt(false);
    }, [activeSpaceId]);

    useEffect(() => {
        if (!isActive) return;
        if (sidebarTab !== 'skills') return;
        void loadSkills();
    }, [sidebarTab, loadSkills, isActive]);

    useEffect(() => {
        if (!isActive) return;
        const onRunnerStatus = (_event: unknown, status: RunnerStatus) => {
            if (!status || typeof status !== 'object') return;
            setRunnerStatus(status);
        };
        window.ipcRenderer.on('redclaw:runner-status', onRunnerStatus);
        return () => {
            window.ipcRenderer.off('redclaw:runner-status', onRunnerStatus);
        };
    }, [isActive]);

    useEffect(() => {
        if (!shouldLoadHistory) return;
        const onSessionTitleUpdated = (_event: unknown, payload: { sessionId?: string; title?: string }) => {
            const nextSessionId = String(payload?.sessionId || '').trim();
            const nextTitle = String(payload?.title || '').trim();
            if (!nextSessionId || !nextTitle) return;
            setSessionList((prev) => sortContextSessionItems(prev.map((item) => (
                item.id !== nextSessionId
                    ? item
                    : {
                        ...item,
                        chatSession: {
                            id: item.chatSession?.id || item.id,
                            title: nextTitle,
                            updatedAt: new Date().toISOString(),
                            createdAt: item.chatSession?.createdAt,
                        },
                    }
            ))));
        };
        window.ipcRenderer.on('chat:session-title-updated', onSessionTitleUpdated);
        return () => {
            window.ipcRenderer.off('chat:session-title-updated', onSessionTitleUpdated);
        };
    }, [shouldLoadHistory]);

    useEffect(() => {
        if (!chatActionMessage) return;
        const timer = window.setTimeout(() => setChatActionMessage(''), 2600);
        return () => window.clearTimeout(timer);
    }, [chatActionMessage]);

    useEffect(() => {
        if (!automationMessage) return;
        const timer = window.setTimeout(() => setAutomationMessage(''), 2800);
        return () => window.clearTimeout(timer);
    }, [automationMessage]);

    useEffect(() => {
        if (!skillsMessage) return;
        const timer = window.setTimeout(() => setSkillsMessage(''), 2800);
        return () => window.clearTimeout(timer);
    }, [skillsMessage]);

    const enabledSkillCount = useMemo(() => skills.filter((skill) => !skill.disabled).length, [skills]);

    const scheduledTasks = useMemo(() => {
        const list = Object.values(runnerStatus?.scheduledTasks || {}) as RunnerScheduledTask[];
        return list.sort((a, b) => {
            const aTime = a.nextRunAt ? new Date(a.nextRunAt).getTime() : Number.MAX_SAFE_INTEGER;
            const bTime = b.nextRunAt ? new Date(b.nextRunAt).getTime() : Number.MAX_SAFE_INTEGER;
            return aTime - bTime;
        });
    }, [runnerStatus]);

    const longTasks = useMemo(() => {
        const list = Object.values(runnerStatus?.longCycleTasks || {}) as RunnerLongCycleTask[];
        return list.sort((a, b) => {
            const aTime = a.nextRunAt ? new Date(a.nextRunAt).getTime() : Number.MAX_SAFE_INTEGER;
            const bTime = b.nextRunAt ? new Date(b.nextRunAt).getTime() : Number.MAX_SAFE_INTEGER;
            return aTime - bTime;
        });
    }, [runnerStatus]);

    const createNewSession = useCallback(async (): Promise<string | null> => {
        const nextActiveSpaceId = activeSpaceId || 'default';
        const nextSpaceName = activeSpaceName || nextActiveSpaceId;
        const contextId = buildRedClawContextId(nextActiveSpaceId);
        setHistoryLoading(true);
        try {
            const session = await uiMeasure('redclaw', 'sessions:create_manual', async () => (
                window.ipcRenderer.invokeGuarded<ChatSession | null>('chat:create-context-session', {
                    contextId,
                    contextType: REDCLAW_CONTEXT_TYPE,
                    title: buildRedClawSessionTitle(nextSpaceName),
                    initialContext: buildRedClawInitialContext(nextSpaceName, nextActiveSpaceId),
                }, {
                    timeoutMs: 3200,
                    fallback: null,
                })
            ), { activeSpaceId: nextActiveSpaceId, spaceName: nextSpaceName });
            if (!session) {
                throw new Error('create context session timed out');
            }
            const nextItem = createContextSessionListItem(session);
            flushSync(() => {
                const nextList = sortContextSessionItems([nextItem, ...sessionListRef.current.filter((item) => item.id !== session.id)]);
                sessionListRef.current = nextList;
                setSessionList(nextList);
                setActiveSessionId(session.id);
                setActiveAiSurface('redclaw');
                hasSessionSnapshotRef.current = true;
            });
            activeSessionIdRef.current = session.id;
            activeSpeakerSessionIdRef.current = session.id;
            debugUi('sessions:create_done', { sessionId: session.id, activeSpaceId: nextActiveSpaceId });
            return session.id;
        } catch (error) {
            console.error('Failed to create RedClaw context session:', error);
            setChatActionMessage('新建对话失败，请稍后重试');
            return null;
        } finally {
            setHistoryLoading(false);
        }
    }, [activeSpaceId, activeSpaceName, debugUi]);

    const startNewDraftSession = useCallback(() => {
        onOpenChatSurface?.();
        setActiveAiSurface('redclaw');
        activeSessionIdRef.current = null;
        activeSpeakerSessionIdRef.current = null;
        setActiveSessionId(null);
        setPreviewTarget(null);
        setChatRefreshKey((value) => value + 1);
        debugUi('sessions:new_draft', { activeSpaceId: activeSpaceId || 'default' });
    }, [activeSpaceId, debugUi, onOpenChatSurface]);

    useEffect(() => {
        if (!isActive || !navigationAction) return;
        if (consumedNavigationActionNonceRef.current === navigationAction.nonce) return;
        consumedNavigationActionNonceRef.current = navigationAction.nonce;
        if (navigationAction.action === 'new') {
            startNewDraftSession();
        } else if (navigationAction.action === 'open-team' && navigationAction.sessionId) {
            pendingRoomSelectionRef.current = navigationAction.sessionId;
            setSelectedRoomId(navigationAction.sessionId);
            setActiveAiSurface('room');
            onOpenChatSurface?.();
        }
        onNavigationActionConsumed?.();
    }, [isActive, navigationAction, onNavigationActionConsumed, onOpenChatSurface, startNewDraftSession]);

    const switchSession = useCallback((nextSessionId: string) => {
        if (!nextSessionId) return;
        setActiveAiSurface('redclaw');
        activeSessionIdRef.current = nextSessionId;
        activeSpeakerSessionIdRef.current = nextSessionId;
        setActiveSessionId(nextSessionId);
        debugUi('sessions:switch', { sessionId: nextSessionId, activeSpaceId });
    }, [activeSpaceId, debugUi]);

    const markHistorySessionActivity = useCallback((sessionId: string, updatedAt: string) => {
        const nextSessionId = String(sessionId || '').trim();
        const nextUpdatedAt = String(updatedAt || '').trim() || new Date().toISOString();
        if (!nextSessionId) return;
        const updateItem = <T extends ContextChatSessionListItem,>(item: T): T => (
            item.id !== nextSessionId
                ? item
                : {
                    ...item,
                    chatSession: {
                        id: item.chatSession?.id || item.id,
                        title: item.chatSession?.title || '未命名会话',
                        updatedAt: nextUpdatedAt,
                        createdAt: item.chatSession?.createdAt,
                    },
                }
        );
        setSessionList((prev) => sortContextSessionItems(prev.map(updateItem)));
        setAdvisorHistorySessions((prev) => (
            [...prev.map(updateItem)].sort((left, right) => sessionUpdatedAtMs(right) - sessionUpdatedAtMs(left))
        ));
    }, []);

    const applyHistorySessionTitle = useCallback((sessionId: string, title: string) => {
        const nextSessionId = String(sessionId || '').trim();
        const nextTitle = String(title || '').trim();
        if (!nextSessionId || !nextTitle) return;
        const nextUpdatedAt = new Date().toISOString();
        const updateItem = <T extends ContextChatSessionListItem,>(item: T): T => (
            item.id !== nextSessionId
                ? item
                : {
                    ...item,
                    chatSession: {
                        id: item.chatSession?.id || item.id,
                        title: nextTitle,
                        updatedAt: nextUpdatedAt,
                        createdAt: item.chatSession?.createdAt,
                    },
                }
        );
        setSessionList((prev) => sortContextSessionItems(prev.map(updateItem)));
        setAdvisorHistorySessions((prev) => (
            [...prev.map(updateItem)].sort((left, right) => sessionUpdatedAtMs(right) - sessionUpdatedAtMs(left))
        ));
    }, []);

    const renameUnifiedHistorySession = useCallback(async (session: RedClawHistoryListItem, title: string) => {
        const nextSessionId = String(session?.id || '').trim();
        const nextTitle = String(title || '').trim();
        if (!nextSessionId || !nextTitle) return;
        await window.ipcRenderer.chat.renameSession({ sessionId: nextSessionId, title: nextTitle });
        applyHistorySessionTitle(nextSessionId, nextTitle);
    }, [applyHistorySessionTitle]);

    const switchHistorySession = useCallback((session: RedClawHistoryListItem) => {
        if (!session?.id) return;
        onOpenChatSurface?.();
        clearSessionActivity(session.id);
        if (session.surface === 'advisor' && session.advisorId) {
            setSelectedAdvisorId(session.advisorId);
            setAdvisorSessionIds((prev) => ({ ...prev, [session.advisorId!]: session.id }));
            setActiveAiSurface('advisor');
            return;
        }
        if (session.surface === 'room' && session.roomId) {
            setSelectedRoomId(session.roomId);
            setActiveAiSurface('room');
            return;
        }
        switchSession(session.id);
    }, [clearSessionActivity, onOpenChatSurface, switchSession]);

    const createAdvisorSession = useCallback(async (advisor: AdvisorProfile): Promise<string | null> => {
        setSpeakerSessionLoading(true);
        try {
            const created = await window.ipcRenderer.invokeGuarded<ChatSession | null>('chat:create-context-session', {
                contextId: advisor.id,
                contextType: ADVISOR_CHAT_CONTEXT_TYPE,
                title: `与 ${advisor.name} 聊聊`,
                initialContext: buildAdvisorInitialContext(advisor),
                metadata: buildAdvisorSessionMetadata(advisor),
            }, {
                timeoutMs: 3200,
                fallback: null,
            });
            if (!created) return null;
            setSelectedAdvisorId(advisor.id);
            setAdvisorSessionIds((prev) => ({ ...prev, [advisor.id]: created.id }));
            setAdvisorHistorySessions((prev) => ([{
                id: created.id,
                messageCount: 0,
                summary: '',
                transcriptCount: 0,
                checkpointCount: 0,
                chatSession: {
                    id: created.id,
                    title: created.title,
                    updatedAt: created.updatedAt,
                    createdAt: created.createdAt,
                },
                surface: 'advisor',
                speakerLabel: advisor.name || '成员',
                advisorId: advisor.id,
            }, ...prev.filter((item) => item.id !== created.id)]));
            setActiveAiSurface('advisor');
            return created.id;
        } catch (error) {
            console.error('Failed to create advisor session:', error);
            setChatActionMessage('成员会话创建失败');
            return null;
        } finally {
            setSpeakerSessionLoading(false);
        }
    }, []);

    const ensureActiveSpeakerSessionForSend = useCallback(async (): Promise<string | null> => {
        if (activeAiSurface === 'advisor') {
            if (!selectedAdvisor) return null;
            const existing = advisorSessionIds[selectedAdvisor.id];
            if (existing) return existing;
            return createAdvisorSession(selectedAdvisor);
        }
        if (activeSessionIdRef.current) return activeSessionIdRef.current;
        return createNewSession();
    }, [activeAiSurface, advisorSessionIds, createAdvisorSession, createNewSession, selectedAdvisor]);

    const switchRoom = useCallback((roomId: string) => {
        const room = teamRooms.find((item) => item.id === roomId);
        if (!room) return;
        onOpenChatSurface?.();
        setSelectedRoomId(room.id);
        setActiveAiSurface('room');
    }, [onOpenChatSurface, teamRooms]);

    const switchAdvisor = useCallback((advisorId: string) => {
        const advisor = advisors.find((item) => item.id === advisorId);
        if (!advisor) return;
        onOpenChatSurface?.();
        setSelectedAdvisorId(advisor.id);
        setActiveAiSurface('advisor');
    }, [advisors, onOpenChatSurface]);

    const createAdvisorFromRedClaw = useCallback(() => {
        setAdvisorCreateModalOpen(true);
    }, []);

    const saveAdvisorFromRedClaw = useCallback(async (
        data: Omit<Advisor, 'id' | 'createdAt' | 'knowledgeFiles'>,
        youtubeParams?: { url: string; count: number; channelId?: string },
        knowledgeFilePaths?: string[],
    ) => {
        try {
            const createData: Record<string, unknown> = { ...data };
            if (youtubeParams?.url) {
                createData.youtubeChannel = {
                    url: youtubeParams.url,
                    channelId: youtubeParams.channelId || '',
                };
            }
            const result = await window.ipcRenderer.advisors.create({
                ...createData,
            }) as { success?: boolean; id?: string; error?: string };
            if (result?.success === false) {
                throw new Error(result.error || '创建成员失败');
            }
            if (result?.id && Array.isArray(knowledgeFilePaths) && knowledgeFilePaths.length > 0) {
                await window.ipcRenderer.advisors.uploadKnowledge({
                    advisorId: result.id,
                    filePaths: knowledgeFilePaths,
                });
            }
            const list = await window.ipcRenderer.advisors.list<AdvisorProfile>();
            setAdvisors(Array.isArray(list) ? list : []);
            setAdvisorCreateModalOpen(false);
            if (result?.id) {
                const advisor = Array.isArray(list) ? list.find((item) => item.id === result.id) : null;
                if (advisor) {
                    setSelectedAdvisorId(advisor.id);
                    setActiveAiSurface('advisor');
                }
            }
        } catch (error) {
            console.error('Failed to create advisor from RedClaw:', error);
            setChatActionMessage(error instanceof Error ? error.message : '创建成员失败');
        }
    }, []);

    const createRoomFromRedClaw = useCallback(() => {
        const visibleAdvisorIds = advisors
            .filter((advisor) => advisor.redclawVisible !== false)
            .map((advisor) => advisor.id);
        const defaultAdvisorIds = selectedAdvisorId && visibleAdvisorIds.includes(selectedAdvisorId)
            ? [selectedAdvisorId]
            : visibleAdvisorIds.slice(0, 3);
        setRoomCreateName('');
        setRoomCreateAdvisorIds(defaultAdvisorIds);
        setRoomCreateError('');
        setRoomCreateModalOpen(true);
    }, [advisors, selectedAdvisorId]);

    const closeRoomCreateModal = useCallback(() => {
        if (isCreatingRoom) return;
        setRoomCreateModalOpen(false);
        setRoomCreateName('');
        setRoomCreateAdvisorIds([]);
        setRoomCreateError('');
    }, [isCreatingRoom]);

    const toggleRoomCreateAdvisor = useCallback((advisorId: string) => {
        setRoomCreateAdvisorIds((current) => current.includes(advisorId)
            ? current.filter((id) => id !== advisorId)
            : [...current, advisorId]);
    }, []);

    const submitRoomCreate = useCallback(async () => {
        const name = roomCreateName.trim();
        if (!name) {
            setRoomCreateError('请输入团队名称');
            return;
        }
        if (roomCreateAdvisorIds.length === 0) {
            setRoomCreateError('请至少选择一位成员');
            return;
        }
        setIsCreatingRoom(true);
        setRoomCreateError('');
        try {
            const session = await window.ipcRenderer.teamRuntime.createSession({
                title: name,
                objective: `团队 ${name} 的协作任务`,
                source: 'team-workbench',
                runtimeMode: 'team',
                metadata: {
                    advisorIds: roomCreateAdvisorIds,
                    surface: 'redclaw',
                },
            }) as TeamWorkbenchSession;
            for (const advisorId of roomCreateAdvisorIds) {
                const advisor = advisors.find((item) => item.id === advisorId);
                if (!advisor) continue;
                await window.ipcRenderer.teamRuntime.addMember({
                    sessionId: session.id,
                    displayName: advisor.name || '成员',
                    roleId: advisor.id,
                    backend: 'redbox-runtime',
                    status: 'idle',
                    capabilities: ['discussion', 'creation'],
                    metadata: {
                        advisorId: advisor.id,
                        avatar: advisor.avatar,
                        personality: advisor.personality,
                    },
                });
            }
            const room = teamRoomFromSession({
                ...session,
                metadata: {
                    ...(session.metadata || {}),
                    advisorIds: roomCreateAdvisorIds,
                    surface: 'redclaw',
                },
            });
            setTeamRooms((prev) => [...prev.filter((item) => item.id !== room.id), room]);
            setSelectedRoomId(room.id);
            onOpenChatSurface?.();
            setActiveAiSurface('room');
            setRoomCreateModalOpen(false);
            setRoomCreateName('');
            setRoomCreateAdvisorIds([]);
        } catch (error) {
            console.error('Failed to create RedClaw room:', error);
            setRoomCreateError(error instanceof Error ? error.message : '创建团队失败');
        } finally {
            setIsCreatingRoom(false);
        }
    }, [advisors, onOpenChatSurface, roomCreateAdvisorIds, roomCreateName]);

    const deleteHistorySession = useCallback(async (targetSessionId: string) => {
        if (!targetSessionId) return;
        const nextActiveSpaceId = activeSpaceId || 'default';
        const nextSpaceName = activeSpaceName || nextActiveSpaceId;
        setHistoryLoading(true);
        try {
            await window.ipcRenderer.chat.deleteSession(targetSessionId);
            if (typeof window !== 'undefined' && readRedClawLastSessionId(nextActiveSpaceId) === targetSessionId) {
                localStorage.removeItem(redClawLastSessionStorageKey(nextActiveSpaceId));
            }
            const remaining = sessionListRef.current.filter((item) => item.id !== targetSessionId);
            sessionListRef.current = remaining;
            setSessionList(remaining);

            if (activeSessionIdRef.current !== targetSessionId) {
                return;
            }

            if (remaining.length > 0) {
                activeSessionIdRef.current = remaining[0].id;
                activeSpeakerSessionIdRef.current = remaining[0].id;
                setActiveSessionId(remaining[0].id);
                return;
            }

            const created = await uiMeasure('redclaw', 'sessions:create_after_delete', async () => (
                window.ipcRenderer.invokeGuarded<ChatSession | null>('chat:create-context-session', {
                    contextId: buildRedClawContextId(nextActiveSpaceId),
                    contextType: REDCLAW_CONTEXT_TYPE,
                    title: buildRedClawSessionTitle(nextSpaceName),
                    initialContext: buildRedClawInitialContext(nextSpaceName, nextActiveSpaceId),
                }, {
                    timeoutMs: 3200,
                    fallback: null,
                })
            ), { activeSpaceId: nextActiveSpaceId, spaceName: nextSpaceName });
            if (!created) {
                throw new Error('create context session timed out');
            }
            const nextItem = createContextSessionListItem(created);
            sessionListRef.current = [nextItem];
            setSessionList([nextItem]);
            activeSessionIdRef.current = created.id;
            activeSpeakerSessionIdRef.current = created.id;
            setActiveSessionId(created.id);
        } catch (error) {
            console.error('Failed to delete RedClaw session:', error);
            setChatActionMessage('删除对话失败，请稍后重试');
            void loadContextSessions(nextActiveSpaceId, nextSpaceName, { createIfEmpty: true, silent: true });
        } finally {
            setHistoryLoading(false);
        }
    }, [activeSpaceId, activeSpaceName, loadContextSessions]);

    const deleteUnifiedHistorySession = useCallback(async (session: RedClawHistoryListItem) => {
        if (!session?.id) return;
        if (session.surface === 'redclaw') {
            await deleteHistorySession(session.id);
            return;
        }
        try {
            await window.ipcRenderer.chat.deleteSession(session.id);
            if (session.surface === 'advisor' && session.advisorId) {
                setAdvisorHistorySessions((prev) => prev.filter((item) => item.id !== session.id));
                setAdvisorSessionIds((prev) => {
                    const next = { ...prev };
                    if (next[session.advisorId!] === session.id) delete next[session.advisorId!];
                    return next;
                });
                if (activeAiSurface === 'advisor' && selectedAdvisorId === session.advisorId && activeSpeakerSessionId === session.id) {
                    setActiveAiSurface('redclaw');
                }
                return;
            }
        } catch (error) {
            console.error('Failed to delete unified RedClaw session:', error);
            setChatActionMessage('删除对话失败，请稍后重试');
        }
    }, [activeAiSurface, activeSpeakerSessionId, deleteHistorySession, selectedAdvisorId, selectedRoomId]);

    const deleteRoomFromRedClaw = useCallback(async (room: RedClawTeamRoom) => {
        if (!room?.id) return;
        try {
            await window.ipcRenderer.teamRuntime.archiveSession({ sessionId: room.id });
            setTeamRooms((prev) => prev.filter((item) => item.id !== room.id));
            if (activeAiSurface === 'room' && selectedRoomId === room.id) {
                setSelectedRoomId(null);
                setActiveAiSurface('redclaw');
            }
        } catch (error) {
            console.error('Failed to delete RedClaw room:', error);
            setChatActionMessage(error instanceof Error ? error.message : '删除团队失败');
        }
    }, [activeAiSurface, selectedRoomId]);

    const compactRedClawContext = useCallback(async () => {
        if (!activeSessionId || chatActionLoading) return;
        uiTraceInteraction('redclaw', 'compact_context', { sessionId: activeSessionId });
        setChatActionLoading('compact');
        try {
            const result = await uiMeasure('redclaw', 'compact_context:invoke', async () => (
                window.ipcRenderer.chat.compactContext(activeSessionId)
            ), { sessionId: activeSessionId });
            if (!result?.success) {
                setChatActionMessage(result?.message || '压缩失败，请稍后重试');
                return;
            }
            if (result.compacted) {
                setChatRefreshKey((value) => value + 1);
            }
            setChatActionMessage(result.message || (result.compacted ? '上下文已压缩' : '暂无可压缩内容'));
        } catch (error) {
            console.error('Failed to compact RedClaw context:', error);
            setChatActionMessage('压缩失败，请稍后重试');
        } finally {
            setChatActionLoading(null);
        }
    }, [activeSessionId, chatActionLoading]);

    const toggleSkill = useCallback(async (skill: SkillDefinition) => {
        try {
            const res = (
                skill.disabled
                    ? await window.ipcRenderer.skills.enable({ name: skill.name })
                    : await window.ipcRenderer.skills.disable({ name: skill.name })
            ) as { success?: boolean; error?: string };
            if (!res?.success) {
                setSkillsMessage(res?.error || '技能状态更新失败');
                return;
            }
            setSkillsMessage(skill.disabled ? `已启用：${skill.name}` : `已禁用：${skill.name}`);
            await loadSkills();
        } catch (error) {
            console.error('Failed to toggle skill:', error);
            setSkillsMessage('技能状态更新失败');
        }
    }, [loadSkills]);

    const installSkill = useCallback(async () => {
        if (isInstallingSkill) return;

        const slug = normalizeClawHubSlug(installSource);
        if (!slug) {
            setSkillsMessage('请输入 ClawHub 技能 slug 或技能链接');
            return;
        }

        setIsInstallingSkill(true);
        try {
            const result = await window.ipcRenderer.skills.marketInstall({ slug, tag: 'latest' }) as {
                success?: boolean;
                error?: string;
                displayName?: string;
            };
            if (!result?.success) {
                setSkillsMessage(result?.error || '技能安装失败');
                return;
            }
            setInstallSource('');
            setSkillsMessage(`已安装技能：${result.displayName || slug}`);
            await loadSkills();
        } catch (error) {
            console.error('Failed to install skill:', error);
            setSkillsMessage('技能安装失败');
        } finally {
            setIsInstallingSkill(false);
        }
    }, [installSource, isInstallingSkill, loadSkills]);

    const toggleRunner = useCallback(async () => {
        if (!runnerStatus) return;
        setAutomationLoading(true);
        try {
            if (runnerStatus.enabled) {
                await window.ipcRenderer.redclawRunner.stop();
                setAutomationMessage('后台任务已暂停');
            } else {
                await window.ipcRenderer.redclawRunner.start({
                    intervalMinutes: runnerIntervalMinutes,
                    maxAutomationPerTick: runnerMaxAutomationPerTick,
                    heartbeatEnabled,
                    heartbeatIntervalMinutes,
                });
                setAutomationMessage('后台任务已启动');
            }
            await loadRunnerStatus(true);
        } catch (error) {
            console.error('Failed to toggle runner:', error);
            setAutomationMessage('更新后台状态失败');
        } finally {
            setAutomationLoading(false);
        }
    }, [
        heartbeatEnabled,
        heartbeatIntervalMinutes,
        loadRunnerStatus,
        runnerIntervalMinutes,
        runnerMaxAutomationPerTick,
        runnerStatus,
    ]);

    const runRunnerNow = useCallback(async () => {
        setAutomationLoading(true);
        try {
            await window.ipcRenderer.redclawRunner.runNow({});
            setAutomationMessage('已触发后台立即执行');
            await loadRunnerStatus(false);
        } catch (error) {
            console.error('Failed to run runner now:', error);
            setAutomationMessage('触发后台执行失败');
        } finally {
            setAutomationLoading(false);
        }
    }, [loadRunnerStatus]);

    const saveRunnerConfig = useCallback(async () => {
        setAutomationLoading(true);
        try {
            await window.ipcRenderer.redclawRunner.setConfig({
                intervalMinutes: runnerIntervalMinutes,
                maxAutomationPerTick: runnerMaxAutomationPerTick,
            });
            setAutomationMessage('后台配置已保存');
            await loadRunnerStatus(true);
        } catch (error) {
            console.error('Failed to save runner config:', error);
            setAutomationMessage('保存后台配置失败');
        } finally {
            setAutomationLoading(false);
        }
    }, [loadRunnerStatus, runnerIntervalMinutes, runnerMaxAutomationPerTick]);

    const saveHeartbeatConfig = useCallback(async () => {
        setAutomationLoading(true);
        try {
            await window.ipcRenderer.redclawRunner.setConfig({
                heartbeatEnabled,
                heartbeatIntervalMinutes,
                heartbeatSuppressEmptyReport: heartbeatSuppressEmpty,
                heartbeatReportToMainSession,
            });
            setAutomationMessage('心跳配置已保存');
            await loadRunnerStatus(true);
        } catch (error) {
            console.error('Failed to save heartbeat config:', error);
            setAutomationMessage('保存心跳配置失败');
        } finally {
            setAutomationLoading(false);
        }
    }, [heartbeatEnabled, heartbeatIntervalMinutes, heartbeatReportToMainSession, heartbeatSuppressEmpty, loadRunnerStatus]);

    const applyScheduleTemplate = useCallback((templateId: string) => {
        const template = pickScheduleTemplate(templateId);
        setScheduleDraft(scheduleDraftFromTemplate(template));
    }, []);

    const addScheduleTask = useCallback(async () => {
        if (isAddingSchedule) return;
        const draft = scheduleDraft;
        if (!draft.prompt.trim()) {
            setAutomationMessage('任务指令不能为空');
            return;
        }
        if ((draft.mode === 'daily' || draft.mode === 'weekly') && !draft.time.trim()) {
            setAutomationMessage('请设置执行时间');
            return;
        }
        if (draft.mode === 'weekly' && draft.weekdays.length === 0) {
            setAutomationMessage('请至少选择一个周几');
            return;
        }

        let runAt: string | undefined;
        if (draft.mode === 'once') {
            const ms = new Date(draft.runAtLocal).getTime();
            if (!Number.isFinite(ms)) {
                setAutomationMessage('请设置一次性任务时间');
                return;
            }
            runAt = new Date(ms).toISOString();
        }

        setIsAddingSchedule(true);
        try {
            const result = await window.ipcRenderer.redclawRunner.addScheduled({
                name: draft.name.trim() || '定时任务',
                mode: draft.mode,
                prompt: draft.prompt.trim(),
                intervalMinutes: draft.mode === 'interval' ? draft.intervalMinutes : undefined,
                time: draft.mode === 'daily' || draft.mode === 'weekly' ? draft.time : undefined,
                weekdays: draft.mode === 'weekly' ? draft.weekdays : undefined,
                runAt,
                enabled: true,
            });
            if (!result?.success) {
                setAutomationMessage(result?.error || '新增定时任务失败');
                return;
            }
            setAutomationMessage('已新增定时任务');
            applyScheduleTemplate(draft.templateId);
            await loadRunnerStatus(false);
        } catch (error) {
            console.error('Failed to add schedule task:', error);
            setAutomationMessage('新增定时任务失败');
        } finally {
            setIsAddingSchedule(false);
        }
    }, [applyScheduleTemplate, isAddingSchedule, loadRunnerStatus, scheduleDraft]);

    const toggleScheduleTask = useCallback(async (task: RunnerScheduledTask) => {
        setAutomationLoading(true);
        try {
            const result = await window.ipcRenderer.redclawRunner.setScheduledEnabled({
                taskId: task.id,
                enabled: !task.enabled,
            });
            if (!result?.success) {
                setAutomationMessage(result?.error || '更新定时任务失败');
                return;
            }
            setAutomationMessage(task.enabled ? '定时任务已暂停' : '定时任务已启用');
            await loadRunnerStatus(false);
        } catch (error) {
            console.error('Failed to toggle schedule task:', error);
            setAutomationMessage('更新定时任务失败');
        } finally {
            setAutomationLoading(false);
        }
    }, [loadRunnerStatus]);

    const runScheduleTaskNow = useCallback(async (taskId: string) => {
        setAutomationLoading(true);
        try {
            const result = await window.ipcRenderer.redclawRunner.runScheduledNow({ taskId });
            if (!result?.success) {
                setAutomationMessage(result?.error || '触发执行失败');
                return;
            }
            setAutomationMessage('已触发定时任务执行');
            await loadRunnerStatus(false);
        } catch (error) {
            console.error('Failed to run schedule now:', error);
            setAutomationMessage('触发执行失败');
        } finally {
            setAutomationLoading(false);
        }
    }, [loadRunnerStatus]);

    const removeScheduleTask = useCallback(async (taskId: string) => {
        setAutomationLoading(true);
        try {
            const result = await window.ipcRenderer.redclawRunner.removeScheduled({ taskId });
            if (!result?.success) {
                setAutomationMessage(result?.error || '删除定时任务失败');
                return;
            }
            setAutomationMessage('定时任务已删除');
            await loadRunnerStatus(false);
        } catch (error) {
            console.error('Failed to remove schedule task:', error);
            setAutomationMessage('删除定时任务失败');
        } finally {
            setAutomationLoading(false);
        }
    }, [loadRunnerStatus]);

    const applyLongTemplate = useCallback((templateId: string) => {
        const template = pickLongTemplate(templateId);
        setLongDraft(longDraftFromTemplate(template));
    }, []);

    const addLongTask = useCallback(async () => {
        if (isAddingLong) return;
        const draft = longDraft;
        if (!draft.objective.trim() || !draft.stepPrompt.trim()) {
            setAutomationMessage('请填写长期目标与每轮指令');
            return;
        }

        setIsAddingLong(true);
        try {
            const result = await window.ipcRenderer.redclawRunner.addLongCycle({
                name: draft.name.trim() || '长周期任务',
                objective: draft.objective.trim(),
                stepPrompt: draft.stepPrompt.trim(),
                intervalMinutes: draft.intervalMinutes,
                totalRounds: draft.totalRounds,
                enabled: true,
            });
            if (!result?.success) {
                setAutomationMessage(result?.error || '新增长周期任务失败');
                return;
            }
            setAutomationMessage('已新增长周期任务');
            applyLongTemplate(draft.templateId);
            await loadRunnerStatus(false);
        } catch (error) {
            console.error('Failed to add long task:', error);
            setAutomationMessage('新增长周期任务失败');
        } finally {
            setIsAddingLong(false);
        }
    }, [applyLongTemplate, isAddingLong, loadRunnerStatus, longDraft]);

    const toggleLongTask = useCallback(async (task: RunnerLongCycleTask) => {
        setAutomationLoading(true);
        try {
            const result = await window.ipcRenderer.redclawRunner.setLongCycleEnabled({
                taskId: task.id,
                enabled: !task.enabled,
            });
            if (!result?.success) {
                setAutomationMessage(result?.error || '更新长周期任务失败');
                return;
            }
            setAutomationMessage(task.enabled ? '长周期任务已暂停' : '长周期任务已启用');
            await loadRunnerStatus(false);
        } catch (error) {
            console.error('Failed to toggle long task:', error);
            setAutomationMessage('更新长周期任务失败');
        } finally {
            setAutomationLoading(false);
        }
    }, [loadRunnerStatus]);

    const runLongTaskNow = useCallback(async (taskId: string) => {
        setAutomationLoading(true);
        try {
            const result = await window.ipcRenderer.redclawRunner.runLongCycleNow({ taskId });
            if (!result?.success) {
                setAutomationMessage(result?.error || '触发执行失败');
                return;
            }
            setAutomationMessage('已触发长周期任务执行');
            await loadRunnerStatus(false);
        } catch (error) {
            console.error('Failed to run long task now:', error);
            setAutomationMessage('触发执行失败');
        } finally {
            setAutomationLoading(false);
        }
    }, [loadRunnerStatus]);

    const removeLongTask = useCallback(async (taskId: string) => {
        setAutomationLoading(true);
        try {
            const result = await window.ipcRenderer.redclawRunner.removeLongCycle({ taskId });
            if (!result?.success) {
                setAutomationMessage(result?.error || '删除长周期任务失败');
                return;
            }
            setAutomationMessage('长周期任务已删除');
            await loadRunnerStatus(false);
        } catch (error) {
            console.error('Failed to remove long task:', error);
            setAutomationMessage('删除长周期任务失败');
        } finally {
            setAutomationLoading(false);
        }
    }, [loadRunnerStatus]);

    const onboardingKnown = onboardingState !== undefined;
    const onboardingCompleted = useMemo(
        () => onboardingState !== undefined && isRedClawOnboardingCompleted(onboardingState),
        [onboardingState],
    );

    const welcomeActions = useMemo(() => {
        const actions = [];
        if (onboardingKnown && !onboardingCompleted) {
            actions.push({
                label: '定义这个空间',
                onClick: () => onOpenRedClawOnboarding?.(),
                icon: <Sparkles className="w-5 h-5" />,
                color: 'text-amber-500',
            });
        } else if (onboardingKnown) {
            actions.push({
                label: '重新定义空间风格',
                onClick: () => onOpenRedClawOnboarding?.(),
                icon: <SlidersHorizontal className="w-5 h-5" />,
                color: 'text-stone-700',
            });
        }
        actions.push(
            {
                label: '想吐槽或提建议?',
                url: 'https://github.com/Jamailar/RedBox/issues',
                icon: <MessageSquarePlus className="w-5 h-5" />,
            },
            {
                label: '喜欢我就点个 Star 吧',
                url: 'https://github.com/Jamailar/RedBox',
                icon: <Heart className="w-5 h-5 fill-current" />,
                color: 'text-rose-500'
            }
        );
        return actions;
    }, [onOpenRedClawOnboarding, onboardingCompleted, onboardingKnown]);

    const handlePreviewLink = useCallback((target: ChatMessageLinkTarget) => {
        setPreviewTarget(target);
        const source = String(target.localPathCandidate || target.href || '').trim();
        if (!source || /^https?:\/\//i.test(source)) return;

        void (async () => {
            try {
                const result = await window.ipcRenderer.files.resolvePreview({ source }) as FilePreviewResolveResult;
                if (!result?.success) {
                    setPreviewTarget((current) => current?.href === target.href
                        ? { ...current, error: result?.error || '解析文件路径失败' }
                        : current);
                    return;
                }
                const localCandidate = String(result.localPathCandidate || result.absolutePath || source).trim();
                const rawResolved = String(result.resolvedUrl || localCandidate || target.resolvedUrl || '').trim();
                const resolvedUrl = rawResolved ? resolveAssetUrl(rawResolved) : '';
                setPreviewTarget((current) => current?.href === target.href
                    ? {
                        ...current,
                        label: String(result.title || current.label || target.label),
                        kind: normalizePreviewKind(result.kind, current.kind),
                        resolvedUrl: resolvedUrl || current.resolvedUrl,
                        isLocal: result.isLocal ?? current.isLocal,
                        localPathCandidate: localCandidate || current.localPathCandidate,
                        extension: String(result.extension || current.extension || '').trim() || undefined,
                        exists: result.exists,
                        isDirectory: result.isDirectory,
                        mimeType: String(result.mimeType || '').trim() || undefined,
                        sizeBytes: typeof result.sizeBytes === 'number' ? result.sizeBytes : undefined,
                        previewText: typeof result.previewText === 'string' ? result.previewText : undefined,
                        error: result.exists === false ? '文件不存在或已被移动' : undefined,
                    }
                    : current);
            } catch (error) {
                console.error('Failed to resolve RedClaw preview target:', error);
                setPreviewTarget((current) => current?.href === target.href
                    ? { ...current, error: '解析文件路径失败' }
                    : current);
            }
        })();
    }, []);

    const handleClosePreview = useCallback(() => {
        setPreviewTarget(null);
    }, []);

    const handleOpenPreviewExternal = useCallback(async (target: ChatMessageLinkTarget) => {
        const source = String(target.localPathCandidate || target.href || '').trim();
        if (!source) return;
        try {
            const result = await window.ipcRenderer.openPath(source);
            if (result && result.success === false) {
                setChatActionMessage(result.error || '打开文件失败');
            }
        } catch (error) {
            console.error('Failed to open RedClaw preview target:', error);
            setChatActionMessage('打开文件失败');
        }
    }, []);

    const handleRevealPreviewInFolder = useCallback(async (target: ChatMessageLinkTarget) => {
        const source = String(target.localPathCandidate || target.href || '').trim();
        if (!source || !target.isLocal) return;
        try {
            const result = await window.ipcRenderer.files.showInFolder({ source }) as { success?: boolean; error?: string };
            if (result && result.success === false) {
                setChatActionMessage(result.error || '定位文件失败');
            }
        } catch (error) {
            console.error('Failed to reveal RedClaw preview target:', error);
            setChatActionMessage('定位文件失败');
        }
    }, []);

    const handleRedClawDispatchOverride = useCallback(async (payload: {
        sessionId?: string;
        message: string;
        displayContent: string;
    }) => {
        const goal = String(payload.message || payload.displayContent || '').trim();
        if (!goal) return false;
        if (!shouldUseRedClawTeam(goal)) return false;
        const result = await window.ipcRenderer.redclawOrchestration.createRun({
            goal,
            sessionId: payload.sessionId || activeSessionId || undefined,
        });
        if (!result?.success || !result.runtimeTaskId) {
            throw new Error(String(result?.error || `${REDCLAW_DISPLAY_NAME} 自动组队失败`));
        }
        const resumeResult = await window.ipcRenderer.tasks.resume({ taskId: result.runtimeTaskId }) as {
            success?: boolean;
            error?: string;
        };
        if (resumeResult && resumeResult.success === false) {
            throw new Error(resumeResult.error || `${REDCLAW_DISPLAY_NAME} 自动执行失败`);
        }
        const roleCount = Array.isArray(result.graph?.nodes) ? result.graph.nodes.length : 0;
        return {
            handled: true,
            assistantContent: [
                `${REDCLAW_DISPLAY_NAME} 已自动组建创作团队，开始执行：${goal}`,
                roleCount > 0 ? `本次会由 ${roleCount} 个岗位接力完成，进度和交付物会回到当前消息流。` : '进度和交付物会回到当前消息流。',
                result.runtimeTaskId ? `任务 ID：${result.runtimeTaskId}` : '',
            ].filter(Boolean).join('\n\n'),
        };
    }, [activeSessionId]);

    useEffect(() => {
        if (!onGlobalSidebarContentChange) return;
        onGlobalSidebarContentChange(
            <RedClawHistorySidebarSection
                historyLoading={historyLoading}
                sessionList={unifiedHistorySessions}
                activeSessionId={activeAiSurface === 'room' ? null : activeSpeakerSessionId}
                teamRooms={teamRooms}
                activeRoomId={selectedRoomId}
                activeSurface={activeAiSurface}
                sessionActivityById={sessionActivityById}
                onCreateRoom={createRoomFromRedClaw}
                onSwitchRoom={switchRoom}
                onDeleteRoom={(room) => void deleteRoomFromRedClaw(room)}
                onSwitchSession={switchHistorySession}
                onDeleteSession={(session) => void deleteUnifiedHistorySession(session)}
                onRenameSession={renameUnifiedHistorySession}
                onOpenManuscript={onOpenManuscript}
            />
        );
    }, [
        activeAiSurface,
        activeSpeakerSessionId,
        createRoomFromRedClaw,
        deleteRoomFromRedClaw,
        deleteUnifiedHistorySession,
        historyLoading,
        onGlobalSidebarContentChange,
        onOpenManuscript,
        renameUnifiedHistorySession,
        selectedRoomId,
        sessionActivityById,
        switchHistorySession,
        switchRoom,
        teamRooms,
        unifiedHistorySessions,
    ]);

    useEffect(() => () => {
        onGlobalSidebarContentChange?.(null);
    }, [onGlobalSidebarContentChange]);

    if (!isActive && shouldSyncGlobalHistory) {
        return <div className="hidden" />;
    }


    return (
        <div className="h-full min-h-0 flex overflow-hidden">
            <div className="relative flex-1 min-w-0 overflow-hidden">
                {isSessionLoading ? (
                    <div className="h-full flex items-center justify-center">
                        <div className="flex flex-col items-center gap-3 text-text-tertiary">
                            <Loader2 className="w-6 h-6 animate-spin" />
                            <span className="text-xs">正在初始化 {REDCLAW_DISPLAY_NAME}...</span>
                        </div>
                    </div>
                ) : (
                    <div className="h-full min-h-0 flex flex-col">
                        <div className="relative min-h-0 flex-1 overflow-hidden">
                            {onboardingKnown && !onboardingCompleted && !hideOnboardingPrompt && (
                                <div className="pointer-events-none absolute inset-x-0 top-4 z-20 flex justify-center px-4">
                                    <div className="pointer-events-auto w-full max-w-2xl rounded-[28px] border border-amber-300/20 bg-[linear-gradient(135deg,rgba(24,18,14,0.96),rgba(17,13,15,0.94))] p-5 text-white shadow-[0_30px_80px_rgba(0,0,0,0.28)] backdrop-blur-xl">
                                        <div className="flex items-start justify-between gap-4">
                                            <div className="space-y-3">
                                                <div className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/6 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-white/58">
                                                    <Sparkles className="h-3.5 w-3.5 text-amber-300" />
                                                    来自 {REDCLAW_DISPLAY_NAME}
                                                </div>
                                                <div className="space-y-2">
                                                    <div className="text-lg font-semibold">先定义这个空间的经营方向和写作风格</div>
                                                    <p className="max-w-xl text-sm leading-6 text-white/68">
                                                        这会影响我后续怎么帮你定调性、写内容、安排转化。先做完这组 10 题，再开始长期创作会更准。
                                                    </p>
                                                </div>
                                                <button
                                                    type="button"
                                                    onClick={() => onOpenRedClawOnboarding?.()}
                                                    className="inline-flex items-center gap-2 rounded-full bg-white px-4 py-2 text-sm font-semibold text-black transition hover:scale-[0.99]"
                                                >
                                                    <SlidersHorizontal className="h-4 w-4" />
                                                    开始定义这个空间
                                                </button>
                                            </div>
                                            <button
                                                type="button"
                                                onClick={() => setHideOnboardingPrompt(true)}
                                                className="inline-flex h-9 w-9 items-center justify-center rounded-full border border-white/10 bg-white/6 text-white/65 transition hover:bg-white/10"
                                                aria-label="稍后再说"
                                            >
                                                <X className="h-4 w-4" />
                                            </button>
                                        </div>
                                    </div>
                                </div>
                            )}
                            <div className="h-full min-h-0 w-full overflow-hidden">
                                {activeAiSurface === 'room' ? (
                                    selectedRoom?.session ? (
                                        <TeamWorkbench
                                            session={selectedRoom.session}
                                            isActive={isActive}
                                        />
                                    ) : (
                                        <div className="flex h-full items-center justify-center text-sm text-text-tertiary">
                                            请选择或创建团队
                                        </div>
                                    )
                                ) : speakerSessionLoading ? (
                                    <div className="flex h-full items-center justify-center">
                                        <div className="flex flex-col items-center gap-3 text-text-tertiary">
                                            <Loader2 className="h-6 w-6 animate-spin" />
                                            <span className="text-xs">正在切换发言人...</span>
                                        </div>
                                    </div>
                                ) : (
                                    <Chat
                                        isActive={isActive}
                                        onExecutionStateChange={setIsRedClawChatExecuting}
                                        key={`redclaw:${activeAiSurface}:${activeAiSurface === 'advisor' ? selectedAdvisorId || 'advisor' : 'redclaw'}:${chatRefreshKey}`}
                                        fixedSessionId={activeSpeakerSessionId}
                                        fixedSessionDraft={!activeSpeakerSessionId}
                                        onEnsureSessionForSend={ensureActiveSpeakerSessionForSend}
                                        pendingMessage={activeAiSurface === 'redclaw' ? resolvedPendingMessage : null}
                                        onMessageConsumed={onPendingMessageConsumed}
                                        showClearButton={false}
                                        fixedSessionBannerText=""
                                        showWelcomeShortcuts={true}
                                        showComposerShortcuts={true}
                                        fixedSessionContextIndicatorMode="corner-ring"
                                        shortcuts={composerShortcuts}
                                        welcomeShortcuts={welcomeShortcuts}
                                        embeddedTheme="auto"
                                        welcomeTitle={activeWelcomeTitle}
                                        welcomeSubtitle=""
                                        welcomeIconSrc={activeWelcomeAvatarText ? undefined : activeWelcomeIconSrc}
                                        welcomeAvatarText={activeWelcomeAvatarText}
                                        welcomeIconVariant={activeWelcomeIconVariant}
                                        welcomeIconAccessory={(
                                            <RedClawAiSwitchBar
                                                activeSurface={activeAiSurface}
                                                advisors={advisors}
                                                selectedAdvisorId={selectedAdvisorId}
                                                onSelectRedClaw={() => setActiveAiSurface('redclaw')}
                                                onSelectAdvisor={switchAdvisor}
                                                onCreateAdvisor={createAdvisorFromRedClaw}
                                            />
                                        )}
                                        welcomeActions={welcomeActions}
                                        contentLayout="wide"
                                        contentWidthPreset={previewTarget ? 'default' : 'narrow'}
                                        allowFileUpload={true}
                                        attachmentPreviewMode="compact-status"
                                        messageWorkflowPlacement="bottom"
                                        messageWorkflowVariant="compact"
                                        messageWorkflowEmphasis="default"
                                        messageWorkflowAutoHideWhenComplete={true}
                                        messageWorkflowFailureTone="neutral"
                                        messageLinkRenderMode="preview-card"
                                        onMessageLinkPreview={handlePreviewLink}
                                        activePreviewHref={previewTarget?.href || null}
                                        keepComposerInputActive={true}
                                        placeholder={`描述创作目标，${REDCLAW_DISPLAY_NAME} 会判断是否需要组队\n使用 # 调用知识库`}
                                        fixedMemberMention={activeSpeakerMention}
                                        onSessionActivity={markHistorySessionActivity}
                                        onDispatchOverride={activeAiSurface === 'redclaw' ? handleRedClawDispatchOverride : undefined}
                                        messageListHeader={<RedClawImageGenerationProgressPanel jobs={activeAiSurface === 'redclaw' ? visibleImageJobs : []} />}
                                        inlineSidePanel={previewTarget ? (
                                            <RedClawFilePreviewPane
                                                target={previewTarget}
                                                onClose={handleClosePreview}
                                                onOpenExternal={handleOpenPreviewExternal}
                                                onRevealInFolder={handleRevealPreviewInFolder}
                                            />
                                        ) : null}
                                    />
                                )}
                            </div>
                            <RedClawSidebar
                                open={!sidebarCollapsed}
                                chatActionMessage={chatActionMessage}
                                skills={skills}
                                isSkillsLoading={isSkillsLoading}
                                skillsMessage={skillsMessage}
                                enabledSkillCount={enabledSkillCount}
                                installSource={installSource}
                                isInstallingSkill={isInstallingSkill}
                                onCollapse={() => setSidebarCollapsed(true)}
                                onInstallSourceChange={setInstallSource}
                                onInstallSkill={() => void installSkill()}
                                onToggleSkill={(skill) => void toggleSkill(skill)}
                            />
                            {advisorCreateModalOpen && (
                                <AdvisorModal
                                    advisor={null}
                                    defaultMode="manual"
                                    onSave={saveAdvisorFromRedClaw}
                                    onClose={() => setAdvisorCreateModalOpen(false)}
                                />
                            )}
                            {roomCreateModalOpen && (
                                <div
                                    className="fixed inset-0 z-[160] flex items-center justify-center bg-black/[0.28] px-4 backdrop-blur-sm"
                                    onMouseDown={closeRoomCreateModal}
                                >
                                    <div
                                        className="w-full max-w-[420px] rounded-2xl border border-border bg-surface-primary p-5 shadow-[0_24px_70px_-30px_rgba(0,0,0,0.55)]"
                                        onMouseDown={(event) => event.stopPropagation()}
                                    >
                                        <div className="mb-4 flex items-center justify-between gap-3">
                                            <div>
                                                <div className="text-base font-semibold text-text-primary">新建团队</div>
                                            </div>
                                            <button
                                                type="button"
                                                onClick={closeRoomCreateModal}
                                                disabled={isCreatingRoom}
                                                className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-text-tertiary transition-colors hover:bg-surface-secondary hover:text-text-primary disabled:opacity-50"
                                                aria-label="关闭"
                                            >
                                                <X className="h-4 w-4" />
                                            </button>
                                        </div>

                                        <div className="space-y-3">
                                            <input
                                                autoFocus
                                                value={roomCreateName}
                                                onChange={(event) => setRoomCreateName(event.target.value)}
                                                onKeyDown={(event) => {
                                                    if (event.key === 'Enter') {
                                                        event.preventDefault();
                                                        void submitRoomCreate();
                                                    } else if (event.key === 'Escape') {
                                                        closeRoomCreateModal();
                                                    }
                                                }}
                                                className="h-10 w-full rounded-xl border border-border bg-surface-secondary/40 px-3 text-sm text-text-primary outline-none transition focus:border-accent-primary/60 focus:bg-surface-primary focus:ring-2 focus:ring-accent-primary/10"
                                                placeholder="团队名称"
                                            />

                                            <div className="max-h-56 overflow-y-auto rounded-xl border border-border/80 p-1 custom-scrollbar">
                                                {advisors.filter((advisor) => advisor.redclawVisible !== false).length === 0 ? (
                                                    <div className="px-3 py-4 text-center text-xs text-text-tertiary">暂无可选成员</div>
                                                ) : advisors.filter((advisor) => advisor.redclawVisible !== false).map((advisor) => {
                                                    const checked = roomCreateAdvisorIds.includes(advisor.id);
                                                    return (
                                                        <button
                                                            key={advisor.id}
                                                            type="button"
                                                            onClick={() => toggleRoomCreateAdvisor(advisor.id)}
                                                            className={clsx(
                                                                'flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left transition-colors',
                                                                checked ? 'bg-accent-primary/10' : 'hover:bg-surface-secondary/70'
                                                            )}
                                                        >
                                                            <span className={clsx(
                                                                'inline-flex h-4 w-4 shrink-0 items-center justify-center rounded border',
                                                                checked ? 'border-accent-primary bg-accent-primary' : 'border-border bg-surface-primary'
                                                            )}>
                                                                {checked && <span className="h-1.5 w-1.5 rounded-full bg-white" />}
                                                            </span>
                                                            <span className="min-w-0 flex-1">
                                                                <span className="block truncate text-sm font-medium text-text-primary">{advisor.name || '未命名成员'}</span>
                                                                {advisor.personality && (
                                                                    <span className="mt-0.5 block truncate text-[11px] text-text-tertiary">{advisor.personality}</span>
                                                                )}
                                                            </span>
                                                        </button>
                                                    );
                                                })}
                                            </div>

                                            {roomCreateError && (
                                                <div className="rounded-lg border border-red-500/25 bg-red-500/[0.08] px-3 py-2 text-xs text-red-600">
                                                    {roomCreateError}
                                                </div>
                                            )}
                                        </div>

                                        <div className="mt-5 flex items-center justify-end gap-2">
                                            <button
                                                type="button"
                                                onClick={closeRoomCreateModal}
                                                disabled={isCreatingRoom}
                                                className="h-9 rounded-xl border border-border px-4 text-sm text-text-secondary transition-colors hover:bg-surface-secondary hover:text-text-primary disabled:opacity-50"
                                            >
                                                取消
                                            </button>
                                            <button
                                                type="button"
                                                onClick={() => void submitRoomCreate()}
                                                disabled={isCreatingRoom}
                                                className="inline-flex h-9 items-center justify-center rounded-xl bg-accent-primary px-4 text-sm font-medium text-white transition-colors hover:bg-accent-hover disabled:opacity-50"
                                            >
                                                {isCreatingRoom ? '创建中...' : '创建'}
                                            </button>
                                        </div>
                                    </div>
                                </div>
                            )}
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
}
