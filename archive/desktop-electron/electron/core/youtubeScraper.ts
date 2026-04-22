import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import os from 'os';

const YTDLP_URL = "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_macos"; // Default to macos for this user env
const LOCAL_BIN_DIR = path.join(os.homedir(), '.redconvert', 'bin');
const LOCAL_YTDLP_PATH = path.join(LOCAL_BIN_DIR, 'yt-dlp');
const LOCAL_YTDLP_META = path.join(LOCAL_BIN_DIR, 'yt-dlp.json'); // 版本信息文件

interface YtdlpMeta {
    version: string;
    installedAt: string;
    updatedAt?: string;
    lastCheckAt?: string; // 上次检查更新时间
}

/**
 * 保存 yt-dlp 元信息
 */
function saveYtdlpMeta(version: string, isUpdate = false): void {
    const meta: YtdlpMeta = {
        version,
        installedAt: new Date().toISOString(),
    };

    // 如果是更新，保留原安装时间
    if (isUpdate && fs.existsSync(LOCAL_YTDLP_META)) {
        try {
            const existing = JSON.parse(fs.readFileSync(LOCAL_YTDLP_META, 'utf-8'));
            meta.installedAt = existing.installedAt || meta.installedAt;
            meta.updatedAt = new Date().toISOString();
        } catch { /* ignore */ }
    }

    fs.writeFileSync(LOCAL_YTDLP_META, JSON.stringify(meta, null, 2));
}

/**
 * 更新上次检查时间
 */
function updateLastCheckTime(): void {
    try {
        let meta: YtdlpMeta = { version: 'unknown', installedAt: new Date().toISOString() };
        if (fs.existsSync(LOCAL_YTDLP_META)) {
            meta = JSON.parse(fs.readFileSync(LOCAL_YTDLP_META, 'utf-8'));
        }
        meta.lastCheckAt = new Date().toISOString();
        fs.writeFileSync(LOCAL_YTDLP_META, JSON.stringify(meta, null, 2));
    } catch { /* ignore */ }
}

/**
 * 读取 yt-dlp 元信息
 */
function loadYtdlpMeta(): YtdlpMeta | null {
    try {
        if (fs.existsSync(LOCAL_YTDLP_META)) {
            return JSON.parse(fs.readFileSync(LOCAL_YTDLP_META, 'utf-8'));
        }
    } catch { /* ignore */ }
    return null;
}

function getEnv() {
    // Ensure we have common bin paths especially for GUI apps on macOS which might lack them
    const commonPaths = [
        '/opt/homebrew/bin',
        '/usr/local/bin',
        '/usr/bin',
        '/bin',
        '/usr/sbin',
        '/sbin',
        path.join(os.homedir(), '.nvm/versions/node/current/bin'), // Try to find nvm node
    ];

    const currentPath = process.env.PATH || '';
    const newPath = commonPaths.reduce((acc, p) => {
        if (!acc.includes(p) && fs.existsSync(p)) {
            return p + path.delimiter + acc;
        }
        return acc;
    }, currentPath);

    return {
        ...process.env,
        PATH: newPath
    };
}

function buildCommonYtdlpArgs(): string[] {
    return [
        '--no-warnings',
        '--ignore-errors',
        '--no-call-home',
        '--extractor-retries', '3',
        '--retries', '3',
        '--socket-timeout', '20',
        '--geo-bypass',
    ];
}

function normalizeChannelUrlCandidates(channelUrl: string): string[] {
    const raw = String(channelUrl || '').trim().replace(/\/$/, '');
    if (!raw) return [];

    const candidates: string[] = [];
    const push = (value: string) => {
        const next = String(value || '').trim();
        if (next && !candidates.includes(next)) {
            candidates.push(next);
        }
    };

    const alreadyScoped = /\/(videos|streams|shorts|featured)(\/)?$/i.test(raw);
    if (alreadyScoped) {
        push(raw);
    } else {
        push(`${raw}/videos`);
        push(raw);
        push(`${raw}/featured`);
    }

    return candidates;
}

