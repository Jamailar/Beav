import { computeScheduledTaskNextRunMs, type BackgroundScheduledTaskLike } from './backgroundScheduledTasks';

export type BackgroundCronSchedulerItem = BackgroundScheduledTaskLike & {
    recurring?: boolean;
    nextRunAt?: string;
};

function parseIsoMs(value?: string): number | null {
    if (!value) return null;
    const ms = new Date(value).getTime();
    return Number.isFinite(ms) ? ms : null;
}

function isRecurringTask(task: BackgroundCronSchedulerItem): boolean {
    if (typeof task.recurring === 'boolean') {
        return task.recurring;
    }
    return task.mode !== 'once';
}

export class BackgroundCronScheduler<T extends BackgroundCronSchedulerItem> {
    private readonly nextFireAt = new Map<string, number>();
    private readonly inFlight = new Set<string>();

    sync(tasks: T[], nowMs: number): void {
        const seen = new Set<string>();
        for (const task of tasks) {
            if (!task.enabled) {
                this.nextFireAt.delete(task.id);
                this.inFlight.delete(task.id);
                continue;
            }

            seen.add(task.id);
            let next = parseIsoMs(task.nextRunAt);
            if (next === null) {
                const anchor = parseIsoMs(task.lastRunAt) ?? parseIsoMs(task.createdAt) ?? nowMs;
                next = computeScheduledTaskNextRunMs(task, anchor);
            }
            if (next === null) {
                this.nextFireAt.delete(task.id);
                this.inFlight.delete(task.id);
                continue;
            }
            this.nextFireAt.set(task.id, next);
        }

        for (const id of Array.from(this.nextFireAt.keys())) {
            if (!seen.has(id)) {
                this.nextFireAt.delete(id);
                this.inFlight.delete(id);
            }
        }
    }

    getDueTaskIds(tasks: T[], nowMs: number): string[] {
        const byId = new Map(tasks.map((task) => [task.id, task] as const));
        const due: Array<{ id: string; next: number }> = [];
        for (const [id, next] of this.nextFireAt.entries()) {
            const task = byId.get(id);
            if (!task || !task.enabled) continue;
            if (this.inFlight.has(id)) continue;
            if (next > nowMs) continue;
            due.push({ id, next });
        }
        due.sort((a, b) => a.next - b.next);
        return due.map((item) => item.id);
    }

    markInFlight(taskId: string): void {
        this.inFlight.add(taskId);
    }

    markSettled(task: T, nowMs: number): void {
        this.inFlight.delete(task.id);
        if (!task.enabled) {
            this.nextFireAt.delete(task.id);
            return;
        }

        if (isRecurringTask(task)) {
            const next = computeScheduledTaskNextRunMs(task, nowMs);
            if (next === null) {
                this.nextFireAt.delete(task.id);
            } else {
                this.nextFireAt.set(task.id, next);
            }
            return;
        }

        this.nextFireAt.delete(task.id);
    }

    markRemoved(taskId: string): void {
        this.inFlight.delete(taskId);
        this.nextFireAt.delete(taskId);
    }

    isInFlight(taskId: string): boolean {
        return this.inFlight.has(taskId);
    }

    getInFlightTaskIds(): string[] {
        return Array.from(this.inFlight.values());
    }

    getNextFireTime(): number | null {
        let next: number | null = null;
        for (const [id, candidate] of this.nextFireAt.entries()) {
            if (this.inFlight.has(id)) continue;
            if (next === null || candidate < next) {
                next = candidate;
            }
        }
        return next;
    }
}
