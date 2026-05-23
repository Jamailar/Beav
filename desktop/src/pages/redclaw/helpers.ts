import type { RunnerResult, RunnerScheduledTask } from './types';
import { REDCLAW_CONTEXT, REDCLAW_CONTEXT_ID, REDCLAW_DISPLAY_NAME, WEEKDAY_OPTIONS } from './config';

export function normalizeClawHubSlug(input: string): string {
    const value = (input || '').trim();
    if (!value) return '';

    if (/^https?:\/\//i.test(value)) {
        try {
            const url = new URL(value);
            if (url.hostname !== 'clawhub.ai' && url.hostname !== 'www.clawhub.ai') {
                return '';
            }
            const parts = url.pathname.split('/').filter(Boolean);
            if (parts[0] === 'skills' && parts[1]) {
                return parts[1].trim().toLowerCase();
            }
            return '';
        } catch {
            return '';
        }
    }

    return value
        .replace(/^clawhub\//i, '')
        .replace(/^\/+|\/+$/g, '')
        .trim()
        .toLowerCase();
}

export function formatDateTime(value?: string | null): string {
    if (!value) return '-';
    const text = String(value).trim();
    const numeric = /^\d+$/.test(text) ? Number(text) : NaN;
    const date = Number.isFinite(numeric)
        ? new Date(numeric > 1_000_000_000_000 ? numeric : numeric * 1000)
        : new Date(text);
    if (Number.isNaN(date.getTime())) return '-';
    return date.toLocaleString();
}

export function buildRedClawContextId(activeSpaceId: string): string {
    return `${REDCLAW_CONTEXT_ID}:${activeSpaceId}`;
}

export function buildRedClawSessionTitle(spaceName: string): string {
    return `${REDCLAW_DISPLAY_NAME} · ${spaceName}`;
}

export function buildRedClawInitialContext(spaceName: string, activeSpaceId: string): string {
    return `${REDCLAW_CONTEXT}\n当前空间: ${spaceName} (${activeSpaceId})`;
}

export function buildRedClawRuntimeMetadata(activeSpaceId: string, spaceName?: string): Record<string, unknown> {
    const spaceId = String(activeSpaceId || 'default').trim() || 'default';
    const contextId = buildRedClawContextId(spaceId);
    return {
        surface: 'redclaw',
        runtimeSurface: 'redclaw',
        runtimeMode: 'redclaw',
        contextType: 'redclaw',
        contextId,
        redclawContext: {
            surface: 'redclaw',
            spaceId,
            contextId,
            profileContext: {
                kind: 'redclaw-profile',
                spaceId,
                spaceName: String(spaceName || spaceId).trim() || spaceId,
            },
        },
    };
}

function contextSessionTimestampMs(value?: string | null): number {
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

export function compareContextSessionItems(
    left: ContextChatSessionListItem,
    right: ContextChatSessionListItem,
): number {
    const leftUpdatedAt = Math.max(
        contextSessionTimestampMs(left.chatSession?.updatedAt),
        contextSessionTimestampMs(left.chatSession?.createdAt),
    );
    const rightUpdatedAt = Math.max(
        contextSessionTimestampMs(right.chatSession?.updatedAt),
        contextSessionTimestampMs(right.chatSession?.createdAt),
    );
    return rightUpdatedAt - leftUpdatedAt;
}

export function sortContextSessionItems(items: ContextChatSessionListItem[]): ContextChatSessionListItem[] {
    return [...items].sort(compareContextSessionItems);
}

export function createContextSessionListItem(session: ChatSession): ContextChatSessionListItem {
    return {
        id: session.id,
        messageCount: 0,
        summary: '',
        transcriptCount: 0,
        checkpointCount: 0,
        context: null,
        chatSession: {
            id: session.id,
            title: session.title,
            updatedAt: session.updatedAt,
            createdAt: session.createdAt,
        },
    };
}

export function modeLabel(task: RunnerScheduledTask): string {
    if (task.mode === 'interval') return `每 ${task.intervalMinutes || 60} 分钟`;
    if (task.mode === 'daily') return `每天 ${task.time || '--:--'}`;
    if (task.mode === 'weekly') {
        const weekdays = Array.isArray(task.weekdays) ? task.weekdays : [];
        const names = weekdays
            .map((day) => WEEKDAY_OPTIONS.find((item) => item.value === day)?.label)
            .filter(Boolean)
            .join('、');
        return `${names || '每周'} ${task.time || '--:--'}`;
    }
    return `一次性 ${formatDateTime(task.runAt)}`;
}

export function resultTone(result?: RunnerResult): string {
    if (result === 'success') return 'text-green-600';
    if (result === 'error') return 'text-red-500';
    if (result === 'skipped') return 'text-amber-500';
    return 'text-text-tertiary';
}
