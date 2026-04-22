import { z } from 'zod';
import * as path from 'path';
import * as fs from 'fs/promises';
import { spawn } from 'child_process';
import {
    DeclarativeTool,
    ToolKind,
    type ToolResult,
    createSuccessResult,
    createErrorResult,
    ToolErrorType,
} from '../toolRegistry';
import { Instance } from '../instance';
import { getUserSkillsDir } from '../skillLoader';
import { SkillManager } from '../skillManager';
import { ChatService } from '../ChatService';

const SkillParamsSchema = z.object({
    skill: z.string().optional().describe('The skill name to load'),
    name: z.string().optional().describe('Legacy alias for the skill name'),
});

type SkillParams = z.infer<typeof SkillParamsSchema>;

export class SkillTool extends DeclarativeTool<typeof SkillParamsSchema> {
    readonly name = 'skill';
    readonly displayName = 'Load Skill';
    get description(): string {
        return this.skillManager.getSkillToolDescription();
    }
    readonly kind = ToolKind.Other;
    readonly parameterSchema = SkillParamsSchema;
    readonly requiresConfirmation = false;

    constructor(
        private readonly skillManager: SkillManager,
        private readonly onActivated?: (payload: { name: string; description: string }) => void,
    ) {
        super();
    }

    getDescription(params: SkillParams): string {
        const skillName = String(params.skill || params.name || '').trim();
        return skillName ? `load skill: ${skillName}` : 'load skill';
    }

    protected validateValues(params: SkillParams): string | null {
        const skillName = String(params.skill || params.name || '').trim();
        if (!skillName) {
            return 'Either `skill` or `name` is required.';
        }
        return null;
    }

    async execute(params: SkillParams, _signal: AbortSignal): Promise<ToolResult> {
        const requestedSkill = String(params.skill || params.name || '').trim();
        const activated = requestedSkill ? await this.skillManager.activateSkill(requestedSkill) : null;
        if (!activated) {
            const available = this.skillManager.getSkills().map((skill) => skill.name).join(', ');
            return createErrorResult(
                `Skill "${requestedSkill}" not found or disabled. Available skills: ${available || 'none'}.`,
                ToolErrorType.INVALID_PARAMS,
            );
        }

        const skill = this.skillManager.getSkill(requestedSkill);
        this.onActivated?.({
            name: skill?.name || requestedSkill,
            description: skill?.description || `技能 ${requestedSkill} 已激活`,
        });
        return createSuccessResult(activated, `Skill "${skill?.name || requestedSkill}" loaded.`);
    }
}

// ========== Skill Manage Tool ==========

const SkillManageParamsSchema = z.object({
    action: z.enum(['list', 'enable', 'disable']).optional().describe('The action to perform (default: "list")'),
    skillName: z.string().optional().describe('The name of the skill to enable or disable (required for enable/disable)'),
});

type SkillManageParams = z.infer<typeof SkillManageParamsSchema>;

export class SkillManageTool extends DeclarativeTool<typeof SkillManageParamsSchema> {
    readonly name = 'skill_manage';
    readonly displayName = 'Manage Skills';
    readonly description = 'List available skills, or enable/disable specific skills. If no action is provided, lists all skills.';
    readonly kind = ToolKind.Other;
    readonly parameterSchema = SkillManageParamsSchema;
    readonly requiresConfirmation = false;

    private chatService: ChatService;

    constructor(chatService: ChatService) {
        super();
        this.chatService = chatService;
    }

    getDescription(params: SkillManageParams): string {
        const action = params.action || 'list';
        return `${action} skill${params.skillName ? ': ' + params.skillName : ''}`;
    }

    async execute(params: SkillManageParams, signal: AbortSignal): Promise<ToolResult> {
        const skillManager = this.chatService.getSkillManager();
        const action = params.action || 'list';

        if (action === 'list') {
            const skills = skillManager.getAllSkills();
            if (skills.length === 0) {
                return createSuccessResult('No skills discovered.');
            }

            let output = 'Discovered Skills:\n\n';
            for (const skill of skills) {
                const status = skill.disabled ? '[Disabled]' : '[Enabled]';
                const builtin = skill.isBuiltin ? ' [Built-in]' : '';
                output += `- **${skill.name}** ${status}${builtin}\n`;
                output += `  - Description: ${skill.description}\n`;
                output += `  - Location: ${skill.location}\n`;
            }
            return createSuccessResult(output);
        }

        if (!params.skillName) {
            return createErrorResult('skillName is required for enable/disable actions', ToolErrorType.INVALID_PARAMS);
        }

        if (action === 'enable') {
            const success = await skillManager.enableSkill(params.skillName);
            if (success) {
                return createSuccessResult(`Skill "${params.skillName}" enabled.`);
            } else {
                return createSuccessResult(`Skill "${params.skillName}" is already enabled or not found.`);
            }
        }

        if (action === 'disable') {
            const success = await skillManager.disableSkill(params.skillName);
            if (success) {
                return createSuccessResult(`Skill "${params.skillName}" disabled.`);
            } else {
                return createSuccessResult(`Skill "${params.skillName}" is already disabled or not found.`);
            }
        }

        return createErrorResult('Invalid action', ToolErrorType.INVALID_PARAMS);
    }
}

