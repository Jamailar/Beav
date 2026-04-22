/**
 * Explore Workspace Tool - 工作区探索工具
 *
 * 一次性返回完整的工作区结构，包括知识库和稿件内容摘要
 */

import { z } from 'zod';
import * as fs from 'fs/promises';
import * as path from 'path';
import {
    DeclarativeTool,
    ToolKind,
    type ToolResult,
    createSuccessResult,
    createErrorResult,
    ToolErrorType,
} from '../toolRegistry';
import { Instance } from '../instance';

const ExploreWorkspaceParamsSchema = z.object({
    target: z.enum(['all', 'knowledge', 'manuscripts', 'skills', 'advisors']).default('all')
        .describe('What to explore: "all" for full workspace, "knowledge" for notes, "manuscripts" for articles, "skills" for available skills, "advisors" for 智囊团 members'),
});

type ExploreWorkspaceParams = z.output<typeof ExploreWorkspaceParamsSchema>;

export class ExploreWorkspaceTool extends DeclarativeTool<typeof ExploreWorkspaceParamsSchema> {
    readonly name = 'explore_workspace';
    readonly displayName = 'Explore Workspace';
    readonly description = `Explore the workspace structure. Returns overview of advisors, knowledge base, manuscripts, and skills.
- Use "advisors" to see 智囊团 members
- Use "knowledge" for notes and collected content
- Use "manuscripts" for user articles
- Use "all" for a complete overview

Example:
explore_workspace({ "target": "all" })
explore_workspace({ "target": "knowledge" })`;
    readonly kind = ToolKind.Read;
    readonly parameterSchema = ExploreWorkspaceParamsSchema;
    readonly requiresConfirmation = false;

    getDescription(params: ExploreWorkspaceParams): string {
        return `Exploring workspace: ${params.target || 'all'}`;
    }

    async execute(params: ExploreWorkspaceParams, signal: AbortSignal): Promise<ToolResult> {
        if (signal.aborted) {
            return createErrorResult('Cancelled', ToolErrorType.CANCELLED);
        }

        try {
            const workspaceRoot = Instance.directory;
            const target = params.target || 'all';
            const sections: string[] = [];

            sections.push(`# 📂 Workspace: \`${workspaceRoot}\`\n`);

            // Advisors (智囊团)
            if (target === 'all' || target === 'advisors') {
                const advisorsPath = path.join(workspaceRoot, 'advisors');
                const advisorsSection = await this.exploreAdvisors(advisorsPath);
                sections.push(advisorsSection);
            }

            // Knowledge Base
            if (target === 'all' || target === 'knowledge') {
                const knowledgePath = path.join(workspaceRoot, 'knowledge');
                const knowledgeSection = await this.exploreKnowledge(knowledgePath);
                sections.push(knowledgeSection);
            }

            // Manuscripts
            if (target === 'all' || target === 'manuscripts') {
                const manuscriptsPath = path.join(workspaceRoot, 'manuscripts');
                const manuscriptsSection = await this.exploreManuscripts(manuscriptsPath);
                sections.push(manuscriptsSection);
            }

            // Skills
            if (target === 'all' || target === 'skills') {
                const skillsPath = path.join(workspaceRoot, 'skills');
                const skillsSection = await this.exploreSkills(skillsPath);
                sections.push(skillsSection);
            }

            const output = sections.join('\n---\n\n');
            return createSuccessResult(output, `📂 Explored ${target}`);

        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return createErrorResult(`Failed to explore workspace: ${message}`);
        }
    }

    private async exploreAdvisors(advisorsPath: string): Promise<string> {
        const lines: string[] = ['## 👥 智囊团 (Advisors)\n'];

        try {
            await fs.access(advisorsPath);
        } catch {
            lines.push('*(Advisors directory not found)*\n');
            return lines.join('\n');
        }

        try {
            const advisorDirs = await fs.readdir(advisorsPath, { withFileTypes: true });
            const advisors: { id: string; name: string; avatar: string; personality: string; path: string }[] = [];

            for (const dir of advisorDirs) {
                if (!dir.isDirectory()) continue;

                const advisorId = dir.name;
                const advisorPath = path.join(advisorsPath, advisorId);
                const configPath = path.join(advisorPath, 'config.json');

                let name = advisorId;
                let avatar = '👤';
                let personality = '';

                // Read config.json
                try {
                    const configContent = await fs.readFile(configPath, 'utf-8');
                    const config = JSON.parse(configContent);
                    name = config.name || advisorId;
                    avatar = config.avatar || '👤';
                    personality = config.personality || '';
                } catch { }

                advisors.push({ id: advisorId, name, avatar, personality, path: advisorPath });
            }

            if (advisors.length === 0) {
                lines.push('*(No advisors found)*\n');
            } else {
                lines.push(`Found **${advisors.length}** advisors:\n`);
                for (const advisor of advisors) {
                    lines.push(`### ${advisor.avatar} ${advisor.name}`);
                    lines.push(`- **ID**: ${advisor.id}`);
                    if (advisor.personality) {
                        lines.push(`- **Personality**: ${advisor.personality}`);
                    }
                    lines.push(`- **Path**: \`${advisor.path}\``);
                    lines.push('');
                }
            }
        } catch (error) {
            lines.push(`*(Error reading advisors: ${error})*\n`);
        }

        return lines.join('\n');
    }