function isTransientYoutubeError(text: string): boolean {
    const lower = String(text || '').toLowerCase();
    return [
        '429',
        'too many requests',
        'timed out',
        'timeout',
        'http error 5',
        'service unavailable',
        'temporarily unavailable',
        'remote end closed connection',
        'connection reset',
        'connection aborted',
        'unable to download api page',
        'precondition check failed',
    ].some((pattern) => lower.includes(pattern));
}

export interface YouTubeChannelInfo {
    channelId: string;
    channelName: string;
    channelDescription: string;
    avatarUrl: string;
    recentVideos: Array<{ id: string; title: string }>;
}

export interface VideoEntry {
    id: string;
    title: string;
    publishedAt: string;
    status: 'pending' | 'downloading' | 'success' | 'failed';
    retryCount: number;
    errorMessage?: string;
    subtitleFile?: string;
}

export async function checkYtdlp(): Promise<{ installed: boolean; version?: string; path?: string }> {
    // 快速检查：只检查文件是否存在 + 读取 meta 文件
    // 不再执行 yt-dlp --version，避免耗时

    // 1. 检查本地安装的 yt-dlp
    if (fs.existsSync(LOCAL_YTDLP_PATH)) {
        const meta = loadYtdlpMeta();
        return {
            installed: true,
            version: meta?.version || '已安装',
            path: LOCAL_YTDLP_PATH
        };
    }

    // 2. 检查系统 PATH 中的 yt-dlp (简单检查常见路径)
    const systemPaths = [
        '/opt/homebrew/bin/yt-dlp',
        '/usr/local/bin/yt-dlp',
        '/usr/bin/yt-dlp'
    ];

    for (const p of systemPaths) {
        if (fs.existsSync(p)) {
            return {
                installed: true,
                version: '系统安装',
                path: p
            };
        }
    }

    return { installed: false };
}

// 保留原始的异步检测函数，用于需要精确版本号的场景
async function checkYtdlpWithVersion(): Promise<{ installed: boolean; version?: string; path?: string }> {
    const { execSync } = require('child_process');
    const env = getEnv();

    if (fs.existsSync(LOCAL_YTDLP_PATH)) {
        try {
            const version = execSync(`"${LOCAL_YTDLP_PATH}" --version`, {
                env,
                timeout: 5000,
                encoding: 'utf-8'
            }).trim();
            return { installed: true, version, path: LOCAL_YTDLP_PATH };
        } catch { }
    }

    try {
        const version = execSync('yt-dlp --version', {
            env,
            timeout: 5000,
            encoding: 'utf-8'
        }).trim();
        return { installed: true, version, path: 'yt-dlp (system)' };
    } catch { }

    return { installed: false };
}

// 不再需要这个函数，但保留以防其他地方引用
function checkSystemYtdlp(resolve: (value: { installed: boolean; version?: string; path?: string }) => void) {
    try {
        const process = spawn('yt-dlp', ['--version'], { env: getEnv() });
        let version = '';
        process.stdout.on('data', (data: Buffer) => version += data.toString().trim());
        process.on('close', (code: number) => resolve({ installed: code === 0, version, path: code === 0 ? 'yt-dlp (system)' : undefined }));
        process.on('error', () => resolve({ installed: false }));
    } catch (e) {
        resolve({ installed: false });
    }
}