// ========== Skill Install Tool ==========

const SkillInstallParamsSchema = z.object({
    source: z.string().describe('The git repository URL or local path of the skill to install'),
    path: z.string().optional().describe('Sub-path within the repository to install from (only used for git sources)'),
    name: z.string().optional().describe('Rename the skill directory (optional)'),
});

type SkillInstallParams = z.infer<typeof SkillInstallParamsSchema>;

export class SkillInstallTool extends DeclarativeTool<typeof SkillInstallParamsSchema> {
    readonly name = 'skill_install';
    readonly displayName = 'Install Skill';
    readonly description = 'Install a skill from a Git repository or local path into the user skills directory.';
    readonly kind = ToolKind.Other;
    readonly parameterSchema = SkillInstallParamsSchema;
    readonly requiresConfirmation = true;

    private chatService: ChatService;

    constructor(chatService: ChatService) {
        super();
        this.chatService = chatService;
    }

    getDescription(params: SkillInstallParams): string {
        return `Install skill from ${params.source}`;
    }

    async execute(params: SkillInstallParams, signal: AbortSignal): Promise<ToolResult> {
        try {
            const userSkillsDir = getUserSkillsDir();
            await fs.mkdir(userSkillsDir, { recursive: true });

            // Determine target directory name
            let targetName = params.name;
            if (!targetName) {
                if (params.source.endsWith('.git')) {
                    targetName = path.basename(params.source, '.git');
                } else {
                    targetName = path.basename(params.source);
                }
            }
            
            const targetDir = path.join(userSkillsDir, targetName);

            // Check if already exists
            try {
                await fs.access(targetDir);
                return createErrorResult(`Skill directory "${targetName}" already exists in user skills.`, ToolErrorType.EXECUTION_FAILED);
            } catch {
                // Good, doesn't exist
            }

            if (params.source.startsWith('http') || params.source.startsWith('git@')) {
                // Git Clone
                await new Promise<void>((resolve, reject) => {
                    const child = spawn('git', ['clone', params.source, targetDir], {
                        stdio: 'ignore'
                    });
                    child.on('close', (code) => {
                        if (code === 0) resolve();
                        else reject(new Error(`Git clone failed with code ${code}`));
                    });
                    child.on('error', reject);
                });

                // Handle subpath if needed
                if (params.path) {
                    // Move subpath content to root of targetDir, remove others?
                    // For simplicity, we just keep the whole repo for now, but maybe we should validate SKILL.md exists in subpath
                    const skillMdPath = path.join(targetDir, params.path, 'SKILL.md');
                    try {
                        await fs.access(skillMdPath);
                    } catch {
                        // Cleanup
                        await fs.rm(targetDir, { recursive: true, force: true });
                        return createErrorResult(`SKILL.md not found in subpath "${params.path}"`, ToolErrorType.EXECUTION_FAILED);
                    }
                    
                    // Note: Ideally we would move the subpath content up or just point the skill loader to it.
                    // But our skill loader currently scans dirs. 
                    // Let's just leave it as is, the loader should find SKILL.md recursively?
                    // skillLoader.ts: loadSkillsFromDir scans subdirectories "dir/skill-name/SKILL.md".
                    // If we cloned a repo into "userSkillsDir/repoName", loadSkillsFromDir(userSkillsDir) will look at "repoName/SKILL.md".
                    // If the skill is in "repoName/subpath/SKILL.md", it might NOT be found by current loader which only looks 1 level deep?
                    // Let's check skillLoader.ts...
                    // It iterates entries in dir. If entry is dir, it checks entry/SKILL.md.
                    // So it ONLY supports 1 level depth.
                    // So we MUST move the content if subpath is provided.
                    
                    if (params.path) {
                        const tempDir = path.join(userSkillsDir, `${targetName}_temp`);
                        const subPathFull = path.join(targetDir, params.path);
                        await fs.rename(subPathFull, tempDir);
                        await fs.rm(targetDir, { recursive: true, force: true });
                        await fs.rename(tempDir, targetDir);
                    }
                }

            } else {
                // Local Path Copy
                // Note: Simple copy using fs.cp (Node 16.7+)
                await fs.cp(params.source, targetDir, { recursive: true });
            }

            // Refresh skills
            await this.chatService.getSkillManager().discoverSkills();

            return createSuccessResult(
                `Successfully installed skill to ${targetDir}.\nRun 'skill_manage action="list"' to verify.`,
                'Skill Installed'
            );

        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return createErrorResult(`Failed to install skill: ${message}`, ToolErrorType.EXECUTION_FAILED);
        }
    }
}
