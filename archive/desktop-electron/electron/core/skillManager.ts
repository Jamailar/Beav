import * as fs from 'fs/promises';
import * as path from 'path';
import os from 'os';
import {
    type SkillDefinition,
    type SkillSourceScope,
    loadSkillsFromDir,
    getUserSkillsDir,
    getClaudeHomeSkillsDirs,
    getProjectSkillsDirs,
    skillNameToKey,
} from './skillLoader';

export type { SkillDefinition, SkillSourceScope } from './skillLoader';

const SKILL_FILE_SAMPLE_LIMIT = 10;
const SKILL_FILE_IGNORES = new Set(['skill.md']);
const SKILL_DISCOVERY_CACHE_TTL_MS = 15_000;

const skillDiscoveryCache = new Map<string, {
    expiresAt: number;
    skills: SkillDefinition[];
}>();

function cloneSkillDefinition(skill: SkillDefinition): SkillDefinition {
    return {
        ...skill,
        aliases: Array.isArray(skill.aliases) ? [...skill.aliases] : [],
        allowedTools: Array.isArray(skill.allowedTools) ? [...skill.allowedTools] : undefined,
        paths: Array.isArray(skill.paths) ? [...skill.paths] : undefined,
    };
}

export class SkillManager {
    private skills: SkillDefinition[] = [];
    private activeSkillNames: Set<string> = new Set();
    private activeSkillContents: Map<string, string> = new Map();
    private disabledSkillNames: Set<string> = new Set();
    private settingsPath: string;

    constructor() {
        const homeDir = os.homedir();
        this.settingsPath = path.join(homeDir, '.redconvert', 'skill-settings.json');
    }

    async discoverSkills(projectRoot?: string): Promise<void> {
        const cacheKey = path.resolve(projectRoot || '__global__');
        const cached = skillDiscoveryCache.get(cacheKey);
        if (cached && cached.expiresAt > Date.now()) {
            this.skills = cached.skills.map(cloneSkillDefinition);
            await this.loadDisabledState();
            for (const skill of this.skills) {
                skill.disabled = this.disabledSkillNames.has(skillNameToKey(skill.name));
            }
            return;
        }

        this.skills = [];

        const builtinSkills = await this.discoverBuiltinSkills();
        this.addSkillsWithPrecedence(builtinSkills.map((skill) => ({
            ...skill,
            sourceScope: 'builtin' as SkillSourceScope,
            isBuiltin: true,
        })));

        const userSkills = await loadSkillsFromDir(getUserSkillsDir(), 'user');
        this.addSkillsWithPrecedence(userSkills);

        for (const globalDir of await getClaudeHomeSkillsDirs()) {
            this.addSkillsWithPrecedence(await loadSkillsFromDir(globalDir, 'claude-home'));
        }

        if (projectRoot) {
            const projectSkillDirs = await getProjectSkillsDirs(projectRoot);
            for (const entry of projectSkillDirs) {
                this.addSkillsWithPrecedence(await loadSkillsFromDir(entry.dir, entry.scope));
            }
        }

        await this.loadDisabledState();
        for (const skill of this.skills) {
            skill.disabled = this.disabledSkillNames.has(skillNameToKey(skill.name));
        }

        skillDiscoveryCache.set(cacheKey, {
            expiresAt: Date.now() + SKILL_DISCOVERY_CACHE_TTL_MS,
            skills: this.skills.map(cloneSkillDefinition),
        });
    }

    private async discoverBuiltinSkills(): Promise<SkillDefinition[]> {
        const cwdBuiltin = path.join(process.cwd(), 'archive', 'desktop-electron', 'electron', 'builtin-skills');
        const cwdSystem = path.join(process.cwd(), 'archive', 'desktop-electron', 'electron', 'system-skills');
        const runtimeBuiltin = path.join(__dirname, 'builtin-skills');
        const runtimeSystem = path.join(__dirname, '..', 'system-skills');
        const packagedSystem = path.join(__dirname, '..', '..', 'electron', 'system-skills');
        const candidates = [cwdBuiltin, cwdSystem, runtimeBuiltin, runtimeSystem, packagedSystem];
        const loaded: SkillDefinition[] = [];
        const seenDirs = new Set<string>();

        for (const candidate of candidates) {
            const resolved = path.resolve(candidate);
            if (seenDirs.has(resolved)) continue;
            seenDirs.add(resolved);
            const stat = await fs.stat(resolved).catch(() => null);
            if (!stat?.isDirectory()) continue;
            loaded.push(...await loadSkillsFromDir(resolved, 'builtin'));
        }

        return loaded;
    }

    private addSkillsWithPrecedence(newSkills: SkillDefinition[]): void {
        const skillMap = new Map<string, SkillDefinition>(
            this.skills.map((skill) => [skillNameToKey(skill.name), skill]),
        );

        for (const newSkill of newSkills) {
            const key = skillNameToKey(newSkill.name);
            const existingSkill = skillMap.get(key);
            if (existingSkill && existingSkill.location !== newSkill.location) {
                console.log(
                    `Skill "${newSkill.name}" from "${newSkill.location}" overrides "${existingSkill.location}".`,
                );
            }
            skillMap.set(key, newSkill);
        }

        this.skills = Array.from(skillMap.values()).sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
    }

