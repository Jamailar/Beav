import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { clsx } from 'clsx';
import { Archive, Bot, Clock3, Edit3, FileText, Folder, History, Image as ImageIcon, Loader2, MessageSquarePlus, Heart, PanelRight, PanelRightOpen, Pin, Plus, RefreshCw, Sparkles, SlidersHorizontal, Trash2, X } from 'lucide-react';
import { Chat } from './Chat';
import { Advisors, type AdvisorProfile } from './Advisors';
import type { ChatMessageLinkKind, ChatMessageLinkTarget } from '../components/MessageItem';
import type { PendingChatMessage, RedClawNavigationAction } from '../features/app-shell/types';
import { useMediaJobSubscription } from '../features/media-jobs/useMediaJobSubscription';
import { useMediaJobsStore } from '../features/media-jobs/useMediaJobsStore';
import { isMediaJobSuccessful, isMediaJobTerminal, type MediaJobProjection } from '../features/media-jobs/types';
import { subscribeRuntimeEventStream } from '../runtime/runtimeEventStream';
import { uiMeasure, uiTraceInteraction } from '../utils/uiDebug';
import { resolveAssetUrl } from '../utils/pathManager';
import {
    HEARTBEAT_INTERVAL_OPTIONS,
    REDCLAW_CONTEXT_TYPE,
    REDCLAW_DISPLAY_NAME,
    REDCLAW_WELCOME_ICON_SRC,
    RUNNER_INTERVAL_OPTIONS,
    RUNNER_MAX_AUTOMATION_OPTIONS,
    SCHEDULE_TEMPLATES,
    createRedClawComposerShortcutsForContext,
    pickScheduleTemplate,
    scheduleDraftFromTemplate,
} from './redclaw/config';
import {
    buildRedClawContextId,
    buildRedClawInitialContext,
    buildRedClawSessionTitle,
    createContextSessionListItem,
    formatDateTime,
    normalizeClawHubSlug,
    sortContextSessionItems,
} from './redclaw/helpers';
import { RedClawFilePreviewPane } from './redclaw/RedClawFilePreviewPane';
import { RedClawHistoryDrawer, type RedClawHistoryListItem, type RedClawHistorySessionActivity } from './redclaw/RedClawHistoryDrawer';
import {
    isRedClawOnboardingCompleted,
} from './redclaw/onboardingState';
import { RedClawSidebar } from './redclaw/RedClawSidebar';
import type {
    RunnerScheduledTask,
    RunnerStatus,
    ScheduleDraft,
    SidebarTab,
} from './redclaw/types';

interface RedClawProps {
    pendingMessage?: PendingChatMessage | null;
    onPendingMessageConsumed?: () => void;
    navigationAction?: RedClawNavigationAction | null;
    onNavigationActionConsumed?: () => void;
    isActive?: boolean;
    onExecutionStateChange?: (active: boolean) => void;
    onOpenRedClawOnboarding?: () => void;
    redclawOnboardingVersion?: number;
    onGlobalSidebarContentChange?: (content: ReactNode | null) => void;
    onTitleBarActionsChange?: (content: ReactNode | null) => void;
    onOpenChatSurface?: () => void;
    onOpenManuscriptEditor?: (filePath: string) => void;
    onOpenManuscript?: (filePath: string) => void;
    activeManuscriptPath?: string | null;
    onOpenTeamMembers?: () => void;
    titleBarActive?: boolean;
}

interface RedClawSpaceListPayload {
    activeSpaceId: string;
    spaces: Array<{ id: string; name: string }>;
}

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

type RedClawAiSurface = 'redclaw' | 'advisor';
type RedClawGlobalSidebarTab = 'sessions' | 'manuscripts';

interface RedClawManuscriptNode {
    name: string;
    path: string;
    isDirectory: boolean;
    children?: RedClawManuscriptNode[];
    title?: string;
    updatedAt?: number | string;
}

interface RedClawFlatManuscriptNode extends RedClawManuscriptNode {
    depth: number;
}

const ADVISOR_CHAT_CONTEXT_TYPE = 'advisor-discussion';
const PREVIEW_SIDEBAR_ANIMATION_MS = 240;
const REDCLAW_AI_SURFACE_STORAGE_KEY = 'redbox:redclaw-ai-surface:v1';
const REDCLAW_PINNED_SESSION_IDS_STORAGE_KEY = 'redbox:redclaw:pinned-session-ids:v1';
const REDCLAW_HIDDEN_EXTERNAL_SESSION_IDS_STORAGE_KEY = 'redbox:redclaw:hidden-external-session-ids:v1';
const PREVIEW_KIND_SET = new Set<ChatMessageLinkKind>([
    'image',
    'video',
    'audio',
    'manuscript',
    'document',
    'pdf',
    'html',
    'text',
    'archive',
    'web',
    'unknown',
]);

const normalizePreviewKind = (value: unknown, fallback: ChatMessageLinkKind): ChatMessageLinkKind => {
    const normalized = String(value || '').trim().toLowerCase() as ChatMessageLinkKind;
    return PREVIEW_KIND_SET.has(normalized) ? normalized : fallback;
};

function readInitialRedClawAiSurface(): RedClawAiSurface {
    if (typeof window === 'undefined') return 'redclaw';
    const saved = String(window.localStorage.getItem(REDCLAW_AI_SURFACE_STORAGE_KEY) || '').trim();
    return saved === 'advisor' ? 'advisor' : 'redclaw';
}

function readRedClawPinnedSessionIds(): string[] {
    if (typeof window === 'undefined') return [];
    try {
        const raw = window.localStorage.getItem(REDCLAW_PINNED_SESSION_IDS_STORAGE_KEY);
        const parsed = raw ? JSON.parse(raw) : [];
        return Array.isArray(parsed) ? parsed.filter((item) => typeof item === 'string') : [];
    } catch {
        return [];
    }
}

function writeRedClawPinnedSessionIds(ids: string[]): void {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem(REDCLAW_PINNED_SESSION_IDS_STORAGE_KEY, JSON.stringify(ids));
}

function readHiddenExternalSessionIds(): string[] {
    if (typeof window === 'undefined') return [];
    try {
        const raw = window.localStorage.getItem(REDCLAW_HIDDEN_EXTERNAL_SESSION_IDS_STORAGE_KEY);
        const parsed = raw ? JSON.parse(raw) : [];
        return Array.isArray(parsed)
            ? Array.from(new Set(parsed.map((item) => String(item || '').trim()).filter(Boolean)))
            : [];
    } catch (error) {
        console.warn('Failed to read hidden external RedClaw sessions:', error);
        return [];
    }
}

function writeHiddenExternalSessionIds(sessionIds: string[]): void {
    if (typeof window === 'undefined') return;
    try {
        const normalized = Array.from(new Set(sessionIds.map((item) => String(item || '').trim()).filter(Boolean)));
        window.localStorage.setItem(REDCLAW_HIDDEN_EXTERNAL_SESSION_IDS_STORAGE_KEY, JSON.stringify(normalized));
    } catch (error) {
        console.warn('Failed to write hidden external RedClaw sessions:', error);
    }
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

function displayRedClawHistoryTitle(title: string, surface?: RedClawHistoryListItem['surface']): string {
    if (surface !== 'redclaw') return title;
    const legacyAiPrefix = new RegExp(`^${['Red', 'Claw'].join('')}(\\s*·\\s*)`);
    return title.replace(legacyAiPrefix, `${REDCLAW_DISPLAY_NAME}$1`);
}

function redClawHistoryRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : {};
}

function isRedClawAutomationHistorySession(session: RedClawHistoryListItem): boolean {
    if (session.surface !== 'redclaw') return false;
    const sessionId = String(session.id || session.chatSession?.id || '').toLowerCase();
    if (sessionId.includes('automation')) return true;
    const context = redClawHistoryRecord(session.context);
    const metadata = redClawHistoryRecord(session.metadata);
    const contextId = String(
        context.contextId || context.context_id || context.id || metadata.contextId || metadata.context_id || ''
    ).toLowerCase();
    const contextType = String(
        context.contextType || context.context_type || context.type || metadata.contextType || metadata.context_type || ''
    ).toLowerCase();
    const sourceKind = String(context.sourceKind || context.source_kind || metadata.sourceKind || metadata.source_kind || '').toLowerCase();
    return contextId.includes('automation') || contextType === 'automation' || sourceKind === 'scheduled';
}

function redClawManuscriptLabel(node: RedClawManuscriptNode): string {
    return String(node.title || node.name || node.path || '未命名稿件').trim();
}

function sortRedClawManuscripts(nodes: RedClawManuscriptNode[]): RedClawManuscriptNode[] {
    return [...nodes].sort((left, right) => {
        if (left.isDirectory !== right.isDirectory) return left.isDirectory ? -1 : 1;
        const leftUpdated = Number(left.updatedAt || 0);
        const rightUpdated = Number(right.updatedAt || 0);
        if (!left.isDirectory && rightUpdated !== leftUpdated) return rightUpdated - leftUpdated;
        return redClawManuscriptLabel(left).localeCompare(redClawManuscriptLabel(right), 'zh-Hans-CN');
    });
}

function flattenRedClawManuscripts(nodes: RedClawManuscriptNode[], depth = 0): RedClawFlatManuscriptNode[] {
    const output: RedClawFlatManuscriptNode[] = [];
    for (const node of sortRedClawManuscripts(nodes)) {
        output.push({ ...node, depth });
        if (node.isDirectory && Array.isArray(node.children) && node.children.length > 0) {
            output.push(...flattenRedClawManuscripts(node.children, depth + 1));
        }
    }
    return output;
}

function countRedClawManuscriptFiles(nodes: RedClawManuscriptNode[]): number {
    let count = 0;
    for (const node of nodes) {
        if (node.isDirectory) {
            count += countRedClawManuscriptFiles(node.children || []);
        } else {
            count += 1;
        }
    }
    return count;
}

