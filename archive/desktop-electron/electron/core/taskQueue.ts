/**
 * Task Queue Manager - 统一任务队列管理
 *
 * 解决多进程冲突问题，确保：
 * 1. 字幕下载任务串行执行
 * 2. Embedding 索引任务串行执行
 * 3. 任务之间不会相互干扰
 * 4. 支持任务优先级和取消
 */

import { EventEmitter } from 'events';

// ========== 类型定义 ==========

export type TaskType = 'subtitle_download' | 'embedding_index';

export interface Task {
    id: string;
    type: TaskType;
    advisorId: string;
    priority: number; // 数字越大优先级越高
    data: unknown;
    createdAt: number;
    status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
    progress?: { current: number; total: number; message: string };
    result?: unknown;
    error?: string;
}

export interface TaskQueueEvents {
    'task:added': (task: Task) => void;
    'task:started': (task: Task) => void;
    'task:progress': (task: Task) => void;
    'task:completed': (task: Task) => void;
    'task:failed': (task: Task) => void;
    'task:cancelled': (task: Task) => void;
    'queue:empty': () => void;
}

type TaskExecutor = (task: Task, onProgress: (current: number, total: number, message: string) => void) => Promise<unknown>;

// ========== TaskQueue Class ==========

export class TaskQueue extends EventEmitter {
    private queues: Map<TaskType, Task[]> = new Map();
    private runningTasks: Map<TaskType, Task | null> = new Map();
    private executors: Map<TaskType, TaskExecutor> = new Map();
    private isProcessing: Map<TaskType, boolean> = new Map();
    private abortControllers: Map<string, AbortController> = new Map();

    constructor() {
        super();
        // 初始化队列
        this.queues.set('subtitle_download', []);
        this.runningTasks.set('subtitle_download', null);
        this.isProcessing.set('subtitle_download', false);

        this.queues.set('embedding_index', []);
        this.runningTasks.set('embedding_index', null);
        this.isProcessing.set('embedding_index', false);
    }

    /**
     * 注册任务执行器
     */
    registerExecutor(type: TaskType, executor: TaskExecutor): void {
        this.executors.set(type, executor);
    }

    /**
     * 添加任务到队列
     */
    addTask(type: TaskType, advisorId: string, data: unknown, priority: number = 0): Task {
        const task: Task = {
            id: `${type}_${advisorId}_${Date.now()}`,
            type,
            advisorId,
            priority,
            data,
            createdAt: Date.now(),
            status: 'pending',
        };

        const queue = this.queues.get(type)!;

        // 如果已有相同 advisorId 的任务正在运行，避免重复入队
        const running = this.runningTasks.get(type);
        if (running?.advisorId === advisorId && running.status === 'running') {
            console.log(`[TaskQueue] Task already running for ${advisorId}, skip enqueue`);
            return running;
        }

        // 检查是否已有相同 advisorId 的任务在队列中（避免重复）
        const existingIndex = queue.findIndex(t => t.advisorId === advisorId && t.status === 'pending');
        if (existingIndex >= 0) {
            // 如果已存在，更新数据并提升优先级
            queue[existingIndex].data = data;
            queue[existingIndex].priority = Math.max(queue[existingIndex].priority, priority);
            console.log(`[TaskQueue] Task already exists for ${advisorId}, updated`);
            return queue[existingIndex];
        }

        // 按优先级插入队列
        let insertIndex = queue.findIndex(t => t.priority < priority);
        if (insertIndex === -1) insertIndex = queue.length;
        queue.splice(insertIndex, 0, task);

        console.log(`[TaskQueue] Added task: ${task.id} (queue size: ${queue.length})`);
        this.emit('task:added', task);

        // 触发处理
        this.processQueue(type);

        return task;
    }

    /**
     * 取消任务
     */
    cancelTask(taskId: string): boolean {
        // 检查是否在队列中
        for (const [type, queue] of this.queues) {
            const index = queue.findIndex(t => t.id === taskId);
            if (index >= 0) {
                const task = queue[index];
                task.status = 'cancelled';
                queue.splice(index, 1);
                this.emit('task:cancelled', task);
                console.log(`[TaskQueue] Cancelled pending task: ${taskId}`);
                return true;
            }

            // 检查是否正在运行
            const running = this.runningTasks.get(type);
            if (running?.id === taskId) {
                const controller = this.abortControllers.get(taskId);
                if (controller) {
                    controller.abort();
                    console.log(`[TaskQueue] Aborting running task: ${taskId}`);
                    return true;
                }
            }
        }
        return false;
    }