    getSkills(): SkillDefinition[] {
        return this.skills.filter((skill) => !skill.disabled);
    }

    getAllSkills(): SkillDefinition[] {
        return this.skills;
    }

    getSkill(name: string): SkillDefinition | null {
        const lookup = skillNameToKey(name);
        for (const skill of this.skills) {
            const candidates = [skill.name, ...(skill.aliases || [])].map(skillNameToKey);
            if (candidates.includes(lookup)) {
                return skill;
            }
        }
        return null;
    }

    private async sampleSkillFiles(baseDir: string): Promise<string[]> {
        const output: string[] = [];
        const queue: string[] = [path.resolve(baseDir)];

        while (queue.length > 0 && output.length < SKILL_FILE_SAMPLE_LIMIT) {
            const current = queue.shift();
            if (!current) break;

            const entries = await fs.readdir(current, { withFileTypes: true }).catch(() => []);
            for (const entry of entries) {
                if (output.length >= SKILL_FILE_SAMPLE_LIMIT) break;
                const entryPath = path.join(current, entry.name);
                if (entry.isDirectory()) {
                    if (entry.name === '.git' || entry.name === 'node_modules' || entry.name === 'dist') continue;
                    queue.push(entryPath);
                    continue;
                }
                if (!entry.isFile()) continue;
                if (SKILL_FILE_IGNORES.has(entry.name.toLowerCase())) continue;
                output.push(path.resolve(entryPath));
            }
        }

        return output;
    }

    private async renderActivatedSkill(skill: SkillDefinition): Promise<string> {
        const files = await this.sampleSkillFiles(skill.baseDir);
        const fileXml = files.length
            ? files.map((file) => `<file>${file}</file>`).join('\n')
            : '';
        const metadataLines = [
            `<name>${skill.name}</name>`,
            `<description>${skill.description}</description>`,
            skill.whenToUse ? `<when_to_use>${skill.whenToUse}</when_to_use>` : '',
            skill.aliases?.length ? `<aliases>${skill.aliases.join(', ')}</aliases>` : '',
            skill.allowedTools?.length ? `<allowed_tools>${skill.allowedTools.join(', ')}</allowed_tools>` : '',
            skill.argumentHint ? `<argument_hint>${skill.argumentHint}</argument_hint>` : '',
            skill.executionContext ? `<context>${skill.executionContext}</context>` : '',
            skill.agent ? `<agent>${skill.agent}</agent>` : '',
            skill.effort ? `<effort>${skill.effort}</effort>` : '',
            skill.paths?.length ? `<paths>${skill.paths.join(', ')}</paths>` : '',
            `<source_scope>${skill.sourceScope}</source_scope>`,
            `<base_dir>${skill.baseDir}</base_dir>`,
        ].filter(Boolean).join('\n');

        return [
            `<activated_skill name="${skill.name}">`,
            '<metadata>',
            metadataLines,
            '</metadata>',
            '<instructions>',
            skill.body.trim(),
            '',
            `Base directory for this skill: ${skill.baseDir}`,
            'Relative paths mentioned by this skill are resolved from the base directory above.',
            '</instructions>',
            fileXml ? '<skill_files>' : '',
            fileXml,
            fileXml ? '</skill_files>' : '',
            '</activated_skill>',
        ].filter(Boolean).join('\n');
    }

    async activateSkill(name: string): Promise<string | null> {
        const skill = this.getSkill(name);
        if (!skill || skill.disabled) {
            return null;
        }

        const key = skillNameToKey(skill.name);
        const cached = this.activeSkillContents.get(key);
        if (cached) {
            this.activeSkillNames.add(key);
            return cached;
        }

        this.activeSkillNames.add(key);
        const content = await this.renderActivatedSkill(skill);
        this.activeSkillContents.set(key, content);
        return content;
    }

    isSkillActive(name: string): boolean {
        return this.activeSkillNames.has(skillNameToKey(name));
    }

    getActiveSkills(): SkillDefinition[] {
        return this.skills.filter((skill) => this.activeSkillNames.has(skillNameToKey(skill.name)));
    }

    getActiveSkillContents(): string[] {
        return this.getActiveSkills()
            .map((skill) => this.activeSkillContents.get(skillNameToKey(skill.name)) || '')
            .filter(Boolean);
    }

    resetActiveSkills(): void {
        this.activeSkillNames.clear();
        this.activeSkillContents.clear();
    }

    findMentionedSkills(input: string): SkillDefinition[] {
        const text = String(input || '').trim();
        if (!text) return [];

        const lowered = text.toLowerCase();
        const matched: SkillDefinition[] = [];
        for (const skill of this.getSkills()) {
            const names = [skill.name, ...(skill.aliases || [])].filter(Boolean);
            const hit = names.some((name) => {
                const normalized = String(name).trim();
                if (!normalized) return false;
                const lowerName = normalized.toLowerCase();
                return lowered.includes(`$${lowerName}`) || lowered.includes(lowerName);
            });
            if (hit) {
                matched.push(skill);
            }
        }
        return matched;
    }