    private async exploreKnowledge(knowledgePath: string): Promise<string> {
        const lines: string[] = ['## 📚 Knowledge Base (知识库)\n'];

        try {
            await fs.access(knowledgePath);
        } catch {
            lines.push('*(Knowledge directory not found)*\n');
            return lines.join('\n');
        }

        try {
            const noteDirs = await fs.readdir(knowledgePath, { withFileTypes: true });
            const notes: { id: string; title: string; preview: string; path: string }[] = [];

            for (const dir of noteDirs) {
                if (!dir.isDirectory()) continue;

                const noteId = dir.name;
                const notePath = path.join(knowledgePath, noteId);
                const metaPath = path.join(notePath, 'meta.json');
                const contentPath = path.join(notePath, 'content.md');

                let title = noteId;
                let preview = '';

                // Read meta.json for title
                try {
                    const metaContent = await fs.readFile(metaPath, 'utf-8');
                    const meta = JSON.parse(metaContent);
                    title = meta.title || noteId;
                } catch { }

                // Read content.md for preview
                try {
                    const content = await fs.readFile(contentPath, 'utf-8');
                    // Get first 200 characters as preview
                    preview = content.slice(0, 200).replace(/\n/g, ' ').trim();
                    if (content.length > 200) preview += '...';
                } catch { }

                notes.push({ id: noteId, title, preview, path: contentPath });
            }

            if (notes.length === 0) {
                lines.push('*(No notes found)*\n');
            } else {
                lines.push(`Found **${notes.length}** notes:\n`);
                for (const note of notes) {
                    lines.push(`### 📝 ${note.title}`);
                    lines.push(`- **ID**: ${note.id}`);
                    lines.push(`- **Path**: \`${note.path}\``);
                    if (note.preview) {
                        lines.push(`- **Preview**: ${note.preview}`);
                    }
                    lines.push('');
                }
            }
        } catch (error) {
            lines.push(`*(Error reading knowledge: ${error})*\n`);
        }

        return lines.join('\n');
    }

    private async exploreManuscripts(manuscriptsPath: string): Promise<string> {
        const lines: string[] = ['## 📄 Manuscripts (稿件)\n'];

        try {
            await fs.access(manuscriptsPath);
        } catch {
            lines.push('*(Manuscripts directory not found)*\n');
            return lines.join('\n');
        }

        try {
            const files = await this.listFilesRecursive(manuscriptsPath, 3);

            if (files.length === 0) {
                lines.push('*(No manuscripts found)*\n');
            } else {
                lines.push(`Found **${files.length}** manuscripts:\n`);
                for (const file of files) {
                    const relativePath = path.relative(manuscriptsPath, file.path);
                    lines.push(`- 📄 **${file.name}** - \`${file.path}\``);
                    if (file.preview) {
                        lines.push(`  Preview: ${file.preview}`);
                    }
                }
                lines.push('');
            }
        } catch (error) {
            lines.push(`*(Error reading manuscripts: ${error})*\n`);
        }

        return lines.join('\n');
    }

    private async exploreSkills(skillsPath: string): Promise<string> {
        const lines: string[] = ['## 🎯 Skills (技能)\n'];

        try {
            await fs.access(skillsPath);
        } catch {
            lines.push('*(Skills directory not found)*\n');
            return lines.join('\n');
        }

        try {
            const files = await fs.readdir(skillsPath, { withFileTypes: true });
            const skills: { name: string; path: string }[] = [];

            for (const file of files) {
                if (file.isFile() && file.name.endsWith('.md')) {
                    skills.push({
                        name: file.name.replace('.md', ''),
                        path: path.join(skillsPath, file.name)
                    });
                }
            }

            if (skills.length === 0) {
                lines.push('*(No skills found)*\n');
            } else {
                lines.push(`Found **${skills.length}** skills:\n`);
                for (const skill of skills) {
                    lines.push(`- 🎯 **${skill.name}** - \`${skill.path}\``);
                }
                lines.push('');
            }
        } catch (error) {
            lines.push(`*(Error reading skills: ${error})*\n`);
        }

        return lines.join('\n');
    }

    private async listFilesRecursive(
        dirPath: string,
        maxDepth: number,
        currentDepth: number = 0
    ): Promise<{ name: string; path: string; preview?: string }[]> {
        const results: { name: string; path: string; preview?: string }[] = [];

        if (currentDepth >= maxDepth) return results;

        try {
            const items = await fs.readdir(dirPath, { withFileTypes: true });

            for (const item of items) {
                if (item.name.startsWith('.')) continue;

                const fullPath = path.join(dirPath, item.name);

                if (item.isDirectory()) {
                    const subFiles = await this.listFilesRecursive(fullPath, maxDepth, currentDepth + 1);
                    results.push(...subFiles);
                } else if (item.name.endsWith('.md')) {
                    let preview = '';
                    try {
                        const content = await fs.readFile(fullPath, 'utf-8');
                        preview = content.slice(0, 100).replace(/\n/g, ' ').trim();
                        if (content.length > 100) preview += '...';
                    } catch { }

                    results.push({ name: item.name, path: fullPath, preview });
                }
            }
        } catch { }

        return results;
    }
}