export async function installYtdlp(onProgress?: (progress: number) => void): Promise<boolean> {
    return new Promise((resolve, reject) => {
        if (!fs.existsSync(LOCAL_BIN_DIR)) {
            fs.mkdirSync(LOCAL_BIN_DIR, { recursive: true });
        }

        // Remove existing potential bad file
        if (fs.existsSync(LOCAL_YTDLP_PATH)) {
            try { fs.unlinkSync(LOCAL_YTDLP_PATH); } catch (e) { /* ignore */ }
        }

        // Use curl for robust download (handles redirects, https, etc. better on macOS)
        const args = ['-L', YTDLP_URL, '-o', LOCAL_YTDLP_PATH];
        const curl = spawn('curl', args);

        // Curl doesn't easily output percentage without -# or progress parsing,
        // but we can at least mimic some progress or just allow it to run.
        if (onProgress) onProgress(10); // Started

        curl.on('close', async (code) => {
            if (code === 0) {
                if (fs.existsSync(LOCAL_YTDLP_PATH)) {
                    fs.chmodSync(LOCAL_YTDLP_PATH, '755'); // Make executable

                    // 获取并保存版本号
                    try {
                        const { execSync } = require('child_process');
                        const version = execSync(`"${LOCAL_YTDLP_PATH}" --version`, {
                            timeout: 10000,
                            encoding: 'utf-8'
                        }).trim();
                        saveYtdlpMeta(version, false);
                    } catch (e) {
                        // 获取版本失败，保存一个占位版本
                        saveYtdlpMeta('unknown', false);
                    }

                    if (onProgress) onProgress(100);
                    resolve(true);
                } else {
                    reject(new Error('Download finished but file missing'));
                }
            } else {
                reject(new Error(`Curl failed with exit code ${code}`));
            }
        });

        curl.on('error', (err) => {
            reject(err);
        });
    });
}

export async function updateYtdlp(): Promise<boolean> {
    const { path: ytPath } = await checkYtdlp();
    if (!ytPath) return false;

    // If using system yt-dlp, we probably shouldn't auto-update it or we need sudo?
    // Let's assume we update only our local one or try 'yt-dlp -U' and see what happens.
    // Ideally we only update the one we manage.

    const cmd = ytPath === LOCAL_YTDLP_PATH ? LOCAL_YTDLP_PATH : 'yt-dlp';

    return new Promise((resolve) => {
        const proc = spawn(cmd, ['-U'], { env: getEnv() });
        proc.on('close', (code: number) => {
            if (code === 0) {
                // 更新成功后，重新获取并保存版本号
                try {
                    const { execSync } = require('child_process');
                    const version = execSync(`"${cmd}" --version`, {
                        timeout: 10000,
                        encoding: 'utf-8'
                    }).trim();
                    saveYtdlpMeta(version, true);
                } catch { /* ignore */ }
            }
            resolve(code === 0);
        });
        proc.on('error', () => resolve(false));
    });
}

/**
 * 检查是否需要更新（每天最多检查一次）
 */
export function shouldCheckForUpdate(): boolean {
    const meta = loadYtdlpMeta();
    if (!meta?.lastCheckAt) return true;

    const lastCheck = new Date(meta.lastCheckAt).getTime();
    const now = Date.now();
    const ONE_DAY = 24 * 60 * 60 * 1000;

    return (now - lastCheck) > ONE_DAY;
}

/**
 * 启动时自动检查和安装/更新 yt-dlp
 * 静默执行，不阻塞主流程
 */
export async function autoSetupYtdlp(): Promise<{ action: 'none' | 'installed' | 'updated' | 'failed'; message: string }> {
    console.log('[yt-dlp] Auto setup check...');

    try {
        const status = await checkYtdlp();

        // 未安装：自动安装
        if (!status.installed) {
            console.log('[yt-dlp] Not installed, auto installing...');
            try {
                await installYtdlp();
                console.log('[yt-dlp] Auto install completed');
                return { action: 'installed', message: 'yt-dlp 已自动安装' };
            } catch (e) {
                console.error('[yt-dlp] Auto install failed:', e);
                return { action: 'failed', message: '自动安装失败' };
            }
        }

        // 已安装：检查是否需要更新
        if (!shouldCheckForUpdate()) {
            console.log('[yt-dlp] Update check skipped (checked recently)');
            return { action: 'none', message: '无需更新' };
        }

        // 执行更新检查
        console.log('[yt-dlp] Checking for updates...');
        updateLastCheckTime();

        const updated = await updateYtdlp();
        if (updated) {
            console.log('[yt-dlp] Updated successfully');
            return { action: 'updated', message: 'yt-dlp 已更新' };
        } else {
            console.log('[yt-dlp] Already up to date');
            return { action: 'none', message: '已是最新版本' };
        }
    } catch (e) {
        console.error('[yt-dlp] Auto setup error:', e);
        return { action: 'failed', message: String(e) };
    }
}