function formatRedClawManuscriptUpdatedAt(value: RedClawManuscriptNode['updatedAt']): string {
    if (!value) return '';
    const date = typeof value === 'number' ? new Date(value) : new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    return date.toLocaleDateString();
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

function canReuseAsFreshSession(sessionItem: ContextChatSessionListItem | null | undefined): boolean {
    if (!sessionItem) return false;
    return Number(sessionItem.messageCount || 0) === 0;
}

function advisorAvatarText(advisor: AdvisorProfile): string {
    const avatar = String(advisor.avatar || '').trim();
    if (avatar && !hasRenderableAdvisorAvatar(advisor)) return avatar.slice(0, 2);
    return String(advisor.name || '成').trim().slice(0, 2);
}

function hasRenderableAdvisorAvatar(advisor: AdvisorProfile): boolean {
    const value = String(advisor.avatar || '').trim();
    return /^(https?:|file:|data:|local-file:|redbox-asset:)/i.test(value) || value.startsWith('/');
}

function advisorRedClawOrder(advisor: AdvisorProfile, index: number): number {
    return Number.isFinite(advisor.redclawOrder) ? Number(advisor.redclawOrder) : index;
}

function visibleRedClawAdvisors(advisors: AdvisorProfile[]): AdvisorProfile[] {
    return advisors
        .map((advisor, index) => ({ advisor, index }))
        .filter(({ advisor }) => advisor.redclawVisible !== false)
        .sort((left, right) => {
            const orderDelta = advisorRedClawOrder(left.advisor, left.index) - advisorRedClawOrder(right.advisor, right.index);
            return orderDelta || left.index - right.index;
        })
        .map(({ advisor }) => advisor);
}

function buildAdvisorInitialContext(advisor: AdvisorProfile): string {
    const knowledgeFiles = Array.isArray(advisor.knowledgeFiles) ? advisor.knowledgeFiles : [];
    const sections = [
        `当前对话绑定成员：${advisor.name}`,
        advisor.personality ? `成员定位：${advisor.personality}` : null,
        `知识库语言：${advisor.knowledgeLanguage || '中文'}`,
        knowledgeFiles.length > 0 ? `已接入知识文件：${knowledgeFiles.length} 个` : '当前暂无知识文件',
        '请始终以该成员身份回答，保持表达风格、专业倾向和角色设定一致。',
        advisor.systemPrompt ? `系统设定：\n${advisor.systemPrompt}` : null,
    ];
    return sections.filter(Boolean).join('\n\n');
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
                    <div key={job.jobId} className="py-1">
                        <div className="mb-3 flex items-center justify-between gap-3">
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
                        <div className="grid max-w-[620px] grid-cols-5 gap-2.5">
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
    const visibleAdvisors = visibleRedClawAdvisors(advisors).slice(0, 6);

    return (
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
                title="RedClaw"
                aria-label="RedClaw"
            >
                <Bot className="h-4 w-4" />
                <span>RedClaw</span>
            </button>
            {visibleAdvisors.length > 0 && <div className="h-5 w-px bg-border" />}
            {visibleAdvisors.map((advisor) => (
                <button
                    key={advisor.id}
                    type="button"
                    onClick={() => onSelectAdvisor(advisor.id)}
                    className={clsx(
                        'flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-full text-[13px] font-semibold transition-all duration-200 ease-out hover:scale-125 active:scale-110',
                        activeSurface === 'advisor' && selectedAdvisorId === advisor.id
                            ? 'bg-accent-primary/10 text-accent-primary'
                            : 'text-text-tertiary hover:bg-surface-primary/70 hover:text-text-primary'
                    )}
                    title={advisor.name}
                    aria-label={advisor.name}
                >
                    {hasRenderableAdvisorAvatar(advisor) ? (
                        <img src={resolveAssetUrl(advisor.avatar)} alt="" className="h-full w-full object-cover" />
                    ) : (
                        advisorAvatarText(advisor)
                    )}
                </button>
            ))}
            <div className="h-5 w-px bg-border" />
            <button
                type="button"
                onClick={onCreateAdvisor}
                className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-text-tertiary transition-colors hover:bg-surface-primary/70 hover:text-text-primary"
                title="成员"
                aria-label="成员"
            >
                <Plus className="h-4 w-4" />
            </button>
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
    onGlobalSidebarContentChange,
    onTitleBarActionsChange,
    onOpenChatSurface,
    onOpenManuscriptEditor,
    onOpenManuscript,
    activeManuscriptPath = null,
    onOpenTeamMembers,
    titleBarActive = false,
}: RedClawProps) {
    const debugUi = useCallback((event: string, extra?: Record<string, unknown>) => {
        if (!import.meta.env.DEV) return;
        console.debug(`[ui][redclaw] ${event}`, extra || {});
    }, []);
    const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
    const [sessionList, setSessionList] = useState<ContextChatSessionListItem[]>([]);
    const [externalAgentSessions, setExternalAgentSessions] = useState<ContextChatSessionListItem[]>([]);
    const [hiddenExternalSessionIds, setHiddenExternalSessionIds] = useState<string[]>(readHiddenExternalSessionIds);
    const [sessionActivityById, setSessionActivityById] = useState<Record<string, RedClawHistorySessionActivity>>({});
    const [isSessionLoading, setIsSessionLoading] = useState(true);
    const [historyLoading, setHistoryLoading] = useState(false);
    const [historyDrawerOpen, setHistoryDrawerOpen] = useState(false);
    const [historyDrawerInitialTab, setHistoryDrawerInitialTab] = useState<'sessions' | 'manuscripts'>('sessions');
    const [previewTarget, setPreviewTarget] = useState<ChatMessageLinkTarget | null>(null);
    const [previewSidebarCollapsed, setPreviewSidebarCollapsed] = useState(false);
    const [isPreviewSidebarClosing, setIsPreviewSidebarClosing] = useState(false);
    const [activeSpaceName, setActiveSpaceName] = useState<string>('默认空间');
    const [activeSpaceId, setActiveSpaceId] = useState<string>('default');
    const [chatRefreshKey, setChatRefreshKey] = useState(0);
    const [chatActionLoading, setChatActionLoading] = useState<'clear' | 'compact' | null>(null);
    const [chatActionMessage, setChatActionMessage] = useState('');

    const [sidebarCollapsed, setSidebarCollapsed] = useState(true);
    const [sidebarTab, setSidebarTab] = useState<SidebarTab>('skills');

    const [skills, setSkills] = useState<SkillDefinition[]>([]);
    const [isSkillsLoading, setIsSkillsLoading] = useState(false);
    const [skillsMessage, setSkillsMessage] = useState('');
    const [installSource, setInstallSource] = useState('');
    const [isInstallingSkill, setIsInstallingSkill] = useState(false);
    const [advisors, setAdvisors] = useState<AdvisorProfile[]>([]);
    const [activeAiSurface, setActiveAiSurface] = useState<RedClawAiSurface>(() => readInitialRedClawAiSurface());
    const [selectedAdvisorId, setSelectedAdvisorId] = useState<string | null>(null);
    const [advisorSessionId, setAdvisorSessionId] = useState<string | null>(null);
    const [isAdvisorSessionLoading, setIsAdvisorSessionLoading] = useState(false);
    const [advisorCreateRequestKey, setAdvisorCreateRequestKey] = useState(0);
    const [chatModelKey, setChatModelKey] = useState('');
    const [globalSidebarTab, setGlobalSidebarTab] = useState<RedClawGlobalSidebarTab>('sessions');
    const [pinnedSessionIds, setPinnedSessionIds] = useState<string[]>(() => readRedClawPinnedSessionIds());
    const [globalManuscriptTree, setGlobalManuscriptTree] = useState<RedClawManuscriptNode[]>([]);
    const [globalManuscriptsLoading, setGlobalManuscriptsLoading] = useState(false);
    const [globalManuscriptsError, setGlobalManuscriptsError] = useState('');
    const [renameSessionTarget, setRenameSessionTarget] = useState<ContextChatSessionListItem | null>(null);
    const [renameSessionTitle, setRenameSessionTitle] = useState('');
    const [renameSessionError, setRenameSessionError] = useState('');
    const [isRenamingSession, setIsRenamingSession] = useState(false);

    const [runnerStatus, setRunnerStatus] = useState<RunnerStatus | null>(null);
    const [automationLoading, setAutomationLoading] = useState(false);
    const [automationMessage, setAutomationMessage] = useState('');
    const [onboardingState, setOnboardingState] = useState<Record<string, unknown> | null>(null);
    const [hideOnboardingPrompt, setHideOnboardingPrompt] = useState(false);
    const [resolvedPendingMessage, setResolvedPendingMessage] = useState<PendingChatMessage | null>(null);
    const trackedMediaJobsById = useMediaJobsStore((state) => state.jobsById);
    const trackedImageJobs = useMemo(() => (
        Object.values(trackedMediaJobsById)
            .filter((job) => job.kind === 'image' && job.ownerSessionId === activeSessionId)
            .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))
    ), [activeSessionId, trackedMediaJobsById]);
    const visibleImageJobs = useMemo(() => (
        trackedImageJobs
            .filter((job) => !isMediaJobSuccessful(job.status) && !isMediaJobTerminal(job.status))
            .slice(0, 3)
    ), [trackedImageJobs]);
    const globalFlatManuscripts = useMemo(() => (
        flattenRedClawManuscripts(globalManuscriptTree).slice(0, 18)
    ), [globalManuscriptTree]);
    const pinnedSessionIdSet = useMemo(() => new Set(pinnedSessionIds), [pinnedSessionIds]);
    const hiddenExternalSessionIdSet = useMemo(() => new Set(hiddenExternalSessionIds), [hiddenExternalSessionIds]);
    const unifiedHistorySessions = useMemo<RedClawHistoryListItem[]>(() => (
        [
            ...sessionList.map((session): RedClawHistoryListItem => ({
                ...session,
                surface: 'redclaw',
                speakerLabel: 'RedClaw',
            })),
            ...externalAgentSessions.map((session): RedClawHistoryListItem => ({
                ...session,
                surface: 'external',
                speakerLabel: 'External Agent',
            })),
        ].sort((left, right) => sessionUpdatedAtMs(right) - sessionUpdatedAtMs(left))
    ), [externalAgentSessions, sessionList]);
    const visibleGlobalSessions = useMemo(() => (
        unifiedHistorySessions
            .map((session, index) => ({ session, index }))
            .sort((left, right) => {
                const leftPinned = left.session.surface !== 'external' && pinnedSessionIdSet.has(left.session.id);
                const rightPinned = right.session.surface !== 'external' && pinnedSessionIdSet.has(right.session.id);
                if (leftPinned !== rightPinned) return leftPinned ? -1 : 1;
                return left.index - right.index;
            })
            .map(({ session }) => session)
    ), [pinnedSessionIdSet, unifiedHistorySessions]);
    const globalManuscriptCount = useMemo(() => (
        countRedClawManuscriptFiles(globalManuscriptTree)
    ), [globalManuscriptTree]);
    const normalizedActiveManuscriptPath = useMemo(() => (
        String(activeManuscriptPath || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
    ), [activeManuscriptPath]);
    const imageJobBootstrapFilter = useMemo(() => activeSessionId ? {
        kind: 'image' as const,
        ownerSessionId: activeSessionId,
        limit: 12,
    } : null, [activeSessionId]);
    useMediaJobSubscription([], {
        enabled: Boolean(activeSessionId),
        bootstrapFilter: imageJobBootstrapFilter,
    });

    const [runnerIntervalMinutes, setRunnerIntervalMinutes] = useState<number>(20);
    const [runnerMaxAutomationPerTick, setRunnerMaxAutomationPerTick] = useState<number>(2);

    const [heartbeatEnabled, setHeartbeatEnabled] = useState(true);
    const [heartbeatIntervalMinutes, setHeartbeatIntervalMinutes] = useState<number>(30);
    const [heartbeatSuppressEmpty, setHeartbeatSuppressEmpty] = useState(true);
    const [heartbeatReportToMainSession, setHeartbeatReportToMainSession] = useState(true);

    const [scheduleAdvanced, setScheduleAdvanced] = useState(false);
    const [scheduleDraft, setScheduleDraft] = useState<ScheduleDraft>(() => scheduleDraftFromTemplate(SCHEDULE_TEMPLATES[0]));
    const [isAddingSchedule, setIsAddingSchedule] = useState(false);
    const sessionRequestIdRef = useRef(0);
    const isActiveRef = useRef(isActive);
    const activeSessionIdRef = useRef<string | null>(null);
    const sessionListRef = useRef<ContextChatSessionListItem[]>([]);
    const runnerStatusRequestIdRef = useRef(0);
    const skillsRequestIdRef = useRef(0);
    const onboardingRequestIdRef = useRef(0);
    const advisorSessionRequestIdRef = useRef(0);
    const hasSessionSnapshotRef = useRef(false);
    const hasRunnerSnapshotRef = useRef(false);
    const hasSkillsSnapshotRef = useRef(false);
    const routedPendingMessageRef = useRef<PendingChatMessage | null>(null);
    const consumedNavigationActionNonceRef = useRef<number | null>(null);
    const previewSidebarAnimationTimerRef = useRef<number | null>(null);

    const clearPreviewSidebarAnimationTimer = useCallback(() => {
        if (previewSidebarAnimationTimerRef.current === null) return;
        window.clearTimeout(previewSidebarAnimationTimerRef.current);
        previewSidebarAnimationTimerRef.current = null;
    }, []);

    useEffect(() => {
        isActiveRef.current = isActive;
    }, [isActive]);

    useEffect(() => {
        activeSessionIdRef.current = activeSessionId;
    }, [activeSessionId]);

    useEffect(() => {
        if (typeof window === 'undefined') return;
        if (!activeSpaceId || !activeSessionId) return;
        localStorage.setItem(redClawLastSessionStorageKey(activeSpaceId), activeSessionId);
    }, [activeSessionId, activeSpaceId]);

    useEffect(() => {
        if (typeof window === 'undefined') return;
        window.localStorage.setItem(REDCLAW_AI_SURFACE_STORAGE_KEY, activeAiSurface);
    }, [activeAiSurface]);

    useEffect(() => {
        sessionListRef.current = sessionList;
    }, [sessionList]);

    const applyHistorySessionUnread = useCallback((sessionId: string | null | undefined, unread: boolean) => {
        const safeSessionId = String(sessionId || '').trim();
        if (!safeSessionId) return;
        const updateItem = <T extends ContextChatSessionListItem,>(item: T): T => {
            if (item.id !== safeSessionId) return item;
            const metadata = item.metadata && typeof item.metadata === 'object' && !Array.isArray(item.metadata)
                ? { ...(item.metadata as Record<string, unknown>) }
                : {};
            if (unread) {
                metadata.unread = true;
            } else {
                delete metadata.unread;
            }
            return {
                ...item,
                unread,
                metadata,
            };
        };
        sessionListRef.current = sessionListRef.current.map(updateItem);
        setSessionList((current) => current.map(updateItem));
        setExternalAgentSessions((current) => current.map(updateItem));
    }, []);

    const setHistorySessionUnread = useCallback((sessionId: string | null | undefined, unread: boolean) => {
        const safeSessionId = String(sessionId || '').trim();
        if (!safeSessionId) return;
        const allItems = [...sessionListRef.current, ...externalAgentSessions];
        const currentItem = allItems.find((item) => item.id === safeSessionId);
        if (!currentItem && !safeSessionId.startsWith('session_bridge_')) return;
        const currentMetadata = currentItem?.metadata && typeof currentItem.metadata === 'object' && !Array.isArray(currentItem.metadata)
            ? currentItem.metadata as Record<string, unknown>
            : null;
        const currentUnread = Boolean(currentItem?.unread) || Boolean(currentMetadata?.unread);
        if (currentItem && currentUnread === unread) return;
        applyHistorySessionUnread(safeSessionId, unread);
        void window.ipcRenderer.chat.setSessionUnread({ sessionId: safeSessionId, unread }).catch((error) => {
            console.error('Failed to update RedClaw session unread state:', error);
        });
    }, [applyHistorySessionUnread, externalAgentSessions]);

    const markSessionRunning = useCallback((sessionId: string | null | undefined) => {
        const safeSessionId = String(sessionId || '').trim();
        if (!safeSessionId) return;
        setSessionActivityById((current) => (
            current[safeSessionId] === 'running' ? current : { ...current, [safeSessionId]: 'running' }
        ));
    }, []);

    const markSessionComplete = useCallback((sessionId: string | null | undefined) => {
        const safeSessionId = String(sessionId || '').trim();
        if (!safeSessionId) return;
        const isCurrentlyOpen = isActiveRef.current && activeSessionIdRef.current === safeSessionId;
        setSessionActivityById((current) => {
            const next = { ...current };
            if (isCurrentlyOpen) {
                delete next[safeSessionId];
            } else {
                next[safeSessionId] = 'unread-complete';
            }
            return next;
        });
        setHistorySessionUnread(safeSessionId, !isCurrentlyOpen);
    }, [setHistorySessionUnread]);

    const clearSessionActivity = useCallback((sessionId: string | null | undefined) => {
        const safeSessionId = String(sessionId || '').trim();
        if (!safeSessionId) return;
        setSessionActivityById((current) => {
            if (!current[safeSessionId]) return current;
            const next = { ...current };
            delete next[safeSessionId];
            return next;
        });
    }, []);

    const clearRunningSessionActivity = useCallback((sessionId: string | null | undefined) => {
        const safeSessionId = String(sessionId || '').trim();
        if (!safeSessionId) return;
        setSessionActivityById((current) => {
            if (current[safeSessionId] !== 'running') return current;
            const next = { ...current };
            delete next[safeSessionId];
            return next;
        });
    }, []);

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

        const activeSession = activeSessionIdRef.current
            ? sessionListRef.current.find((item) => item.id === activeSessionIdRef.current) || null
            : null;
        if (canReuseAsFreshSession(activeSession)) {
            routedPendingMessageRef.current = pendingMessage;
            setResolvedPendingMessage(pendingMessage);
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
                    window.ipcRenderer.chat.createContextSessionGuarded<ChatSession>({
                        contextId,
                        contextType: REDCLAW_CONTEXT_TYPE,
                        title: buildRedClawSessionTitle(nextSpaceName),
                        initialContext: buildRedClawInitialContext(nextSpaceName, nextActiveSpaceId),
                    })
                ), { activeSpaceId: nextActiveSpaceId, spaceName: nextSpaceName });

                if (!session) {
                    throw new Error('create context session timed out');
                }
                if (cancelled) return;

                const nextItem = createContextSessionListItem(session);
                setSessionList((prev) => sortContextSessionItems([nextItem, ...prev.filter((item) => item.id !== session.id)]));
                setActiveSessionId(session.id);
                setChatModelKey('');
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
        const shouldCreateIfEmpty = options?.createIfEmpty !== false;
        if (!hasSessionSnapshotRef.current && !options?.silent) {
            setIsSessionLoading(true);
        }
        if (!options?.silent) {
            setHistoryLoading(true);
        }

        try {
            const contextId = buildRedClawContextId(nextActiveSpaceId);
            const listResult = await uiMeasure('redclaw', 'sessions:list_context', async () => (
                window.ipcRenderer.chat.listContextSessionsGuarded<ContextChatSessionListItem>({
                    contextId,
                    contextType: REDCLAW_CONTEXT_TYPE,
                })
            ), { activeSpaceId: nextActiveSpaceId, spaceName: nextSpaceName }) as ContextChatSessionListItem[];

            if (requestId !== sessionRequestIdRef.current) return;
            if (listResult == null) {
                if (!hasSessionSnapshotRef.current) {
                    setActiveSpaceId(nextActiveSpaceId);
                    setActiveSpaceName(nextSpaceName);
                    setSessionList([]);
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
                    window.ipcRenderer.chat.createContextSessionGuarded<ChatSession>({
                        contextId,
                        contextType: REDCLAW_CONTEXT_TYPE,
                        title: buildRedClawSessionTitle(nextSpaceName),
                        initialContext: buildRedClawInitialContext(nextSpaceName, nextActiveSpaceId),
                    })
                ), { activeSpaceId: nextActiveSpaceId, spaceName: nextSpaceName });
                if (!created) {
                    if (!hasSessionSnapshotRef.current) {
                        setSessionList([]);
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
            await loadContextSessions(nextActiveSpaceId, nextSpaceName, { createIfEmpty: true });
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
                window.ipcRenderer.redclawRunner.getStatus()
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
                window.ipcRenderer.listSkillsGuarded<SkillDefinition>()
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

    const loadAdvisors = useCallback(async () => {
        try {
            const list = await window.ipcRenderer.advisors.list<AdvisorProfile>();
            setAdvisors(Array.isArray(list) ? list : []);
        } catch (error) {
            console.error('Failed to load RedClaw advisors:', error);
        }
    }, []);

    const normalizeExternalAgentSession = useCallback((item: ContextChatSessionListItem): ContextChatSessionListItem => {
        const rawTitle = String(
            item.chatSession?.title
            || (item as unknown as { title?: string }).title
            || '外部 Agent 对话'
        ).trim() || '外部 Agent 对话';
        const rawUpdatedAt = String(
            item.chatSession?.updatedAt
            || (item as unknown as { updatedAt?: string }).updatedAt
            || item.chatSession?.createdAt
            || Date.now()
        );
        const rawCreatedAt = String(
            item.chatSession?.createdAt
            || (item as unknown as { createdAt?: string }).createdAt
            || rawUpdatedAt
        );
        return {
            ...item,
            id: String(item.id || item.chatSession?.id || '').trim(),
            metadata: item.metadata || null,
            chatSession: {
                id: String(item.chatSession?.id || item.id || '').trim(),
                title: rawTitle,
                updatedAt: rawUpdatedAt,
                createdAt: rawCreatedAt,
            },
        };
    }, []);

    const loadExternalAgentSessions = useCallback(async () => {
        try {
            const result = await window.ipcRenderer.sessions.list() as ContextChatSessionListItem[];
            const items = Array.isArray(result)
                ? sortContextSessionItems(result
                    .filter((item) => {
                        const metadata = item.metadata && typeof item.metadata === 'object' && !Array.isArray(item.metadata)
                            ? item.metadata as Record<string, unknown>
                            : {};
                        const sessionId = String(item.id || item.chatSession?.id || '').trim();
                        return String(metadata.source || '').trim() === 'acp'
                            && !hiddenExternalSessionIdSet.has(sessionId)
                            && !item.archived
                            && metadata.archived !== true
                            && String(metadata.status || '').trim() !== 'archived';
                    })
                    .map(normalizeExternalAgentSession))
                : [];
            setExternalAgentSessions(items);
        } catch (error) {
            console.error('Failed to load external RedClaw sessions:', error);
        }
    }, [hiddenExternalSessionIdSet, normalizeExternalAgentSession]);

    useEffect(() => subscribeRuntimeEventStream({
        eventTypes: [
            'runtime:stream-start',
            'runtime:tool-start',
            'runtime:task-node-changed',
            'runtime:cli-install-started',
            'runtime:cli-execution-started',
            'runtime:cli-escalation-requested',
            'runtime:done',
            'runtime:checkpoint',
        ],
        checkpointTypes: [
            'chat.response_end',
            'chat.cancelled',
            'chat.error',
        ],
        onPhaseStart: ({ sessionId }) => markSessionRunning(sessionId),
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
                void loadExternalAgentSessions();
            } else {
                clearRunningSessionActivity(sessionId);
            }
        },
        onChatResponseEnd: ({ sessionId }) => {
            markSessionComplete(sessionId);
            void loadExternalAgentSessions();
        },
        onChatCancelled: ({ sessionId }) => clearRunningSessionActivity(sessionId),
        onChatError: ({ sessionId }) => clearRunningSessionActivity(sessionId),
    }), [
        clearRunningSessionActivity,
        loadExternalAgentSessions,
        markSessionComplete,
        markSessionRunning,
    ]);

    const loadGlobalManuscripts = useCallback(async () => {
        setGlobalManuscriptsLoading(true);
        setGlobalManuscriptsError('');
        try {
            const tree = await window.ipcRenderer.manuscripts.list<RedClawManuscriptNode[]>();
            setGlobalManuscriptTree(Array.isArray(tree) ? sortRedClawManuscripts(tree) : []);
        } catch (error) {
            console.error('Failed to load RedClaw global manuscripts:', error);
            setGlobalManuscriptsError('稿件加载失败');
        } finally {
            setGlobalManuscriptsLoading(false);
        }
    }, []);

    const loadAdvisorSession = useCallback(async (advisor: AdvisorProfile) => {
        const requestId = ++advisorSessionRequestIdRef.current;
        setIsAdvisorSessionLoading(true);
        setAdvisorSessionId(null);

        try {
            const listResult = await uiMeasure('redclaw', 'advisor_session:list_context', async () => (
                window.ipcRenderer.chat.listContextSessionsGuarded<ContextChatSessionListItem>({
                    contextId: advisor.id,
                    contextType: ADVISOR_CHAT_CONTEXT_TYPE,
                })
            ), { advisorId: advisor.id }) as ContextChatSessionListItem[] | null;

            if (requestId !== advisorSessionRequestIdRef.current) return;
            const items = sortContextSessionItems(listResult || []);
            const existingSessionId = items[0]?.id || null;
            if (existingSessionId) {
                setAdvisorSessionId(existingSessionId);
                return;
            }

            const created = await uiMeasure('redclaw', 'advisor_session:create_context', async () => (
                window.ipcRenderer.chat.createContextSessionGuarded<ChatSession>({
                    contextId: advisor.id,
                    contextType: ADVISOR_CHAT_CONTEXT_TYPE,
                    title: `与 ${advisor.name} 聊聊`,
                    initialContext: buildAdvisorInitialContext(advisor),
                })
            ), { advisorId: advisor.id });

            if (requestId !== advisorSessionRequestIdRef.current) return;
            if (!created?.id) {
                throw new Error('create advisor context session timed out');
            }
            setAdvisorSessionId(created.id);
        } catch (error) {
            console.error('Failed to load RedClaw advisor session:', error);
            if (requestId === advisorSessionRequestIdRef.current) {
                setAdvisorSessionId(null);
                setChatActionMessage('打开成员对话失败，请稍后重试');
                setActiveAiSurface('redclaw');
            }
        } finally {
            if (requestId === advisorSessionRequestIdRef.current) {
                setIsAdvisorSessionLoading(false);
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
            setOnboardingState(bundle?.onboardingState || null);
        } catch (error) {
            console.error('Failed to load RedClaw onboarding bundle:', error);
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

    useEffect(() => () => {
        clearPreviewSidebarAnimationTimer();
    }, [clearPreviewSidebarAnimationTimer]);

    useEffect(() => {
        clearPreviewSidebarAnimationTimer();
        setIsPreviewSidebarClosing(false);
        setPreviewSidebarCollapsed(false);
        setPreviewTarget(null);
    }, [activeSessionId, activeSpaceId, clearPreviewSidebarAnimationTimer]);

    useEffect(() => {
        if (!isActive || !activeSessionId) return;
        clearSessionActivity(activeSessionId);
        setHistorySessionUnread(activeSessionId, false);
    }, [activeSessionId, clearSessionActivity, isActive, setHistorySessionUnread]);

    useEffect(() => {
        if (!isActive) return;
        void initSession();
        void loadExternalAgentSessions();
        void loadRunnerStatus(true);
    }, [initSession, isActive, loadExternalAgentSessions, loadRunnerStatus]);

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
        if (!isActive) return;
        const onSpaceChanged = () => {
            void initSession();
            void loadRunnerStatus(true);
            void loadSkills();
            void loadAdvisors();
            void loadExternalAgentSessions();
            void loadOnboardingBundle();
            setHideOnboardingPrompt(false);
        };
        window.ipcRenderer.spaces.onChanged(onSpaceChanged);
        return () => {
            window.ipcRenderer.spaces.offChanged(onSpaceChanged);
        };
    }, [initSession, isActive, loadAdvisors, loadExternalAgentSessions, loadOnboardingBundle, loadRunnerStatus, loadSkills]);

    useEffect(() => {
        setHideOnboardingPrompt(false);
    }, [activeSpaceId]);

    useEffect(() => {
        if (!isActive) return;
        if (sidebarTab !== 'skills') return;
        void loadSkills();
    }, [sidebarTab, loadSkills, isActive]);

    useEffect(() => {
        if (!isActive) return;
        void loadAdvisors();
    }, [isActive, loadAdvisors]);

    useEffect(() => {
        if (!isActive) return;
        const handleAdvisorsChanged = () => {
            void loadAdvisors();
        };
        window.ipcRenderer.advisors.onChanged(handleAdvisorsChanged);
        return () => {
            window.ipcRenderer.advisors.offChanged(handleAdvisorsChanged);
        };
    }, [isActive, loadAdvisors]);

    useEffect(() => {
        if (advisors.length === 0) {
            if (activeAiSurface === 'advisor') {
                setActiveAiSurface('redclaw');
            }
            setSelectedAdvisorId(null);
            setAdvisorSessionId(null);
            return;
        }
        if (!selectedAdvisorId) {
            if (activeAiSurface === 'advisor') {
                const firstVisibleAdvisor = visibleRedClawAdvisors(advisors)[0] || advisors[0];
                setSelectedAdvisorId(firstVisibleAdvisor.id);
            }
            return;
        }
        if (advisors.some((advisor) => advisor.id === selectedAdvisorId)) return;
        setSelectedAdvisorId(null);
        setAdvisorSessionId(null);
        setActiveAiSurface('redclaw');
    }, [activeAiSurface, advisors, selectedAdvisorId]);

    useEffect(() => {
        if (!isActive) return;
        const onRunnerStatus = (_event: unknown, status: RunnerStatus) => {
            if (!status || typeof status !== 'object') return;
            setRunnerStatus(status);
        };
        window.ipcRenderer.redclawRunner.onStatus(onRunnerStatus as (...args: unknown[]) => void);
        return () => {
            window.ipcRenderer.redclawRunner.offStatus(onRunnerStatus as (...args: unknown[]) => void);
        };
    }, [isActive]);

    useEffect(() => {
        if (!isActive) return;
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
                        },
                    }
            ))));
        };
        window.ipcRenderer.chat.onSessionTitleUpdated(onSessionTitleUpdated as (...args: unknown[]) => void);
        return () => {
            window.ipcRenderer.chat.offSessionTitleUpdated(onSessionTitleUpdated as (...args: unknown[]) => void);
        };
    }, [isActive]);

    useEffect(() => {
        if (!isActive || !historyDrawerOpen) return;
        void loadContextSessions(activeSpaceId || 'default', activeSpaceName || '默认空间', {
            preferredSessionId: activeSessionIdRef.current,
            createIfEmpty: true,
            silent: false,
        });
        void loadExternalAgentSessions();
    }, [activeSpaceId, activeSpaceName, historyDrawerOpen, isActive, loadContextSessions, loadExternalAgentSessions]);

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

    const selectedAdvisor = useMemo(() => (
        selectedAdvisorId
            ? advisors.find((advisor) => advisor.id === selectedAdvisorId) || null
            : null
    ), [advisors, selectedAdvisorId]);

    useEffect(() => {
        if (activeAiSurface !== 'advisor') return;
        if (!selectedAdvisor || advisorSessionId || isAdvisorSessionLoading) return;
        void loadAdvisorSession(selectedAdvisor);
    }, [activeAiSurface, advisorSessionId, isAdvisorSessionLoading, loadAdvisorSession, selectedAdvisor]);

    useEffect(() => {
        if (!onGlobalSidebarContentChange || globalSidebarTab !== 'manuscripts') return;
        void loadGlobalManuscripts();
        const timer = window.setInterval(() => {
            void loadGlobalManuscripts();
        }, 5000);
        return () => window.clearInterval(timer);
    }, [globalSidebarTab, loadGlobalManuscripts, onGlobalSidebarContentChange]);

    const createNewSession = useCallback(async () => {
        const nextActiveSpaceId = activeSpaceId || 'default';
        const nextSpaceName = activeSpaceName || nextActiveSpaceId;
        const contextId = buildRedClawContextId(nextActiveSpaceId);
        setHistoryLoading(true);
        try {
            const session = await uiMeasure('redclaw', 'sessions:create_manual', async () => (
                window.ipcRenderer.chat.createContextSessionGuarded<ChatSession>({
                    contextId,
                    contextType: REDCLAW_CONTEXT_TYPE,
                    title: buildRedClawSessionTitle(nextSpaceName),
                    initialContext: buildRedClawInitialContext(nextSpaceName, nextActiveSpaceId),
                })
            ), { activeSpaceId: nextActiveSpaceId, spaceName: nextSpaceName });
            if (!session) {
                throw new Error('create context session timed out');
            }
            const nextItem = createContextSessionListItem(session);
            setSessionList((prev) => sortContextSessionItems([nextItem, ...prev.filter((item) => item.id !== session.id)]));
            setActiveSessionId(session.id);
            setActiveAiSurface('redclaw');
            setChatModelKey('');
            onOpenChatSurface?.();
            hasSessionSnapshotRef.current = true;
            debugUi('sessions:create_done', { sessionId: session.id, activeSpaceId: nextActiveSpaceId });
        } catch (error) {
            console.error('Failed to create RedClaw context session:', error);
            setChatActionMessage('新建对话失败，请稍后重试');
        } finally {
            setHistoryLoading(false);
        }
    }, [activeSpaceId, activeSpaceName, debugUi, onOpenChatSurface]);

    const switchSession = useCallback((nextSessionId: string) => {
        if (!nextSessionId || nextSessionId === activeSessionIdRef.current) return;
        setActiveSessionId(nextSessionId);
        setActiveAiSurface('redclaw');
        setChatModelKey('');
        onOpenChatSurface?.();
        debugUi('sessions:switch', { sessionId: nextSessionId, activeSpaceId });
    }, [activeSpaceId, debugUi, onOpenChatSurface]);

    const openHistoryDrawer = useCallback((tab: 'sessions' | 'manuscripts' = 'sessions') => {
        setHistoryDrawerInitialTab(tab);
        setHistoryDrawerOpen(true);
    }, []);

    const openRenameSessionDialog = useCallback((session: ContextChatSessionListItem) => {
        setRenameSessionTarget(session);
        setRenameSessionTitle(session.chatSession?.title?.trim() || '未命名会话');
        setRenameSessionError('');
    }, []);

    const closeRenameSessionDialog = useCallback(() => {
        if (isRenamingSession) return;
        setRenameSessionTarget(null);
        setRenameSessionTitle('');
        setRenameSessionError('');
    }, [isRenamingSession]);

    const togglePinnedSession = useCallback((sessionId: string) => {
        if (!sessionId) return;
        setPinnedSessionIds((current) => {
            const next = current.includes(sessionId)
                ? current.filter((id) => id !== sessionId)
                : [sessionId, ...current.filter((id) => id !== sessionId)];
            writeRedClawPinnedSessionIds(next);
            return next;
        });
    }, []);

    const submitRenameSession = useCallback(async () => {
        if (!renameSessionTarget || isRenamingSession) return;
        const nextTitle = renameSessionTitle.trim();
        if (!nextTitle) {
            setRenameSessionError('请输入名称');
            return;
        }

        setIsRenamingSession(true);
        setRenameSessionError('');
        try {
            const result = await window.ipcRenderer.chat.renameSession({
                sessionId: renameSessionTarget.id,
                title: nextTitle,
            });
            if (result && result.success === false) {
                throw new Error(result.error || '重命名失败');
            }
            const nextUpdatedAt = result?.session?.updatedAt || new Date().toISOString();
            setSessionList((current) => sortContextSessionItems(current.map((item) => (
                item.id === renameSessionTarget.id
                    ? {
                        ...item,
                        chatSession: {
                            id: item.chatSession?.id || item.id,
                            title: nextTitle,
                            updatedAt: nextUpdatedAt,
                        },
                    }
                    : item
            ))));
            setRenameSessionTarget(null);
            setRenameSessionTitle('');
        } catch (error) {
            setRenameSessionError(error instanceof Error ? error.message : '重命名失败');
        } finally {
            setIsRenamingSession(false);
        }
    }, [isRenamingSession, renameSessionTarget, renameSessionTitle]);

    const openGlobalManuscript = useCallback((path: string) => {
        const normalizedPath = String(path || '').trim();
        if (!normalizedPath) return;
        if (onOpenManuscriptEditor) {
            onOpenManuscriptEditor(normalizedPath);
            return;
        }
        if (onOpenManuscript) {
            onOpenManuscript(normalizedPath);
            return;
        }
        openHistoryDrawer('manuscripts');
    }, [onOpenManuscript, onOpenManuscriptEditor, openHistoryDrawer]);

    const handlePreviewLink = useCallback((target: ChatMessageLinkTarget) => {
        clearPreviewSidebarAnimationTimer();
        setIsPreviewSidebarClosing(false);
        setPreviewTarget(target);
        setPreviewSidebarCollapsed(false);
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
    }, [clearPreviewSidebarAnimationTimer]);

    const handleClosePreview = useCallback(() => {
        if (!previewTarget || isPreviewSidebarClosing) return;
        clearPreviewSidebarAnimationTimer();
        setIsPreviewSidebarClosing(true);
        previewSidebarAnimationTimerRef.current = window.setTimeout(() => {
            setPreviewTarget(null);
            setPreviewSidebarCollapsed(false);
            setIsPreviewSidebarClosing(false);
            previewSidebarAnimationTimerRef.current = null;
        }, PREVIEW_SIDEBAR_ANIMATION_MS);
    }, [clearPreviewSidebarAnimationTimer, isPreviewSidebarClosing, previewTarget]);

    const togglePreviewSidebarCollapsed = useCallback(() => {
        if (!previewTarget) return;
        clearPreviewSidebarAnimationTimer();
        if (previewSidebarCollapsed || isPreviewSidebarClosing) {
            setIsPreviewSidebarClosing(false);
            setPreviewSidebarCollapsed(false);
            return;
        }
        setIsPreviewSidebarClosing(true);
        previewSidebarAnimationTimerRef.current = window.setTimeout(() => {
            setPreviewSidebarCollapsed(true);
            setIsPreviewSidebarClosing(false);
            previewSidebarAnimationTimerRef.current = null;
        }, PREVIEW_SIDEBAR_ANIMATION_MS);
    }, [clearPreviewSidebarAnimationTimer, isPreviewSidebarClosing, previewSidebarCollapsed, previewTarget]);

    const handleOpenPreviewExternal = useCallback(async (target: ChatMessageLinkTarget) => {
        const source = String(target.localPathCandidate || target.href || '').trim();
        if (!source) return;

        if (/^https?:\/\//i.test(target.resolvedUrl)) {
            window.open(target.resolvedUrl, '_blank', 'noopener,noreferrer');
            return;
        }

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

    const handleSelectRedClawShortcut = useCallback(() => {
        advisorSessionRequestIdRef.current += 1;
        setActiveAiSurface('redclaw');
        setIsAdvisorSessionLoading(false);
    }, []);

    const handleSelectAdvisorShortcut = useCallback((advisorId: string) => {
        const advisor = advisors.find((item) => item.id === advisorId);
        if (!advisor) {
            onOpenTeamMembers?.();
            return;
        }
        setSelectedAdvisorId(advisor.id);
        setAdvisorSessionId(null);
        setActiveAiSurface('advisor');
        void loadAdvisorSession(advisor);
    }, [advisors, loadAdvisorSession, onOpenTeamMembers]);

    const handleCreateAdvisorShortcut = useCallback(() => {
        setAdvisorCreateRequestKey((value) => value + 1);
    }, []);

    const handleAdvisorHostChange = useCallback((nextAdvisors: AdvisorProfile[]) => {
        setAdvisors(Array.isArray(nextAdvisors) ? nextAdvisors : []);
    }, []);

    const handleAdvisorHostSelected = useCallback((advisorId: string | null) => {
        const nextAdvisorId = String(advisorId || '').trim();
        if (!nextAdvisorId) return;
        setSelectedAdvisorId(nextAdvisorId);
        setAdvisorSessionId(null);
        setActiveAiSurface('advisor');
    }, []);

    useEffect(() => {
        if (!isActive || !navigationAction) return;
        if (consumedNavigationActionNonceRef.current === navigationAction.nonce) return;
        consumedNavigationActionNonceRef.current = navigationAction.nonce;
        if (navigationAction.action === 'new') {
            void createNewSession();
        } else if ((navigationAction.action === 'open-session' || navigationAction.action === 'open-team') && navigationAction.sessionId) {
            switchSession(navigationAction.sessionId);
            void loadContextSessions(
                activeSpaceId || 'default',
                activeSpaceName || activeSpaceId || 'default',
                {
                    preferredSessionId: navigationAction.sessionId,
                    createIfEmpty: false,
                    silent: true,
                },
            );
        }
        onNavigationActionConsumed?.();
    }, [activeSpaceId, activeSpaceName, createNewSession, isActive, loadContextSessions, navigationAction, onNavigationActionConsumed, switchSession]);

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
            setPinnedSessionIds((current) => {
                if (!current.includes(targetSessionId)) return current;
                const next = current.filter((id) => id !== targetSessionId);
                writeRedClawPinnedSessionIds(next);
                return next;
            });
            const remaining = sessionListRef.current.filter((item) => item.id !== targetSessionId);
            setSessionList(remaining);

            if (activeSessionIdRef.current !== targetSessionId) {
                return;
            }

            if (remaining.length > 0) {
                setActiveSessionId(remaining[0].id);
                setActiveAiSurface('redclaw');
                setChatModelKey('');
                return;
            }

            const created = await uiMeasure('redclaw', 'sessions:create_after_delete', async () => (
                    window.ipcRenderer.chat.createContextSessionGuarded<ChatSession>({
                        contextId: buildRedClawContextId(nextActiveSpaceId),
                        contextType: REDCLAW_CONTEXT_TYPE,
                        title: buildRedClawSessionTitle(nextSpaceName),
                        initialContext: buildRedClawInitialContext(nextSpaceName, nextActiveSpaceId),
                    })
                ), { activeSpaceId: nextActiveSpaceId, spaceName: nextSpaceName });
            if (!created) {
                throw new Error('create context session timed out');
            }
            const nextItem = createContextSessionListItem(created);
            setSessionList([nextItem]);
            setActiveSessionId(created.id);
            setActiveAiSurface('redclaw');
            setChatModelKey('');
        } catch (error) {
            console.error('Failed to delete RedClaw session:', error);
            setChatActionMessage('删除对话失败，请稍后重试');
            void loadContextSessions(nextActiveSpaceId, nextSpaceName, { createIfEmpty: true, silent: true });
        } finally {
            setHistoryLoading(false);
        }
    }, [activeSpaceId, activeSpaceName, loadContextSessions]);

    const archiveUnifiedHistorySession = useCallback(async (session: RedClawHistoryListItem) => {
        const targetSessionId = String(session?.id || '').trim();
        if (!targetSessionId) return;
        const nextActiveSpaceId = activeSpaceId || 'default';
        const nextSpaceName = activeSpaceName || nextActiveSpaceId;
        const isExternalSession = session.surface === 'external';
        setHistoryLoading(true);
        if (isExternalSession) {
            setHiddenExternalSessionIds((current) => {
                if (current.includes(targetSessionId)) return current;
                const next = [...current, targetSessionId];
                writeHiddenExternalSessionIds(next);
                return next;
            });
            setExternalAgentSessions((current) => current.filter((item) => item.id !== targetSessionId));
        }
        try {
            await window.ipcRenderer.chat.archiveSession(targetSessionId);
            setPinnedSessionIds((current) => {
                if (!current.includes(targetSessionId)) return current;
                const next = current.filter((id) => id !== targetSessionId);
                writeRedClawPinnedSessionIds(next);
                return next;
            });
            const remaining = sessionListRef.current.filter((item) => item.id !== targetSessionId);
            sessionListRef.current = remaining;
            setSessionList(remaining);

            if (activeSessionIdRef.current === targetSessionId) {
                const nextSessionId = remaining[0]?.id || null;
                setActiveSessionId(nextSessionId);
                setActiveAiSurface('redclaw');
                setChatModelKey('');
                if (!nextSessionId) {
                    void loadContextSessions(nextActiveSpaceId, nextSpaceName, { createIfEmpty: true, silent: true });
                }
            }
        } catch (error) {
            console.error('Failed to archive RedClaw session:', error);
            setChatActionMessage(error instanceof Error ? error.message : '归档对话失败');
            if (isExternalSession) {
                void loadExternalAgentSessions();
            } else {
                void loadContextSessions(nextActiveSpaceId, nextSpaceName, { createIfEmpty: true, silent: true });
            }
        } finally {
            setHistoryLoading(false);
        }
    }, [activeSpaceId, activeSpaceName, loadContextSessions, loadExternalAgentSessions]);

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

    const onboardingCompleted = useMemo(() => isRedClawOnboardingCompleted(onboardingState), [onboardingState]);

    const welcomeActions = useMemo(() => {
        const actions = [];
        if (!onboardingCompleted) {
            actions.push({
                label: '定义这个空间',
                onClick: () => onOpenRedClawOnboarding?.(),
                icon: <Sparkles className="w-5 h-5" />,
                color: 'text-amber-500',
            });
        } else {
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
    }, [onOpenRedClawOnboarding, onboardingCompleted]);

    useEffect(() => {
        if (!onGlobalSidebarContentChange) return;
        onGlobalSidebarContentChange(
            <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-border/70 bg-surface-primary/60 text-text-primary">
                <div className="border-b border-border/70 px-3 py-3">
                    <div className="truncate text-[11px] font-bold uppercase tracking-[0.08em] text-text-tertiary">RedClaw</div>
                    <div className="mt-1 truncate text-sm font-semibold text-text-primary">{activeSpaceName || '默认空间'}</div>
                </div>
                <div className="grid grid-cols-2 gap-1 border-b border-border/70 p-2">
                    {[
                        { id: 'sessions' as const, label: '会话', count: unifiedHistorySessions.length },
                        { id: 'manuscripts' as const, label: '稿件', count: globalManuscriptCount },
                    ].map((tab) => (
                        <button
                            key={tab.id}
                            type="button"
                            onClick={() => setGlobalSidebarTab(tab.id)}
                            className={clsx(
                                'flex h-8 items-center justify-center gap-1.5 rounded-lg text-[11px] font-bold transition-colors',
                                globalSidebarTab === tab.id
                                    ? 'bg-surface-secondary text-text-primary shadow-sm'
                                    : 'text-text-tertiary hover:text-text-primary'
                            )}
                        >
                            <span>{tab.label}</span>
                            <span className="text-[9px] opacity-70">{tab.count}</span>
                        </button>
                    ))}
                </div>
                <div className="grid gap-1.5 p-2">
                    {globalSidebarTab === 'sessions' ? (
                        <button
                            type="button"
                            onClick={() => void createNewSession()}
                            className="flex items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[12px] font-medium text-text-secondary transition-colors hover:bg-surface-secondary hover:text-text-primary"
                        >
                            <Plus className="h-3.5 w-3.5 shrink-0" />
                            <span className="truncate">新建对话</span>
                        </button>
                    ) : (
                        <button
                            type="button"
                            onClick={() => openHistoryDrawer('manuscripts')}
                            className="flex items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[12px] font-medium text-text-secondary transition-colors hover:bg-surface-secondary hover:text-text-primary"
                        >
                            <Plus className="h-3.5 w-3.5 shrink-0" />
                            <span className="truncate">新建 / 管理稿件</span>
                        </button>
                    )}
                    <button
                        type="button"
                        onClick={() => setSidebarCollapsed(false)}
                        className="flex items-center justify-between gap-2 rounded-lg px-2.5 py-2 text-left text-[12px] font-medium text-text-secondary transition-colors hover:bg-surface-secondary hover:text-text-primary"
                    >
                        <span className="truncate">技能面板</span>
                        <span className="rounded-full bg-surface-secondary px-1.5 py-0.5 text-[10px] text-text-tertiary">{enabledSkillCount}</span>
                    </button>
                </div>
                <div className="flex items-center justify-between border-y border-border/70 px-3 py-2">
                    <div className="text-[10px] font-bold uppercase tracking-[0.08em] text-text-tertiary">
                        {globalSidebarTab === 'sessions' ? '最近会话' : '稿件库'}
                    </div>
                    {globalSidebarTab === 'sessions' && historyLoading ? <Loader2 className="h-3 w-3 animate-spin text-text-tertiary" /> : null}
                    {globalSidebarTab === 'manuscripts' ? (
                        <button
                            type="button"
                            onClick={() => void loadGlobalManuscripts()}
                            disabled={globalManuscriptsLoading}
                            className="text-text-tertiary transition-colors hover:text-text-primary disabled:opacity-50"
                            title="刷新稿件"
                            aria-label="刷新稿件"
                        >
                            <RefreshCw className={clsx('h-3 w-3', globalManuscriptsLoading && 'animate-spin')} />
                        </button>
                    ) : null}
                </div>
                <div className="redclaw-history-scroll min-h-0 flex-1 overflow-y-auto p-2">
                    {globalSidebarTab === 'manuscripts' ? (
                        globalManuscriptsLoading && globalFlatManuscripts.length === 0 ? (
                            <div className="flex h-full items-center justify-center py-8">
                                <Loader2 className="h-4 w-4 animate-spin text-accent-primary/60" />
                            </div>
                        ) : globalManuscriptsError && globalFlatManuscripts.length === 0 ? (
                            <div className="flex h-full flex-col items-center justify-center px-4 py-8 text-center text-text-tertiary">
                                <FileText className="mb-2 h-5 w-5 text-red-400/40" />
                                <div className="text-[12px] font-medium">{globalManuscriptsError}</div>
                            </div>
                        ) : globalFlatManuscripts.length === 0 ? (
                            <div className="flex h-full flex-col items-center justify-center px-4 py-8 text-center text-text-tertiary">
                                <FileText className="mb-2 h-5 w-5 text-accent-primary/25" />
                                <div className="text-[12px] font-medium">暂无稿件</div>
                            </div>
                        ) : (
                            <div className="space-y-0.5 pb-2">
                                {globalFlatManuscripts.map((node) => {
                                    const label = redClawManuscriptLabel(node);
                                    const normalizedNodePath = String(node.path || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
                                    const isCurrentManuscript = !node.isDirectory
                                        && normalizedActiveManuscriptPath
                                        && normalizedNodePath === normalizedActiveManuscriptPath;
                                    const containsCurrentManuscript = node.isDirectory
                                        && normalizedActiveManuscriptPath
                                        && normalizedNodePath
                                        && normalizedActiveManuscriptPath.startsWith(`${normalizedNodePath}/`);
                                    const updatedLabel = formatRedClawManuscriptUpdatedAt(node.updatedAt);
                                    return (
                                        <button
                                            key={`${node.isDirectory ? 'folder' : 'file'}:${node.path || label}`}
                                            type="button"
                                            onClick={() => {
                                                if (node.isDirectory) {
                                                    openHistoryDrawer('manuscripts');
                                                    return;
                                                }
                                                openGlobalManuscript(node.path);
                                            }}
                                            className={clsx(
                                                'flex w-full items-center gap-2 rounded-lg py-1.5 pr-2 text-left text-[12px] font-medium transition-colors hover:bg-surface-secondary/70 hover:text-text-primary',
                                                isCurrentManuscript
                                                    ? 'bg-surface-elevated text-text-primary ring-1 ring-accent-primary/20'
                                                    : containsCurrentManuscript
                                                        ? 'bg-surface-secondary/45 text-text-primary'
                                                        : 'text-text-secondary'
                                            )}
                                            style={{ paddingLeft: `${8 + node.depth * 12}px` }}
                                            title={node.path || label}
                                        >
                                            {node.isDirectory
                                                ? <Folder className="h-3.5 w-3.5 shrink-0 text-accent-primary/70" />
                                                : <FileText className="h-3.5 w-3.5 shrink-0 text-text-tertiary" />}
                                            <span className="min-w-0 flex-1 truncate">{label}</span>
                                            {updatedLabel && !node.isDirectory ? (
                                                <span className="shrink-0 text-[9px] text-text-tertiary">{updatedLabel}</span>
                                            ) : null}
                                        </button>
                                    );
                                })}
                            </div>
                        )
                    ) : historyLoading && unifiedHistorySessions.length === 0 ? (
                        <div className="flex h-full items-center justify-center py-8">
                            <Loader2 className="h-4 w-4 animate-spin text-accent-primary/60" />
                        </div>
                    ) : unifiedHistorySessions.length === 0 ? (
                        <div className="flex h-full flex-col items-center justify-center px-4 py-8 text-center text-text-tertiary">
                            <History className="mb-2 h-5 w-5 text-accent-primary/25" />
                            <div className="text-[12px] font-medium">暂无记录</div>
                        </div>
                    ) : (
                        <div className="space-y-1 pb-2">
                            {visibleGlobalSessions.slice(0, 12).map((session) => {
                                const isCurrentSession = session.id === activeSessionId;
                                const isExternalSession = session.surface === 'external';
                                const isPinned = !isExternalSession && (pinnedSessionIdSet.has(session.id) || Boolean(session.starred));
                                const title = displayRedClawHistoryTitle(session.chatSession?.title?.trim() || '未命名会话', session.surface);
                                const summary = session.summary?.trim();
                                const speakerLabel = String(session.speakerLabel || '').trim();
                                const activity = sessionActivityById[session.id];
                                const isAutomationSession = isRedClawAutomationHistorySession(session);
                                const isUnread = Boolean(session.unread)
                                    || Boolean(session.metadata && typeof session.metadata === 'object' && !Array.isArray(session.metadata) && (session.metadata as Record<string, unknown>).unread);
                                return (
                                    <div
                                        key={session.id}
                                        className={clsx(
                                            'group relative rounded-lg px-2.5 py-2 transition-colors',
                                            isCurrentSession
                                                ? 'bg-surface-elevated ring-1 ring-accent-primary/20'
                                                : 'hover:bg-surface-secondary/70'
                                        )}
                                    >
                                        {isCurrentSession && (
                                            <div className="absolute left-0 top-1/2 h-5 w-0.5 -translate-y-1/2 rounded-r-full bg-accent-primary" />
                                        )}
                                        <button
                                            type="button"
                                            onClick={() => switchSession(session.id)}
                                            className="block w-full min-w-0 pr-20 text-left"
                                        >
                                            <div className="flex min-w-0 items-center gap-1.5">
                                                {isAutomationSession ? (
                                                    <Clock3 className="h-3.5 w-3.5 shrink-0 text-text-tertiary" />
                                                ) : null}
                                                <span className={clsx(
                                                    'min-w-0 truncate text-[12px] font-semibold',
                                                    isCurrentSession ? 'text-text-primary' : 'text-text-secondary group-hover:text-text-primary'
                                                )}>
                                                    {title}
                                                </span>
                                                {isPinned ? (
                                                    <Pin className="h-3 w-3 shrink-0 text-accent-primary" />
                                                ) : null}
                                            </div>
                                            <div className="mt-1 truncate text-[10px] text-text-tertiary">
                                                {speakerLabel ? `${speakerLabel} · ` : ''}
                                                {formatDateTime(session.chatSession?.updatedAt || null)}
                                            </div>
                                            {summary && (
                                                <div className="mt-1 line-clamp-1 text-[11px] text-text-secondary/70">
                                                    {summary}
                                                </div>
                                            )}
                                        </button>
                                        {activity === 'running' ? (
                                            <span
                                                className="absolute right-3 top-1/2 flex h-4 w-4 -translate-y-1/2 items-center justify-center transition-opacity group-hover:opacity-0"
                                                aria-label="正在执行"
                                            >
                                                <span className="h-4 w-4 rounded-full border-2 border-text-tertiary/30 border-t-text-tertiary/80 animate-spin" />
                                            </span>
                                        ) : null}
                                        {(activity === 'unread-complete' || isUnread) ? (
                                            <span
                                                className="absolute right-4 top-1/2 h-2.5 w-2.5 -translate-y-1/2 rounded-full bg-emerald-500 shadow-[0_0_0_3px_rgba(16,185,129,0.14)] transition-opacity group-hover:opacity-0"
                                                aria-label={isUnread ? '未读' : '执行完成'}
                                            />
                                        ) : null}
                                        {!isExternalSession ? (
                                            <button
                                                type="button"
                                                onClick={(event) => {
                                                    event.stopPropagation();
                                                    togglePinnedSession(session.id);
                                                }}
                                                className={clsx(
                                                    'absolute right-[3.25rem] top-2 flex h-6 w-6 items-center justify-center rounded-md transition hover:bg-surface-secondary hover:text-text-primary group-hover:opacity-100',
                                                    isPinned
                                                        ? 'text-accent-primary opacity-100'
                                                        : 'text-text-tertiary opacity-0'
                                                )}
                                                title={isPinned ? '取消置顶' : '置顶'}
                                                aria-label={isPinned ? '取消置顶' : '置顶'}
                                            >
                                                <Pin className="h-3 w-3" />
                                            </button>
                                        ) : null}
                                        {!isExternalSession ? (
                                            <button
                                                type="button"
                                                onClick={(event) => {
                                                    event.stopPropagation();
                                                    openRenameSessionDialog(session);
                                                }}
                                                className="absolute right-7 top-2 flex h-6 w-6 items-center justify-center rounded-md text-text-tertiary opacity-0 transition hover:bg-surface-secondary hover:text-text-primary group-hover:opacity-100"
                                                title="重命名"
                                                aria-label="重命名"
                                            >
                                                <Edit3 className="h-3 w-3" />
                                            </button>
                                        ) : null}
                                        <button
                                            type="button"
                                            onClick={(event) => {
                                                event.stopPropagation();
                                                void archiveUnifiedHistorySession(session);
                                            }}
                                            className="absolute right-1.5 top-2 flex h-6 w-6 items-center justify-center rounded-md text-text-tertiary opacity-0 transition hover:bg-red-500/12 hover:text-red-400 group-hover:opacity-100"
                                            title="归档"
                                            aria-label="归档"
                                        >
                                            <Archive className="h-3 w-3" />
                                        </button>
                                    </div>
                                );
                            })}
                        </div>
                    )}
                </div>
            </div>
        );
    }, [
        activeSessionId,
        activeSpaceName,
        archiveUnifiedHistorySession,
        createNewSession,
        deleteHistorySession,
        enabledSkillCount,
        globalFlatManuscripts,
        globalManuscriptCount,
        globalManuscriptsError,
        globalManuscriptsLoading,
        globalSidebarTab,
        historyLoading,
        loadGlobalManuscripts,
        normalizedActiveManuscriptPath,
        onGlobalSidebarContentChange,
        openGlobalManuscript,
        openHistoryDrawer,
        openRenameSessionDialog,
        pinnedSessionIdSet,
        sessionActivityById,
        sessionList,
        switchSession,
        togglePinnedSession,
        unifiedHistorySessions,
        visibleGlobalSessions,
    ]);

    useEffect(() => () => {
        onGlobalSidebarContentChange?.(null);
    }, [onGlobalSidebarContentChange]);

    useEffect(() => {
        if (!onTitleBarActionsChange) return;
        if (!titleBarActive || !previewTarget) {
            onTitleBarActionsChange(null);
            return;
        }

        onTitleBarActionsChange(
            <button
                type="button"
                onClick={togglePreviewSidebarCollapsed}
                className="app-titlebar-button"
                title={previewSidebarCollapsed ? '展开文件预览' : '折叠文件预览'}
                aria-label={previewSidebarCollapsed ? '展开文件预览' : '折叠文件预览'}
                data-preview-sidebar-state={previewSidebarCollapsed ? 'collapsed' : 'expanded'}
                data-no-window-drag
            >
                <PanelRight className="h-[14px] w-[14px]" strokeWidth={1.8} />
            </button>
        );
    }, [
        onTitleBarActionsChange,
        previewSidebarCollapsed,
        previewTarget,
        titleBarActive,
        togglePreviewSidebarCollapsed,
    ]);

    useEffect(() => () => {
        onTitleBarActionsChange?.(null);
    }, [onTitleBarActionsChange]);

    const effectiveAiSurface: RedClawAiSurface = activeAiSurface === 'advisor' && selectedAdvisor ? 'advisor' : 'redclaw';
    const currentChatSessionId = effectiveAiSurface === 'advisor' ? advisorSessionId : activeSessionId;
    const currentWelcomeTitle = effectiveAiSurface === 'advisor' && selectedAdvisor
        ? selectedAdvisor.name
        : 'RedClaw 自媒体AI工作台';
    const currentWelcomeIconSrc = effectiveAiSurface === 'advisor'
        ? selectedAdvisor && hasRenderableAdvisorAvatar(selectedAdvisor)
            ? resolveAssetUrl(selectedAdvisor.avatar)
            : undefined
        : REDCLAW_WELCOME_ICON_SRC;
    const currentWelcomeAvatarText = effectiveAiSurface === 'advisor' && selectedAdvisor && !hasRenderableAdvisorAvatar(selectedAdvisor)
        ? advisorAvatarText(selectedAdvisor)
        : undefined;
    const currentWelcomeIconVariant = effectiveAiSurface === 'advisor' ? 'avatar' : 'default';
    const currentPendingMessage = effectiveAiSurface === 'redclaw' ? resolvedPendingMessage : null;
    const currentMemberMention = effectiveAiSurface === 'advisor' && selectedAdvisor ? {
        id: selectedAdvisor.id,
        name: selectedAdvisor.name,
        avatar: selectedAdvisor.avatar,
        personality: selectedAdvisor.personality,
    } : null;
    const currentMessageListHeader = effectiveAiSurface === 'redclaw'
        ? <RedClawImageGenerationProgressPanel jobs={visibleImageJobs} />
        : null;
    const isCurrentChatLoading = effectiveAiSurface === 'advisor' && isAdvisorSessionLoading && !advisorSessionId;
    const previewPaneVisible = Boolean(previewTarget && (!previewSidebarCollapsed || isPreviewSidebarClosing));

    return (
        <div className="h-full min-h-0 flex overflow-hidden bg-surface-primary">
            <div className={clsx(
                'relative min-w-0 overflow-hidden transition-[flex-basis,max-width] duration-[280ms] ease-[cubic-bezier(0.22,1,0.36,1)]',
                previewPaneVisible ? 'basis-[46%] max-w-[780px] shrink-0 border-r border-border/70' : 'flex-1'
            )}>
                {isSessionLoading && !activeSessionId ? (
                    <div className="h-full flex items-center justify-center">
                        <div className="flex flex-col items-center gap-3 text-text-tertiary">
                            <Loader2 className="w-6 h-6 animate-spin" />
                            <span className="text-xs">正在初始化 RedClaw...</span>
                        </div>
                    </div>
                ) : activeSessionId ? (
                    <div className="h-full min-h-0 flex flex-col">
                        <div className="relative min-h-0 flex-1 overflow-hidden">
                            {!onboardingCompleted && !hideOnboardingPrompt && (
                                <div className="pointer-events-none absolute inset-x-0 top-4 z-20 flex justify-center px-4">
                                    <div className="pointer-events-auto w-full max-w-2xl rounded-[28px] border border-amber-300/20 bg-[linear-gradient(135deg,rgba(24,18,14,0.96),rgba(17,13,15,0.94))] p-5 text-white shadow-[0_30px_80px_rgba(0,0,0,0.28)] backdrop-blur-xl">
                                        <div className="flex items-start justify-between gap-4">
                                            <div className="space-y-3">
                                                <div className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/6 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-white/58">
                                                    <Sparkles className="h-3.5 w-3.5 text-amber-300" />
                                                    来自 RedClaw
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
                            {isCurrentChatLoading ? (
                                <div className="flex h-full items-center justify-center">
                                    <div className="flex flex-col items-center gap-3 text-text-tertiary">
                                        <Loader2 className="h-5 w-5 animate-spin" />
                                        <span className="text-xs">正在打开成员对话...</span>
                                    </div>
                                </div>
                            ) : currentChatSessionId ? (
                                <Chat
                                isActive={isActive}
                                onExecutionStateChange={onExecutionStateChange}
                                key={`redclaw:${effectiveAiSurface}:${currentChatSessionId}:${chatRefreshKey}`}
                                fixedSessionId={currentChatSessionId}
                                initialChatModelKey={chatModelKey}
                                onChatModelKeyChange={setChatModelKey}
                                pendingMessage={currentPendingMessage}
                                onMessageConsumed={onPendingMessageConsumed}
                                defaultCollapsed={true}
                                showClearButton={false}
                                fixedSessionBannerText=""
                                showWelcomeShortcuts={effectiveAiSurface === 'redclaw'}
                                showComposerShortcuts={effectiveAiSurface === 'redclaw'}
                                fixedSessionContextIndicatorMode="corner-ring"
                                shortcuts={effectiveAiSurface === 'redclaw' ? createRedClawComposerShortcutsForContext : []}
                                welcomeShortcuts={effectiveAiSurface === 'redclaw' ? createRedClawComposerShortcutsForContext : []}
                                embeddedTheme="auto"
                                welcomeTitle={currentWelcomeTitle}
                                welcomeSubtitle=""
                                welcomeIconSrc={currentWelcomeIconSrc}
                                welcomeAvatarText={currentWelcomeAvatarText}
                                welcomeIconVariant={currentWelcomeIconVariant}
                                welcomeIconAccessory={(
                                    <RedClawAiSwitchBar
                                        activeSurface={effectiveAiSurface}
                                        advisors={advisors}
                                        selectedAdvisorId={selectedAdvisorId}
                                        onSelectRedClaw={handleSelectRedClawShortcut}
                                        onSelectAdvisor={handleSelectAdvisorShortcut}
                                        onCreateAdvisor={handleCreateAdvisorShortcut}
                                    />
                                )}
                                welcomeActions={effectiveAiSurface === 'redclaw' ? welcomeActions : []}
                                contentLayout="wide"
                                contentWidthPreset={previewPaneVisible ? 'default' : 'narrow'}
                                allowFileUpload={true}
                                attachmentPreviewMode="compact-status"
                                placeholder="描述创作目标，使用 # 调用知识库"
                                messageWorkflowPlacement="bottom"
                                messageWorkflowVariant="compact"
                                messageWorkflowEmphasis="default"
                                messageWorkflowAutoHideWhenComplete={true}
                                messageWorkflowFailureTone="neutral"
                                messageLinkRenderMode="preview-card"
                                onMessageLinkPreview={handlePreviewLink}
                                activePreviewHref={previewTarget?.href || null}
                                keepComposerInputActive={true}
                                fixedMemberMention={currentMemberMention}
                                messageListHeader={currentMessageListHeader}
                                />
                            ) : (
                                <div className="flex h-full items-center justify-center">
                                    <div className="flex flex-col items-center gap-3 text-text-tertiary">
                                        <Loader2 className="h-5 w-5 animate-spin" />
                                        <span className="text-xs">正在初始化对话...</span>
                                    </div>
                                </div>
                            )}
                            <RedClawHistoryDrawer
                                open={historyDrawerOpen}
                                initialTab={historyDrawerInitialTab}
                                activeSpaceName={activeSpaceName}
                                historyLoading={historyLoading}
                                sessionList={unifiedHistorySessions}
                                activeSessionId={activeSessionId}
                                sessionActivityById={sessionActivityById}
                                onToggleOpen={() => setHistoryDrawerOpen((value) => !value)}
                                onClose={() => setHistoryDrawerOpen(false)}
                                onCreateSession={() => void createNewSession()}
                                onSwitchSession={switchSession}
                                onDeleteSession={(sessionId) => void deleteHistorySession(sessionId)}
                                onArchiveSession={(session) => void archiveUnifiedHistorySession(session)}
                                onSetSessionUnread={setHistorySessionUnread}
                                onRenameSession={openRenameSessionDialog}
                                onOpenManuscript={onOpenManuscriptEditor || onOpenManuscript}
                                activeManuscriptPath={activeManuscriptPath}
                            />
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
                            <Advisors
                                isActive={isActive}
                                modalOnly
                                createRequestKey={advisorCreateRequestKey}
                                createRequestMode="manual"
                                onAdvisorsChange={handleAdvisorHostChange}
                                onSelectedAdvisorIdChange={handleAdvisorHostSelected}
                            />
                            {previewTarget && previewSidebarCollapsed && !isPreviewSidebarClosing ? (
                                <button
                                    type="button"
                                    onClick={togglePreviewSidebarCollapsed}
                                    className="absolute right-5 top-16 z-30 inline-flex h-9 w-9 items-center justify-center rounded-xl border border-border/80 bg-surface-elevated/92 text-text-tertiary shadow-sm backdrop-blur-xl transition-colors hover:bg-surface-primary hover:text-text-primary"
                                    title="展开文件预览"
                                    aria-label="展开文件预览"
                                >
                                    <PanelRightOpen className="h-4 w-4" />
                                </button>
                            ) : null}
                        </div>
                    </div>
                ) : (
                    <div className="h-full flex items-center justify-center text-text-tertiary text-sm">
                        RedClaw 会话初始化失败
                    </div>
                )}
            </div>
            {previewPaneVisible && previewTarget ? (
                <aside
                    className={clsx(
                        'redclaw-preview-sidebar min-h-0 min-w-[420px] flex-1 overflow-hidden bg-surface-primary',
                        isPreviewSidebarClosing ? 'redclaw-preview-sidebar--closing' : 'redclaw-preview-sidebar--open'
                    )}
                >
                    <RedClawFilePreviewPane
                        target={previewTarget}
                        onClose={handleClosePreview}
                        onOpenExternal={handleOpenPreviewExternal}
                        onRevealInFolder={handleRevealPreviewInFolder}
                        variant="sidebar"
                    />
                </aside>
            ) : null}
            {renameSessionTarget && (
                <div
                    className="fixed inset-0 z-[80] flex items-center justify-center bg-black/25 px-4 backdrop-blur-[2px]"
                    onMouseDown={closeRenameSessionDialog}
                >
                    <div
                        className="w-full max-w-[360px] rounded-2xl border border-border bg-surface-primary p-4 shadow-2xl"
                        onMouseDown={(event) => event.stopPropagation()}
                    >
                        <div className="flex items-center justify-between gap-3">
                            <div className="text-[14px] font-bold text-text-primary">重命名会话</div>
                            <button
                                type="button"
                                onClick={closeRenameSessionDialog}
                                disabled={isRenamingSession}
                                className="flex h-7 w-7 items-center justify-center rounded-lg text-text-tertiary transition hover:bg-surface-secondary hover:text-text-primary disabled:opacity-50"
                            >
                                <X className="h-3.5 w-3.5" />
                            </button>
                        </div>
                        <input
                            autoFocus
                            value={renameSessionTitle}
                            onChange={(event) => {
                                setRenameSessionTitle(event.target.value);
                                if (renameSessionError) setRenameSessionError('');
                            }}
                            onKeyDown={(event) => {
                                if (event.key === 'Enter') {
                                    event.preventDefault();
                                    void submitRenameSession();
                                } else if (event.key === 'Escape') {
                                    event.preventDefault();
                                    closeRenameSessionDialog();
                                }
                            }}
                            className="mt-4 h-10 w-full rounded-xl border border-border bg-surface-secondary/50 px-3 text-sm text-text-primary outline-none transition placeholder:text-text-tertiary focus:border-accent-primary/50 focus:bg-surface-primary focus:ring-2 focus:ring-accent-primary/10"
                            placeholder="会话名称"
                            disabled={isRenamingSession}
                        />
                        {renameSessionError && (
                            <div className="mt-2 text-xs text-red-500">{renameSessionError}</div>
                        )}
                        <div className="mt-4 flex justify-end gap-2">
                            <button
                                type="button"
                                onClick={closeRenameSessionDialog}
                                disabled={isRenamingSession}
                                className="rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-text-secondary transition-colors hover:bg-surface-secondary hover:text-text-primary disabled:opacity-50"
                            >
                                取消
                            </button>
                            <button
                                type="button"
                                onClick={() => void submitRenameSession()}
                                disabled={isRenamingSession || !renameSessionTitle.trim()}
                                className="rounded-lg bg-accent-primary px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-accent-hover disabled:opacity-50"
                            >
                                {isRenamingSession ? '保存中...' : '保存'}
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
