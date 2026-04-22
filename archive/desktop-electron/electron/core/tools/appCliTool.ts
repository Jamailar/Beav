import { z } from 'zod';
import path from 'node:path';
import fs from 'node:fs/promises';
import { spawn } from 'node:child_process';
import matter from 'gray-matter';
import { ulid } from 'ulid';
import { toAppAssetUrl } from '../localAssetManager';
import {
    DeclarativeTool,
    ToolKind,
    type ToolResult,
    createSuccessResult,
    createErrorResult,
    ToolErrorType,
} from '../toolRegistry';
import {
    getWorkspacePaths,
    listSpaces,
    createSpace,
    renameSpace,
    setActiveSpace,
    getActiveSpaceId,
    getSettings,
    saveSettings,
    listArchiveProfiles,
    createArchiveProfile,
    updateArchiveProfile,
    deleteArchiveProfile,
    listArchiveSamples,
    createArchiveSample,
    updateArchiveSample,
    deleteArchiveSample,
    listWanderHistory,
    getWanderHistory,
    saveWanderHistory,
    deleteWanderHistory,
} from '../../db';
import {
    listUserMemoriesFromFile,
    addUserMemoryToFile,
    deleteUserMemoryFromFile,
    updateUserMemoryInFile,
} from '../fileMemoryStore';
import {
    createRedClawProject,
    getRedClawProject,
    listRedClawProjects,
    saveRedClawCopyPack,
    saveRedClawImagePack,
    saveRedClawRetrospective,
    type RedClawAuthoringTaskType,
    type RedClawContentPlatform,
    type RedClawImagePrompt,
    type RedClawSourceMode,
} from '../redclawStore';
import {
    listMediaAssets,
    bindMediaAssetToManuscript,
    updateMediaAssetMetadata,
    getAbsoluteMediaPath,
} from '../mediaLibraryStore';
import {
    addAssetToVideoProjectPack,
    addGeneratedAssetToVideoProjectPack,
    createVideoProjectPack,
    getVideoProjectPack,
    listVideoProjectPacks,
    updateVideoProjectBrief,
    updateVideoProjectScript,
} from '../videoProjectStore';
import {
    listSubjectCategories,
    createSubjectCategory,
    updateSubjectCategory,
    deleteSubjectCategory,
    listSubjects,
    getSubject,
    createSubject,
    updateSubject,
    deleteSubject,
    searchSubjects,
} from '../subjectsLibraryStore';
import { generateImagesToMediaLibrary } from '../imageGenerationService';
import { generateVideosToMediaLibrary } from '../videoGenerationService';
import { SkillManager } from '../skillManager';
import { getWorkItemStore, type WorkItemStatus, type WorkItemType } from '../workItemStore';
import {
    getMcpServers,
    saveMcpServers,
    testMcpServerConnection,
    importLocalMcpServers,
    getMcpOAuthStatus,
} from '../mcpStore';
import { listMcpTools, callMcpTool } from '../mcpRuntime';
import { getRandomWanderItems, runWanderBrainstorm } from '../wanderService';
import {
    ensureManuscriptFileName,
    getDraftTypeFromFileName,
    getManuscriptExtension,
    getPackageKindFromFileName,
    isManuscriptPackageName,
    isSupportedManuscriptFile,
    stripManuscriptExtension,
} from '../../../shared/manuscriptFiles';

const AppCliParamsSchema = z.object({
    command: z.string().min(1).describe('CLI command. Example: "redclaw list --limit 20"'),
    payload: z.record(z.any()).optional().describe('Optional structured payload for complex commands.'),
});

type AppCliParams = z.infer<typeof AppCliParamsSchema>;

type FlagValue = string | boolean;

interface ParsedCommand {
    namespace: string;
    action: string;
    flags: Record<string, FlagValue>;
    args: string[];
}

interface GeneratedImageCliResult {
    provider: string;
    providerTemplate: string;
    model: string;
    generationMode?: 'text-to-image' | 'image-to-image' | 'reference-guided';
    referenceImageCount?: number;
    subjects?: Array<{
        id: string;
        name: string;
        imageCount: number;
    }>;
    aspectRatio?: string;
    size: string;
    quality: string;
    count: number;
    assets: Array<{
        id: string;
        projectId?: string;
        relativePath?: string;
        absolutePath?: string | null;
        previewUrl?: string | null;
        prompt?: string;
        createdAt: string;
    }>;
    videoProject?: {
        id: string;
        title: string;
        projectDir: string;
        manifestPath: string;
        scriptPath: string;
        briefPath: string;
    } | null;
}

interface GeneratedVideoCliResult {
    provider: string;
    model: string;
    generationMode?: 'text-to-video' | 'reference-guided' | 'first-last-frame' | 'continuation';
    referenceImageCount?: number;
    referenceSource?: 'video-project-keyframes' | 'video-project-references' | 'subject-or-direct-references';
    subjects?: Array<{
        id: string;
        name: string;
        imageCount: number;
        voiceReference?: boolean;
    }>;
    voiceReferenceUsed?: boolean;
    aspectRatio?: string;
    resolution: '720p' | '1080p';
    durationSeconds: number;
    count: number;
    assets: Array<{
        id: string;
        projectId?: string;
        relativePath?: string;
        absolutePath?: string | null;
        previewUrl?: string | null;
        prompt?: string;
        createdAt: string;
    }>;
    videoProject?: {
        id: string;
        title: string;
        projectDir: string;
        manifestPath: string;
        scriptPath: string;
        briefPath: string;
    } | null;
}

const normalizeRedClawPlatform = (value: unknown): RedClawContentPlatform | undefined => {
    const normalized = String(value || '').trim();
    if (normalized === 'wechat_official_account' || normalized === 'xiaohongshu') {
        return normalized;
    }
    return undefined;
};

const normalizeRedClawTaskType = (value: unknown): RedClawAuthoringTaskType | undefined => {
    const normalized = String(value || '').trim();
    if (normalized === 'expand_from_xhs' || normalized === 'direct_write') {
        return normalized;
    }
    return undefined;
};

const normalizeRedClawSourceMode = (value: unknown): RedClawSourceMode | undefined => {
    const normalized = String(value || '').trim();
    if (normalized === 'manual' || normalized === 'knowledge' || normalized === 'manuscript') {
        return normalized;
    }
    return undefined;
};

const CONCURRENCY_SAFE_APP_CLI_ACTIONS = new Map<string, Set<string>>([
    ['workspace', new Set(['list', 'show', 'get'])],
    ['work', new Set(['list', 'get', 'ready'])],
    ['spaces', new Set(['list'])],
    ['manuscripts', new Set(['list'])],
    ['knowledge', new Set(['list', 'get', 'search'])],
    ['advisors', new Set(['list', 'get', 'search'])],
    ['memory', new Set(['list', 'get', 'search'])],
    ['redclaw', new Set(['list', 'get', 'status'])],
    ['media', new Set(['list', 'get', 'search'])],
    ['subjects', new Set(['list', 'get', 'search'])],
    ['mcp', new Set(['list', 'status', 'oauth-status'])],
    ['settings', new Set(['get', 'show'])],
    ['archives', new Set(['list', 'get'])],
    ['wander', new Set(['list', 'get', 'random'])],
]);

function toPrettyJson(data: unknown): string {
    return JSON.stringify(data, null, 2);
}

function tokenize(input: string): string[] {
    const tokens: string[] = [];
    const regex = /"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)'|(\S+)/g;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(input)) !== null) {
        const quotedDouble = match[1];
        const quotedSingle = match[2];
        const plain = match[3];
        const token = quotedDouble !== undefined
            ? quotedDouble.replace(/\\"/g, '"')
            : quotedSingle !== undefined
              ? quotedSingle.replace(/\\'/g, '\'')
              : plain;
        tokens.push(token);
    }
    return tokens;
}

function parseCommand(command: string): ParsedCommand {
    const tokens = tokenize(command.trim());
    if (tokens.length === 0) {
        return { namespace: 'help', action: 'show', flags: {}, args: [] };
    }

    while (tokens.length > 0 && ['app-cli', 'app_cli', 'redconvert', 'redconvert-cli'].includes(tokens[0].toLowerCase())) {
        tokens.shift();
    }

    if (tokens.length === 0) {
        return { namespace: 'help', action: 'show', flags: {}, args: [] };
    }

    const namespace = (tokens.shift() || 'help').toLowerCase();
    const actionCandidate = tokens[0] && !tokens[0].startsWith('--') ? tokens.shift() : undefined;
    const action = (actionCandidate || 'list').toLowerCase();

    const flags: Record<string, FlagValue> = {};
    const args: string[] = [];
    for (let i = 0; i < tokens.length; i++) {
        const token = tokens[i];
        if (token.startsWith('--')) {
            const key = token.slice(2).toLowerCase();
            const next = tokens[i + 1];
            if (next && !next.startsWith('--')) {
                flags[key] = next;
                i += 1;
            } else {
                flags[key] = true;
            }
            continue;
        }
        args.push(token);
    }

    return { namespace, action, flags, args };
}

function readFlag(flags: Record<string, FlagValue>, ...keys: string[]): string | undefined {
    for (const key of keys) {
        const value = flags[key];
        if (typeof value === 'string') {
            return value;
        }
        if (value === true) {
            return 'true';
        }
    }
    return undefined;
}

function parseNumber(input: unknown): number | undefined {
    if (input === undefined || input === null || input === '') return undefined;
    const value = Number(input);
    if (Number.isNaN(value)) return undefined;
    return value;
}

function parseBoolean(input: unknown): boolean | undefined {
    if (input === undefined || input === null || input === '') return undefined;
    if (typeof input === 'boolean') return input;
    const raw = String(input).trim().toLowerCase();
    if (['1', 'true', 'yes', 'on', 'enabled'].includes(raw)) return true;
    if (['0', 'false', 'no', 'off', 'disabled'].includes(raw)) return false;
    return undefined;
}

function parseList(input: unknown): string[] {
    if (Array.isArray(input)) {
        return input.map((item) => String(item || '').trim()).filter(Boolean);
    }
    const raw = String(input || '').trim();
    if (!raw) return [];

    if ((raw.startsWith('[') && raw.endsWith(']'))) {
        try {
            const parsed = JSON.parse(raw);
            if (Array.isArray(parsed)) {
                return parsed.map((item) => String(item || '').trim()).filter(Boolean);
            }
        } catch {
            // ignore
        }
    }

    const delimiter = raw.includes('|') ? '|' : ',';
    return raw.split(delimiter).map((item) => item.trim()).filter(Boolean);
}

function dedupeList(input: string[], limit?: number): string[] {
    const seen = new Set<string>();
    const output: string[] = [];
    for (const item of input) {
        const normalized = String(item || '').trim();
        if (!normalized || seen.has(normalized)) continue;
        seen.add(normalized);
        output.push(normalized);
        if (limit && output.length >= limit) break;
    }
    return output;
}

function requireString(value: unknown, fieldName: string): string {
    const text = String(value || '').trim();
    if (!text) {
        throw new Error(`${fieldName} is required`);
    }
    return text;
}

function normalizeRelativePath(input: string): string {
    const normalized = path.normalize(String(input || '')).replace(/\\/g, '/').replace(/^\.\/+/, '');
    if (!normalized || normalized === '.' || normalized === '..') {
        throw new Error('Invalid relative path');
    }
    if (normalized.startsWith('../') || normalized.includes('/../')) {
        throw new Error('Path traversal is not allowed');
    }
    return normalized;
}

function buildReferenceAwarePrompt(
    basePrompt: string,
    referenceLabels: string[],
    generationMode?: 'text-to-image' | 'image-to-image' | 'reference-guided',
): string {
    const normalizedPrompt = basePrompt.trim();
    if (!referenceLabels.length) {
        return normalizedPrompt;
    }
    if (generationMode === 'image-to-image') {
        return [
            normalizedPrompt,
            '',
            '改图约束：',
            '- 以上内容仅描述需要修改或新增的部分。',
            '- 除这些改动外，尽量保持参考图原有的构图、主体、配色、质感和整体风格不变。',
        ].join('\n');
    }
    return [
        normalizedPrompt,
        '',
        '参考图说明（生成时必须遵守）：',
        ...referenceLabels.map((item, index) => `- 图${index + 1}：${item}`),
        '- 若存在参考图，必须优先保留参考图中的主体特征、款式、配色、材质、轮廓和关键视觉元素，不要退回纯文生图思路。',
    ].join('\n');
}

function inferVideoGenerationMode(
    explicitMode: 'text-to-video' | 'reference-guided' | 'first-last-frame' | 'continuation' | undefined,
    referenceImages: string[],
): 'text-to-video' | 'reference-guided' | 'first-last-frame' | 'continuation' {
    if (explicitMode) {
        return explicitMode;
    }
    if (referenceImages.length >= 1) {
        return 'reference-guided';
    }
    return 'text-to-video';
}

const APP_CLI_NAMESPACE_HELP: Record<string, { summary: string; actions: string[]; examples: string[] }> = {
    work: {
        summary: 'Manage unified work items and ready/blocked states.',
        actions: ['list', 'ready', 'get', 'create', 'update', 'link', 'dep-add', 'dep-remove', 'promote-redclaw', 'schedule-add', 'schedule-update', 'cycle-add', 'cycle-update', 'run-now'],
        examples: ['work ready', 'work create --title "写一条效率工具笔记" --type redclaw-note', 'work schedule-add --title "每晚巡检选题库" --prompt "检查今日新增素材" --mode daily --time 22:30'],
    },
    spaces: {
        summary: 'Manage workspaces/spaces.',
        actions: ['list', 'create', 'rename', 'switch'],
        examples: ['spaces list', 'spaces create --name "民宿空间"'],
    },
    manuscripts: {
        summary: 'List, read, write, and organize manuscripts.',
        actions: ['list', 'read', 'write', 'create', 'organize', 'clips', 'clip-add', 'clip-update', 'clip-delete', 'clip-split', 'track-add', 'export'],
        examples: ['manuscripts list', 'manuscripts write --path "drafts/demo.md"', 'manuscripts export --path "wander/demo.redvideo"'],
    },
    knowledge: {
        summary: 'List and search saved knowledge items.',
        actions: ['list', 'get', 'search'],
        examples: ['knowledge list --source redbook', 'knowledge search --query "AI"'],
    },
    advisors: {
        summary: 'List and query advisor profiles.',
        actions: ['list', 'get', 'search'],
        examples: ['advisors list'],
    },
    memory: {
        summary: 'Manage long-term memory entries.',
        actions: ['list', 'get', 'search', 'add', 'update', 'delete'],
        examples: ['memory list', 'memory add --content "用户偏好短句风格" --type preference'],
    },
    redclaw: {
        summary: 'Manage RedClaw projects and automation.',
        actions: ['list', 'get', 'create', 'save-copy', 'save-image', 'save-retro', 'runner-status', 'runner-start', 'heartbeat-set', 'schedule-add', 'schedule-update', 'long-add', 'long-update'],
        examples: ['redclaw create --goal "做一条民宿选题" --platform xiaohongshu', 'redclaw runner-status'],
    },
    media: {
        summary: 'List media and bind assets to manuscripts.',
        actions: ['list', 'get', 'bind', 'update'],
        examples: ['media list --limit 100'],
    },
    subjects: {
        summary: 'Search subjects/personas/products and categories.',
        actions: ['list', 'get', 'search', 'categories'],
        examples: ['subjects search --query "张三 Z001 跑鞋"', 'subjects get --id subject_xxx'],
    },
    image: {
        summary: 'Generate images, including reference-guided flows.',
        actions: ['generate'],
        examples: ['image generate --prompt "..." --count 2'],
    },
    video: {
        summary: 'Create video project packs and generate videos.',
        actions: ['generate', 'project-create', 'project-list', 'project-get', 'project-script', 'project-brief', 'project-asset-add'],
        examples: [
            'video project-create --title "Jamba 酒吧短片" --duration 8 --aspect-ratio 16:9 --mode reference-guided',
            'video project-script --id video_project_xxx',
            'video generate --prompt "海边日落镜头" --mode text-to-video --duration 8',
            'video generate --prompt "让这些参考图里的主体元素进入同一支短视频镜头" --mode reference-guided --reference-images "/abs/ref1.png,/abs/ref2.png,/abs/ref3.png"',
            'video generate --prompt "从清晨空房间过渡到夜晚亮灯房间" --mode first-last-frame --reference-images "/abs/first.png,/abs/last.png"',
            'video generate --prompt "让这段镜头继续向前推进" --mode continuation --first-clip "/abs/clip.mp4"',
        ],
    },
    mcp: {
        summary: 'Discover, inspect, test, and call MCP servers/tools.',
        actions: ['list', 'import-local', 'tools', 'test', 'status', 'oauth-status', 'call'],
        examples: ['mcp list', 'mcp tools --id filesystem', 'mcp call --id filesystem --tool read_file --args "{\\"path\\":\\"/tmp/demo.txt\\"}"'],
    },
    settings: {
        summary: 'Inspect and update app settings.',
        actions: ['get', 'set', 'show'],
        examples: ['settings get'],
    },
    skills: {
        summary: 'Inspect and manage workspace skills.',
        actions: ['list', 'get', 'install', 'disable', 'enable'],
        examples: ['skills list'],
    },
    archives: {
        summary: 'Manage archive profiles and samples.',
        actions: ['profiles', 'samples', 'list', 'get'],
        examples: ['archives profiles'],
    },
    wander: {
        summary: 'Inspect or run random wander / brainstorm flows.',
        actions: ['list', 'get', 'random', 'run'],
        examples: ['wander random --count 3', 'wander run --count 3 --multi-choice true'],
    },
};

function helpText(topic?: string): string {
    const normalizedTopic = String(topic || '').trim().toLowerCase();
    if (normalizedTopic) {
        const entry = APP_CLI_NAMESPACE_HELP[normalizedTopic];
        if (!entry) {
            return [
                `Unknown app_cli help topic: ${normalizedTopic}`,
                '',
                'Use one of:',
                ...Object.keys(APP_CLI_NAMESPACE_HELP).sort().map((name) => `- ${name}`),
            ].join('\n');
        }
        return [
            `App CLI - ${normalizedTopic}`,
            '',
            entry.summary,
            `Actions: ${entry.actions.join(', ')}`,
            '',
            ...(normalizedTopic === 'video'
                ? [
                    'Mode rules:',
                    '- text-to-video: 不传参考图；只根据文字生成视频。',
                    '- reference-guided: 传 1 到 5 张参考图；主要复用这些图中的主体、元素、风格和构图线索，不是首尾帧过渡。',
                    '- first-last-frame: 传 2 张参考图，并按“首帧,尾帧”顺序传入；在 RedBox 官方路由中会映射成 first_last_frame + media[]。',
                    '- continuation: 传 1 段起始视频 `--first-clip`；在 RedBox 官方路由中会映射成 continuation + media[]。',
                    '- 若未显式传 mode，app_cli 只会做安全兜底：0 个参考输入=文生视频，>=1 张参考图=参考图视频。首尾帧模式必须显式指定。',
                    '',
                ]
                : []),
            'Examples:',
            ...entry.examples.map((item) => `- ${item}`),
        ].join('\n');
    }

    return [
        'App CLI - 命令发现入口',
        '',
        '命令结构: <namespace> <action> [--flags]',
        '先用 `help <namespace>` 发现动作，再调用具体命令。',
        '',
        'Namespaces:',
        ...Object.entries(APP_CLI_NAMESPACE_HELP)
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([name, entry]) => `- ${name}: ${entry.summary}`),
        '',
        'Examples:',
        '- help work',
        '- help redclaw',
        '- help manuscripts',
        '- help mcp',
        '',
        '规则: 新增功能页必须同步新增 app_cli 子命令。',
    ].join('\n');
}