export async function fetchChannelInfo(channelUrl: string, onProgress?: (msg: string) => void): Promise<YouTubeChannelInfo> {
    const { path: ytPath } = await checkYtdlp();
    const cmd = ytPath || 'yt-dlp';
    const candidates = normalizeChannelUrlCandidates(channelUrl);

    console.log(`[fetchChannelInfo] using binary: ${cmd}`);
    let lastError = 'unknown error';

    for (const candidate of candidates) {
        try {
            if (onProgress) onProgress(`Starting info fetch for ${candidate}...`);
            return await fetchChannelInfoWithSingleJson(candidate);
        } catch (error) {
            lastError = String(error);
            console.warn(`[fetchChannelInfo] candidate failed: ${candidate}`, error);
        }
    }

    throw new Error(`Failed to fetch channel info: ${lastError}`);
}

async function fetchChannelInfoWithSingleJson(channelUrl: string): Promise<YouTubeChannelInfo> {
    const { path: ytPath } = await checkYtdlp();
    const cmd = ytPath || 'yt-dlp';

    return new Promise((resolve, reject) => {
        const args = [
            ...buildCommonYtdlpArgs(),
            '-J', // dump single json
            '--flat-playlist',
            '--playlist-end', '5',
            channelUrl
        ];

        const process = spawn(cmd, args, { env: getEnv() }); // spawn does not support maxBuffer, we handle buffering manually
        let output = '';
        let errorOutput = '';

        process.stdout.on('data', (data: Buffer) => {
            output += data.toString();
        });

        process.stderr.on('data', (data: Buffer) => {
            errorOutput += data.toString();
        });

        process.on('close', (code: number) => {
            if (code !== 0) {
                reject(new Error(`Failed to fetch channel info: ${errorOutput}`));
                return;
            }

            try {
                const data = JSON.parse(output);

                // Extract channel info
                // Note: data might be a playlist object or a video object depending on URL
                // For a channel URL, it's typically a playlist

                const channelName = data.uploader || data.channel || data.title || 'Unknown Channel';
                const channelId = data.channel_id || data.uploader_id || data.id;
                const channelDescription = data.description || '';

                // Find best avatar
                let avatarUrl = '';
                if (data.thumbnails && data.thumbnails.length > 0) {
                    // Find highest resolution thumbnail that looks like an avatar (usually square-ish)
                    // or just the last one which is usually highest quality
                    avatarUrl = data.thumbnails[data.thumbnails.length - 1].url;
                }

                const recentVideos = (data.entries || []).map((entry: any) => ({
                    id: entry.id,
                    title: entry.title
                }));

                resolve({
                    channelId,
                    channelName,
                    channelDescription,
                    avatarUrl,
                    recentVideos
                });
            } catch (e) {
                reject(new Error(`Failed to parse yt-dlp output: ${e}`));
            }
        });
    });
}

