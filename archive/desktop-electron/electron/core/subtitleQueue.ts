/**
 * 字幕下载队列服务
 * 确保同一时间只有一个字幕下载任务在执行，防止 YouTube 429 限流
 */

import { downloadSingleSubtitle } from './youtubeScraper';

interface SubtitleTask {
    id: string;
    videoId: string;
    outputDir: string;
    minIntervalMs?: number;
    resolve: (result: { success: boolean; subtitleFile?: string; error?: string }) => void;
    addedAt: number;
}

class SubtitleDownloadQueue {
    private queue: SubtitleTask[] = [];
    private isProcessing: boolean = false;
    private lastDownloadTime: number = 0;
    private readonly DEFAULT_MIN_INTERVAL_MS = 3000; // 默认最小间隔 3 秒

    /**
     * 添加字幕下载任务到队列
     */
    addTask(
        videoId: string,
        outputDir: string,
        options?: { minIntervalMs?: number }
    ): Promise<{ success: boolean; subtitleFile?: string; error?: string }> {
        return new Promise((resolve) => {
            const taskId = `${videoId}_${Date.now()}`;

            // 检查是否已经在队列中
            const existingTask = this.queue.find(t => t.videoId === videoId);
            if (existingTask) {
                console.log(`[SubtitleQueue] Task for ${videoId} already in queue, skipping`);
                resolve({ success: false, error: 'Task already in queue' });
                return;
            }

            const task: SubtitleTask = {
                id: taskId,
                videoId,
                outputDir,
                minIntervalMs: options?.minIntervalMs,
                resolve,
                addedAt: Date.now()
            };

            this.queue.push(task);
            console.log(`[SubtitleQueue] Added task for ${videoId}, queue length: ${this.queue.length}`);

            // 开始处理队列
            this.processQueue();
        });
    }

    /**
     * 获取队列状态
     */
    getStatus() {
        return {
            queueLength: this.queue.length,
            isProcessing: this.isProcessing,
            pendingVideoIds: this.queue.map(t => t.videoId)
        };
    }

    /**
     * 处理队列
     */
    private async processQueue() {
        // 如果已经在处理，不重复启动
        if (this.isProcessing) {
            return;
        }

        // 如果队列为空，退出
        if (this.queue.length === 0) {
            return;
        }

        this.isProcessing = true;

        while (this.queue.length > 0) {
            const task = this.queue[0];
            const minIntervalMs = Math.max(this.DEFAULT_MIN_INTERVAL_MS, Number(task.minIntervalMs) || 0);

            // 计算需要等待的时间
            const timeSinceLastDownload = Date.now() - this.lastDownloadTime;
            const waitTime = Math.max(0, minIntervalMs - timeSinceLastDownload);

            if (waitTime > 0) {
                console.log(`[SubtitleQueue] Waiting ${waitTime}ms before next download...`);
                await this.sleep(waitTime);
            }

            console.log(`[SubtitleQueue] Processing task for ${task.videoId}, remaining: ${this.queue.length - 1}`);

            try {
                // 执行下载
                const result = await downloadSingleSubtitle(task.videoId, task.outputDir);

                // 记录下载时间
                this.lastDownloadTime = Date.now();

                // 返回结果
                task.resolve(result);

                // 如果遇到 429 错误，增加等待时间
                if (result.error && result.error.includes('429')) {
                    console.log(`[SubtitleQueue] Got 429 error, adding extra delay...`);
                    await this.sleep(10000); // 额外等待 10 秒
                }
            } catch (error) {
                console.error(`[SubtitleQueue] Error processing task for ${task.videoId}:`, error);
                task.resolve({ success: false, error: String(error) });
            }

            // 移除已处理的任务
            this.queue.shift();
        }

        this.isProcessing = false;
        console.log(`[SubtitleQueue] Queue empty, processing stopped`);
    }

    private sleep(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}

// 导出单例
export const subtitleQueue = new SubtitleDownloadQueue();

/**
 * 通过队列下载字幕（推荐使用）
 */
export async function queueSubtitleDownload(
    videoId: string,
    outputDir: string,
    options?: { minIntervalMs?: number }
): Promise<{ success: boolean; subtitleFile?: string; error?: string }> {
    return subtitleQueue.addTask(videoId, outputDir, options);
}

/**
 * 获取队列状态
 */
export function getSubtitleQueueStatus() {
    return subtitleQueue.getStatus();
}
