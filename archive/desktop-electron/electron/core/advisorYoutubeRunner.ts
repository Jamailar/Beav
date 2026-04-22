import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import path from 'node:path';
import { getWorkspacePaths } from '../db';
import { indexManager } from './IndexManager';
import { normalizeVideo } from './normalization';
import { fetchVideoList, type VideoEntry } from './youtubeScraper';
import { queueSubtitleDownload } from './subtitleQueue';

export interface AdvisorYoutubeChannelConfig {
    url: string;
    channelId?: string;
    lastRefreshed?: string;
    backgroundEnabled?: boolean;
    refreshIntervalMinutes?: number;
    subtitleDownloadIntervalSeconds?: number;
    maxVideosPerRefresh?: number;
    maxDownloadsPerRun?: number;
    lastBackgroundRunAt?: string;
    lastBackgroundError?: string;
}

interface AdvisorConfig {
    name?: string;
    youtubeChannel?: AdvisorYoutubeChannelConfig;
    videos?: VideoEntry[];
}

export interface AdvisorYoutubeRunnerStatus {
    enabled: boolean;
    isTicking: boolean;
    tickIntervalMinutes: number;
    lastTickAt: string | null;
    nextTickAt: string | null;
    lastError: string | null;
}

export interface AdvisorYoutubeProgressEvent {
    advisorId: string;
    progress: string;
}

const DEFAULT_TICK_INTERVAL_MINUTES = 10;
const DEFAULT_REFRESH_INTERVAL_MINUTES = 180;
const DEFAULT_SUBTITLE_INTERVAL_SECONDS = 8;
const DEFAULT_MAX_VIDEOS_PER_REFRESH = 20;
const DEFAULT_MAX_DOWNLOADS_PER_RUN = 3;

function nowIso(): string {
    return new Date().toISOString();
}

function getAdvisorsDir(): string {
    return path.join(getWorkspacePaths().base, 'advisors');
}

function normalizeYoutubeChannelConfig(raw?: AdvisorYoutubeChannelConfig | null): AdvisorYoutubeChannelConfig | null {
    if (!raw?.url) return null;
    return {
        ...raw,
        backgroundEnabled: raw.backgroundEnabled !== false,
        refreshIntervalMinutes: Math.max(15, Number(raw.refreshIntervalMinutes) || DEFAULT_REFRESH_INTERVAL_MINUTES),
        subtitleDownloadIntervalSeconds: Math.max(3, Number(raw.subtitleDownloadIntervalSeconds) || DEFAULT_SUBTITLE_INTERVAL_SECONDS),
        maxVideosPerRefresh: Math.max(1, Number(raw.maxVideosPerRefresh) || DEFAULT_MAX_VIDEOS_PER_REFRESH),
        maxDownloadsPerRun: Math.max(1, Number(raw.maxDownloadsPerRun) || DEFAULT_MAX_DOWNLOADS_PER_RUN),
        lastBackgroundRunAt: raw.lastBackgroundRunAt || undefined,
        lastBackgroundError: raw.lastBackgroundError || undefined,
    };
}

async function readAdvisorConfig(advisorId: string): Promise<{ advisorDir: string; configPath: string; config: AdvisorConfig }> {
    const advisorDir = path.join(getAdvisorsDir(), advisorId);
    const configPath = path.join(advisorDir, 'config.json');
    const configRaw = await fs.readFile(configPath, 'utf-8');
    return {
        advisorDir,
        configPath,
        config: JSON.parse(configRaw) as AdvisorConfig,
    };
}

async function writeAdvisorConfig(configPath: string, config: AdvisorConfig): Promise<void> {
    await fs.writeFile(configPath, JSON.stringify(config, null, 2), 'utf-8');
}

function mergeVideos(existingVideos: VideoEntry[], fetchedVideos: VideoEntry[]): VideoEntry[] {
    const existingById = new Map(existingVideos.map((video) => [video.id, video]));
    const merged = fetchedVideos.map((video) => {
        const existing = existingById.get(video.id);
        return existing ? { ...video, ...existing } : video;
    });

    for (const existing of existingVideos) {
        if (!merged.some((video) => video.id === existing.id)) {
            merged.push(existing);
        }
    }

    return merged;
}

async function indexSubtitleIfNeeded(advisorId: string, video: VideoEntry, knowledgeDir: string): Promise<void> {
    if (!video.subtitleFile) return;
    try {
        const subtitleContent = await fs.readFile(path.join(knowledgeDir, video.subtitleFile), 'utf-8');
        indexManager.addToQueue(normalizeVideo(
            `advisor_${advisorId}_youtube_${video.id}`,
            {
                videoId: video.id,
                title: video.title,
                description: '',
                videoUrl: `https://www.youtube.com/watch?v=${video.id}`,
            },
            subtitleContent,
            'advisor',
            advisorId
        ));
    } catch (error) {
        console.error('[AdvisorYoutubeRunner] Failed to index subtitle:', error);
    }
}