export async function downloadSubtitles(
    channelUrl: string,
    videoCount: number,
    outputDir: string,
    onProgress?: (progress: string) => void
): Promise<string[]> {
    const { path: ytPath } = await checkYtdlp();
    const cmd = ytPath || 'yt-dlp';

    return new Promise((resolve) => {
        // Ensure output directory exists
        // (Caller should handle this, but just in case)

        const args = [
            '--skip-download',      // Don't download video
            '--write-auto-sub',     // Write automatic subtitles
            '--write-sub',          // Write manual subtitles if available
            '--sub-lang', 'en,en-US,en-GB', // Prioritize English subtitles
            '--sub-format', 'vtt',  // VTT format
            '--convert-subs', 'srt', // Convert to SRT for easier reading
            '--playlist-end', String(videoCount),
            '--output', path.join(outputDir, '%(title)s.%(ext)s'),
            '--no-overwrites',      // Skip if exists
            channelUrl
        ];

        console.log(`[downloadSubtitles] spawning: ${cmd} ${args.join(' ')}`);

        const process = spawn(cmd, args, { env: getEnv() });
        let errorOutput = '';

        process.stdout.on('data', (data) => {
            const line = data.toString();
            if (onProgress) {
                // Parse progress info if possible, or just send line
                // yt-dlp output example: [download] Downloading video 1 of 10
                onProgress(line);
            }
        });

        process.stderr.on('data', (data) => {
            // yt-dlp often prints progress to stderr
            const line = data.toString();
            // console.log('yt-dlp stderr:', line); // Debug
            if (onProgress) {
                onProgress(line);
            }
            errorOutput += line;
        });

        process.on('close', (code) => {
            if (code !== 0) {
                // Warning: yt-dlp might return non-zero if some videos fail, 
                // but we might still have successfully downloaded others.
                // We act successfully if we downloaded anything, but maybe log warning.
                console.warn('[downloadSubtitles] yt-dlp finished with code', code);
                console.warn('[downloadSubtitles] stderr accumulated:', errorOutput);
            } else {
                console.log('[downloadSubtitles] finished successfully');
            }

            resolve([]); // We don't track exact files here easily without parsing output
        });
    });
}

/**
 * Fetch video list from a YouTube channel
 */
export async function fetchVideoList(channelUrl: string, limit: number = 50): Promise<VideoEntry[]> {
    const { path: ytPath } = await checkYtdlp();
    const cmd = ytPath || 'yt-dlp';
    const candidates = normalizeChannelUrlCandidates(channelUrl);
    let lastError = 'unknown error';

    for (const candidate of candidates) {
        try {
            const videos = await new Promise<VideoEntry[]>((resolve, reject) => {
                const args = [
                    ...buildCommonYtdlpArgs(),
                    '-J',
                    '--flat-playlist',
                    '--playlist-end', String(limit),
                    candidate
                ];

                console.log(`[fetchVideoList] spawning: ${cmd} ${args.join(' ')}`);

                const process = spawn(cmd, args, { env: getEnv() });
                let output = '';
                let errorOutput = '';

                process.stdout.on('data', (data: Buffer) => {
                    output += data.toString();
                });

                process.stderr.on('data', (data: Buffer) => {
                    errorOutput += data.toString();
                });

                process.on('close', (code: number) => {
                    if (code !== 0) {
                        console.error('[fetchVideoList] error:', errorOutput);
                        reject(new Error(`Failed to fetch video list: ${errorOutput}`));
                        return;
                    }

                    try {
                        const data = JSON.parse(output);
                        const videos: VideoEntry[] = (data.entries || []).map((entry: { id: string; title: string; upload_date?: string }) => ({
                            id: entry.id,
                            title: entry.title || 'Untitled',
                            publishedAt: entry.upload_date || '',
                            status: 'pending' as const,
                            retryCount: 0
                        }));
                        resolve(videos);
                    } catch (e) {
                        reject(new Error(`Failed to parse video list: ${e}`));
                    }
                });

                process.on('error', (err) => reject(err));
            });

            if (videos.length > 0) {
                return videos;
            }
        } catch (error) {
            lastError = String(error);
            console.warn(`[fetchVideoList] candidate failed: ${candidate}`, error);
        }
    }

    throw new Error(`Failed to fetch video list: ${lastError}`);
}

/**
 * Download subtitle for a single video
 * Downloads any available subtitle (auto or manual) and renames to {videoId}.txt
 * Includes retry logic for 429 rate limit errors
 */
