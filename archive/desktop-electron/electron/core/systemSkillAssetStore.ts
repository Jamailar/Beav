import { app } from 'electron';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import matter from 'gray-matter';

export type InternalSkillBundle = {
    name: string;
    rootDir: string;
    skillBody: string;
    rawSkillFile: string;
    references: Record<string, string>;
    scripts: Record<string, string>;
    agents: Record<string, string>;
};

const resolveInternalSkillRoot = (skillName: string): string => {
    const candidates = [
        path.join(process.cwd(), 'archive', 'desktop-electron', 'electron', 'system-skills', skillName),
        path.join(app.getAppPath(), 'electron', 'system-skills', skillName),
        path.join(__dirname, '..', 'system-skills', skillName),
    ];

    for (const candidate of candidates) {
        if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
            return candidate;
        }
    }

    throw new Error(`Internal skill bundle not found: ${skillName}`);
};

const readUtf8IfExists = async (filePath: string): Promise<string> => {
    try {
        return await fsp.readFile(filePath, 'utf-8');
    } catch {
        return '';
    }
};

const listFilesRecursively = async (dirPath: string): Promise<string[]> => {
    const output: string[] = [];
    const entries = await fsp.readdir(dirPath, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
        const fullPath = path.join(dirPath, entry.name);
        if (entry.isDirectory()) {
            output.push(...await listFilesRecursively(fullPath));
            continue;
        }
        if (entry.isFile()) {
            output.push(fullPath);
        }
    }
    return output.sort((a, b) => a.localeCompare(b, 'zh-CN'));
};

export const loadInternalSkillBundle = async (skillName: string): Promise<InternalSkillBundle> => {
    const rootDir = resolveInternalSkillRoot(skillName);
    const skillFilePath = path.join(rootDir, 'SKILL.md');
    const rawSkillFile = await readUtf8IfExists(skillFilePath);
    if (!rawSkillFile.trim()) {
        throw new Error(`Internal skill missing SKILL.md: ${skillName}`);
    }

    const parsed = matter(rawSkillFile);
    const referencesDir = path.join(rootDir, 'references');
    const scriptsDir = path.join(rootDir, 'scripts');
    const agentsDir = path.join(rootDir, 'agents');

    const [referenceFiles, scriptFiles, agentFiles] = await Promise.all([
        listFilesRecursively(referencesDir),
        listFilesRecursively(scriptsDir),
        listFilesRecursively(agentsDir),
    ]);

    const referencesEntries = await Promise.all(
        referenceFiles.map(async (filePath) => [path.relative(referencesDir, filePath).replace(/\\/g, '/'), await readUtf8IfExists(filePath)] as const),
    );
    const scriptEntries = await Promise.all(
        scriptFiles.map(async (filePath) => [path.relative(scriptsDir, filePath).replace(/\\/g, '/'), await readUtf8IfExists(filePath)] as const),
    );
    const agentEntries = await Promise.all(
        agentFiles.map(async (filePath) => [path.relative(agentsDir, filePath).replace(/\\/g, '/'), await readUtf8IfExists(filePath)] as const),
    );

    return {
        name: typeof parsed.data?.name === 'string' && parsed.data.name.trim() ? parsed.data.name.trim() : skillName,
        rootDir,
        skillBody: String(parsed.content || '').trim(),
        rawSkillFile,
        references: Object.fromEntries(referencesEntries.filter(([, content]) => String(content || '').trim())),
        scripts: Object.fromEntries(scriptEntries.filter(([, content]) => String(content || '').trim())),
        agents: Object.fromEntries(agentEntries.filter(([, content]) => String(content || '').trim())),
    };
};