    async preactivateMentionedSkills(input: string): Promise<Array<{ skill: SkillDefinition; content: string }>> {
        const matches = this.findMentionedSkills(input);
        const output: Array<{ skill: SkillDefinition; content: string }> = [];
        for (const skill of matches) {
            if (this.isSkillActive(skill.name)) continue;
            const content = await this.activateSkill(skill.name);
            if (content) {
                output.push({ skill, content });
            }
        }
        return output;
    }

    async setDisabledSkills(disabledNames: string[]): Promise<void> {
        this.disabledSkillNames = new Set(disabledNames.map(skillNameToKey));
        for (const skill of this.skills) {
            skill.disabled = this.disabledSkillNames.has(skillNameToKey(skill.name));
        }
        await this.saveDisabledState();
    }

    async enableSkill(name: string): Promise<boolean> {
        const skill = this.getSkill(name);
        if (!skill) return false;
        const key = skillNameToKey(skill.name);
        if (!this.disabledSkillNames.has(key)) return false;
        this.disabledSkillNames.delete(key);
        await this.setDisabledSkills(Array.from(this.disabledSkillNames));
        return true;
    }

    async disableSkill(name: string): Promise<boolean> {
        const skill = this.getSkill(name);
        if (!skill) return false;
        const key = skillNameToKey(skill.name);
        if (this.disabledSkillNames.has(key)) return false;
        this.disabledSkillNames.add(key);
        this.activeSkillNames.delete(key);
        this.activeSkillContents.delete(key);
        await this.setDisabledSkills(Array.from(this.disabledSkillNames));
        return true;
    }

    private async loadDisabledState(): Promise<void> {
        try {
            const content = await fs.readFile(this.settingsPath, 'utf-8');
            const settings = JSON.parse(content);
            if (Array.isArray(settings.disabledSkills)) {
                this.disabledSkillNames = new Set(settings.disabledSkills.map((item: string) => skillNameToKey(item)));
            }
        } catch {
            // ignore
        }
    }

    private async saveDisabledState(): Promise<void> {
        try {
            const payload = {
                disabledSkills: Array.from(this.disabledSkillNames),
            };
            await fs.mkdir(path.dirname(this.settingsPath), { recursive: true });
            await fs.writeFile(this.settingsPath, JSON.stringify(payload, null, 2), 'utf-8');
        } catch (error) {
            console.error('Failed to save skill settings:', error);
        }
    }

    getSkillsXml(): string {
        const enabledSkills = this.getSkills();
        if (enabledSkills.length === 0) return '';

        const skillNodes = enabledSkills
            .map((skill) => [
                '  <skill>',
                `    <name>${skill.name}</name>`,
                `    <description>${skill.description}</description>`,
                skill.whenToUse ? `    <when_to_use>${skill.whenToUse}</when_to_use>` : '',
                skill.aliases?.length ? `    <aliases>${skill.aliases.join(', ')}</aliases>` : '',
                skill.allowedTools?.length ? `    <allowed_tools>${skill.allowedTools.join(', ')}</allowed_tools>` : '',
                skill.argumentHint ? `    <argument_hint>${skill.argumentHint}</argument_hint>` : '',
                skill.executionContext ? `    <context>${skill.executionContext}</context>` : '',
                skill.agent ? `    <agent>${skill.agent}</agent>` : '',
                skill.effort ? `    <effort>${skill.effort}</effort>` : '',
                skill.paths?.length ? `    <paths>${skill.paths.join(', ')}</paths>` : '',
                `    <source_scope>${skill.sourceScope}</source_scope>`,
                `    <location>${skill.location}</location>`,
                '  </skill>',
            ].filter(Boolean).join('\n'))
            .join('\n');

        return [
            'Skills provide specialized instructions and workflows for specific tasks.',
            'Keep the full skill body out of context until needed.',
            'When a task clearly matches one of the skills below, use the `skill` tool to load the full instructions before proceeding.',
            '<available_skills>',
            skillNodes,
            '</available_skills>',
        ].join('\n');
    }

    getSkillToolDescription(): string {
        const enabledSkills = this.getSkills();
        if (enabledSkills.length === 0) {
            return 'Load a specialized skill that provides domain-specific instructions and workflows. No skills are currently available.';
        }

        const list = enabledSkills
            .map((skill) => `- ${skill.name}: ${skill.description}`)
            .join('\n');

        return [
            'Load a specialized skill that provides domain-specific instructions and workflows.',
            '',
            'When a task matches one of the skills below, load it first so the conversation receives the full instructions and related file context.',
            'Prefer the `skill` tool over direct guessing when a specialized workflow is likely to help.',
            '',
            'Available skills:',
            list,
        ].join('\n');
    }
}