export async function downloadSingleSubtitle(
    videoId: string,
    outputDir: string,
    retryCount: number = 0
): Promise<{ success: boolean; subtitleFile?: string; error?: string }> {
    const { path: ytPath } = await checkYtdlp();
    const cmd = ytPath || 'yt-dlp';
    const MAX_RETRIES = 3;
    const RETRY_DELAYS = [5000, 15000, 30000]; // 5s, 15s, 30s

    return new Promise((resolve) => {
        const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;
        // Use video ID as output filename to make matching easier
        const tempOutputPath = path.join(outputDir, `${videoId}_temp.%(ext)s`);
        const finalTxtPath = path.join(outputDir, `${videoId}.txt`);

        // Check if already exists
        if (fs.existsSync(finalTxtPath)) {
            resolve({ success: true, subtitleFile: `${videoId}.txt` });
            return;
        }

        const attemptArgsMatrix: string[][] = [
            [
                ...buildCommonYtdlpArgs(),
                '--skip-download',
                '--write-auto-sub',
                '--write-sub',
                '--sub-langs', 'all,-live_chat',
                '--sub-format', 'vtt/srt/best',
                '--convert-subs', 'srt',
                '--no-playlist',
                '--sleep-requests', '1',
                '--output', tempOutputPath,
                videoUrl,
            ],
            [
                ...buildCommonYtdlpArgs(),
                '--extractor-args', 'youtube:player_client=android,web',
                '--skip-download',
                '--write-auto-sub',
                '--write-sub',
                '--sub-langs', 'all,-live_chat',
                '--sub-format', 'vtt/srt/best',
                '--convert-subs', 'srt',
                '--no-playlist',
                '--sleep-requests', '1',
                '--output', tempOutputPath,
                videoUrl,
            ],
            [
                ...buildCommonYtdlpArgs(),
                '--extractor-args', 'youtube:player_client=tv,ios,web',
                '--skip-download',
                '--write-auto-sub',
                '--write-sub',
                '--sub-langs', 'all,-live_chat',
                '--sub-format', 'vtt/srt/best',
                '--convert-subs', 'srt',
                '--no-playlist',
                '--sleep-requests', '1',
                '--output', tempOutputPath,
                videoUrl,
            ],
        ];

        const args = attemptArgsMatrix[Math.min(retryCount, attemptArgsMatrix.length - 1)];

        console.log(`[downloadSingleSubtitle] spawning (attempt ${retryCount + 1}/${MAX_RETRIES + 1}): ${cmd} ${args.join(' ')}`);

        const proc = spawn(cmd, args, { env: getEnv() });
        let errorOutput = '';
        let stdoutOutput = '';

        proc.stdout.on('data', (data: Buffer) => {
            const msg = data.toString();
            stdoutOutput += msg;
            console.log(`[downloadSingleSubtitle] stdout: ${msg.trim()}`);
        });

        proc.stderr.on('data', (data: Buffer) => {
            const msg = data.toString();
            errorOutput += msg;
            console.log(`[downloadSingleSubtitle] stderr: ${msg.trim()}`);
        });

        proc.on('close', async (code: number) => {
            // Find downloaded subtitle file (could be .vtt, .srt, .ttml, .srv1, .srv2, .srv3, .json3, any language)
            const files = fs.readdirSync(outputDir).filter(f =>
                f.startsWith(`${videoId}_temp`) &&
                (f.endsWith('.vtt') || f.endsWith('.srt') || f.endsWith('.ttml') ||
                 f.endsWith('.srv1') || f.endsWith('.srv2') || f.endsWith('.srv3') ||
                 f.endsWith('.json3') || f.endsWith('.xml'))
            );

            console.log(`[downloadSingleSubtitle] Found subtitle files:`, files);

            if (files.length > 0) {
                // Take the first match and convert to txt
                const srcFile = path.join(outputDir, files[0]);
                try {
                    // Read subtitle content and write as .txt
                    const content = fs.readFileSync(srcFile, 'utf-8');

                    // 彻底清理字幕格式，转换为纯文本（无换行）
                    const cleanedContent = content
                        // 移除 VTT 头部信息（包括 WEBVTT、Kind、Language 等）
                        .replace(/^WEBVTT[\s\S]*?(?=\n\n|\n\d)/m, '')
                        .replace(/^Kind:.*$/gm, '')
                        .replace(/^Language:.*$/gm, '')
                        // 移除 VTT 时间轴（格式：00:00:00.000 --> 00:00:00.000 或带位置信息）
                        .replace(/^\d{2}:\d{2}:\d{2}[.,]\d{3}\s*-->\s*\d{2}:\d{2}:\d{2}[.,]\d{3}.*$/gm, '')
                        // 移除 SRT 时间轴（格式：00:00:00,000 --> 00:00:00,000）
                        .replace(/^\d{2}:\d{2}:\d{2},\d{3}\s*-->\s*\d{2}:\d{2}:\d{2},\d{3}.*$/gm, '')
                        // 移除 VTT cue 标识符（如 00:00:00.000）
                        .replace(/^\d{2}:\d{2}:\d{2}[.,]\d{3}$/gm, '')
                        // 移除 SRT 序号行（纯数字行）
                        .replace(/^\d+$/gm, '')
                        // 移除 VTT 的位置标记（如 align:start position:0%）
                        .replace(/align:\w+\s*/g, '')
                        .replace(/position:\d+%\s*/g, '')
                        // 移除 HTML/VTT 标签（如 <c>, </c>, <00:00:00.000>）
                        .replace(/<[^>]+>/g, '')
                        // 移除行内时间标记（如 00:00:00.000）
                        .replace(/\d{2}:\d{2}:\d{2}[.,]\d{3}/g, '')
                        // 将所有内容合并为一行纯文本
                        .split('\n')
                        .map(line => line.trim())
                        .filter(line => line.length > 0)
                        .join(' ')
                        // 移除多余空格
                        .replace(/\s{2,}/g, ' ')
                        .trim();

                    fs.writeFileSync(finalTxtPath, cleanedContent, 'utf-8');

                    // Clean up temp file(s)
                    files.forEach(f => {
                        try { fs.unlinkSync(path.join(outputDir, f)); } catch (e) { /* ignore */ }
                    });

                    resolve({ success: true, subtitleFile: `${videoId}.txt` });
                } catch (e) {
                    resolve({ success: false, error: `Failed to convert subtitle: ${e}` });
                }
            } else if (isTransientYoutubeError(errorOutput) || isTransientYoutubeError(stdoutOutput)) {
                if (retryCount < MAX_RETRIES) {
                    const delay = RETRY_DELAYS[retryCount] || 30000;
                    console.log(`[downloadSingleSubtitle] transient failure, retrying in ${delay / 1000}s... (attempt ${retryCount + 2}/${MAX_RETRIES + 1})`);
                    setTimeout(async () => {
                        const result = await downloadSingleSubtitle(videoId, outputDir, retryCount + 1);
                        resolve(result);
                    }, delay);
                } else {
                    console.error(`[downloadSingleSubtitle] Max retries reached for ${videoId}`);
                    resolve({ success: false, error: `字幕下载失败（多次重试后仍失败）: ${errorOutput.slice(0, 280) || stdoutOutput.slice(0, 280)}` });
                }
            } else if (code === 0) {
                // yt-dlp succeeded but no subtitle found (video has no subtitles)
                resolve({ success: false, error: 'No subtitles available' });
            } else {
                console.error(`[downloadSingleSubtitle] failed for ${videoId}:`, errorOutput);
                resolve({ success: false, error: errorOutput.slice(0, 200) });
            }
        });

        proc.on('error', (err) => {
            resolve({ success: false, error: err.message });
        });
    });
}