    /**
     * 取消某个 advisor 的所有任务
     */
    cancelAdvisorTasks(advisorId: string): number {
        let cancelled = 0;
        for (const [type, queue] of this.queues) {
            // 取消队列中的任务
            for (let i = queue.length - 1; i >= 0; i--) {
                if (queue[i].advisorId === advisorId) {
                    const task = queue[i];
                    task.status = 'cancelled';
                    queue.splice(i, 1);
                    this.emit('task:cancelled', task);
                    cancelled++;
                }
            }

            // 取消正在运行的任务
            const running = this.runningTasks.get(type);
            if (running?.advisorId === advisorId) {
                const controller = this.abortControllers.get(running.id);
                if (controller) {
                    controller.abort();
                    cancelled++;
                }
            }
        }
        console.log(`[TaskQueue] Cancelled ${cancelled} tasks for advisor: ${advisorId}`);
        return cancelled;
    }

    /**
     * 获取队列状态
     */
    getQueueStatus(type: TaskType): {
        pending: number;
        running: Task | null;
        tasks: Task[];
    } {
        return {
            pending: this.queues.get(type)?.length || 0,
            running: this.runningTasks.get(type) || null,
            tasks: [...(this.queues.get(type) || [])],
        };
    }

    /**
     * 获取所有队列状态
     */
    getAllStatus(): Record<TaskType, { pending: number; running: Task | null }> {
        return {
            subtitle_download: {
                pending: this.queues.get('subtitle_download')?.length || 0,
                running: this.runningTasks.get('subtitle_download') || null,
            },
            embedding_index: {
                pending: this.queues.get('embedding_index')?.length || 0,
                running: this.runningTasks.get('embedding_index') || null,
            },
        };
    }

    /**
     * 处理队列
     */
    private async processQueue(type: TaskType): Promise<void> {
        // 如果已经在处理中，跳过
        if (this.isProcessing.get(type)) {
            return;
        }

        const queue = this.queues.get(type)!;
        if (queue.length === 0) {
            return;
        }

        const executor = this.executors.get(type);
        if (!executor) {
            console.error(`[TaskQueue] No executor registered for type: ${type}`);
            return;
        }

        this.isProcessing.set(type, true);

        while (queue.length > 0) {
            const task = queue.shift()!;
            task.status = 'running';
            this.runningTasks.set(type, task);

            // 创建 AbortController
            const abortController = new AbortController();
            this.abortControllers.set(task.id, abortController);

            console.log(`[TaskQueue] Starting task: ${task.id}`);
            this.emit('task:started', task);

            try {
                const result = await executor(task, (current, total, message) => {
                    task.progress = { current, total, message };
                    this.emit('task:progress', task);
                });

                if (abortController.signal.aborted) {
                    task.status = 'cancelled';
                    this.emit('task:cancelled', task);
                } else {
                    task.status = 'completed';
                    task.result = result;
                    console.log(`[TaskQueue] Completed task: ${task.id}`);
                    this.emit('task:completed', task);
                }
            } catch (error) {
                if (abortController.signal.aborted) {
                    task.status = 'cancelled';
                    this.emit('task:cancelled', task);
                } else {
                    task.status = 'failed';
                    task.error = error instanceof Error ? error.message : String(error);
                    console.error(`[TaskQueue] Failed task: ${task.id}`, error);
                    this.emit('task:failed', task);
                }
            } finally {
                this.abortControllers.delete(task.id);
                this.runningTasks.set(type, null);
            }

            // 短暂延迟，避免过于频繁
            await new Promise(resolve => setTimeout(resolve, 500));
        }

        this.isProcessing.set(type, false);
        this.emit('queue:empty');
    }
}

// ========== 全局单例 ==========

let globalTaskQueue: TaskQueue | null = null;

export function getTaskQueue(): TaskQueue {
    if (!globalTaskQueue) {
        globalTaskQueue = new TaskQueue();
    }
    return globalTaskQueue;
}

export function initializeTaskQueue(): TaskQueue {
    const queue = getTaskQueue();
    console.log('[TaskQueue] Initialized global task queue');
    return queue;
}
