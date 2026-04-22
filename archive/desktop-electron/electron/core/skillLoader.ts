import * as fs from 'fs/promises';
import * as path from 'path';
import os from 'os';
import matter from 'gray-matter';
import { glob } from 'glob';

export type SkillSourceScope = 'builtin' | 'user' | 'workspace' | 'claude-home';

export interface SkillDefinition {
    name: string;
    description: string;
    location: string;
    body: string;
    baseDir: string;
    aliases: string[];
    whenToUse?: string;
    allowedTools?: string[];
    argumentHint?: string;
    userInvocable?: boolean;
    executionContext?: 'inline' | 'fork';
    agent?: string;
    effort?: string;
    paths?: string[];
    sourceScope: SkillSourceScope;
    isBuiltin?: boolean;
    disabled?: boolean;
}

const DEFAULT_DESCRIPTION = '按需加载的专用技能指令';
const ROOT_MARKDOWN_PATTERN = '*.md';
const SKILL_MARKDOWN_PATTERN = '**/SKILL.md';
const IGNORE_PATTERNS = [
    '**/node_modules/**',
    '**/.git/**',
    '**/dist/**',
    '**/dist-electron/**',
    '**/.next/**',
    '**/.turbo/**',
];

function normalizeSkillKey(value: string): string {
    return String(value || '')
        .trim()
        .toLowerCase()
        .replace(/\.md$/i, '')
        .replace(/\\/g, '/')
        .replace(/[_\s]+/g, '-');
}

function inferSkillName(filePath: string): string {
    const base = path.basename(filePath);
    if (/^skill\.md$/i.test(base)) {
        return path.basename(path.dirname(filePath));
    }
    return base.replace(/\.md$/i, '');
}

function inferSkillDescription(body: string): string {
    const lines = String(body || '')
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .filter((line) => !line.startsWith('#'));
    const first = lines[0] || '';
    const compact = first.replace(/\s+/g, ' ').trim();
    return compact ? compact.slice(0, 120) : DEFAULT_DESCRIPTION;
}

function parseAliases(data: Record<string, unknown>): string[] {
    const value = data.aliases;
    if (Array.isArray(value)) {
        return value.map((item) => String(item || '').trim()).filter(Boolean);
    }
    if (typeof value === 'string') {
        return value
            .split(',')
            .map((item) => item.trim())
            .filter(Boolean);
    }
    return [];
}

function parseStringList(value: unknown): string[] {
    if (Array.isArray(value)) {
        return value.map((item) => String(item || '').trim()).filter(Boolean);
    }
    if (typeof value === 'string') {
        return value
            .split(',')
            .map((item) => item.trim())
            .filter(Boolean);
    }
    return [];
}

async function pathExists(targetPath: string): Promise<boolean> {
    try {
        await fs.access(targetPath);
        return true;
    } catch {
        return false;
    }
}

async function listMarkdownSkillFiles(dir: string): Promise<string[]> {
    const absolutePath = path.resolve(dir);
    const [rootMarkdown, nestedSkillMarkdown] = await Promise.all([
        glob(ROOT_MARKDOWN_PATTERN, {
            cwd: absolutePath,
            absolute: true,
            nodir: true,
            ignore: IGNORE_PATTERNS,
            dot: true,
        }),
        glob(SKILL_MARKDOWN_PATTERN, {
            cwd: absolutePath,
            absolute: true,
            nodir: true,
            ignore: IGNORE_PATTERNS,
            dot: true,
        }),
    ]);

    return Array.from(new Set([...rootMarkdown, ...nestedSkillMarkdown]))
        .map((item) => path.resolve(item))
        .sort((a, b) => a.localeCompare(b));
}

export async function loadSkillFromFile(
    filePath: string,
    sourceScope: SkillSourceScope = 'user',
): Promise<SkillDefinition | null> {
    try {
        const absolutePath = path.resolve(filePath);
        const content = await fs.readFile(absolutePath, 'utf-8');
        const parsed = matter(content);
        const data = (parsed.data || {}) as Record<string, unknown>;
        const name = typeof data.name === 'string' && data.name.trim()
            ? data.name.trim()
            : inferSkillName(absolutePath);
        const body = String(parsed.content || '').trim();
        const description = typeof data.description === 'string' && data.description.trim()
            ? data.description.trim()
            : inferSkillDescription(body);

        if (!name) {
            console.warn(`Invalid skill file (missing name): ${absolutePath}`);
            return null;
        }

        return {
            name,
            description: description || DEFAULT_DESCRIPTION,
            location: absolutePath,
            body,
            baseDir: path.dirname(absolutePath),
            aliases: parseAliases(data),
            whenToUse: typeof data.when_to_use === 'string'
                ? data.when_to_use.trim()
                : (typeof data['when-to-use'] === 'string' ? data['when-to-use'].trim() : undefined),
            allowedTools: parseStringList(data['allowed-tools'] ?? data.allowed_tools),
            argumentHint: typeof data['argument-hint'] === 'string'
                ? data['argument-hint'].trim()
                : (typeof data.argument_hint === 'string' ? data.argument_hint.trim() : undefined),
            userInvocable: data['user-invocable'] === undefined
                ? true
                : Boolean(data['user-invocable']),
            executionContext: data.context === 'fork' ? 'fork' : 'inline',
            agent: typeof data.agent === 'string' && data.agent.trim() ? data.agent.trim() : undefined,
            effort: typeof data.effort === 'string' && data.effort.trim() ? data.effort.trim() : undefined,
            paths: parseStringList(data.paths),
            sourceScope,
        };
    } catch (error) {
        console.error(`Error loading skill from ${filePath}:`, error);
        return null;
    }
}

export async function loadSkillsFromDir(
    dir: string,
    sourceScope: SkillSourceScope = 'user',
): Promise<SkillDefinition[]> {
    const skills: SkillDefinition[] = [];
    const absolutePath = path.resolve(dir);
    const stats = await fs.stat(absolutePath).catch(() => null);
    if (!stats?.isDirectory()) {
        return skills;
    }

    const files = await listMarkdownSkillFiles(absolutePath);
    for (const filePath of files) {
        const skill = await loadSkillFromFile(filePath, sourceScope);
        if (skill) {
            skills.push(skill);
        }
    }
    return skills;
}

export function getUserSkillsDir(): string {
    return path.join(os.homedir(), '.redconvert', 'skills');
}

export async function getClaudeHomeSkillsDirs(): Promise<string[]> {
    const homeDir = os.homedir();
    const candidates = [
        path.join(homeDir, '.claude', 'skills'),
    ];
    const dirs: string[] = [];
    for (const dir of candidates) {
        if (await pathExists(dir)) {
            dirs.push(path.resolve(dir));
        }
    }
    return dirs;
}

export async function getProjectSkillsDirs(projectRoot: string): Promise<Array<{ dir: string; scope: SkillSourceScope }>> {
    const dirs = new Map<string, SkillSourceScope>();
    const root = path.resolve(projectRoot);

    const projectLocalCandidates = [
        path.join(root, 'skills'),
    ];

    for (const dir of projectLocalCandidates) {
        if (await pathExists(dir)) {
            dirs.set(path.resolve(dir), 'workspace');
        }
    }

    return Array.from(dirs.entries()).map(([dir, scope]) => ({ dir, scope }));
}

export async function ensureDir(dir: string): Promise<void> {
    await fs.mkdir(dir, { recursive: true });
}

export function skillNameToKey(value: string): string {
    return normalizeSkillKey(value);
}