export class AdvisorYoutubeBackgroundRunner extends EventEmitter {
    private timer: NodeJS.Timeout | null = null;
    private enabled = false;
    private isTicking = false;
    private tickIntervalMinutes = DEFAULT_TICK_INTERVAL_MINUTES;
    private lastTickAt: string | null = null;
    private nextTickAt: string | null = null;
    private lastError: string | null = null;

    start(intervalMinutes = DEFAULT_TICK_INTERVAL_MINUTES): AdvisorYoutubeRunnerStatus {
        this.tickIntervalMinutes = Math.max(1, Number(intervalMinutes) || DEFAULT_TICK_INTERVAL_MINUTES);
        this.enabled = true;
        this.resetTimer();
        return this.getStatus();
    }

    stop(): AdvisorYoutubeRunnerStatus {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
        this.enabled = false;
        this.nextTickAt = null;
        return this.getStatus();
    }

    getStatus(): AdvisorYoutubeRunnerStatus {
        return {
            enabled: this.enabled,
            isTicking: this.isTicking,
            tickIntervalMinutes: this.tickIntervalMinutes,
            lastTickAt: this.lastTickAt,
            nextTickAt: this.nextTickAt,
            lastError: this.lastError,
        };
    }

    async shouldKeepAliveWhenNoWindow(): Promise<boolean> {
        if (!this.enabled) return false;

        try {
            const advisorsDir = getAdvisorsDir();
            await fs.mkdir(advisorsDir, { recursive: true });
            const dirs = await fs.readdir(advisorsDir, { withFileTypes: true });

            for (const dir of dirs) {
                if (!dir.isDirectory()) continue;
                try {
                    const { config } = await readAdvisorConfig(dir.name);
                    const youtubeChannel = normalizeYoutubeChannelConfig(config.youtubeChannel);
                    if (youtubeChannel?.url && youtubeChannel.backgroundEnabled !== false) {
                        return true;
                    }
                } catch (error) {
                    console.warn('[AdvisorYoutubeRunner] keep-alive scan failed:', error);
                }
            }
        } catch (error) {
            console.warn('[AdvisorYoutubeRunner] keep-alive check failed:', error);
        }

        return false;
    }

    async runNow(advisorId?: string): Promise<{ success: boolean; processed: number; error?: string }> {
        try {
            const processed = await this.runTick(advisorId, true);
            return { success: true, processed };
        } catch (error) {
            return { success: false, processed: 0, error: String(error) };
        }
    }

    private resetTimer(): void {
        if (this.timer) {
            clearInterval(this.timer);
        }
        const intervalMs = this.tickIntervalMinutes * 60 * 1000;
        this.nextTickAt = new Date(Date.now() + intervalMs).toISOString();
        this.timer = setInterval(() => {
            void this.runTick().catch((error) => {
                console.error('[AdvisorYoutubeRunner] tick failed:', error);
            });
        }, intervalMs);
        void this.runTick().catch((error) => {
            console.error('[AdvisorYoutubeRunner] initial tick failed:', error);
        });
    }

    private async runTick(targetAdvisorId?: string, force = false): Promise<number> {
        if (!this.enabled && !force) return 0;
        if (this.isTicking) return 0;
        this.isTicking = true;
        this.lastTickAt = nowIso();
        this.lastError = null;

        try {
            const advisorsDir = getAdvisorsDir();
            await fs.mkdir(advisorsDir, { recursive: true });
            const dirs = await fs.readdir(advisorsDir, { withFileTypes: true });
            let processed = 0;

            for (const dir of dirs) {
                if (!dir.isDirectory()) continue;
                if (targetAdvisorId && dir.name !== targetAdvisorId) continue;
                const didProcess = await this.syncAdvisor(dir.name, force);
                if (didProcess) processed += 1;
            }

            return processed;
        } catch (error) {
            this.lastError = String(error);
            throw error;
        } finally {
            this.isTicking = false;
            if (this.enabled) {
                this.nextTickAt = new Date(Date.now() + this.tickIntervalMinutes * 60 * 1000).toISOString();
            }
        }
    }

