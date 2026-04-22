export type ScheduleMode = 'interval' | 'daily' | 'weekly' | 'once';
export type RunnerResult = 'success' | 'error' | 'skipped';
export type SidebarTab = 'skills';

export interface RunnerScheduledTask {
    id: string;
    name: string;
    enabled: boolean;
    mode: ScheduleMode;
    prompt: string;
    intervalMinutes?: number;
    time?: string;
    weekdays?: number[];
    runAt?: string;
    createdAt: string;
    updatedAt: string;
    lastRunAt?: string;
    lastResult?: RunnerResult;
    lastError?: string;
    nextRunAt?: string;
}

export interface RunnerLongCycleTask {
    id: string;
    name: string;
    enabled: boolean;
    status: 'running' | 'paused' | 'completed';
    objective: string;
    stepPrompt: string;
    intervalMinutes: number;
    totalRounds: number;
    completedRounds: number;
    createdAt: string;
    updatedAt: string;
    lastRunAt?: string;
    lastResult?: RunnerResult;
    lastError?: string;
    nextRunAt?: string;
}

export interface RunnerStatus {
    enabled: boolean;
    lockState: 'owner' | 'passive';
    blockedBy: string | null;
    intervalMinutes: number;
    keepAliveWhenNoWindow: boolean;
    maxProjectsPerTick: number;
    maxAutomationPerTick?: number;
    isTicking: boolean;
    currentProjectId: string | null;
    currentAutomationTaskId?: string | null;
    nextAutomationFireAt?: string | null;
    inFlightTaskIds?: string[];
    inFlightLongCycleTaskIds?: string[];
    heartbeatInFlight?: boolean;
    lastTickAt: string | null;
    nextTickAt: string | null;
    nextMaintenanceAt?: string | null;
    lastError: string | null;
    heartbeat?: {
        enabled: boolean;
        intervalMinutes: number;
        suppressEmptyReport: boolean;
        reportToMainSession: boolean;
        prompt?: string;
        lastRunAt?: string;
        nextRunAt?: string;
        lastDigest?: string;
    };
    scheduledTasks?: Record<string, RunnerScheduledTask>;
    longCycleTasks?: Record<string, RunnerLongCycleTask>;
}

export interface ScheduleTemplate {
    id: string;
    label: string;
    description: string;
    name: string;
    mode: ScheduleMode;
    intervalMinutes?: number;
    time?: string;
    weekdays?: number[];
    prompt: string;
}

export interface LongTemplate {
    id: string;
    label: string;
    description: string;
    name: string;
    objective: string;
    stepPrompt: string;
    intervalMinutes: number;
    totalRounds: number;
}

export interface ScheduleDraft {
    templateId: string;
    name: string;
    mode: ScheduleMode;
    intervalMinutes: number;
    time: string;
    weekdays: number[];
    runAtLocal: string;
    prompt: string;
}

export interface LongDraft {
    templateId: string;
    name: string;
    objective: string;
    stepPrompt: string;
    intervalMinutes: number;
    totalRounds: number;
}