const CATEGORY_RULES: Array<{ category: string; keywords: string[] }> = [
    { category: '01_AI科技', keywords: ['ai', 'gpt', 'agent', '模型', '大模型', '自动化', '提示词', '技术', '算法'] },
    { category: '02_职场成长', keywords: ['职场', '面试', '简历', '效率', '副业', '管理', '成长', '学习', '复盘'] },
    { category: '03_生活美学', keywords: ['民宿', '家居', '旅行', '生活', '日常', '美学', '摄影', '收纳', '早餐'] },
    { category: '04_个人IP', keywords: ['个人ip', '人设', '观点', '故事', '表达', '品牌', '创业', '定位'] },
];

function detectManuscriptCategory(text: string): string {
    const lower = text.toLowerCase();
    let best: { category: string; score: number } = { category: '99_未分类', score: 0 };
    for (const rule of CATEGORY_RULES) {
        let score = 0;
        for (const keyword of rule.keywords) {
            if (lower.includes(keyword.toLowerCase())) {
                score += 1;
            }
        }
        if (score > best.score) {
            best = { category: rule.category, score };
        }
    }
    return best.category;
}

async function listManuscripts(root: string): Promise<string[]> {
    const results: string[] = [];
    const walk = async (dir: string) => {
        const entries = await fs.readdir(dir, { withFileTypes: true });
        for (const entry of entries) {
            const absolute = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                if (isManuscriptPackageName(entry.name)) {
                    results.push(path.relative(root, absolute).replace(/\\/g, '/'));
                    continue;
                }
                await walk(absolute);
                continue;
            }
            if (isSupportedManuscriptFile(entry.name)) {
                results.push(path.relative(root, absolute).replace(/\\/g, '/'));
            }
        }
    };
    await fs.mkdir(root, { recursive: true });
    await walk(root);
    return results.sort((a, b) => a.localeCompare(b));
}

function getDefaultManuscriptPackageEntry(fileName: string): string {
    const packageKind = getPackageKindFromFileName(fileName);
    if (packageKind === 'video' || packageKind === 'audio') {
        return 'script.md';
    }
    return 'content.md';
}

function getPackageManifestPath(packagePath: string): string {
    return path.join(packagePath, 'manifest.json');
}

function getPackageTimelinePath(packagePath: string): string {
    return path.join(packagePath, 'timeline.otio.json');
}

async function readJsonFile<T>(filePath: string, fallback: T): Promise<T> {
    try {
        const raw = await fs.readFile(filePath, 'utf-8');
        return JSON.parse(raw) as T;
    } catch {
        return fallback;
    }
}

function createEmptyOtioTimeline(title: string) {
    return {
        OTIO_SCHEMA: 'Timeline.1',
        name: title,
        global_start_time: null,
        tracks: {
            OTIO_SCHEMA: 'Stack.1',
            children: [
                { OTIO_SCHEMA: 'Track.1', name: 'V1', kind: 'Video', children: [] },
                { OTIO_SCHEMA: 'Track.1', name: 'A1', kind: 'Audio', children: [] },
            ],
        },
        metadata: {
            owner: 'redbox',
            engine: 'ai-editing',
            version: 1,
            sourceRefs: [],
        },
    };
}

function createTimelineClipId(): string {
    return `clip_${ulid()}`;
}

function getTimelineClipIdentity(clip: any, fallbackTrackName = '', fallbackIndex = 0): string {
    const metadata = (clip?.metadata && typeof clip.metadata === 'object') ? clip.metadata : {};
    const explicitClipId = String(metadata.clipId || '').trim();
    if (explicitClipId) return explicitClipId;
    const assetId = String(metadata.assetId || clip?.media_references?.DEFAULT_MEDIA?.metadata?.assetId || '').trim();
    const name = String(clip?.name || '').trim();
    return `${fallbackTrackName}:${assetId || name || 'clip'}:${fallbackIndex}`;
}

function ensureTimelineTrack(timeline: Record<string, unknown>, trackName: string, kind: 'Video' | 'Audio') {
    const stack = ((timeline as any).tracks ||= { OTIO_SCHEMA: 'Stack.1', children: [] });
    const tracks = Array.isArray(stack.children) ? stack.children : [];
    const existing = tracks.find((track: any) => String(track?.name || '').trim() === trackName);
    if (existing) return existing;
    const nextTrack = {
        OTIO_SCHEMA: 'Track.1',
        name: trackName,
        kind,
        children: [],
    };
    tracks.push(nextTrack);
    stack.children = tracks;
    return nextTrack;
}

function getPackageEntryPath(packagePath: string, fileName: string, manifest?: Record<string, unknown>): string {
    const entry = String(manifest?.entry || '').trim() || getDefaultManuscriptPackageEntry(fileName);
    return path.join(packagePath, entry);
}

async function createManuscriptPackage(packagePath: string, content: string, fileName: string): Promise<void> {
    const now = Date.now();
    const title = stripManuscriptExtension(fileName);
    const packageKind = getPackageKindFromFileName(fileName);
    const draftType = getDraftTypeFromFileName(fileName);
    const manifest = {
        id: ulid(),
        type: 'manuscript-package',
        packageKind,
        draftType,
        title,
        status: 'writing',
        version: 1,
        createdAt: now,
        updatedAt: now,
        entry: getDefaultManuscriptPackageEntry(fileName),
        timeline: packageKind === 'video' || packageKind === 'audio' ? 'timeline.otio.json' : undefined,
    };

    await fs.mkdir(packagePath, { recursive: true });
    await fs.mkdir(path.join(packagePath, 'cache'), { recursive: true });
    await fs.mkdir(path.join(packagePath, 'exports'), { recursive: true });
    await fs.writeFile(getPackageManifestPath(packagePath), JSON.stringify(manifest, null, 2), 'utf-8');
    await fs.writeFile(getPackageEntryPath(packagePath, fileName, manifest), content || '', 'utf-8');

    if (packageKind === 'video' || packageKind === 'audio') {
        await fs.writeFile(path.join(packagePath, 'assets.json'), JSON.stringify({ items: [] }, null, 2), 'utf-8');
        await fs.writeFile(getPackageTimelinePath(packagePath), JSON.stringify(createEmptyOtioTimeline(title), null, 2), 'utf-8');
        if (packageKind === 'video') {
            await fs.writeFile(path.join(packagePath, 'storyboard.json'), JSON.stringify({ scenes: [] }, null, 2), 'utf-8');
            await fs.writeFile(path.join(packagePath, 'transcript.json'), JSON.stringify({ items: [] }, null, 2), 'utf-8');
        } else {
            await fs.writeFile(path.join(packagePath, 'segments.json'), JSON.stringify({ items: [] }, null, 2), 'utf-8');
            await fs.writeFile(path.join(packagePath, 'transcript.json'), JSON.stringify({ items: [] }, null, 2), 'utf-8');
        }
    } else if (packageKind === 'article') {
        await fs.writeFile(path.join(packagePath, 'layout.html'), '', 'utf-8');
        await fs.writeFile(path.join(packagePath, 'wechat.html'), '', 'utf-8');
        await fs.writeFile(path.join(packagePath, 'styles.json'), JSON.stringify({ theme: 'default' }, null, 2), 'utf-8');
        await fs.writeFile(path.join(packagePath, 'assets.json'), JSON.stringify({ items: [] }, null, 2), 'utf-8');
    } else if (packageKind === 'post') {
        await fs.writeFile(path.join(packagePath, 'images.json'), JSON.stringify({ items: [] }, null, 2), 'utf-8');
        await fs.writeFile(path.join(packagePath, 'cover.json'), JSON.stringify({ assetId: null }, null, 2), 'utf-8');
        await fs.writeFile(path.join(packagePath, 'layout.json'), JSON.stringify({ cards: [] }, null, 2), 'utf-8');
        await fs.writeFile(path.join(packagePath, 'assets.json'), JSON.stringify({ items: [] }, null, 2), 'utf-8');
    }
}

async function readManuscriptPackage(packagePath: string) {
    const fileName = path.basename(packagePath);
    const metadata = await readJsonFile<Record<string, unknown>>(getPackageManifestPath(packagePath), {});
    const content = await fs.readFile(getPackageEntryPath(packagePath, fileName, metadata), 'utf-8').catch(() => '');
    return { path: packagePath, content, metadata };
}

async function saveManuscriptPackage(packagePath: string, content: string, metadata?: Record<string, unknown>) {
    const fileName = path.basename(packagePath);
    const existingMetadata = await readJsonFile<Record<string, unknown>>(getPackageManifestPath(packagePath), {});
    const nextMetadata = {
        ...existingMetadata,
        ...(metadata || {}),
        updatedAt: Date.now(),
        entry: String((metadata || {}).entry || existingMetadata.entry || getDefaultManuscriptPackageEntry(fileName)),
    };
    await fs.mkdir(packagePath, { recursive: true });
    await fs.writeFile(getPackageEntryPath(packagePath, fileName, nextMetadata), content, 'utf-8');
    await fs.writeFile(getPackageManifestPath(packagePath), JSON.stringify(nextMetadata, null, 2), 'utf-8');
}

function buildTimelineClipSummaries(timeline: Record<string, unknown>) {
    const tracks = Array.isArray((timeline as any)?.tracks?.children) ? (timeline as any).tracks.children : [];
    const sourceRefs = Array.isArray((timeline as any)?.metadata?.sourceRefs) ? (timeline as any).metadata.sourceRefs : [];
    const sourceRefByAssetId = new Map<string, Record<string, unknown>>();
    for (const item of sourceRefs) {
        const assetId = String((item as any)?.assetId || '').trim();
        if (!assetId) continue;
        sourceRefByAssetId.set(assetId, item as Record<string, unknown>);
    }

    return tracks.flatMap((track: any) => {
        const trackName = String(track?.name || '').trim();
        const trackKind = String(track?.kind || '').trim();
        const children = Array.isArray(track?.children) ? track.children : [];
        return children.map((clip: any, index: number) => {
            const metadata = (clip?.metadata && typeof clip.metadata === 'object') ? clip.metadata : {};
            const mediaRef = clip?.media_references?.DEFAULT_MEDIA;
            const assetId = String(metadata.assetId || mediaRef?.metadata?.assetId || '').trim();
            const sourceRef = assetId ? sourceRefByAssetId.get(assetId) : null;
            return {
                clipId: getTimelineClipIdentity(clip, trackName, index),
                assetId,
                name: String(clip?.name || assetId || `Clip ${index + 1}`),
                track: trackName,
                trackKind,
                order: Number(metadata.order ?? index) || 0,
                durationMs: metadata.durationMs ?? null,
                trimInMs: Number(metadata.trimInMs ?? 0) || 0,
                trimOutMs: Number(metadata.trimOutMs ?? 0) || 0,
                enabled: metadata.enabled ?? true,
                assetKind: String(metadata.assetKind || sourceRef?.assetKind || ''),
                mediaPath: String(sourceRef?.mediaPath || mediaRef?.target_url || ''),
                mimeType: String(sourceRef?.mimeType || mediaRef?.metadata?.mimeType || ''),
            };
        });
    });
}

function normalizePackageTimeline(timeline: Record<string, unknown>) {
    const tracks = Array.isArray((timeline as any)?.tracks?.children) ? (timeline as any).tracks.children : [];
    const nextSourceRefs: Array<Record<string, unknown>> = [];

    for (const track of tracks) {
        const trackName = String((track as any)?.name || '').trim();
        const children = Array.isArray((track as any)?.children) ? track.children : [];
        track.children = children.map((clip: any, index: number) => {
            const metadata = (clip?.metadata && typeof clip.metadata === 'object') ? clip.metadata : {};
            const assetId = String(metadata.assetId || clip?.media_references?.DEFAULT_MEDIA?.metadata?.assetId || '').trim();
            const mediaRef = clip?.media_references?.DEFAULT_MEDIA;
            nextSourceRefs.push({
                assetId,
                mediaPath: String(mediaRef?.target_url || ''),
                mimeType: String(mediaRef?.metadata?.mimeType || ''),
                track: trackName,
                order: index,
                assetKind: String(metadata.assetKind || ''),
                addedAt: String(metadata.addedAt || new Date().toISOString()),
            });
            return {
                ...clip,
                metadata: {
                    ...metadata,
                    clipId: getTimelineClipIdentity(clip, trackName, index),
                    order: index,
                    durationMs: metadata.durationMs ?? null,
                    trimInMs: Number(metadata.trimInMs ?? 0) || 0,
                    trimOutMs: Number(metadata.trimOutMs ?? 0) || 0,
                    enabled: metadata.enabled ?? true,
                },
            };
        });
    }

    (timeline as any).metadata = {
        ...((timeline as any).metadata || {}),
        sourceRefs: nextSourceRefs.filter((item) => String(item.assetId || '').trim()),
    };
    return timeline;
}

const isProbablyFilePath = (value: string): boolean => {
    if (!value) return false;
    if (path.isAbsolute(value)) return true;
    return value.includes('/') || value.includes('\\');
};

async function resolveFfmpegCommand(): Promise<string> {
    const envPath = String(process.env.REDCONVERT_FFMPEG_PATH || process.env.FFMPEG_PATH || '').trim();
    const candidates: string[] = [];
    if (envPath) candidates.push(envPath.includes('app.asar') ? envPath.replace('app.asar', 'app.asar.unpacked') : envPath);

    try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const ffmpegStaticPath = require('ffmpeg-static') as string | null;
        if (ffmpegStaticPath) {
            candidates.push(ffmpegStaticPath.includes('app.asar') ? ffmpegStaticPath.replace('app.asar', 'app.asar.unpacked') : ffmpegStaticPath);
        }
    } catch {
        // ignore
    }

    if ((process as any).resourcesPath) {
        const exeName = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
        candidates.push(path.join((process as any).resourcesPath, 'app.asar.unpacked', 'node_modules', 'ffmpeg-static', exeName));
    }

    for (const candidate of candidates) {
        if (!candidate || !isProbablyFilePath(candidate)) continue;
        try {
            await fs.access(candidate);
            return candidate;
        } catch {
            // keep trying
        }
    }

    const allowSystemFallback = String(process.env.REDCONVERT_ALLOW_SYSTEM_FFMPEG || '').trim().toLowerCase();
    if (allowSystemFallback === '1' || allowSystemFallback === 'true' || allowSystemFallback === 'yes') {
        return 'ffmpeg';
    }
    throw new Error('Bundled ffmpeg not found. Please reinstall app/package to restore internal ffmpeg binary.');
}

async function runFfmpeg(args: string[]): Promise<void> {
    const ffmpegCommand = await resolveFfmpegCommand();
    await new Promise<void>((resolve, reject) => {
        const child = spawn(ffmpegCommand, args, {
            windowsHide: true,
            stdio: ['ignore', 'ignore', 'pipe'],
        });
        let stderr = '';
        child.stderr?.on('data', (chunk) => {
            if (!chunk) return;
            stderr += String(chunk);
            if (stderr.length > 6000) stderr = stderr.slice(-6000);
        });
        child.once('error', reject);
        child.once('close', (code) => {
            if (code === 0) {
                resolve();
                return;
            }
            reject(new Error(`ffmpeg exited with code ${code}: ${stderr || '(no stderr)'}`));
        });
    });
}

function sanitizeExportBaseName(input: string): string {
    const base = String(input || '').trim().replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, '-');
    return base.replace(/-+/g, '-').replace(/^-+|-+$/g, '') || `export-${Date.now()}`;
}

function parseOutputSize(input: unknown, fallback: { width: number; height: number }): { width: number; height: number } {
    const raw = String(input || '').trim();
    const matched = raw.match(/^(\d{2,5})x(\d{2,5})$/i);
    if (!matched) return fallback;
    const width = Number(matched[1]);
    const height = Number(matched[2]);
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
        return fallback;
    }
    return { width, height };
}