    private async syncAdvisor(advisorId: string, force: boolean): Promise<boolean> {
        const { advisorDir, configPath, config } = await readAdvisorConfig(advisorId);
        const youtubeChannel = normalizeYoutubeChannelConfig(config.youtubeChannel);
        if (!youtubeChannel?.url) return false;
        if (!youtubeChannel.backgroundEnabled && !force) return false;

        if (!force && youtubeChannel.lastBackgroundRunAt) {
            const lastRunAt = new Date(youtubeChannel.lastBackgroundRunAt).getTime();
            const minNextAt = lastRunAt + youtubeChannel.refreshIntervalMinutes! * 60 * 1000;
            if (Number.isFinite(lastRunAt) && Date.now() < minNextAt) {
                return false;
            }
        }

        const knowledgeDir = path.join(advisorDir, 'knowledge');
        await fs.mkdir(knowledgeDir, { recursive: true });

        try {
            this.emitProgress(advisorId, '后台刷新 YouTube 视频列表...');
            const fetchedVideos = await fetchVideoList(youtubeChannel.url, youtubeChannel.maxVideosPerRefresh);
            const mergedVideos = mergeVideos(Array.isArray(config.videos) ? config.videos : [], fetchedVideos);
            config.videos = mergedVideos;
            config.youtubeChannel = {
                ...youtubeChannel,
                lastRefreshed: nowIso(),
                lastBackgroundRunAt: nowIso(),
                lastBackgroundError: '',
            };
            await writeAdvisorConfig(configPath, config);

            const queuedVideos = mergedVideos.filter((video) =>
                video.status === 'pending' || (video.status === 'failed' && (video.retryCount || 0) < 5)
            ).slice(0, youtubeChannel.maxDownloadsPerRun);

            for (let index = 0; index < queuedVideos.length; index += 1) {
                const video = queuedVideos[index];
                this.emitProgress(advisorId, `后台下载字幕 (${index + 1}/${queuedVideos.length}): ${video.title.slice(0, 30)}...`);
                video.status = 'downloading';
                await writeAdvisorConfig(configPath, config);

                const result = await queueSubtitleDownload(video.id, knowledgeDir, {
                    minIntervalMs: youtubeChannel.subtitleDownloadIntervalSeconds! * 1000,
                });

                if (result.success) {
                    video.status = 'success';
                    video.subtitleFile = result.subtitleFile;
                    video.errorMessage = undefined;
                    await indexSubtitleIfNeeded(advisorId, video, knowledgeDir);
                } else {
                    video.status = 'failed';
                    video.retryCount = (video.retryCount || 0) + 1;
                    video.errorMessage = result.error;
                }

                config.youtubeChannel = {
                    ...config.youtubeChannel,
                    lastBackgroundRunAt: nowIso(),
                    lastBackgroundError: '',
                };
                await writeAdvisorConfig(configPath, config);
            }

            if (queuedVideos.length > 0) {
                this.emitProgress(advisorId, `后台同步完成，处理 ${queuedVideos.length} 个视频`);
            }

            return true;
        } catch (error) {
            config.youtubeChannel = {
                ...youtubeChannel,
                lastBackgroundRunAt: nowIso(),
                lastBackgroundError: String(error),
            };
            await writeAdvisorConfig(configPath, config);
            this.emitProgress(advisorId, `后台同步失败: ${String(error)}`);
            return true;
        }
    }

    private emitProgress(advisorId: string, progress: string): void {
        this.emit('progress', { advisorId, progress } satisfies AdvisorYoutubeProgressEvent);
    }
}

let globalRunner: AdvisorYoutubeBackgroundRunner | null = null;

export function getAdvisorYoutubeBackgroundRunner(): AdvisorYoutubeBackgroundRunner {
    if (!globalRunner) {
        globalRunner = new AdvisorYoutubeBackgroundRunner();
    }
    return globalRunner;
}

export function getDefaultAdvisorYoutubeChannelConfig(input?: Partial<AdvisorYoutubeChannelConfig>): AdvisorYoutubeChannelConfig {
    return normalizeYoutubeChannelConfig({
        url: input?.url || '',
        channelId: input?.channelId || '',
        lastRefreshed: input?.lastRefreshed,
        backgroundEnabled: input?.backgroundEnabled,
        refreshIntervalMinutes: input?.refreshIntervalMinutes,
        subtitleDownloadIntervalSeconds: input?.subtitleDownloadIntervalSeconds,
        maxVideosPerRefresh: input?.maxVideosPerRefresh,
        maxDownloadsPerRun: input?.maxDownloadsPerRun,
        lastBackgroundRunAt: input?.lastBackgroundRunAt,
        lastBackgroundError: input?.lastBackgroundError,
    }) || {
        url: input?.url || '',
        channelId: input?.channelId || '',
        backgroundEnabled: true,
        refreshIntervalMinutes: DEFAULT_REFRESH_INTERVAL_MINUTES,
        subtitleDownloadIntervalSeconds: DEFAULT_SUBTITLE_INTERVAL_SECONDS,
        maxVideosPerRefresh: DEFAULT_MAX_VIDEOS_PER_REFRESH,
        maxDownloadsPerRun: DEFAULT_MAX_DOWNLOADS_PER_RUN,
    };
}
