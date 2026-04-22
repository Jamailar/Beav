import { nextCronRunMs } from './backgroundCron';

export type BackgroundScheduleMode = 'interval' | 'daily' | 'weekly' | 'once';

export type BackgroundScheduledTaskLike = {
    id: string;
    enabled: boolean;
    mode: BackgroundScheduleMode;
    createdAt: string;
    lastRunAt?: string;
    intervalMinutes?: number;
    time?: string;
    weekdays?: number[];
    runAt?: string;
};

function parseIsoMs(value?: string): number | null {
    if (!value) return null;
    const ms = new Date(value).getTime();
    return Number.isFinite(ms) ? ms : null;
}

function sanitizeWeekdays(value: unknown): number[] {
    const list = Array.isArray(value) ? value : [];
    const set = new Set<number>();
    for (const item of list) {
        const n = Number(item);
        if (!Number.isFinite(n)) continue;
        const day = Math.max(0, Math.min(6, Math.floor(n)));
        set.add(day);
    }
    return Array.from(set.values()).sort((a, b) => a - b);
}

function sanitizeTimeHHmm(value: unknown): string | undefined {
    const text = String(value || '').trim();
    if (!text) return undefined;
    const match = text.match(/^(\d{1,2}):(\d{2})$/);
    if (!match) return undefined;
    const hour = Number(match[1]);
    const minute = Number(match[2]);
    if (!Number.isFinite(hour) || !Number.isFinite(minute)) return undefined;
    if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return undefined;
    return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

function buildCronExpressionForTask(task: BackgroundScheduledTaskLike): string | null {
    const normalized = sanitizeTimeHHmm(task.time);
    if (!normalized) return null;
    const [hourText, minuteText] = normalized.split(':');
    const hour = String(Number(hourText));
    const minute = String(Number(minuteText));

    if (task.mode === 'daily') {
        return `${minute} ${hour} * * *`;
    }
    if (task.mode === 'weekly') {
        const weekdays = sanitizeWeekdays(task.weekdays);
        const days = weekdays.length > 0 ? weekdays : [1];
        return `${minute} ${hour} * * ${days.join(',')}`;
    }
    return null;
}

export function computeScheduledTaskNextRunMs(task: BackgroundScheduledTaskLike, fromMs: number): number | null {
    if (!task.enabled) return null;

    if (task.mode === 'interval') {
        const minutes = Math.max(1, Math.min(180, Math.round(Number(task.intervalMinutes || 60))));
        return fromMs + minutes * 60 * 1000;
    }

    if (task.mode === 'once') {
        if (task.lastRunAt) return null;
        return parseIsoMs(task.runAt);
    }

    const cronExpr = buildCronExpressionForTask(task);
    if (!cronExpr) return null;
    return nextCronRunMs(cronExpr, fromMs);
}

export function findMissedScheduledTasks<T extends BackgroundScheduledTaskLike>(tasks: T[], nowMs: number): T[] {
    return tasks.filter((task) => {
        if (!task.enabled) return false;
        const anchorMs = parseIsoMs(task.lastRunAt) ?? parseIsoMs(task.createdAt) ?? nowMs;
        const nextMs = computeScheduledTaskNextRunMs(task, anchorMs);
        return nextMs !== null && nextMs < nowMs;
    });
}