function quoteConcatPath(filePath: string): string {
    return `file '${String(filePath).replace(/'/g, `'\\''`)}'`;
}

function resolveClipAbsolutePath(mediaPath: string): string {
    return path.isAbsolute(mediaPath) ? mediaPath : getAbsoluteMediaPath(mediaPath);
}

async function exportVideoOrAudioPackage(params: {
    packagePath: string;
    relPath: string;
    packageKind: 'video' | 'audio';
    outputName?: string;
    size?: string;
}): Promise<Record<string, unknown>> {
    const timeline = await readJsonFile<Record<string, unknown>>(getPackageTimelinePath(params.packagePath), createEmptyOtioTimeline(path.basename(params.packagePath)));
    const clips = (buildTimelineClipSummaries(timeline) as Array<Record<string, unknown>>)
        .filter((item: Record<string, unknown>) => item.enabled !== false)
        .sort((a: Record<string, unknown>, b: Record<string, unknown>) => {
            const trackCompare = String(a.track || '').localeCompare(String(b.track || ''));
            if (trackCompare !== 0) return trackCompare;
            return Number(a.order ?? 0) - Number(b.order ?? 0);
        });

    const targetTrack = params.packageKind === 'video' ? 'V1' : 'A1';
    const exportableClips = clips.filter((item: Record<string, unknown>) => String(item.track || '').trim() === targetTrack);
    if (exportableClips.length === 0) {
        throw new Error(`No enabled clips found on track ${targetTrack}`);
    }

    const exportsDir = path.join(params.packagePath, 'exports');
    await fs.mkdir(exportsDir, { recursive: true });
    const tempDir = await fs.mkdtemp(path.join(exportsDir, '.render-'));
    const skipped: Array<{ assetId: string; reason: string }> = [];

    try {
        const segmentPaths: string[] = [];
        const size = parseOutputSize(params.size, params.packageKind === 'video' ? { width: 1280, height: 720 } : { width: 0, height: 0 });
        for (let index = 0; index < exportableClips.length; index += 1) {
            const clip = exportableClips[index];
            const assetId = String(clip.assetId || '').trim();
            const mediaPath = String(clip.mediaPath || '').trim();
            if (!assetId || !mediaPath) {
                skipped.push({ assetId: assetId || `clip-${index + 1}`, reason: 'missing mediaPath' });
                continue;
            }
            const absolutePath = resolveClipAbsolutePath(mediaPath);
            try {
                await fs.access(absolutePath);
            } catch {
                skipped.push({ assetId, reason: 'source asset missing on disk' });
                continue;
            }

            const clipDurationMs = parseNumber(clip.durationMs);
            const trimInMs = Math.max(0, parseNumber(clip.trimInMs) || 0);
            const segmentBase = path.join(tempDir, `segment-${String(index + 1).padStart(3, '0')}`);

            if (params.packageKind === 'audio') {
                const segmentPath = `${segmentBase}.mp3`;
                const args = ['-y'];
                if (trimInMs > 0) {
                    args.push('-ss', (trimInMs / 1000).toFixed(3));
                }
                args.push('-i', absolutePath);
                if (clipDurationMs && clipDurationMs > 0) {
                    args.push('-t', (clipDurationMs / 1000).toFixed(3));
                }
                args.push(
                    '-vn',
                    '-ac', '2',
                    '-ar', '44100',
                    '-c:a', 'libmp3lame',
                    '-b:a', '192k',
                    segmentPath,
                );
                await runFfmpeg(args);
                segmentPaths.push(segmentPath);
                continue;
            }

            const kind = String(clip.assetKind || '').trim().toLowerCase();
            const segmentPath = `${segmentBase}.mp4`;
            if (kind === 'image') {
                const durationSeconds = ((clipDurationMs && clipDurationMs > 0 ? clipDurationMs : 4000) / 1000).toFixed(3);
                await runFfmpeg([
                    '-y',
                    '-loop', '1',
                    '-i', absolutePath,
                    '-t', durationSeconds,
                    '-vf', `scale=${size.width}:${size.height}:force_original_aspect_ratio=decrease,pad=${size.width}:${size.height}:(ow-iw)/2:(oh-ih)/2,format=yuv420p`,
                    '-r', '30',
                    '-c:v', 'libx264',
                    '-pix_fmt', 'yuv420p',
                    '-an',
                    segmentPath,
                ]);
                segmentPaths.push(segmentPath);
                continue;
            }

            const args = ['-y'];
            if (trimInMs > 0) {
                args.push('-ss', (trimInMs / 1000).toFixed(3));
            }
            args.push('-i', absolutePath);
            if (clipDurationMs && clipDurationMs > 0) {
                args.push('-t', (clipDurationMs / 1000).toFixed(3));
            }
            args.push(
                '-vf', `scale=${size.width}:${size.height}:force_original_aspect_ratio=decrease,pad=${size.width}:${size.height}:(ow-iw)/2:(oh-ih)/2,format=yuv420p`,
                '-r', '30',
                '-c:v', 'libx264',
                '-preset', 'veryfast',
                '-pix_fmt', 'yuv420p',
                '-c:a', 'aac',
                '-ar', '48000',
                '-ac', '2',
                segmentPath,
            );
            await runFfmpeg(args);
            segmentPaths.push(segmentPath);
        }

        if (segmentPaths.length === 0) {
            throw new Error('No clip could be rendered');
        }

        const extension = params.packageKind === 'video' ? 'mp4' : 'mp3';
        const outputName = `${sanitizeExportBaseName(params.outputName || `${stripManuscriptExtension(path.basename(params.packagePath))}-rough-cut`)}.${extension}`;
        const outputPath = path.join(exportsDir, outputName);

        if (segmentPaths.length === 1) {
            await fs.copyFile(segmentPaths[0], outputPath);
        } else {
            const concatListPath = path.join(tempDir, 'concat.txt');
            await fs.writeFile(concatListPath, segmentPaths.map((item) => quoteConcatPath(item)).join('\n'), 'utf-8');
            if (params.packageKind === 'audio') {
                await runFfmpeg([
                    '-y',
                    '-f', 'concat',
                    '-safe', '0',
                    '-i', concatListPath,
                    '-c:a', 'libmp3lame',
                    '-b:a', '192k',
                    outputPath,
                ]);
            } else {
                await runFfmpeg([
                    '-y',
                    '-f', 'concat',
                    '-safe', '0',
                    '-i', concatListPath,
                    '-c:v', 'libx264',
                    '-preset', 'veryfast',
                    '-pix_fmt', 'yuv420p',
                    '-c:a', 'aac',
                    '-ar', '48000',
                    '-ac', '2',
                    outputPath,
                ]);
            }
        }

        return {
            success: true,
            path: params.relPath,
            packageKind: params.packageKind,
            outputName,
            outputPath,
            outputUrl: toAppAssetUrl(outputPath),
            renderedClipCount: segmentPaths.length,
            skipped,
        };
    } finally {
        try {
            await fs.rm(tempDir, { recursive: true, force: true });
        } catch {
            // ignore cleanup
        }
    }
}

export class AppCliTool extends DeclarativeTool<typeof AppCliParamsSchema> {
    readonly name = 'app_cli';
    readonly displayName = 'App CLI';
    readonly description = 'CLI-style app control layer. Manage spaces/manuscripts/redclaw/media/subjects/image/settings/skills/memory with terminal-like commands.';
    readonly kind = ToolKind.Execute;
    readonly parameterSchema = AppCliParamsSchema;
    readonly requiresConfirmation = false;

    getDescription(params: AppCliParams): string {
        return `app_cli: ${params.command}`;
    }

    isConcurrencySafe(params: AppCliParams): boolean {
        const parsed = parseCommand(params.command);
        const allowedActions = CONCURRENCY_SAFE_APP_CLI_ACTIONS.get(parsed.namespace);
        if (!allowedActions) {
            return false;
        }
        return allowedActions.has(parsed.action);
    }

    async execute(params: AppCliParams): Promise<ToolResult> {
        try {
            const payload = (params.payload || {}) as Record<string, unknown>;
            const parsed = parseCommand(params.command);
            const paths = getWorkspacePaths();
            console.log('[app_cli] execute', {
                command: params.command,
                namespace: parsed.namespace,
                action: parsed.action,
                activeSpaceId: getActiveSpaceId(),
                workspaceBase: paths.base,
                manuscriptsRoot: paths.manuscripts,
            });

            if (parsed.namespace === 'help') {
                const topic = parsed.action && parsed.action !== 'show'
                    ? parsed.action
                    : (typeof readFlag(parsed.flags, 'namespace', 'topic') === 'string'
                        ? String(readFlag(parsed.flags, 'namespace', 'topic'))
                        : '');
                return createSuccessResult(helpText(topic), topic ? `app_cli help ${topic}` : 'app_cli help');
            }

            const result = await this.dispatch(parsed, payload);
            if (parsed.namespace === 'manuscripts' && parsed.action === 'list') {
                const info = result as { count?: number; files?: string[] };
                console.log('[app_cli] manuscripts:list result', {
                    count: info?.count ?? null,
                    sample: Array.isArray(info?.files) ? info.files.slice(0, 5) : [],
                });
            }
            if (parsed.namespace === 'image' && parsed.action === 'generate') {
                const imageResult = result as GeneratedImageCliResult;
                const lines = [
                    `Generated ${imageResult.count} image(s).`,
                    `provider=${imageResult.provider} template=${imageResult.providerTemplate} model=${imageResult.model}`,
                ];
                if (imageResult.aspectRatio) {
                    lines.push(`aspectRatio=${imageResult.aspectRatio}`);
                }
                if (imageResult.assets.length > 0) {
                    lines.push(
                        ...imageResult.assets.map((asset, index) =>
                            `${index + 1}. ${asset.id}${asset.previewUrl ? ` -> ${asset.previewUrl}` : ''}`
                        )
                    );
                }
                return {
                    success: true,
                    llmContent: lines.join('\n'),
                    display: 'image generate',
                    data: {
                        kind: 'generated-images',
                        ...imageResult,
                    },
                };
            }
            if (parsed.namespace === 'video' && parsed.action === 'generate') {
                const videoResult = result as GeneratedVideoCliResult;
                const lines = [
                    `Generated ${videoResult.count} video(s).`,
                    `provider=${videoResult.provider} model=${videoResult.model}`,
                ];
                if (videoResult.generationMode) {
                    lines.push(`mode=${videoResult.generationMode}`);
                }
                if (videoResult.aspectRatio) {
                    lines.push(`aspectRatio=${videoResult.aspectRatio}`);
                }
                lines.push(`resolution=${videoResult.resolution}`);
                lines.push(`duration=${videoResult.durationSeconds}s`);
                if (videoResult.assets.length > 0) {
                    lines.push(
                        ...videoResult.assets.map((asset, index) =>
                            `${index + 1}. ${asset.id}${asset.previewUrl ? ` -> ${asset.previewUrl}` : ''}`
                        )
                    );
                }
                return {
                    success: true,
                    llmContent: lines.join('\n'),
                    display: 'video generate',
                    data: {
                        kind: 'generated-videos',
                        ...videoResult,
                    },
                };
            }
            if (parsed.namespace === 'manuscripts' && (parsed.action === 'write' || parsed.action === 'create')) {
                const info = result as {
                    success?: boolean;
                    path?: string;
                    absolutePath?: string;
                    bytes?: number;
                };
                const lines = [
                    'Manuscript saved successfully.',
                    `relativePath=${info.path || ''}`,
                    `absolutePath=${info.absolutePath || ''}`,
                    `bytes=${info.bytes ?? 0}`,
                ];
                return {
                    success: true,
                    llmContent: lines.join('\n'),
                    display: 'manuscripts write',
                    data: {
                        kind: 'manuscript-write',
                        ...info,
                    },
                };
            }
            if (parsed.namespace === 'manuscripts' && parsed.action === 'export') {
                const info = result as {
                    path?: string;
                    packageKind?: string;
                    outputPath?: string;
                    outputUrl?: string;
                    renderedClipCount?: number;
                    skipped?: Array<{ assetId: string; reason: string }>;
                };
                const lines = [
                    'Manuscript export completed.',
                    `path=${info.path || ''}`,
                    `kind=${info.packageKind || ''}`,
                    `renderedClips=${info.renderedClipCount ?? 0}`,
                    `outputPath=${info.outputPath || ''}`,
                    `outputUrl=${info.outputUrl || ''}`,
                ];
                if (Array.isArray(info.skipped) && info.skipped.length > 0) {
                    lines.push(`skipped=${info.skipped.length}`);
                }
                return {
                    success: true,
                    llmContent: lines.join('\n'),
                    display: 'manuscripts export',
                    data: {
                        kind: 'manuscript-export',
                        ...info,
                    },
                };
            }
            return createSuccessResult(toPrettyJson(result), `${parsed.namespace} ${parsed.action}`);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            console.error('[app_cli] execute failed', {
                command: params.command,
                error: message,
            });
            return createErrorResult(`app_cli failed: ${message}`, ToolErrorType.EXECUTION_FAILED);
        }
    }

    private async dispatch(parsed: ParsedCommand, payload: Record<string, unknown>): Promise<unknown> {
        switch (parsed.namespace) {
            case 'workspace':
                return {
                    activeSpaceId: getActiveSpaceId(),
                    paths: getWorkspacePaths(),
                };
            case 'work':
                return this.handleWork(parsed, payload);
            case 'spaces':
                return this.handleSpaces(parsed, payload);
            case 'manuscripts':
                return this.handleManuscripts(parsed, payload);
            case 'knowledge':
                return this.handleKnowledge(parsed, payload);
            case 'advisors':
                return this.handleAdvisors(parsed, payload);
            case 'memory':
                return this.handleMemory(parsed, payload);
            case 'redclaw':
                return this.handleRedclaw(parsed, payload);
            case 'media':
                return this.handleMedia(parsed, payload);
            case 'subjects':
                return this.handleSubjects(parsed, payload);
            case 'image':
                return this.handleImage(parsed, payload);
            case 'video':
                return this.handleVideo(parsed, payload);
            case 'mcp':
                return this.handleMcp(parsed, payload);
            case 'settings':
                return this.handleSettings(parsed, payload);
            case 'skills':
                return this.handleSkills(parsed, payload);
            case 'archives':
                return this.handleArchives(parsed, payload);
            case 'wander':
                return this.handleWander(parsed, payload);
            default:
                throw new Error(`Unknown namespace: ${parsed.namespace}`);
        }
    }

    private async handleSpaces(parsed: ParsedCommand, _payload: Record<string, unknown>) {
        const action = parsed.action;
        if (action === 'list') {
            return {
                activeSpaceId: getActiveSpaceId(),
                spaces: listSpaces(),
            };
        }
        if (action === 'create') {
            const name = requireString(readFlag(parsed.flags, 'name') || parsed.args[0], 'name');
            return { space: createSpace(name) };
        }
        if (action === 'rename') {
            const id = requireString(readFlag(parsed.flags, 'id', 'space-id') || parsed.args[0], 'id');
            const name = requireString(readFlag(parsed.flags, 'name') || parsed.args[1], 'name');
            return { space: renameSpace(id, name) };
        }
        if (action === 'switch') {
            const id = requireString(readFlag(parsed.flags, 'id', 'space-id') || parsed.args[0], 'id');
            return { space: setActiveSpace(id), paths: getWorkspacePaths() };
        }
        throw new Error(`Unsupported spaces action: ${action}`);
    }

    private async handleWork(parsed: ParsedCommand, payload: Record<string, unknown>) {
        const store = getWorkItemStore();
        const action = parsed.action;
        if (action === 'list') {
            const limit = parseNumber(readFlag(parsed.flags, 'limit') || payload.limit) || 30;
            const items = await store.listWorkItems({
                status: readFlag(parsed.flags, 'status') as any,
                type: (readFlag(parsed.flags, 'type') || payload.type || undefined) as WorkItemType | undefined,
                tag: readFlag(parsed.flags, 'tag') || (payload.tag as string | undefined),
                limit,
            });
            return { count: items.length, items };
        }
        if (action === 'ready') {
            const limit = parseNumber(readFlag(parsed.flags, 'limit') || payload.limit) || 20;
            const items = await store.listReadyWorkItems(limit);
            return { count: items.length, items };
        }
        if (action === 'get') {
            const id = requireString(readFlag(parsed.flags, 'id') || payload.id, 'id');
            return store.getWorkItem(id);
        }
        if (action === 'create') {
            const title = requireString(readFlag(parsed.flags, 'title') || payload.title, 'title');
            return store.createWorkItem({
                title,
                description: readFlag(parsed.flags, 'description', 'desc') || (payload.description as string | undefined),
                type: (readFlag(parsed.flags, 'type') || payload.type || 'generic') as WorkItemType,
                status: (readFlag(parsed.flags, 'status') || payload.status || 'pending') as WorkItemStatus,
                priority: parseNumber(readFlag(parsed.flags, 'priority') || payload.priority),
                tags: parseList(readFlag(parsed.flags, 'tags') || payload.tags),
                parentId: readFlag(parsed.flags, 'parent-id') || (payload.parentId as string | undefined),
                dependsOn: parseList(readFlag(parsed.flags, 'depends-on') || payload.dependsOn),
                summary: readFlag(parsed.flags, 'summary') || (payload.summary as string | undefined),
                refs: {
                    projectIds: parseList(readFlag(parsed.flags, 'project-id') || payload.projectIds || payload.projectId),
                    sessionIds: parseList(readFlag(parsed.flags, 'session-id') || payload.sessionIds || payload.sessionId),
                    taskIds: parseList(readFlag(parsed.flags, 'task-id') || payload.taskIds || payload.taskId),
                    backgroundTaskIds: parseList(readFlag(parsed.flags, 'background-task-id') || payload.backgroundTaskIds || payload.backgroundTaskId),
                    filePaths: parseList(readFlag(parsed.flags, 'file-path') || payload.filePaths || payload.filePath),
                },
            });
        }
        if (action === 'update') {
            const id = requireString(readFlag(parsed.flags, 'id') || payload.id, 'id');
            return store.updateWorkItem(id, {
                title: readFlag(parsed.flags, 'title') || (payload.title as string | undefined),
                description: readFlag(parsed.flags, 'description', 'desc') || (payload.description as string | undefined),
                type: (readFlag(parsed.flags, 'type') || payload.type || undefined) as WorkItemType | undefined,
                status: (readFlag(parsed.flags, 'status') || payload.status || undefined) as WorkItemStatus | undefined,
                priority: parseNumber(readFlag(parsed.flags, 'priority') || payload.priority),
                tags: readFlag(parsed.flags, 'tags') !== undefined || payload.tags !== undefined
                    ? parseList(readFlag(parsed.flags, 'tags') || payload.tags)
                    : undefined,
                parentId: readFlag(parsed.flags, 'clear-parent') === 'true'
                    ? null
                    : (readFlag(parsed.flags, 'parent-id') || payload.parentId || undefined) as string | undefined,
                summary: readFlag(parsed.flags, 'clear-summary') === 'true'
                    ? null
                    : (readFlag(parsed.flags, 'summary') || payload.summary || undefined) as string | undefined,
            });
        }
        if (action === 'link') {
            const id = requireString(readFlag(parsed.flags, 'id') || payload.id, 'id');
            return store.attachRefs(id, {
                projectIds: parseList(readFlag(parsed.flags, 'project-id') || payload.projectIds || payload.projectId),
                sessionIds: parseList(readFlag(parsed.flags, 'session-id') || payload.sessionIds || payload.sessionId),
                taskIds: parseList(readFlag(parsed.flags, 'task-id') || payload.taskIds || payload.taskId),
                backgroundTaskIds: parseList(readFlag(parsed.flags, 'background-task-id') || payload.backgroundTaskIds || payload.backgroundTaskId),
                filePaths: parseList(readFlag(parsed.flags, 'file-path') || payload.filePaths || payload.filePath),
            });
        }
        if (action === 'dep-add') {
            const id = requireString(readFlag(parsed.flags, 'id') || payload.id, 'id');
            const dependencyId = requireString(readFlag(parsed.flags, 'depends-on', 'dependency-id') || payload.dependsOn || payload.dependencyId, 'dependencyId');
            return store.addDependency(id, dependencyId);
        }
        if (action === 'dep-remove') {
            const id = requireString(readFlag(parsed.flags, 'id') || payload.id, 'id');
            const dependencyId = requireString(readFlag(parsed.flags, 'depends-on', 'dependency-id') || payload.dependsOn || payload.dependencyId, 'dependencyId');
            return store.removeDependency(id, dependencyId);
        }
        if (action === 'promote-redclaw') {
            const id = requireString(readFlag(parsed.flags, 'id') || payload.id, 'id');
            const existing = await store.getWorkItem(id);
            if (!existing) {
                throw new Error(`Work item not found: ${id}`);
            }
            const result = await createRedClawProject({
                goal: readFlag(parsed.flags, 'goal') || (payload.goal as string | undefined) || existing.title,
                targetAudience: readFlag(parsed.flags, 'audience', 'target-audience') || (payload.targetAudience as string | undefined),
                tone: readFlag(parsed.flags, 'tone') || (payload.tone as string | undefined),
                successCriteria: readFlag(parsed.flags, 'success', 'success-criteria') || (payload.successCriteria as string | undefined),
                tags: parseList(readFlag(parsed.flags, 'tags') || payload.tags || existing.tags),
                workItemId: id,
            });
            return {
                workItemId: id,
                projectId: result.project.id,
                project: result.project,
                projectDir: result.projectDir,
            };
        }
        if (action === 'schedule-add') {
            const title = requireString(readFlag(parsed.flags, 'title', 'name') || payload.title || payload.name, 'title');
            const prompt = requireString(readFlag(parsed.flags, 'prompt') || payload.prompt, 'prompt');
            const mode = String(readFlag(parsed.flags, 'mode') || payload.mode || 'interval').trim().toLowerCase() as 'interval' | 'daily' | 'weekly' | 'once';
            const subagentRoles = parseList(readFlag(parsed.flags, 'subagent-roles', 'roles') || payload.subagentRoles);
            const weekdays = parseList(readFlag(parsed.flags, 'weekdays') || payload.weekdays)
                .map((item) => Number(item))
                .filter((n) => Number.isFinite(n))
                .map((n) => Math.max(0, Math.min(6, Math.floor(n))));
            const workItem = await store.createWorkItem({
                title,
                description: prompt,
                type: 'automation',
                status: 'waiting',
                priority: parseNumber(readFlag(parsed.flags, 'priority') || payload.priority),
                tags: parseList(readFlag(parsed.flags, 'tags') || payload.tags),
                summary: '已登记定时任务，等待执行。',
                refs: {
                    projectIds: parseList(readFlag(parsed.flags, 'project-id') || payload.projectId),
                },
                metadata: {
                    automationKind: 'scheduled',
                    subagentRoles,
                },
                schedule: {
                    mode,
                    enabled: parseBoolean(readFlag(parsed.flags, 'enabled') || payload.enabled) !== false,
                    intervalMinutes: parseNumber(readFlag(parsed.flags, 'interval', 'interval-minutes') || payload.intervalMinutes),
                    time: (readFlag(parsed.flags, 'time') || payload.time) as string | undefined,
                    weekdays,
                    runAt: (readFlag(parsed.flags, 'run-at', 'at') || payload.runAt) as string | undefined,
                },
            });
            const mod = await import('../redclawBackgroundRunner');
            const runner = mod.getRedClawBackgroundRunner();
            const task = await runner.addScheduledTask({
                name: title,
                mode,
                prompt,
                projectId: readFlag(parsed.flags, 'project-id', 'projectid') || (payload.projectId as string | undefined),
                workItemId: workItem.id,
                subagentRoles: subagentRoles as any,
                intervalMinutes: parseNumber(readFlag(parsed.flags, 'interval', 'interval-minutes') || payload.intervalMinutes),
                time: (readFlag(parsed.flags, 'time') || payload.time) as string | undefined,
                weekdays,
                runAt: (readFlag(parsed.flags, 'run-at', 'at') || payload.runAt) as string | undefined,
                enabled: parseBoolean(readFlag(parsed.flags, 'enabled') || payload.enabled),
            });
            return { workItemId: workItem.id, scheduledTaskId: task.id, workItem, task };
        }
        if (action === 'schedule-update') {
            const id = requireString(readFlag(parsed.flags, 'id') || payload.id, 'id');
            const existing = await store.getWorkItem(id);
            if (!existing) throw new Error(`Work item not found: ${id}`);
            const scheduledTaskId = String((existing.metadata as Record<string, unknown> | undefined)?.scheduledTaskId || '').trim()
                || requireString(readFlag(parsed.flags, 'task-id', 'taskid') || payload.taskId, 'taskId');
            const subagentRoles = readFlag(parsed.flags, 'subagent-roles', 'roles') !== undefined || payload.subagentRoles !== undefined
                ? parseList(readFlag(parsed.flags, 'subagent-roles', 'roles') || payload.subagentRoles)
                : undefined;
            const weekdaysInput = readFlag(parsed.flags, 'weekdays') ?? payload.weekdays;
            const weekdays = weekdaysInput !== undefined
                ? parseList(weekdaysInput).map((item) => Number(item)).filter((n) => Number.isFinite(n)).map((n) => Math.max(0, Math.min(6, Math.floor(n))))
                : undefined;
            const mod = await import('../redclawBackgroundRunner');
            const runner = mod.getRedClawBackgroundRunner();
            const task = await runner.updateScheduledTask(scheduledTaskId, {
                name: (readFlag(parsed.flags, 'title', 'name') || payload.title || payload.name) as string | undefined,
                mode: (readFlag(parsed.flags, 'mode') || payload.mode || undefined) as any,
                prompt: (readFlag(parsed.flags, 'prompt') || payload.prompt) as string | undefined,
                projectId: readFlag(parsed.flags, 'clear-project') === 'true' ? null : (readFlag(parsed.flags, 'project-id', 'projectid') || payload.projectId || undefined) as string | undefined,
                workItemId: id,
                subagentRoles: subagentRoles as any,
                intervalMinutes: parseNumber(readFlag(parsed.flags, 'interval', 'interval-minutes') || payload.intervalMinutes),
                time: (readFlag(parsed.flags, 'time') || payload.time) as string | undefined,
                weekdays,
                runAt: (readFlag(parsed.flags, 'run-at', 'at') || payload.runAt) as string | undefined,
                enabled: parseBoolean(readFlag(parsed.flags, 'enabled') || payload.enabled),
            });
            const nextSchedule = {
                mode: task.mode,
                enabled: task.enabled,
                intervalMinutes: task.intervalMinutes,
                time: task.time,
                weekdays: task.weekdays,
                runAt: task.runAt,
                nextRunAt: task.nextRunAt,
                lastRunAt: task.lastRunAt,
            } as const;
            const workItem = await store.updateWorkItem(id, {
                title: (readFlag(parsed.flags, 'title', 'name') || payload.title || payload.name) as string | undefined,
                description: (readFlag(parsed.flags, 'prompt') || payload.prompt) as string | undefined,
                status: task.enabled ? 'waiting' : 'pending',
                schedule: nextSchedule,
                metadata: {
                    ...(existing.metadata || {}),
                    automationKind: 'scheduled',
                    scheduledTaskId: task.id,
                    subagentRoles: subagentRoles ?? (existing.metadata as any)?.subagentRoles ?? [],
                },
            });
            return { workItem, task };
        }
        if (action === 'cycle-add') {
            const title = requireString(readFlag(parsed.flags, 'title', 'name') || payload.title || payload.name, 'title');
            const objective = requireString(readFlag(parsed.flags, 'objective') || payload.objective, 'objective');
            const stepPrompt = requireString(readFlag(parsed.flags, 'step-prompt') || payload.stepPrompt, 'stepPrompt');
            const subagentRoles = parseList(readFlag(parsed.flags, 'subagent-roles', 'roles') || payload.subagentRoles);
            const intervalMinutes = parseNumber(readFlag(parsed.flags, 'interval', 'interval-minutes') || payload.intervalMinutes);
            const totalRounds = parseNumber(readFlag(parsed.flags, 'rounds', 'total-rounds') || payload.totalRounds);
            const workItem = await store.createWorkItem({
                title,
                description: objective,
                type: 'automation',
                status: 'active',
                priority: parseNumber(readFlag(parsed.flags, 'priority') || payload.priority),
                tags: parseList(readFlag(parsed.flags, 'tags') || payload.tags),
                summary: '已登记长周期任务，等待首轮推进。',
                refs: {
                    projectIds: parseList(readFlag(parsed.flags, 'project-id') || payload.projectId),
                },
                metadata: {
                    automationKind: 'long-cycle',
                    subagentRoles: subagentRoles.length > 0 ? subagentRoles : ['planner', 'ops-coordinator', 'reviewer'],
                },
                schedule: {
                    mode: 'long-cycle',
                    enabled: parseBoolean(readFlag(parsed.flags, 'enabled') || payload.enabled) !== false,
                    intervalMinutes: intervalMinutes || undefined,
                    totalRounds: totalRounds || undefined,
                    completedRounds: 0,
                },
            });
            const mod = await import('../redclawBackgroundRunner');
            const runner = mod.getRedClawBackgroundRunner();
            const task = await runner.addLongCycleTask({
                name: title,
                objective,
                stepPrompt,
                projectId: readFlag(parsed.flags, 'project-id', 'projectid') || (payload.projectId as string | undefined),
                workItemId: workItem.id,
                subagentRoles: (subagentRoles.length > 0 ? subagentRoles : ['planner', 'ops-coordinator', 'reviewer']) as any,
                intervalMinutes,
                totalRounds,
                enabled: parseBoolean(readFlag(parsed.flags, 'enabled') || payload.enabled),
            });
            return { workItemId: workItem.id, longCycleTaskId: task.id, workItem, task };
        }
        if (action === 'cycle-update') {
            const id = requireString(readFlag(parsed.flags, 'id') || payload.id, 'id');
            const existing = await store.getWorkItem(id);
            if (!existing) throw new Error(`Work item not found: ${id}`);
            const longCycleTaskId = String((existing.metadata as Record<string, unknown> | undefined)?.longCycleTaskId || '').trim()
                || requireString(readFlag(parsed.flags, 'task-id', 'taskid') || payload.taskId, 'taskId');
            const subagentRoles = readFlag(parsed.flags, 'subagent-roles', 'roles') !== undefined || payload.subagentRoles !== undefined
                ? parseList(readFlag(parsed.flags, 'subagent-roles', 'roles') || payload.subagentRoles)
                : undefined;
            const mod = await import('../redclawBackgroundRunner');
            const runner = mod.getRedClawBackgroundRunner();
            const task = await runner.updateLongCycleTask(longCycleTaskId, {
                name: (readFlag(parsed.flags, 'title', 'name') || payload.title || payload.name) as string | undefined,
                objective: (readFlag(parsed.flags, 'objective') || payload.objective) as string | undefined,
                stepPrompt: (readFlag(parsed.flags, 'step-prompt') || payload.stepPrompt) as string | undefined,
                projectId: readFlag(parsed.flags, 'clear-project') === 'true' ? null : (readFlag(parsed.flags, 'project-id', 'projectid') || payload.projectId || undefined) as string | undefined,
                workItemId: id,
                subagentRoles: subagentRoles as any,
                intervalMinutes: parseNumber(readFlag(parsed.flags, 'interval', 'interval-minutes') || payload.intervalMinutes),
                totalRounds: parseNumber(readFlag(parsed.flags, 'rounds', 'total-rounds') || payload.totalRounds),
                enabled: parseBoolean(readFlag(parsed.flags, 'enabled') || payload.enabled),
            });
            const workItem = await store.updateWorkItem(id, {
                title: (readFlag(parsed.flags, 'title', 'name') || payload.title || payload.name) as string | undefined,
                description: (readFlag(parsed.flags, 'objective') || payload.objective) as string | undefined,
                status: task.status === 'completed' ? 'done' : (task.enabled ? 'active' : 'waiting'),
                schedule: {
                    mode: 'long-cycle',
                    enabled: task.enabled,
                    intervalMinutes: task.intervalMinutes,
                    totalRounds: task.totalRounds,
                    completedRounds: task.completedRounds,
                    nextRunAt: task.nextRunAt,
                    lastRunAt: task.lastRunAt,
                },
                metadata: {
                    ...(existing.metadata || {}),
                    automationKind: 'long-cycle',
                    longCycleTaskId: task.id,
                    subagentRoles: subagentRoles ?? (existing.metadata as any)?.subagentRoles ?? [],
                },
            });
            return { workItem, task };
        }
        if (action === 'run-now') {
            const id = requireString(readFlag(parsed.flags, 'id') || payload.id, 'id');
            const existing = await store.getWorkItem(id);
            if (!existing) throw new Error(`Work item not found: ${id}`);
            const metadata = (existing.metadata || {}) as Record<string, unknown>;
            const mod = await import('../redclawBackgroundRunner');
            const runner = mod.getRedClawBackgroundRunner();
            if (metadata.scheduledTaskId) {
                return runner.runScheduledTaskNow(String(metadata.scheduledTaskId));
            }
            if (metadata.longCycleTaskId) {
                return runner.runLongCycleTaskNow(String(metadata.longCycleTaskId));
            }
            throw new Error('This work item is not bound to a scheduled or long-cycle task.');
        }
        throw new Error(`Unsupported work action: ${action}`);
    }

    private async handleManuscripts(parsed: ParsedCommand, payload: Record<string, unknown>) {
        const manuscriptsRoot = getWorkspacePaths().manuscripts;
        await fs.mkdir(manuscriptsRoot, { recursive: true });
        const action = parsed.action;

        if (action === 'list') {
            console.log('[app_cli] manuscripts:list scanning', { manuscriptsRoot });
            const files = await listManuscripts(manuscriptsRoot);
            return { count: files.length, files };
        }

        if (action === 'organize') {
            const dryRun = String(readFlag(parsed.flags, 'dry-run') || payload.dryRun || 'false') === 'true';
            const files = await listManuscripts(manuscriptsRoot);
            const report: Array<{ from: string; to: string; category: string }> = [];

            for (const relPath of files) {
                if (relPath.startsWith('_drafts/') || relPath.startsWith('_published/')) continue;
                const absolute = path.join(manuscriptsRoot, relPath);
                const stats = await fs.stat(absolute);
                let joinedText = '';
                if (stats.isDirectory()) {
                    const manifestPath = path.join(absolute, 'manifest.json');
                    const rawManifest = await fs.readFile(manifestPath, 'utf-8').catch(() => '{}');
                    const manifest = JSON.parse(rawManifest) as Record<string, unknown>;
                    const entryPath = path.join(absolute, String(manifest.entry || 'content.md'));
                    const entryContent = await fs.readFile(entryPath, 'utf-8').catch(() => '');
                    joinedText = [String(manifest.title || ''), entryContent].join('\n');
                } else {
                    const raw = await fs.readFile(absolute, 'utf-8');
                    const parsedMatter = matter(raw);
                    joinedText = [
                        String((parsedMatter.data as Record<string, unknown>).title || ''),
                        parsedMatter.content || '',
                    ].join('\n');
                }
                const category = detectManuscriptCategory(joinedText);
                const targetDir = path.join(manuscriptsRoot, category);
                const ext = path.extname(relPath);
                const baseName = path.basename(relPath, ext);
                let candidate = path.join(category, `${baseName}${ext}`).replace(/\\/g, '/');
                let index = 2;
                while (candidate !== relPath) {
                    try {
                        await fs.access(path.join(manuscriptsRoot, candidate));
                        candidate = path.join(category, `${baseName}-${index}${ext}`).replace(/\\/g, '/');
                        index += 1;
                    } catch {
                        break;
                    }
                }

                if (candidate === relPath) continue;
                report.push({ from: relPath, to: candidate, category });
                if (!dryRun) {
                    await fs.mkdir(targetDir, { recursive: true });
                    await fs.rename(absolute, path.join(manuscriptsRoot, candidate));
                }
            }

            return {
                dryRun,
                totalFiles: files.length,
                moved: report.length,
                report,
            };
        }

        if (action === 'read') {
            const relPath = normalizeRelativePath(requireString(readFlag(parsed.flags, 'path') || payload.path, 'path'));
            const absolute = path.join(manuscriptsRoot, relPath);
            const stats = await fs.stat(absolute);
            if (stats.isDirectory() && isManuscriptPackageName(path.basename(absolute))) {
                const pkg = await readManuscriptPackage(absolute);
                return {
                    path: relPath,
                    content: pkg.content,
                    metadata: pkg.metadata || {},
                };
            }
            const raw = await fs.readFile(absolute, 'utf-8');
            const parsedMatter = matter(raw);
            return {
                path: relPath,
                content: parsedMatter.content,
                metadata: parsedMatter.data || {},
            };
        }

        if (action === 'clips') {
            const relPath = normalizeRelativePath(requireString(readFlag(parsed.flags, 'path') || payload.path, 'path'));
            const absolute = path.join(manuscriptsRoot, relPath);
            const stats = await fs.stat(absolute);
            if (!stats.isDirectory() || !isManuscriptPackageName(path.basename(absolute))) {
                throw new Error('clips 仅支持视频/音频工程稿件');
            }
            const timeline = await readJsonFile<Record<string, unknown>>(getPackageTimelinePath(absolute), {});
            const clips = buildTimelineClipSummaries(timeline);
            return {
                path: relPath,
                count: clips.length,
                clips,
            };
        }

        if (action === 'track-add') {
            const relPath = normalizeRelativePath(requireString(readFlag(parsed.flags, 'path') || payload.path, 'path'));
            const kind = String(readFlag(parsed.flags, 'kind') || payload.kind || 'video').trim().toLowerCase() === 'audio' ? 'audio' : 'video';
            const absolute = path.join(manuscriptsRoot, relPath);
            const stats = await fs.stat(absolute);
            if (!stats.isDirectory() || !isManuscriptPackageName(path.basename(absolute))) {
                throw new Error('track-add 仅支持视频/音频工程稿件');
            }
            const timelinePath = getPackageTimelinePath(absolute);
            const timeline = await readJsonFile<Record<string, unknown>>(timelinePath, createEmptyOtioTimeline(path.basename(absolute)));
            const tracks = Array.isArray((timeline as any)?.tracks?.children) ? (timeline as any).tracks.children : [];
            const prefix = kind === 'audio' ? 'A' : 'V';
            const trackKind = kind === 'audio' ? 'Audio' as const : 'Video' as const;
            const existingIndexes = tracks
                .map((track: any) => String(track?.name || '').trim())
                .filter((name: string) => name.startsWith(prefix))
                .map((name: string) => Number(name.slice(1)))
                .filter((value: number) => Number.isFinite(value));
            const nextIndex = existingIndexes.length > 0 ? Math.max(...existingIndexes) + 1 : 1;
            const trackName = `${prefix}${nextIndex}`;
            ensureTimelineTrack(timeline, trackName, trackKind);
            normalizePackageTimeline(timeline);
            await fs.writeFile(timelinePath, JSON.stringify(timeline, null, 2), 'utf-8');
            return {
                success: true,
                path: relPath,
                track: trackName,
                clips: buildTimelineClipSummaries(timeline),
            };
        }

        if (action === 'clip-add') {
            const relPath = normalizeRelativePath(requireString(readFlag(parsed.flags, 'path') || payload.path, 'path'));
            const assetId = requireString(readFlag(parsed.flags, 'asset-id', 'assetid') || payload.assetId, 'assetId');
            const absolute = path.join(manuscriptsRoot, relPath);
            const stats = await fs.stat(absolute);
            if (!stats.isDirectory() || !isManuscriptPackageName(path.basename(absolute))) {
                throw new Error('clip-add 仅支持视频/音频工程稿件');
            }
            const asset = (await listMediaAssets(5000)).find((item) => item.id === assetId);
            if (!asset) {
                throw new Error(`Media asset not found: ${assetId}`);
            }

            const assetKind = String(asset.mimeType || '').startsWith('audio/')
                ? 'audio'
                : String(asset.mimeType || '').startsWith('video/')
                    ? 'video'
                    : /\.(mp3|wav|m4a|aac|flac|ogg|opus)$/i.test(String(asset.relativePath || ''))
                        ? 'audio'
                        : /\.(mp4|mov|webm|m4v|avi|mkv)$/i.test(String(asset.relativePath || ''))
                            ? 'video'
                            : /\.(png|jpg|jpeg|webp|gif|bmp|svg)$/i.test(String(asset.relativePath || ''))
                                ? 'image'
                                : 'unknown';
            const timelinePath = getPackageTimelinePath(absolute);
            const timeline = await readJsonFile<Record<string, unknown>>(timelinePath, createEmptyOtioTimeline(path.basename(absolute)));
            const preferredTrack = String(readFlag(parsed.flags, 'track') || payload.track || '').trim() || (assetKind === 'audio' ? 'A1' : 'V1');
            const targetTrack = ensureTimelineTrack(timeline, preferredTrack, preferredTrack.startsWith('A') ? 'Audio' : 'Video');
            const targetChildren = Array.isArray((targetTrack as any)?.children) ? targetTrack.children : [];
            const desiredOrderRaw = parseNumber(readFlag(parsed.flags, 'order') ?? payload.order);
            const desiredOrder = desiredOrderRaw === undefined ? targetChildren.length : Math.max(0, Math.min(Math.trunc(desiredOrderRaw), targetChildren.length));
            targetChildren.splice(desiredOrder, 0, {
                OTIO_SCHEMA: 'Clip.2',
                name: asset.title || asset.id,
                source_range: null,
                media_references: {
                    DEFAULT_MEDIA: {
                        OTIO_SCHEMA: 'ExternalReference.1',
                        target_url: asset.relativePath || '',
                        available_range: null,
                        metadata: {
                            assetId: asset.id,
                            mimeType: asset.mimeType || '',
                        },
                    },
                },
                active_media_reference_key: 'DEFAULT_MEDIA',
                metadata: {
                    clipId: createTimelineClipId(),
                    assetId: asset.id,
                    assetKind,
                    source: 'media-library',
                    order: desiredOrder,
                    durationMs: parseNumber(readFlag(parsed.flags, 'duration-ms', 'duration') ?? payload.durationMs) ?? null,
                    trimInMs: 0,
                    trimOutMs: 0,
                    enabled: true,
                    addedAt: new Date().toISOString(),
                },
            });
            targetTrack.children = targetChildren;
            normalizePackageTimeline(timeline);
            await fs.writeFile(timelinePath, JSON.stringify(timeline, null, 2), 'utf-8');
            return {
                success: true,
                path: relPath,
                assetId,
                clips: buildTimelineClipSummaries(timeline),
            };
        }

        if (action === 'clip-update') {
            const relPath = normalizeRelativePath(requireString(readFlag(parsed.flags, 'path') || payload.path, 'path'));
            const clipId = String(readFlag(parsed.flags, 'clip-id', 'clipid') || payload.clipId || '').trim();
            const assetId = String(readFlag(parsed.flags, 'asset-id', 'assetid') || payload.assetId || '').trim();
            if (!clipId && !assetId) {
                throw new Error('clip-update 需要 clipId 或 assetId');
            }
            const absolute = path.join(manuscriptsRoot, relPath);
            const stats = await fs.stat(absolute);
            if (!stats.isDirectory() || !isManuscriptPackageName(path.basename(absolute))) {
                throw new Error('clip-update 仅支持视频/音频工程稿件');
            }

            const timelinePath = getPackageTimelinePath(absolute);
            const timeline = await readJsonFile<Record<string, unknown>>(timelinePath, createEmptyOtioTimeline(path.basename(absolute)));
            const tracks = Array.isArray((timeline as any)?.tracks?.children) ? (timeline as any).tracks.children : [];
            let clipToMove: any = null;
            let currentTrack: any = null;

            const matchesTargetClip = (clip: any, trackName: string, index: number) => {
                if (clipId) {
                    return getTimelineClipIdentity(clip, trackName, index) === clipId;
                }
                return String(clip?.metadata?.assetId || clip?.media_references?.DEFAULT_MEDIA?.metadata?.assetId || '').trim() === assetId;
            };

            for (const track of tracks) {
                const children = Array.isArray((track as any)?.children) ? track.children : [];
                const trackName = String((track as any)?.name || '').trim();
                const clipIndex = children.findIndex((clip: any, index: number) => matchesTargetClip(clip, trackName, index));
                if (clipIndex >= 0) {
                    clipToMove = children.splice(clipIndex, 1)[0];
                    currentTrack = track;
                    break;
                }
            }

            if (!clipToMove || !currentTrack) {
                throw new Error(`Clip not found for assetId: ${assetId}`);
            }

            const nextTrackName = String(readFlag(parsed.flags, 'track') || payload.track || currentTrack?.name || '').trim();
            const targetTrack = tracks.find((track: any) => String(track?.name || '').trim() === nextTrackName) || currentTrack;
            const targetChildren = Array.isArray(targetTrack.children) ? targetTrack.children : [];
            const nextMetadata = (clipToMove?.metadata && typeof clipToMove.metadata === 'object') ? clipToMove.metadata : {};
            const durationRaw = readFlag(parsed.flags, 'duration-ms', 'duration') ?? payload.durationMs;
            const trimInRaw = readFlag(parsed.flags, 'trim-in-ms', 'trim-in') ?? payload.trimInMs;
            const trimOutRaw = readFlag(parsed.flags, 'trim-out-ms', 'trim-out') ?? payload.trimOutMs;
            const enabledRaw = readFlag(parsed.flags, 'enabled') ?? payload.enabled;
            const orderRaw = readFlag(parsed.flags, 'order') ?? payload.order;

            clipToMove = {
                ...clipToMove,
                metadata: {
                    ...nextMetadata,
                    clipId: String(nextMetadata.clipId || '').trim() || clipId || createTimelineClipId(),
                    durationMs: durationRaw === null ? null : (parseNumber(durationRaw) ?? nextMetadata.durationMs ?? null),
                    trimInMs: parseNumber(trimInRaw) ?? nextMetadata.trimInMs ?? 0,
                    trimOutMs: parseNumber(trimOutRaw) ?? nextMetadata.trimOutMs ?? 0,
                    enabled: enabledRaw === undefined ? (nextMetadata.enabled ?? true) : String(enabledRaw) !== 'false',
                },
            };

            const desiredOrder = (() => {
                const parsedOrder = parseNumber(orderRaw);
                if (parsedOrder === undefined || Number.isNaN(parsedOrder)) return targetChildren.length;
                return Math.max(0, Math.min(Math.trunc(parsedOrder), targetChildren.length));
            })();

            targetChildren.splice(desiredOrder, 0, clipToMove);
            targetTrack.children = targetChildren;
            normalizePackageTimeline(timeline);
            await fs.writeFile(timelinePath, JSON.stringify(timeline, null, 2), 'utf-8');
            return {
                success: true,
                path: relPath,
                clipId: String(clipToMove?.metadata?.clipId || clipId || ''),
                assetId: String(clipToMove?.metadata?.assetId || assetId || ''),
                clips: buildTimelineClipSummaries(timeline),
            };
        }

        if (action === 'clip-delete') {
            const relPath = normalizeRelativePath(requireString(readFlag(parsed.flags, 'path') || payload.path, 'path'));
            const clipId = requireString(readFlag(parsed.flags, 'clip-id', 'clipid') || payload.clipId, 'clipId');
            const absolute = path.join(manuscriptsRoot, relPath);
            const stats = await fs.stat(absolute);
            if (!stats.isDirectory() || !isManuscriptPackageName(path.basename(absolute))) {
                throw new Error('clip-delete 仅支持视频/音频工程稿件');
            }
            const timelinePath = getPackageTimelinePath(absolute);
            const timeline = await readJsonFile<Record<string, unknown>>(timelinePath, createEmptyOtioTimeline(path.basename(absolute)));
            const tracks = Array.isArray((timeline as any)?.tracks?.children) ? (timeline as any).tracks.children : [];
            let removed = false;
            for (const track of tracks) {
                const trackName = String((track as any)?.name || '').trim();
                const children = Array.isArray((track as any)?.children) ? track.children : [];
                track.children = children.filter((clip: any, index: number) => {
                    const matches = getTimelineClipIdentity(clip, trackName, index) === clipId;
                    if (matches) removed = true;
                    return !matches;
                });
            }
            if (!removed) {
                throw new Error(`Clip not found for clipId: ${clipId}`);
            }
            normalizePackageTimeline(timeline);
            await fs.writeFile(timelinePath, JSON.stringify(timeline, null, 2), 'utf-8');
            return {
                success: true,
                path: relPath,
                clipId,
                clips: buildTimelineClipSummaries(timeline),
            };
        }

        if (action === 'clip-split') {
            const relPath = normalizeRelativePath(requireString(readFlag(parsed.flags, 'path') || payload.path, 'path'));
            const clipId = requireString(readFlag(parsed.flags, 'clip-id', 'clipid') || payload.clipId, 'clipId');
            const ratioRaw = parseNumber(readFlag(parsed.flags, 'ratio', 'split-ratio') ?? payload.splitRatio);
            const splitRatio = ratioRaw === undefined ? 0.5 : Math.min(Math.max(ratioRaw, 0.1), 0.9);
            const absolute = path.join(manuscriptsRoot, relPath);
            const stats = await fs.stat(absolute);
            if (!stats.isDirectory() || !isManuscriptPackageName(path.basename(absolute))) {
                throw new Error('clip-split 仅支持视频/音频工程稿件');
            }
            const timelinePath = getPackageTimelinePath(absolute);
            const timeline = await readJsonFile<Record<string, unknown>>(timelinePath, createEmptyOtioTimeline(path.basename(absolute)));
            const tracks = Array.isArray((timeline as any)?.tracks?.children) ? (timeline as any).tracks.children : [];
            let splitDone = false;
            for (const track of tracks) {
                const trackName = String((track as any)?.name || '').trim();
                const children = Array.isArray((track as any)?.children) ? track.children : [];
                const nextChildren: any[] = [];
                for (let index = 0; index < children.length; index += 1) {
                    const clip = children[index];
                    nextChildren.push(clip);
                    if (getTimelineClipIdentity(clip, trackName, index) !== clipId) continue;
                    const metadata = (clip?.metadata && typeof clip.metadata === 'object') ? clip.metadata : {};
                    const currentDuration = Number(metadata.durationMs ?? 4000) || 4000;
                    const firstDuration = Math.max(1000, Math.round(currentDuration * splitRatio));
                    const secondDuration = Math.max(1000, currentDuration - firstDuration);
                    clip.metadata = {
                        ...metadata,
                        clipId: String(metadata.clipId || '').trim() || clipId,
                        durationMs: firstDuration,
                    };
                    nextChildren.push({
                        ...clip,
                        metadata: {
                            ...metadata,
                            clipId: createTimelineClipId(),
                            durationMs: secondDuration,
                            trimInMs: Number(metadata.trimInMs ?? 0) + firstDuration,
                        },
                    });
                    splitDone = true;
                }
                track.children = nextChildren;
                if (splitDone) break;
            }
            if (!splitDone) {
                throw new Error(`Clip not found for clipId: ${clipId}`);
            }
            normalizePackageTimeline(timeline);
            await fs.writeFile(timelinePath, JSON.stringify(timeline, null, 2), 'utf-8');
            return {
                success: true,
                path: relPath,
                clipId,
                clips: buildTimelineClipSummaries(timeline),
            };
        }

        if (action === 'export') {
            const relPath = normalizeRelativePath(requireString(readFlag(parsed.flags, 'path') || payload.path, 'path'));
            const absolute = path.join(manuscriptsRoot, relPath);
            const stats = await fs.stat(absolute);
            if (!stats.isDirectory() || !isManuscriptPackageName(path.basename(absolute))) {
                throw new Error('export 仅支持工程稿件目录');
            }
            const packageKind = getPackageKindFromFileName(path.basename(absolute));
            if (packageKind !== 'video' && packageKind !== 'audio') {
                throw new Error('当前 export 仅支持视频/音频工程稿件');
            }
            return exportVideoOrAudioPackage({
                packagePath: absolute,
                relPath,
                packageKind,
                outputName: readFlag(parsed.flags, 'output', 'output-name') || (payload.outputName as string | undefined),
                size: readFlag(parsed.flags, 'size') || (payload.size as string | undefined),
            });
        }

        if (action === 'write' || action === 'create') {
            const relPathInput = requireString(readFlag(parsed.flags, 'path') || payload.path, 'path');
            const fallbackExtension = getManuscriptExtension(relPathInput) || '.md';
            const relPath = normalizeRelativePath(ensureManuscriptFileName(relPathInput, fallbackExtension));
            const absolute = path.join(manuscriptsRoot, relPath);

            const content = String(
                readFlag(parsed.flags, 'content')
                || payload.content
                || ''
            );

            let metadataInput = payload.metadata as Record<string, unknown> | undefined;
            const metadataRaw = readFlag(parsed.flags, 'metadata');
            if (!metadataInput && metadataRaw) {
                try {
                    metadataInput = JSON.parse(metadataRaw) as Record<string, unknown>;
                } catch {
                    throw new Error('metadata must be valid JSON');
                }
            }

            await fs.mkdir(path.dirname(absolute), { recursive: true });

            if (isManuscriptPackageName(path.basename(absolute))) {
                let currentMeta: Record<string, unknown> = {};
                let currentContent = '';
                try {
                    const pkg = await readManuscriptPackage(absolute);
                    currentMeta = pkg.metadata || {};
                    currentContent = pkg.content || '';
                } catch {
                    currentMeta = {};
                }
                try {
                    await fs.access(absolute);
                } catch {
                    await createManuscriptPackage(absolute, content, path.basename(absolute));
                }
                const nextMeta: Record<string, unknown> = {
                    ...currentMeta,
                    ...(metadataInput || {}),
                    id: currentMeta.id || ulid(),
                    createdAt: currentMeta.createdAt || Date.now(),
                    updatedAt: Date.now(),
                };
                const nextContent = content || currentContent;
                await saveManuscriptPackage(absolute, nextContent, nextMeta);
                return {
                    success: true,
                    path: relPath,
                    absolutePath: absolute,
                    bytes: Buffer.byteLength(nextContent, 'utf8'),
                    frontmatter: nextMeta,
                };
            }

            let currentMeta: Record<string, unknown> = {};
            let currentContent = '';
            try {
                const existingRaw = await fs.readFile(absolute, 'utf-8');
                const existing = matter(existingRaw);
                currentMeta = (existing.data || {}) as Record<string, unknown>;
                currentContent = existing.content || '';
            } catch {
                currentMeta = {};
            }

            const nextMeta: Record<string, unknown> = {
                ...currentMeta,
                ...(metadataInput || {}),
                id: currentMeta.id || ulid(),
                createdAt: currentMeta.createdAt || Date.now(),
                updatedAt: Date.now(),
            };
            const nextContent = content || currentContent;
            await fs.writeFile(absolute, matter.stringify(nextContent, nextMeta), 'utf-8');
            return {
                success: true,
                path: relPath,
                absolutePath: absolute,
                bytes: Buffer.byteLength(nextContent, 'utf8'),
                frontmatter: nextMeta,
            };
        }

        if (action === 'mkdir') {
            const relPath = normalizeRelativePath(requireString(readFlag(parsed.flags, 'path') || payload.path, 'path'));
            await fs.mkdir(path.join(manuscriptsRoot, relPath), { recursive: true });
            return { success: true, path: relPath };
        }

        if (action === 'delete') {
            const relPath = normalizeRelativePath(requireString(readFlag(parsed.flags, 'path') || payload.path, 'path'));
            await fs.rm(path.join(manuscriptsRoot, relPath), { recursive: true, force: true });
            return { success: true, path: relPath };
        }

        if (action === 'rename') {
            const oldPath = normalizeRelativePath(requireString(readFlag(parsed.flags, 'path') || payload.path, 'path'));
            const newName = requireString(readFlag(parsed.flags, 'name') || payload.name, 'name');
            const oldAbsolute = path.join(manuscriptsRoot, oldPath);
            const newAbsolute = path.join(path.dirname(oldAbsolute), newName);
            await fs.rename(oldAbsolute, newAbsolute);
            return { success: true, newPath: path.relative(manuscriptsRoot, newAbsolute).replace(/\\/g, '/') };
        }

        if (action === 'move') {
            const source = normalizeRelativePath(requireString(readFlag(parsed.flags, 'path', 'source') || payload.path || payload.source, 'source'));
            const targetDir = normalizeRelativePath(requireString(readFlag(parsed.flags, 'to', 'target-dir') || payload.targetDir, 'targetDir'));
            const sourceAbsolute = path.join(manuscriptsRoot, source);
            const targetAbsolute = path.join(manuscriptsRoot, targetDir, path.basename(sourceAbsolute));
            await fs.mkdir(path.dirname(targetAbsolute), { recursive: true });
            await fs.rename(sourceAbsolute, targetAbsolute);
            return { success: true, newPath: path.relative(manuscriptsRoot, targetAbsolute).replace(/\\/g, '/') };
        }

        throw new Error(`Unsupported manuscripts action: ${action}`);
    }

    private async handleKnowledge(parsed: ParsedCommand, payload: Record<string, unknown>) {
        const paths = getWorkspacePaths();
        const source = (readFlag(parsed.flags, 'source') || payload.source || 'all') as 'all' | 'redbook' | 'youtube';
        const resolveRoots = (): Array<{ source: 'redbook' | 'youtube'; root: string }> => {
            if (source === 'redbook') return [{ source: 'redbook', root: paths.knowledgeRedbook }];
            if (source === 'youtube') return [{ source: 'youtube', root: paths.knowledgeYoutube }];
            return [
                { source: 'redbook', root: paths.knowledgeRedbook },
                { source: 'youtube', root: paths.knowledgeYoutube },
            ];
        };

        const action = parsed.action;
        if (action === 'list') {
            const result: Record<string, string[]> = {};
            for (const item of resolveRoots()) {
                await fs.mkdir(item.root, { recursive: true });
                const entries = await fs.readdir(item.root, { withFileTypes: true });
                result[item.source] = entries
                    .filter((entry) => entry.isDirectory())
                    .map((entry) => entry.name)
                    .sort((a, b) => a.localeCompare(b));
            }
            return result;
        }

        if (action === 'read') {
            const id = requireString(readFlag(parsed.flags, 'id') || payload.id, 'id');
            const fileName = String(readFlag(parsed.flags, 'file') || payload.file || 'content.md');
            const roots = resolveRoots();
            for (const item of roots) {
                const target = path.join(item.root, id, fileName);
                try {
                    const content = await fs.readFile(target, 'utf-8');
                    return { source: item.source, id, file: fileName, content };
                } catch {
                    // try next root
                }
            }
            throw new Error(`Knowledge item not found: ${id}/${fileName}`);
        }

        if (action === 'search') {
            const query = requireString(readFlag(parsed.flags, 'query') || payload.query, 'query').toLowerCase();
            const hits: Array<{ source: string; id: string; file: string }> = [];
            for (const item of resolveRoots()) {
                await fs.mkdir(item.root, { recursive: true });
                const entries = await fs.readdir(item.root, { withFileTypes: true });
                for (const entry of entries) {
                    if (!entry.isDirectory()) continue;
                    const id = entry.name;
                    for (const file of ['content.md', 'meta.json']) {
                        const fullPath = path.join(item.root, id, file);
                        try {
                            const content = (await fs.readFile(fullPath, 'utf-8')).toLowerCase();
                            if (content.includes(query)) {
                                hits.push({ source: item.source, id, file });
                            }
                        } catch {
                            // ignore missing file
                        }
                    }
                }
            }
            return { query, count: hits.length, hits };
        }

        throw new Error(`Unsupported knowledge action: ${action}`);
    }

    private async handleAdvisors(parsed: ParsedCommand, payload: Record<string, unknown>) {
        const advisorsRoot = getWorkspacePaths().advisors;
        await fs.mkdir(advisorsRoot, { recursive: true });
        const action = parsed.action;

        if (action === 'list') {
            const entries = await fs.readdir(advisorsRoot, { withFileTypes: true });
            const advisors: Array<{ id: string; name?: string }> = [];
            for (const entry of entries) {
                if (!entry.isDirectory()) continue;
                const id = entry.name;
                const configPath = path.join(advisorsRoot, id, 'config.json');
                try {
                    const config = JSON.parse(await fs.readFile(configPath, 'utf-8')) as { name?: string };
                    advisors.push({ id, name: config.name });
                } catch {
                    advisors.push({ id });
                }
            }
            return advisors.sort((a, b) => (a.name || a.id).localeCompare(b.name || b.id));
        }

        if (action === 'read') {
            const id = requireString(readFlag(parsed.flags, 'id') || payload.id, 'id');
            const configPath = path.join(advisorsRoot, id, 'config.json');
            const config = JSON.parse(await fs.readFile(configPath, 'utf-8'));
            return { id, config };
        }

        throw new Error(`Unsupported advisors action: ${action}`);
    }

    private async handleMemory(parsed: ParsedCommand, payload: Record<string, unknown>) {
        const action = parsed.action;
        if (action === 'list') {
            const limit = parseNumber(readFlag(parsed.flags, 'limit')) || 100;
            const memories = await listUserMemoriesFromFile();
            return { count: memories.length, memories: memories.slice(0, Math.max(1, limit)) };
        }
        if (action === 'add') {
            const content = requireString(readFlag(parsed.flags, 'content') || payload.content, 'content');
            const type = (readFlag(parsed.flags, 'type') || payload.type || 'general') as 'general' | 'preference' | 'fact';
            const tags = parseList(readFlag(parsed.flags, 'tags') || payload.tags);
            return addUserMemoryToFile(content, type, tags);
        }
        if (action === 'delete') {
            const id = requireString(readFlag(parsed.flags, 'id') || payload.id, 'id');
            await deleteUserMemoryFromFile(id);
            return { success: true, id };
        }
        if (action === 'update') {
            const id = requireString(readFlag(parsed.flags, 'id') || payload.id, 'id');
            const content = readFlag(parsed.flags, 'content') || payload.content;
            const type = readFlag(parsed.flags, 'type') || payload.type;
            const tags = readFlag(parsed.flags, 'tags') || payload.tags;
            await updateUserMemoryInFile(id, {
                content: typeof content === 'string' ? content : undefined,
                type: typeof type === 'string' ? type as 'general' | 'preference' | 'fact' : undefined,
                tags: tags !== undefined ? parseList(tags) : undefined,
            });
            return { success: true, id };
        }
        throw new Error(`Unsupported memory action: ${action}`);
    }

    private async handleRedclaw(parsed: ParsedCommand, payload: Record<string, unknown>) {
        const action = parsed.action;
        const getRunner = async () => {
            const mod = await import('../redclawBackgroundRunner');
            return mod.getRedClawBackgroundRunner();
        };
        if (action === 'list') {
            const limit = parseNumber(readFlag(parsed.flags, 'limit') || payload.limit) || 20;
            return listRedClawProjects(limit);
        }
        if (action === 'create') {
            const goal = requireString(readFlag(parsed.flags, 'goal') || payload.goal, 'goal');
            return createRedClawProject({
                goal,
                platform: normalizeRedClawPlatform(readFlag(parsed.flags, 'platform') || payload.platform),
                taskType: normalizeRedClawTaskType(readFlag(parsed.flags, 'task-type') || payload.taskType),
                targetAudience: readFlag(parsed.flags, 'audience', 'target-audience') || (payload.targetAudience as string | undefined),
                tone: readFlag(parsed.flags, 'tone') || (payload.tone as string | undefined),
                successCriteria: readFlag(parsed.flags, 'success', 'success-criteria') || (payload.successCriteria as string | undefined),
                sourcePlatform: normalizeRedClawPlatform(readFlag(parsed.flags, 'source-platform') || payload.sourcePlatform),
                sourceNoteId: readFlag(parsed.flags, 'source-note-id') || (payload.sourceNoteId as string | undefined),
                sourceMode: normalizeRedClawSourceMode(readFlag(parsed.flags, 'source-mode') || payload.sourceMode),
                sourceTitle: readFlag(parsed.flags, 'source-title') || (payload.sourceTitle as string | undefined),
                sourceManuscriptPath: readFlag(parsed.flags, 'source-manuscript-path') || (payload.sourceManuscriptPath as string | undefined),
                tags: parseList(readFlag(parsed.flags, 'tags') || payload.tags),
                workItemId: readFlag(parsed.flags, 'work-item-id') || (payload.workItemId as string | undefined),
            });
        }
        if (action === 'get') {
            const projectId = requireString(readFlag(parsed.flags, 'project-id', 'projectid') || payload.projectId, 'projectId');
            return getRedClawProject(projectId);
        }
        if (action === 'save-copy') {
            const projectId = requireString(readFlag(parsed.flags, 'project-id', 'projectid') || payload.projectId, 'projectId');
            const titleOptions = parseList(readFlag(parsed.flags, 'titles', 'title-options') || payload.titleOptions);
            const content = requireString(readFlag(parsed.flags, 'content') || payload.content, 'content');
            return saveRedClawCopyPack({
                projectId,
                platform: normalizeRedClawPlatform(readFlag(parsed.flags, 'platform') || payload.platform),
                taskType: normalizeRedClawTaskType(readFlag(parsed.flags, 'task-type') || payload.taskType),
                titleOptions: titleOptions.length > 0 ? titleOptions : ['默认标题'],
                finalTitle: readFlag(parsed.flags, 'final-title') || (payload.finalTitle as string | undefined),
                summary: readFlag(parsed.flags, 'summary') || (payload.summary as string | undefined),
                introduction: readFlag(parsed.flags, 'introduction', 'intro') || (payload.introduction as string | undefined),
                content,
                hashtags: parseList(readFlag(parsed.flags, 'hashtags') || payload.hashtags),
                coverTexts: parseList(readFlag(parsed.flags, 'cover-texts') || payload.coverTexts),
                imageSuggestions: parseList(readFlag(parsed.flags, 'image-suggestions') || payload.imageSuggestions),
                cta: readFlag(parsed.flags, 'cta') || (payload.cta as string | undefined),
                sourcePlatform: normalizeRedClawPlatform(readFlag(parsed.flags, 'source-platform') || payload.sourcePlatform),
                sourceNoteId: readFlag(parsed.flags, 'source-note-id') || (payload.sourceNoteId as string | undefined),
                sourceMode: normalizeRedClawSourceMode(readFlag(parsed.flags, 'source-mode') || payload.sourceMode),
                sourceTitle: readFlag(parsed.flags, 'source-title') || (payload.sourceTitle as string | undefined),
                sourceManuscriptPath: readFlag(parsed.flags, 'source-manuscript-path') || (payload.sourceManuscriptPath as string | undefined),
                publishPlan: readFlag(parsed.flags, 'publish-plan') || (payload.publishPlan as string | undefined),
            });
        }
        if (action === 'save-image') {
            const projectId = requireString(readFlag(parsed.flags, 'project-id', 'projectid') || payload.projectId, 'projectId');
            let images = (payload.images as RedClawImagePrompt[] | undefined) || [];
            if (!Array.isArray(images) || images.length === 0) {
                const prompts = parseList(readFlag(parsed.flags, 'prompts') || payload.prompts);
                images = prompts.map((prompt) => ({ prompt }));
            }
            if (!images.length) {
                throw new Error('images/prompts is required');
            }
            return saveRedClawImagePack({
                projectId,
                coverPrompt: readFlag(parsed.flags, 'cover-prompt') || (payload.coverPrompt as string | undefined),
                notes: readFlag(parsed.flags, 'notes') || (payload.notes as string | undefined),
                images,
            });
        }
        if (action === 'save-retro') {
            const projectId = requireString(readFlag(parsed.flags, 'project-id', 'projectid') || payload.projectId, 'projectId');
            return saveRedClawRetrospective({
                projectId,
                metrics: {
                    views: parseNumber(readFlag(parsed.flags, 'views') || (payload.metrics as any)?.views),
                    likes: parseNumber(readFlag(parsed.flags, 'likes') || (payload.metrics as any)?.likes),
                    comments: parseNumber(readFlag(parsed.flags, 'comments') || (payload.metrics as any)?.comments),
                    collects: parseNumber(readFlag(parsed.flags, 'collects') || (payload.metrics as any)?.collects),
                    shares: parseNumber(readFlag(parsed.flags, 'shares') || (payload.metrics as any)?.shares),
                    follows: parseNumber(readFlag(parsed.flags, 'follows') || (payload.metrics as any)?.follows),
                },
                whatWorked: readFlag(parsed.flags, 'worked') || (payload.whatWorked as string | undefined),
                whatFailed: readFlag(parsed.flags, 'failed') || (payload.whatFailed as string | undefined),
                nextHypotheses: parseList(readFlag(parsed.flags, 'hypotheses') || payload.nextHypotheses),
                nextActions: parseList(readFlag(parsed.flags, 'actions') || payload.nextActions),
            });
        }
        if (action === 'runner-status') {
            const runner = await getRunner();
            return runner.getStatus();
        }
        if (action === 'runner-start') {
            const runner = await getRunner();
            return runner.start({
                intervalMinutes: parseNumber(readFlag(parsed.flags, 'interval', 'interval-minutes') || payload.intervalMinutes),
                keepAliveWhenNoWindow: parseBoolean(readFlag(parsed.flags, 'keep-alive') || payload.keepAliveWhenNoWindow),
                maxProjectsPerTick: parseNumber(readFlag(parsed.flags, 'max-projects', 'max-projects-per-tick') || payload.maxProjectsPerTick),
                maxAutomationPerTick: parseNumber(readFlag(parsed.flags, 'max-automation', 'max-automation-per-tick') || payload.maxAutomationPerTick),
                heartbeatEnabled: parseBoolean(readFlag(parsed.flags, 'heartbeat-enabled') || payload.heartbeatEnabled),
                heartbeatIntervalMinutes: parseNumber(readFlag(parsed.flags, 'heartbeat-interval') || payload.heartbeatIntervalMinutes),
            });
        }
        if (action === 'runner-stop') {
            const runner = await getRunner();
            return runner.stop();
        }
        if (action === 'runner-run-now') {
            const runner = await getRunner();
            const projectId = readFlag(parsed.flags, 'project-id', 'projectid') || (payload.projectId as string | undefined);
            return runner.runNow(projectId);
        }
        if (action === 'runner-set-config') {
            const runner = await getRunner();
            return runner.setRunnerConfig({
                intervalMinutes: parseNumber(readFlag(parsed.flags, 'interval', 'interval-minutes') || payload.intervalMinutes),
                keepAliveWhenNoWindow: parseBoolean(readFlag(parsed.flags, 'keep-alive') || payload.keepAliveWhenNoWindow),
                maxProjectsPerTick: parseNumber(readFlag(parsed.flags, 'max-projects', 'max-projects-per-tick') || payload.maxProjectsPerTick),
                maxAutomationPerTick: parseNumber(readFlag(parsed.flags, 'max-automation', 'max-automation-per-tick') || payload.maxAutomationPerTick),
                heartbeatEnabled: parseBoolean(readFlag(parsed.flags, 'heartbeat-enabled') || payload.heartbeatEnabled),
                heartbeatIntervalMinutes: parseNumber(readFlag(parsed.flags, 'heartbeat-interval') || payload.heartbeatIntervalMinutes),
                heartbeatSuppressEmptyReport: parseBoolean(readFlag(parsed.flags, 'heartbeat-suppress-empty') || payload.heartbeatSuppressEmptyReport),
                heartbeatReportToMainSession: parseBoolean(readFlag(parsed.flags, 'heartbeat-report-main') || payload.heartbeatReportToMainSession),
                heartbeatPrompt: (readFlag(parsed.flags, 'heartbeat-prompt') || payload.heartbeatPrompt) as string | undefined,
            });
        }
        if (action === 'runner-enable-project' || action === 'runner-disable-project' || action === 'runner-set-project') {
            const runner = await getRunner();
            const projectId = requireString(readFlag(parsed.flags, 'project-id', 'projectid') || payload.projectId, 'projectId');
            let enabled: boolean;
            if (action === 'runner-enable-project') {
                enabled = true;
            } else if (action === 'runner-disable-project') {
                enabled = false;
            } else {
                const parsedEnabled = parseBoolean(readFlag(parsed.flags, 'enabled') || payload.enabled);
                if (parsedEnabled === undefined) {
                    throw new Error('enabled is required for runner-set-project');
                }
                enabled = parsedEnabled;
            }
            return runner.setProjectState({
                projectId,
                enabled,
                prompt: readFlag(parsed.flags, 'prompt') || (payload.prompt as string | undefined),
            });
        }
        if (action === 'heartbeat-status') {
            const runner = await getRunner();
            const status = runner.getStatus();
            return {
                enabled: status.heartbeat?.enabled ?? false,
                intervalMinutes: status.heartbeat?.intervalMinutes ?? null,
                nextRunAt: status.heartbeat?.nextRunAt || null,
                lastRunAt: status.heartbeat?.lastRunAt || null,
                suppressEmptyReport: status.heartbeat?.suppressEmptyReport ?? true,
                reportToMainSession: status.heartbeat?.reportToMainSession ?? true,
                hasCustomPrompt: Boolean(status.heartbeat?.prompt),
            };
        }
        if (action === 'heartbeat-set') {
            const runner = await getRunner();
            return runner.setRunnerConfig({
                heartbeatEnabled: parseBoolean(readFlag(parsed.flags, 'enabled') || payload.enabled),
                heartbeatIntervalMinutes: parseNumber(readFlag(parsed.flags, 'interval', 'interval-minutes') || payload.intervalMinutes),
                heartbeatSuppressEmptyReport: parseBoolean(readFlag(parsed.flags, 'suppress-empty') || payload.suppressEmptyReport),
                heartbeatReportToMainSession: parseBoolean(readFlag(parsed.flags, 'report-main') || payload.reportToMainSession),
                heartbeatPrompt: (readFlag(parsed.flags, 'prompt') || payload.prompt) as string | undefined,
            });
        }
        if (action === 'schedule-list') {
            const runner = await getRunner();
            const tasks = runner.listScheduledTasks();
            return { count: tasks.length, tasks };
        }
        if (action === 'schedule-add') {
            const runner = await getRunner();
            const mode = String(readFlag(parsed.flags, 'mode') || payload.mode || 'interval').trim().toLowerCase();
            const weekdays = parseList(readFlag(parsed.flags, 'weekdays') || payload.weekdays)
                .map((item) => Number(item))
                .filter((n) => Number.isFinite(n))
                .map((n) => Math.max(0, Math.min(6, Math.floor(n))));

            return runner.addScheduledTask({
                name: requireString(readFlag(parsed.flags, 'name') || payload.name, 'name'),
                mode: mode as 'interval' | 'daily' | 'weekly' | 'once',
                prompt: requireString(readFlag(parsed.flags, 'prompt') || payload.prompt, 'prompt'),
                projectId: readFlag(parsed.flags, 'project-id', 'projectid') || (payload.projectId as string | undefined),
                workItemId: readFlag(parsed.flags, 'work-item-id') || (payload.workItemId as string | undefined),
                subagentRoles: parseList(readFlag(parsed.flags, 'subagent-roles', 'roles') || payload.subagentRoles) as any,
                intervalMinutes: parseNumber(readFlag(parsed.flags, 'interval', 'interval-minutes') || payload.intervalMinutes),
                time: (readFlag(parsed.flags, 'time') || payload.time) as string | undefined,
                weekdays,
                runAt: (readFlag(parsed.flags, 'run-at', 'at') || payload.runAt) as string | undefined,
                enabled: parseBoolean(readFlag(parsed.flags, 'enabled') || payload.enabled),
            });
        }
        if (action === 'schedule-update' || action === 'schedule-edit') {
            const runner = await getRunner();
            const taskId = requireString(readFlag(parsed.flags, 'task-id', 'taskid') || payload.taskId, 'taskId');
            const modeRaw = readFlag(parsed.flags, 'mode') || (payload.mode as string | undefined);
            const mode = modeRaw ? String(modeRaw).trim().toLowerCase() as 'interval' | 'daily' | 'weekly' | 'once' : undefined;
            const weekdaysInput = readFlag(parsed.flags, 'weekdays') ?? payload.weekdays;
            const weekdays = weekdaysInput !== undefined
                ? parseList(weekdaysInput)
                    .map((item) => Number(item))
                    .filter((n) => Number.isFinite(n))
                    .map((n) => Math.max(0, Math.min(6, Math.floor(n))))
                : undefined;
            const subagentRoles = readFlag(parsed.flags, 'subagent-roles', 'roles') !== undefined || payload.subagentRoles !== undefined
                ? parseList(readFlag(parsed.flags, 'subagent-roles', 'roles') || payload.subagentRoles)
                : undefined;
            const clearProject = parseBoolean(readFlag(parsed.flags, 'clear-project') || payload.clearProject) === true;
            const projectIdRaw = readFlag(parsed.flags, 'project-id', 'projectid') || (payload.projectId as string | undefined);

            return runner.updateScheduledTask(taskId, {
                name: (readFlag(parsed.flags, 'name') || payload.name) as string | undefined,
                mode,
                prompt: (readFlag(parsed.flags, 'prompt') || payload.prompt) as string | undefined,
                projectId: clearProject ? null : projectIdRaw,
                workItemId: (readFlag(parsed.flags, 'work-item-id') || payload.workItemId || undefined) as string | undefined,
                subagentRoles: subagentRoles as any,
                intervalMinutes: parseNumber(readFlag(parsed.flags, 'interval', 'interval-minutes') || payload.intervalMinutes),
                time: (readFlag(parsed.flags, 'time') || payload.time) as string | undefined,
                weekdays,
                runAt: (readFlag(parsed.flags, 'run-at', 'at') || payload.runAt) as string | undefined,
                enabled: parseBoolean(readFlag(parsed.flags, 'enabled') || payload.enabled),
            });
        }
        if (action === 'schedule-remove') {
            const runner = await getRunner();
            const taskId = requireString(readFlag(parsed.flags, 'task-id', 'taskid') || payload.taskId, 'taskId');
            return runner.removeScheduledTask(taskId);
        }
        if (action === 'schedule-enable' || action === 'schedule-disable') {
            const runner = await getRunner();
            const taskId = requireString(readFlag(parsed.flags, 'task-id', 'taskid') || payload.taskId, 'taskId');
            return runner.setScheduledTaskEnabled(taskId, action === 'schedule-enable');
        }
        if (action === 'schedule-run-now') {
            const runner = await getRunner();
            const taskId = requireString(readFlag(parsed.flags, 'task-id', 'taskid') || payload.taskId, 'taskId');
            return runner.runScheduledTaskNow(taskId);
        }
        if (action === 'long-list') {
            const runner = await getRunner();
            const tasks = runner.listLongCycleTasks();
            return { count: tasks.length, tasks };
        }
        if (action === 'long-add') {
            const runner = await getRunner();
            return runner.addLongCycleTask({
                name: requireString(readFlag(parsed.flags, 'name') || payload.name, 'name'),
                objective: requireString(readFlag(parsed.flags, 'objective') || payload.objective, 'objective'),
                stepPrompt: requireString(readFlag(parsed.flags, 'step-prompt') || payload.stepPrompt, 'stepPrompt'),
                projectId: readFlag(parsed.flags, 'project-id', 'projectid') || (payload.projectId as string | undefined),
                workItemId: readFlag(parsed.flags, 'work-item-id') || (payload.workItemId as string | undefined),
                subagentRoles: parseList(readFlag(parsed.flags, 'subagent-roles', 'roles') || payload.subagentRoles) as any,
                intervalMinutes: parseNumber(readFlag(parsed.flags, 'interval', 'interval-minutes') || payload.intervalMinutes),
                totalRounds: parseNumber(readFlag(parsed.flags, 'rounds', 'total-rounds') || payload.totalRounds),
                enabled: parseBoolean(readFlag(parsed.flags, 'enabled') || payload.enabled),
            });
        }
        if (action === 'long-update' || action === 'long-edit') {
            const runner = await getRunner();
            const taskId = requireString(readFlag(parsed.flags, 'task-id', 'taskid') || payload.taskId, 'taskId');
            const clearProject = parseBoolean(readFlag(parsed.flags, 'clear-project') || payload.clearProject) === true;
            const projectIdRaw = readFlag(parsed.flags, 'project-id', 'projectid') || (payload.projectId as string | undefined);
            const subagentRoles = readFlag(parsed.flags, 'subagent-roles', 'roles') !== undefined || payload.subagentRoles !== undefined
                ? parseList(readFlag(parsed.flags, 'subagent-roles', 'roles') || payload.subagentRoles)
                : undefined;
            return runner.updateLongCycleTask(taskId, {
                name: (readFlag(parsed.flags, 'name') || payload.name) as string | undefined,
                objective: (readFlag(parsed.flags, 'objective') || payload.objective) as string | undefined,
                stepPrompt: (readFlag(parsed.flags, 'step-prompt') || payload.stepPrompt) as string | undefined,
                projectId: clearProject ? null : projectIdRaw,
                workItemId: (readFlag(parsed.flags, 'work-item-id') || payload.workItemId || undefined) as string | undefined,
                subagentRoles: subagentRoles as any,
                intervalMinutes: parseNumber(readFlag(parsed.flags, 'interval', 'interval-minutes') || payload.intervalMinutes),
                totalRounds: parseNumber(readFlag(parsed.flags, 'rounds', 'total-rounds') || payload.totalRounds),
                enabled: parseBoolean(readFlag(parsed.flags, 'enabled') || payload.enabled),
            });
        }
        if (action === 'long-remove') {
            const runner = await getRunner();
            const taskId = requireString(readFlag(parsed.flags, 'task-id', 'taskid') || payload.taskId, 'taskId');
            return runner.removeLongCycleTask(taskId);
        }
        if (action === 'long-enable' || action === 'long-disable') {
            const runner = await getRunner();
            const taskId = requireString(readFlag(parsed.flags, 'task-id', 'taskid') || payload.taskId, 'taskId');
            return runner.setLongCycleTaskEnabled(taskId, action === 'long-enable');
        }
        if (action === 'long-run-now') {
            const runner = await getRunner();
            const taskId = requireString(readFlag(parsed.flags, 'task-id', 'taskid') || payload.taskId, 'taskId');
            return runner.runLongCycleTaskNow(taskId);
        }
        throw new Error(`Unsupported redclaw action: ${action}`);
    }

    private async handleSubjects(parsed: ParsedCommand, payload: Record<string, unknown>) {
        const action = parsed.action;
        if (action === 'list') {
            const limit = parseNumber(readFlag(parsed.flags, 'limit') || payload.limit) || 200;
            const categoryId = readFlag(parsed.flags, 'category-id', 'category') || (payload.categoryId as string | undefined);
            const subjects = categoryId
                ? await searchSubjects('', { categoryId, limit })
                : await listSubjects(limit);
            return { count: subjects.length, subjects };
        }

        if (action === 'get') {
            const id = requireString(readFlag(parsed.flags, 'id') || payload.id, 'id');
            return getSubject(id);
        }

        if (action === 'search') {
            const query = requireString(readFlag(parsed.flags, 'query') || payload.query, 'query');
            const categoryId = readFlag(parsed.flags, 'category-id', 'category') || (payload.categoryId as string | undefined);
            const limit = parseNumber(readFlag(parsed.flags, 'limit') || payload.limit) || 20;
            const subjects = await searchSubjects(query, { categoryId, limit });
            return { query, count: subjects.length, subjects };
        }

        if (action === 'create') {
            return createSubject({
                name: requireString(readFlag(parsed.flags, 'name') || payload.name, 'name'),
                categoryId: readFlag(parsed.flags, 'category-id', 'category') || (payload.categoryId as string | undefined),
                description: readFlag(parsed.flags, 'description', 'desc') || (payload.description as string | undefined),
                tags: parseList(readFlag(parsed.flags, 'tags') || payload.tags),
                attributes: Array.isArray(payload.attributes) ? payload.attributes as Array<{ key: string; value: string }> : undefined,
                images: Array.isArray(payload.images) ? payload.images as Array<{ name?: string; dataUrl?: string; relativePath?: string }> : undefined,
            });
        }

        if (action === 'update') {
            const id = requireString(readFlag(parsed.flags, 'id') || payload.id, 'id');
            return updateSubject({
                id,
                name: readFlag(parsed.flags, 'name') || (payload.name as string | undefined),
                categoryId: readFlag(parsed.flags, 'category-id', 'category') || (payload.categoryId as string | undefined),
                description: readFlag(parsed.flags, 'description', 'desc') || (payload.description as string | undefined),
                tags: readFlag(parsed.flags, 'tags') || (payload.tags as string[] | string | undefined),
                attributes: Array.isArray(payload.attributes) ? payload.attributes as Array<{ key: string; value: string }> : undefined,
                images: Array.isArray(payload.images) ? payload.images as Array<{ name?: string; dataUrl?: string; relativePath?: string }> : undefined,
            });
        }

        if (action === 'delete') {
            const id = requireString(readFlag(parsed.flags, 'id') || payload.id, 'id');
            await deleteSubject(id);
            return { success: true, id };
        }

        if (action === 'categories') {
            const subAction = (parsed.args[0] || 'list').toLowerCase();
            if (subAction === 'list') {
                const categories = await listSubjectCategories();
                return { count: categories.length, categories };
            }
            if (subAction === 'create') {
                const name = requireString(readFlag(parsed.flags, 'name') || payload.name || parsed.args[1], 'name');
                return createSubjectCategory(name);
            }
            if (subAction === 'update') {
                const id = requireString(readFlag(parsed.flags, 'id') || payload.id || parsed.args[1], 'id');
                const name = requireString(readFlag(parsed.flags, 'name') || payload.name || parsed.args[2], 'name');
                return updateSubjectCategory({ id, name });
            }
            if (subAction === 'delete') {
                const id = requireString(readFlag(parsed.flags, 'id') || payload.id || parsed.args[1], 'id');
                await deleteSubjectCategory(id);
                return { success: true, id };
            }
            throw new Error(`Unsupported subjects categories action: ${subAction}`);
        }

        throw new Error(`Unsupported subjects action: ${action}`);
    }

    private async handleMedia(parsed: ParsedCommand, payload: Record<string, unknown>) {
        const action = parsed.action;
        if (action === 'list') {
            const limit = parseNumber(readFlag(parsed.flags, 'limit') || payload.limit) || 200;
            const assets = await listMediaAssets(limit);
            return { count: assets.length, assets };
        }
        if (action === 'update') {
            const assetId = requireString(readFlag(parsed.flags, 'asset-id', 'assetid') || payload.assetId, 'assetId');
            const updated = await updateMediaAssetMetadata({
                assetId,
                projectId: readFlag(parsed.flags, 'project-id') || (payload.projectId as string | undefined),
                title: readFlag(parsed.flags, 'title') || (payload.title as string | undefined),
                prompt: readFlag(parsed.flags, 'prompt') || (payload.prompt as string | undefined),
            });
            return updated;
        }
        if (action === 'bind') {
            const assetId = requireString(readFlag(parsed.flags, 'asset-id', 'assetid') || payload.assetId, 'assetId');
            const manuscriptPath = normalizeRelativePath(requireString(readFlag(parsed.flags, 'manuscript-path') || payload.manuscriptPath, 'manuscriptPath'));
            const roleRaw = readFlag(parsed.flags, 'role') || payload.role;
            const role = roleRaw === 'cover' || roleRaw === 'image' || roleRaw === 'asset'
                ? roleRaw
                : undefined;
            return bindMediaAssetToManuscript({ assetId, manuscriptPath, role });
        }
        if (action === 'path') {
            const assetId = requireString(readFlag(parsed.flags, 'asset-id', 'assetid') || payload.assetId, 'assetId');
            const assets = await listMediaAssets(5000);
            const asset = assets.find((item) => item.id === assetId);
            if (!asset) throw new Error('Media asset not found');
            return {
                assetId,
                relativePath: asset.relativePath || null,
                absolutePath: asset.relativePath ? getAbsoluteMediaPath(asset.relativePath) : null,
            };
        }
        if (action === 'stats') {
            const assets = await listMediaAssets(5000);
            return {
                total: assets.length,
                generated: assets.filter((a) => a.source === 'generated').length,
                planned: assets.filter((a) => a.source === 'planned').length,
                imported: assets.filter((a) => a.source === 'imported').length,
            };
        }
        throw new Error(`Unsupported media action: ${action}`);
    }

    private async handleImage(parsed: ParsedCommand, payload: Record<string, unknown>) {
        if (parsed.action !== 'generate') {
            throw new Error(`Unsupported image action: ${parsed.action}`);
        }
        const prompt = requireString(readFlag(parsed.flags, 'prompt') || payload.prompt, 'prompt');
        const generationModeRaw = readFlag(parsed.flags, 'mode', 'generation-mode') || payload.generationMode;
        let generationMode: 'text-to-image' | 'image-to-image' | 'reference-guided' | undefined = (() => {
            const normalized = String(generationModeRaw || '').trim().toLowerCase();
            if (normalized === 'image-to-image' || normalized === 'reference-guided' || normalized === 'text-to-image') {
                return normalized as 'text-to-image' | 'image-to-image' | 'reference-guided';
            }
            return undefined;
        })();
        const referenceImagesRaw = readFlag(parsed.flags, 'reference-images', 'refs') || payload.referenceImages;
        const directReferenceImages = Array.isArray(referenceImagesRaw)
            ? referenceImagesRaw.map((item) => String(item || '').trim()).filter(Boolean).slice(0, 4)
            : String(referenceImagesRaw || '')
                .split(',')
                .map((item) => item.trim())
                .filter(Boolean)
                .slice(0, 4);
        const subjectIds = parseList(readFlag(parsed.flags, 'subject-ids', 'subjects') || payload.subjectIds);
        const subjectQuery = readFlag(parsed.flags, 'subject-query', 'query-subjects') || (payload.subjectQuery as string | undefined);
        const matchedSubjects = subjectIds.length > 0
            ? await Promise.all(subjectIds.slice(0, 4).map(async (id) => getSubject(id)))
            : (subjectQuery ? await searchSubjects(subjectQuery, { limit: 4 }) : []);
        const subjectReferenceImages: string[] = [];
        const referenceLabels: string[] = [];

        if (directReferenceImages.length > 0) {
            referenceLabels.push(...directReferenceImages.map((_, index) => `用户上传的参考图${index + 1}`));
        }

        if (matchedSubjects.length > 0) {
            if (matchedSubjects.length === 1) {
                const subject = matchedSubjects[0];
                for (const imagePath of (subject.absoluteImagePaths || []).slice(0, 4)) {
                    subjectReferenceImages.push(imagePath);
                    referenceLabels.push(`${subject.name}${subject.categoryId ? `（${subject.categoryId}）` : ''} 的主体参考图`);
                }
            } else {
                for (const subject of matchedSubjects) {
                    const firstImage = (subject.absoluteImagePaths || [])[0];
                    if (!firstImage) continue;
                    subjectReferenceImages.push(firstImage);
                    const categoryLabel = subject.categoryId ? `，分类=${subject.categoryId}` : '';
                    const tagLabel = Array.isArray(subject.tags) && subject.tags.length > 0 ? `，标签=${subject.tags.slice(0, 4).join('/')}` : '';
                    referenceLabels.push(`${subject.name}${categoryLabel}${tagLabel}`);
                }
            }
        }

        const referenceImages = dedupeList([...directReferenceImages, ...subjectReferenceImages], 4);
        const videoProjectId = String(readFlag(parsed.flags, 'video-project-id') || payload.videoProjectId || '').trim();
        if (!generationMode && referenceImages.length > 0) {
            generationMode = 'reference-guided';
        }
        const effectivePrompt = buildReferenceAwarePrompt(prompt, referenceLabels, generationMode);
        const result = await generateImagesToMediaLibrary({
            prompt: effectivePrompt,
            projectId: readFlag(parsed.flags, 'project-id') || (payload.projectId as string | undefined),
            title: readFlag(parsed.flags, 'title') || (payload.title as string | undefined),
            generationMode,
            referenceImages,
            count: parseNumber(readFlag(parsed.flags, 'count') || payload.count),
            model: readFlag(parsed.flags, 'model') || (payload.model as string | undefined),
            provider: readFlag(parsed.flags, 'provider') || (payload.provider as string | undefined),
            providerTemplate: readFlag(parsed.flags, 'template', 'provider-template') || (payload.providerTemplate as string | undefined),
            aspectRatio: readFlag(parsed.flags, 'ratio', 'aspect-ratio') || (payload.aspectRatio as string | undefined),
            size: readFlag(parsed.flags, 'size') || (payload.size as string | undefined),
            quality: readFlag(parsed.flags, 'quality') || (payload.quality as string | undefined),
        });
        let videoProject = videoProjectId ? await getVideoProjectPack(videoProjectId) : null;
        if (videoProjectId) {
            for (const [index, asset] of result.assets.entries()) {
                videoProject = await addGeneratedAssetToVideoProjectPack({
                    projectId: videoProjectId,
                    asset,
                    kind: 'keyframe',
                    label: result.assets.length > 1 ? `keyframe-${index + 1}` : 'keyframe',
                    role: 'storyboard-keyframe',
                });
            }
        }
        return {
            provider: result.provider,
            providerTemplate: result.providerTemplate,
            model: result.model,
            generationMode: result.generationMode,
            referenceImageCount: result.referenceImageCount,
            subjects: matchedSubjects.map((subject) => ({
                id: subject.id,
                name: subject.name,
                imageCount: (subject.absoluteImagePaths || []).length,
            })),
            aspectRatio: result.aspectRatio,
            size: result.size,
            quality: result.quality,
            count: result.assets.length,
            assets: result.assets.map((asset) => ({
                id: asset.id,
                projectId: asset.projectId,
                relativePath: asset.relativePath,
                absolutePath: asset.relativePath ? getAbsoluteMediaPath(asset.relativePath) : null,
                previewUrl: asset.relativePath ? toAppAssetUrl(getAbsoluteMediaPath(asset.relativePath)) : null,
                prompt: asset.prompt,
                createdAt: asset.createdAt,
            })),
            videoProject: videoProject ? {
                id: videoProject.id,
                title: videoProject.title,
                projectDir: videoProject.projectDir,
                manifestPath: path.join(videoProject.projectDir, 'manifest.json'),
                scriptPath: path.join(videoProject.projectDir, videoProject.scriptPath),
                briefPath: path.join(videoProject.projectDir, videoProject.briefPath),
            } : null,
        } satisfies GeneratedImageCliResult;
    }

    private async handleVideo(parsed: ParsedCommand, payload: Record<string, unknown>) {
        if (parsed.action === 'project-create') {
            const manifest = await createVideoProjectPack({
                title: requireString(readFlag(parsed.flags, 'title') || payload.title, 'title'),
                brief: String(readFlag(parsed.flags, 'brief') || payload.brief || '').trim() || undefined,
                script: typeof payload.script === 'string' ? payload.script : undefined,
                mode: (() => {
                    const value = String(readFlag(parsed.flags, 'mode') || payload.mode || '').trim().toLowerCase();
                    if (value === 'text-to-video' || value === 'reference-guided' || value === 'first-last-frame' || value === 'continuation' || value === 'multi-video') {
                        return value as 'text-to-video' | 'reference-guided' | 'first-last-frame' | 'continuation' | 'multi-video';
                    }
                    return undefined;
                })(),
                aspectRatio: String(readFlag(parsed.flags, 'aspect-ratio', 'ratio') || payload.aspectRatio || '').trim() || undefined,
                durationSeconds: parseNumber(readFlag(parsed.flags, 'duration', 'seconds') || payload.durationSeconds || payload.seconds),
                workItemId: String(readFlag(parsed.flags, 'work-item-id') || payload.workItemId || '').trim() || undefined,
                metadata: payload.metadata && typeof payload.metadata === 'object' ? payload.metadata as Record<string, unknown> : undefined,
            });
            return {
                id: manifest.id,
                title: manifest.title,
                status: manifest.status,
                mode: manifest.mode,
                aspectRatio: manifest.aspectRatio,
                durationSeconds: manifest.durationSeconds,
                projectDir: manifest.projectDir,
                manifestPath: path.join(manifest.projectDir, 'manifest.json'),
                scriptPath: path.join(manifest.projectDir, manifest.scriptPath),
                briefPath: path.join(manifest.projectDir, manifest.briefPath),
            };
        }
        if (parsed.action === 'project-list') {
            const items = await listVideoProjectPacks(parseNumber(readFlag(parsed.flags, 'limit') || payload.limit) || 50);
            return items.map((manifest) => ({
                id: manifest.id,
                title: manifest.title,
                status: manifest.status,
                mode: manifest.mode,
                aspectRatio: manifest.aspectRatio,
                durationSeconds: manifest.durationSeconds,
                updatedAt: manifest.updatedAt,
                projectDir: manifest.projectDir,
                manifestPath: path.join(manifest.projectDir, 'manifest.json'),
            }));
        }
        if (parsed.action === 'project-get') {
            const id = requireString(readFlag(parsed.flags, 'id') || payload.id, 'id');
            const manifest = await getVideoProjectPack(id);
            if (!manifest) {
                throw new Error('Video project not found');
            }
            return {
                ...manifest,
                manifestPath: path.join(manifest.projectDir, 'manifest.json'),
                scriptPath: path.join(manifest.projectDir, manifest.scriptPath),
                briefPath: path.join(manifest.projectDir, manifest.briefPath),
            };
        }
        if (parsed.action === 'project-script') {
            const id = requireString(readFlag(parsed.flags, 'id') || payload.id, 'id');
            const script = typeof payload.content === 'string'
                ? payload.content
                : requireString(readFlag(parsed.flags, 'content') || payload.script, 'content');
            const manifest = await updateVideoProjectScript({
                projectId: id,
                script,
                status: 'ready',
            });
            return {
                id: manifest.id,
                title: manifest.title,
                status: manifest.status,
                scriptPath: path.join(manifest.projectDir, manifest.scriptPath),
                updatedAt: manifest.updatedAt,
            };
        }
        if (parsed.action === 'project-brief') {
            const id = requireString(readFlag(parsed.flags, 'id') || payload.id, 'id');
            const brief = typeof payload.content === 'string'
                ? payload.content
                : requireString(readFlag(parsed.flags, 'content') || payload.brief, 'content');
            const manifest = await updateVideoProjectBrief({ projectId: id, brief });
            return {
                id: manifest.id,
                title: manifest.title,
                briefPath: path.join(manifest.projectDir, manifest.briefPath),
                updatedAt: manifest.updatedAt,
            };
        }
        if (parsed.action === 'project-asset-add') {
            const id = requireString(readFlag(parsed.flags, 'id') || payload.id, 'id');
            const sourcePath = requireString(readFlag(parsed.flags, 'path', 'source') || payload.sourcePath, 'sourcePath');
            const kindRaw = String(readFlag(parsed.flags, 'kind') || payload.kind || '').trim().toLowerCase();
            const kind = (() => {
                if (kindRaw === 'reference-image' || kindRaw === 'voice-reference' || kindRaw === 'keyframe' || kindRaw === 'clip' || kindRaw === 'output' || kindRaw === 'other') {
                    return kindRaw as 'reference-image' | 'voice-reference' | 'keyframe' | 'clip' | 'output' | 'other';
                }
                throw new Error('kind must be one of reference-image, voice-reference, keyframe, clip, output, other');
            })();
            const manifest = await addAssetToVideoProjectPack({
                projectId: id,
                sourcePath,
                kind,
                label: String(readFlag(parsed.flags, 'label') || payload.label || '').trim() || undefined,
                role: String(readFlag(parsed.flags, 'role') || payload.role || '').trim() || undefined,
            });
            return {
                id: manifest.id,
                title: manifest.title,
                updatedAt: manifest.updatedAt,
                references: manifest.references.length,
                keyframes: manifest.keyframes.length,
                clips: manifest.clips.length,
                outputs: manifest.outputs.length,
            };
        }
        if (parsed.action !== 'generate') {
            throw new Error(`Unsupported video action: ${parsed.action}`);
        }
        const prompt = requireString(readFlag(parsed.flags, 'prompt') || payload.prompt, 'prompt');
        const generationModeRaw = readFlag(parsed.flags, 'mode', 'generation-mode') || payload.generationMode;
        const generationMode = (() => {
            const normalized = String(generationModeRaw || '').trim().toLowerCase();
            if (normalized === 'reference-guided' || normalized === 'first-last-frame' || normalized === 'text-to-video' || normalized === 'continuation') {
                return normalized as 'reference-guided' | 'first-last-frame' | 'text-to-video' | 'continuation';
            }
            return undefined;
        })();
        const referenceImagesRaw = readFlag(parsed.flags, 'reference-images', 'refs') || payload.referenceImages;
        const directReferenceImages = Array.isArray(referenceImagesRaw)
            ? referenceImagesRaw.map((item) => String(item || '').trim()).filter(Boolean).slice(0, 5)
            : String(referenceImagesRaw || '')
                .split(',')
                .map((item) => item.trim())
                .filter(Boolean)
                .slice(0, 5);
        const rawProjectId = String(readFlag(parsed.flags, 'video-project-id') || payload.videoProjectId || readFlag(parsed.flags, 'project-id') || '').trim();
        const videoProjectId = rawProjectId.startsWith('video_project_') ? rawProjectId : String(readFlag(parsed.flags, 'video-project-id') || payload.videoProjectId || '').trim();
        const videoProject = videoProjectId ? await getVideoProjectPack(videoProjectId) : null;
        const subjectIds = parseList(readFlag(parsed.flags, 'subject-ids', 'subjects') || payload.subjectIds);
        const subjectQuery = readFlag(parsed.flags, 'subject-query', 'query-subjects') || (payload.subjectQuery as string | undefined);
        const matchedSubjects = subjectIds.length > 0
            ? await Promise.all(subjectIds.slice(0, 5).map(async (id) => getSubject(id)))
            : (subjectQuery ? await searchSubjects(subjectQuery, { limit: 5 }) : []);
        const subjectReferenceImages: string[] = [];
        if (matchedSubjects.length > 0) {
            if (matchedSubjects.length === 1) {
                const subject = matchedSubjects[0];
                for (const imagePath of (subject.absoluteImagePaths || []).slice(0, 5)) {
                    subjectReferenceImages.push(imagePath);
                }
            } else {
                for (const subject of matchedSubjects) {
                    const firstImage = (subject.absoluteImagePaths || [])[0];
                    if (!firstImage) continue;
                    subjectReferenceImages.push(firstImage);
                    if (subjectReferenceImages.length >= 5) break;
                }
            }
        }
        const projectKeyframeImages = (videoProject?.keyframes || [])
            .map((entry) => entry.absolutePath)
            .filter(Boolean)
            .slice(0, 5);
        const projectReferenceImages = (videoProject?.references || [])
            .filter((entry) => entry.kind === 'reference-image')
            .map((entry) => entry.absolutePath)
            .filter(Boolean)
            .slice(0, 5);
        const projectPriorityImages = projectKeyframeImages.length > 0 ? projectKeyframeImages : projectReferenceImages;
        const shouldPreferProjectImages = projectPriorityImages.length > 0 && directReferenceImages.length === 0;
        const referenceImages = shouldPreferProjectImages
            ? dedupeList(projectPriorityImages, 5)
            : dedupeList([...directReferenceImages, ...subjectReferenceImages], 5);
        const explicitDrivingAudio = String(readFlag(parsed.flags, 'driving-audio', 'audio-url') || payload.drivingAudio || '').trim();
        const firstClip = String(readFlag(parsed.flags, 'first-clip', 'video-url') || payload.firstClip || '').trim();
        const effectiveGenerationMode = inferVideoGenerationMode(generationMode, referenceImages);
        const subjectDrivingAudio = !explicitDrivingAudio && effectiveGenerationMode === 'reference-guided'
            ? String(matchedSubjects.find((subject) => subject.absoluteVoicePath)?.absoluteVoicePath || '').trim()
            : '';
        const drivingAudio = explicitDrivingAudio || subjectDrivingAudio;
        const result = await generateVideosToMediaLibrary({
            prompt,
            projectId: readFlag(parsed.flags, 'project-id') || (payload.projectId as string | undefined),
            title: readFlag(parsed.flags, 'title') || (payload.title as string | undefined),
            generationMode: effectiveGenerationMode,
            referenceImages,
            drivingAudio,
            firstClip,
            count: parseNumber(readFlag(parsed.flags, 'count') || payload.count),
            model: readFlag(parsed.flags, 'model') || (payload.model as string | undefined),
            aspectRatio: readFlag(parsed.flags, 'ratio', 'aspect-ratio') || (payload.aspectRatio as string | undefined),
            resolution: (readFlag(parsed.flags, 'resolution', 'size') || payload.resolution) as '720p' | '1080p' | undefined,
            durationSeconds: parseNumber(readFlag(parsed.flags, 'duration', 'seconds') || payload.durationSeconds || payload.seconds),
            generateAudio: parseBoolean(readFlag(parsed.flags, 'audio', 'generate-audio') || payload.generateAudio),
        });
        let updatedVideoProject = videoProject;
        if (videoProjectId) {
            for (const [index, asset] of result.assets.entries()) {
                updatedVideoProject = await addGeneratedAssetToVideoProjectPack({
                    projectId: videoProjectId,
                    asset,
                    kind: result.assets.length > 1 ? 'clip' : 'output',
                    label: result.assets.length > 1 ? `clip-${index + 1}` : 'final-output',
                    role: result.assets.length > 1 ? 'generated-clip' : 'final-video',
                });
            }
        }
        return {
            provider: result.provider,
            model: result.model,
            generationMode: effectiveGenerationMode,
            referenceImageCount: referenceImages.length,
            subjects: matchedSubjects.map((subject) => ({
                id: subject.id,
                name: subject.name,
                imageCount: Array.isArray(subject.absoluteImagePaths) ? subject.absoluteImagePaths.length : 0,
                voiceReference: Boolean(subject.absoluteVoicePath),
            })),
            voiceReferenceUsed: Boolean(subjectDrivingAudio),
            referenceSource: shouldPreferProjectImages
                ? (projectKeyframeImages.length > 0 ? 'video-project-keyframes' : 'video-project-references')
                : 'subject-or-direct-references',
            aspectRatio: result.aspectRatio,
            resolution: result.resolution,
            durationSeconds: result.durationSeconds,
            count: result.assets.length,
            assets: result.assets.map((asset) => ({
                id: asset.id,
                projectId: asset.projectId,
                relativePath: asset.relativePath,
                absolutePath: asset.relativePath ? getAbsoluteMediaPath(asset.relativePath) : null,
                previewUrl: asset.relativePath ? toAppAssetUrl(getAbsoluteMediaPath(asset.relativePath)) : null,
                prompt: asset.prompt,
                createdAt: asset.createdAt,
            })),
            videoProject: updatedVideoProject ? {
                id: updatedVideoProject.id,
                title: updatedVideoProject.title,
                projectDir: updatedVideoProject.projectDir,
                manifestPath: path.join(updatedVideoProject.projectDir, 'manifest.json'),
                scriptPath: path.join(updatedVideoProject.projectDir, updatedVideoProject.scriptPath),
                briefPath: path.join(updatedVideoProject.projectDir, updatedVideoProject.briefPath),
            } : null,
        } satisfies GeneratedVideoCliResult;
    }

    private async handleMcp(parsed: ParsedCommand, payload: Record<string, unknown>) {
        const action = parsed.action;
        if (action === 'list') {
            const enabledOnly = parseBoolean(readFlag(parsed.flags, 'enabled-only') || payload.enabledOnly);
            const servers = getMcpServers();
            const filtered = enabledOnly ? servers.filter((server) => server.enabled) : servers;
            return { count: filtered.length, servers: filtered };
        }

        if (action === 'import-local') {
            return importLocalMcpServers();
        }

        if (action === 'test') {
            const id = requireString(readFlag(parsed.flags, 'id', 'server-id') || payload.id, 'id');
            const server = getMcpServers().find((item) => item.id === id);
            if (!server) throw new Error(`MCP server not found: ${id}`);
            const result = await testMcpServerConnection(server);
            return { id, ...result };
        }

        if (action === 'tools') {
            const id = requireString(readFlag(parsed.flags, 'id', 'server-id') || payload.id, 'id');
            const server = getMcpServers().find((item) => item.id === id);
            if (!server) throw new Error(`MCP server not found: ${id}`);
            const tools = await listMcpTools(server);
            return {
                id,
                count: tools.length,
                tools,
            };
        }

        if (action === 'call') {
            const id = requireString(readFlag(parsed.flags, 'id', 'server-id') || payload.id, 'id');
            const toolName = requireString(readFlag(parsed.flags, 'tool', 'name') || payload.tool, 'tool');
            const server = getMcpServers().find((item) => item.id === id);
            if (!server) throw new Error(`MCP server not found: ${id}`);

            let args: Record<string, unknown> = {};
            const rawArgs = readFlag(parsed.flags, 'args') || payload.args;
            if (rawArgs !== undefined && rawArgs !== null) {
                if (typeof rawArgs === 'string') {
                    try {
                        args = JSON.parse(rawArgs) as Record<string, unknown>;
                    } catch {
                        throw new Error('args must be valid JSON object');
                    }
                } else if (typeof rawArgs === 'object') {
                    args = rawArgs as Record<string, unknown>;
                }
            }

            const result = await callMcpTool(server, toolName, args);
            return {
                id,
                tool: toolName,
                args,
                result,
            };
        }

        if (action === 'oauth-status') {
            const id = requireString(readFlag(parsed.flags, 'id', 'server-id') || payload.id, 'id');
            const result = await getMcpOAuthStatus(id);
            return { id, ...result };
        }

        if (action === 'enable' || action === 'disable') {
            const id = requireString(readFlag(parsed.flags, 'id', 'server-id') || payload.id, 'id');
            const enabled = action === 'enable';
            const servers = getMcpServers().map((server) => (
                server.id === id ? { ...server, enabled } : server
            ));
            const saved = saveMcpServers(servers);
            return { success: true, id, enabled, count: saved.length };
        }

        throw new Error(`Unsupported mcp action: ${action}`);
    }

    private async handleSettings(parsed: ParsedCommand, payload: Record<string, unknown>) {
        if (parsed.action === 'get') {
            const settings = (getSettings() || {}) as Record<string, unknown>;
            const key = readFlag(parsed.flags, 'key') || (payload.key as string | undefined);
            if (key) {
                return { key, value: settings[key] };
            }
            return settings;
        }

        if (parsed.action === 'set') {
            const key = requireString(readFlag(parsed.flags, 'key') || payload.key, 'key');
            const value = readFlag(parsed.flags, 'value') || payload.value;
            const current = (getSettings() || {}) as Record<string, unknown>;
            const next: Record<string, unknown> = { ...current };
            next[key] = value;
            saveSettings({
                api_endpoint: String(next.api_endpoint || ''),
                api_key: String(next.api_key || ''),
                model_name: String(next.model_name || ''),
                role_mapping: typeof next.role_mapping === 'string' ? next.role_mapping : JSON.stringify(next.role_mapping || {}),
                workspace_dir: String(next.workspace_dir || ''),
                active_space_id: String(next.active_space_id || ''),
                transcription_model: String(next.transcription_model || ''),
                transcription_endpoint: String(next.transcription_endpoint || ''),
                transcription_key: String(next.transcription_key || ''),
                embedding_endpoint: String(next.embedding_endpoint || ''),
                embedding_key: String(next.embedding_key || ''),
                embedding_model: String(next.embedding_model || ''),
                ai_sources_json: typeof next.ai_sources_json === 'string'
                    ? next.ai_sources_json
                    : JSON.stringify(next.ai_sources_json || []),
                default_ai_source_id: String(next.default_ai_source_id || ''),
                image_provider: String(next.image_provider || ''),
                image_endpoint: String(next.image_endpoint || ''),
                image_api_key: String(next.image_api_key || ''),
                image_model: String(next.image_model || ''),
                image_provider_template: String(next.image_provider_template || ''),
                image_aspect_ratio: String(next.image_aspect_ratio || ''),
                image_size: String(next.image_size || ''),
                image_quality: String(next.image_quality || ''),
                mcp_servers_json: typeof next.mcp_servers_json === 'string'
                    ? next.mcp_servers_json
                    : JSON.stringify(next.mcp_servers_json || []),
                redclaw_compact_target_tokens: Number(next.redclaw_compact_target_tokens || 256000),
            });
            return { success: true, key, value };
        }

        throw new Error(`Unsupported settings action: ${parsed.action}`);
    }

    private async handleSkills(parsed: ParsedCommand, payload: Record<string, unknown>) {
        const manager = new SkillManager();
        await manager.discoverSkills(getWorkspacePaths().base);

        if (parsed.action === 'list') {
            return manager.getAllSkills().map((skill) => ({
                name: skill.name,
                description: skill.description,
                disabled: Boolean(skill.disabled),
                location: skill.location,
            }));
        }
        if (parsed.action === 'enable') {
            const name = requireString(readFlag(parsed.flags, 'name') || payload.name, 'name');
            const changed = await manager.enableSkill(name);
            return { success: true, changed };
        }
        if (parsed.action === 'disable') {
            const name = requireString(readFlag(parsed.flags, 'name') || payload.name, 'name');
            const changed = await manager.disableSkill(name);
            return { success: true, changed };
        }
        throw new Error(`Unsupported skills action: ${parsed.action}`);
    }

    private async handleArchives(parsed: ParsedCommand, payload: Record<string, unknown>) {
        const action = parsed.action;
        if (action === 'profiles' || action === 'list-profiles') {
            return listArchiveProfiles();
        }
        if (action === 'create-profile') {
            const profile = (payload.profile || payload) as Record<string, unknown>;
            return createArchiveProfile({
                id: requireString(profile.id, 'profile.id'),
                name: requireString(profile.name, 'profile.name'),
                platform: String(profile.platform || ''),
                goal: String(profile.goal || ''),
                domain: String(profile.domain || ''),
                audience: String(profile.audience || ''),
                tone_tags: Array.isArray(profile.tone_tags) ? profile.tone_tags as string[] : parseList(profile.tone_tags),
            });
        }
        if (action === 'update-profile') {
            const profile = (payload.profile || payload) as Record<string, unknown>;
            return updateArchiveProfile({
                id: requireString(profile.id, 'profile.id'),
                name: requireString(profile.name, 'profile.name'),
                platform: String(profile.platform || ''),
                goal: String(profile.goal || ''),
                domain: String(profile.domain || ''),
                audience: String(profile.audience || ''),
                tone_tags: Array.isArray(profile.tone_tags) ? profile.tone_tags as string[] : parseList(profile.tone_tags),
            });
        }
        if (action === 'delete-profile') {
            const id = requireString(readFlag(parsed.flags, 'id') || payload.id, 'id');
            deleteArchiveProfile(id);
            return { success: true, id };
        }
        if (action === 'samples') {
            const profileId = requireString(readFlag(parsed.flags, 'profile-id') || payload.profileId, 'profileId');
            return listArchiveSamples(profileId);
        }
        if (action === 'create-sample') {
            const sample = (payload.sample || payload) as Record<string, unknown>;
            return createArchiveSample({
                id: requireString(sample.id, 'sample.id'),
                profile_id: requireString(sample.profile_id || sample.profileId, 'sample.profile_id'),
                title: String(sample.title || ''),
                content: String(sample.content || ''),
                excerpt: String(sample.excerpt || ''),
                tags: Array.isArray(sample.tags) ? sample.tags as string[] : parseList(sample.tags),
                images: Array.isArray(sample.images) ? sample.images as string[] : parseList(sample.images),
                platform: String(sample.platform || ''),
                source_url: String(sample.source_url || sample.sourceUrl || ''),
                sample_date: String(sample.sample_date || sample.sampleDate || ''),
                is_featured: Number(sample.is_featured || sample.isFeatured || 0) ? 1 : 0,
            });
        }
        if (action === 'update-sample') {
            const sample = (payload.sample || payload) as Record<string, unknown>;
            return updateArchiveSample({
                id: requireString(sample.id, 'sample.id'),
                profile_id: requireString(sample.profile_id || sample.profileId, 'sample.profile_id'),
                title: String(sample.title || ''),
                content: String(sample.content || ''),
                excerpt: String(sample.excerpt || ''),
                tags: Array.isArray(sample.tags) ? sample.tags as string[] : parseList(sample.tags),
                images: Array.isArray(sample.images) ? sample.images as string[] : parseList(sample.images),
                platform: String(sample.platform || ''),
                source_url: String(sample.source_url || sample.sourceUrl || ''),
                sample_date: String(sample.sample_date || sample.sampleDate || ''),
                is_featured: Number(sample.is_featured || sample.isFeatured || 0) ? 1 : 0,
            });
        }
        if (action === 'delete-sample') {
            const id = requireString(readFlag(parsed.flags, 'id') || payload.id, 'id');
            deleteArchiveSample(id);
            return { success: true, id };
        }
        throw new Error(`Unsupported archives action: ${action}`);
    }

    private async handleWander(parsed: ParsedCommand, payload: Record<string, unknown>) {
        const action = parsed.action;
        if (action === 'list') {
            return listWanderHistory();
        }
        if (action === 'get') {
            const id = requireString(readFlag(parsed.flags, 'id') || payload.id, 'id');
            return getWanderHistory(id);
        }
        if (action === 'save') {
            const id = requireString(readFlag(parsed.flags, 'id') || payload.id, 'id');
            const items = Array.isArray(payload.items) ? payload.items : [];
            const result = payload.result;
            return saveWanderHistory(id, items as any[], result as any);
        }
        if (action === 'random') {
            const count = parseNumber(readFlag(parsed.flags, 'count') || payload.count) || 3;
            return getRandomWanderItems(count);
        }
        if (action === 'run' || action === 'brainstorm') {
            const count = parseNumber(readFlag(parsed.flags, 'count') || payload.count) || 3;
            const multiChoiceInput = readFlag(parsed.flags, 'multi-choice', 'deep-think')
                ?? payload.multiChoice
                ?? payload.deepThink;
            const persistHistoryInput = readFlag(parsed.flags, 'save', 'persist-history')
                ?? payload.persistHistory;
            const multiChoice = parseBoolean(multiChoiceInput);
            const persistHistory = parseBoolean(persistHistoryInput);
            const requestId = String(readFlag(parsed.flags, 'request-id') || payload.requestId || '').trim() || undefined;
            const items = Array.isArray(payload.items) ? payload.items as any[] : undefined;
            const result = await runWanderBrainstorm({
                items: items as any,
                count,
                multiChoice,
                deepThink: multiChoice,
                persistHistory,
                requestId,
            });
            return {
                requestId: result.requestId,
                historyId: result.historyId,
                items: result.items,
                result: result.result,
            };
        }
        if (action === 'delete') {
            const id = requireString(readFlag(parsed.flags, 'id') || payload.id, 'id');
            deleteWanderHistory(id);
            return { success: true, id };
        }
        throw new Error(`Unsupported wander action: ${action}`);
    }
}
