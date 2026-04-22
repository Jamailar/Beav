import fs from 'node:fs/promises';
import path from 'node:path';
import { getWorkspacePaths } from '../db';
import { loadInternalSkillBundle } from './systemSkillAssetStore';
import { loadAndRenderPrompt } from '../prompts/runtime';
import { normalizeApiBaseUrl, safeUrlJoin } from './urlUtils';
import { searchWeb, type SearchResult } from './bingSearch';

type SearchSummaryItem = {
    title: string;
    url?: string;
    snippet: string;
};

type PersonaResearchResult = {
    persona_name?: string;
    personality_summary?: string;
    description?: string;
    category?: string;
    color?: string;
    emoji?: string;
    vibe?: string;
    role_sentence?: string;
    target_users?: string[];
    primary_jobs?: string[];
    out_of_scope?: string[];
    personality_traits?: string[];
    experience_claim?: string;
    memory_focus?: string;
    quality_bar?: string;
    risk_posture?: string;
    escalation_triggers?: string[];
    non_negotiables?: string[];
    deliverables_primary?: string[];
    deliverables_secondary?: string[];
    workflow?: Array<{
        phase: string;
        input?: string;
        action?: string;
        output?: string;
        exit_criteria?: string;
    }>;
    communication?: {
        tone?: string;
        response_density?: string;
        preferred_structure?: string;
        example_phrases?: string[];
    };
    metrics?: string[];
    advanced_capabilities?: string[];
    evidence_highlights?: string[];
    assumptions?: string[];
};

export type AdvisorPersonaGenerationInput = {
    advisorId?: string;
    channelName: string;
    channelDescription: string;
    videoTitles: string[];
    knowledgeLanguage?: string;
    apiKey: string;
    baseURL: string;
    model: string;
};

export type AdvisorPersonaGenerationOutput = {
    prompt: string;
    personality: string;
    searchResults: SearchSummaryItem[];
    research: PersonaResearchResult;
};

const RESEARCH_SYSTEM_PROMPT_PATH = 'runtime/advisors/generate_persona_research_system.txt';
const RESEARCH_USER_PROMPT_PATH = 'runtime/advisors/generate_persona_research_user.txt';
const FINAL_SYSTEM_PROMPT_PATH = 'runtime/advisors/generate_persona_final_system.txt';
const FINAL_USER_PROMPT_PATH = 'runtime/advisors/generate_persona_final_user.txt';

const MAX_SEARCH_RESULTS = 6;
const MAX_VIDEO_TITLES = 20;
const MAX_KNOWLEDGE_FILES = 12;
const MAX_KNOWLEDGE_SNIPPET_CHARS = 3200;
const MAX_MANUSCRIPT_FILES = 8;
const MAX_MANUSCRIPT_SNIPPET_CHARS = 2200;

const truncateText = (value: string, maxChars: number): string => {
    const text = String(value || '').replace(/\0/g, '').trim();
    if (text.length <= maxChars) return text;
    return `${text.slice(0, Math.max(0, maxChars - 1)).trim()}…`;
};

const isUtf8TextFile = (fileName: string): boolean => {
    const normalized = String(fileName || '').toLowerCase();
    return normalized.endsWith('.md') || normalized.endsWith('.txt') || normalized.endsWith('.json');
};

const listMarkdownFilesRecursive = async (dirPath: string, maxDepth = 6, currentDepth = 0): Promise<string[]> => {
    if (currentDepth > maxDepth) return [];
    const entries = await fs.readdir(dirPath, { withFileTypes: true }).catch(() => []);
    const output: string[] = [];
    for (const entry of entries) {
        const fullPath = path.join(dirPath, entry.name);
        if (entry.isDirectory()) {
            if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'dist' || entry.name === 'dist-electron') {
                continue;
            }
            output.push(...await listMarkdownFilesRecursive(fullPath, maxDepth, currentDepth + 1));
            continue;
        }
        if (entry.isFile() && isUtf8TextFile(entry.name)) {
            output.push(fullPath);
        }
    }
    return output.sort((a, b) => a.localeCompare(b, 'zh-CN'));
};

const findNeedleIndex = (content: string, needles: string[]): number => {
    const lower = content.toLowerCase();
    for (const needle of needles) {
        const normalized = String(needle || '').trim().toLowerCase();
        if (!normalized) continue;
        const index = lower.indexOf(normalized);
        if (index >= 0) return index;
    }
    return -1;
};

const buildExcerptAround = (content: string, index: number, maxChars: number): string => {
    const text = String(content || '').replace(/\s+/g, ' ').trim();
    if (!text) return '';
    if (index < 0) return truncateText(text, maxChars);
    const start = Math.max(0, index - Math.floor(maxChars * 0.2));
    const end = Math.min(text.length, start + maxChars);
    const slice = text.slice(start, end).trim();
    return `${start > 0 ? '…' : ''}${slice}${end < text.length ? '…' : ''}`;
};

const renderSearchSummary = (items: SearchSummaryItem[]): string => {
    if (!items.length) return '(无外部搜索结果)';
    return items.map((item, index) => {
        const title = truncateText(item.title, 120);
        const snippet = truncateText(item.snippet, 240);
        const url = item.url ? `\nURL: ${item.url}` : '';
        return `Result ${index + 1}\nTitle: ${title}${url}\nSnippet: ${snippet}`;
    }).join('\n\n');
};

const renderCorpus = (label: string, items: Array<{ file: string; excerpt: string }>, emptyText: string): string => {
    if (!items.length) return emptyText;
    return items.map((item, index) => {
        return `${label} ${index + 1}\nFile: ${item.file}\nExcerpt:\n${item.excerpt}`;
    }).join('\n\n');
};

const requestChatCompletion = async ({
    baseURL,
    apiKey,
    model,
    messages,
    temperature,
    requireJson,
    timeoutMs = 120000,
}: {
    baseURL: string;
    apiKey: string;
    model: string;
    messages: Array<{ role: 'system' | 'user'; content: string }>;
    temperature: number;
    requireJson?: boolean;
    timeoutMs?: number;
}): Promise<string> => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const response = await fetch(safeUrlJoin(baseURL, '/chat/completions'), {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${apiKey}`,
            },
            body: JSON.stringify({
                model,
                temperature,
                response_format: requireJson ? { type: 'json_object' } : undefined,
                messages,
            }),
            signal: controller.signal,
        });
        const rawText = await response.text().catch(() => '');
        if (!response.ok) {
            throw new Error(`Advisor persona request failed (${response.status}): ${rawText || response.statusText}`);
        }
        const parsed = JSON.parse(rawText) as { choices?: Array<{ message?: { content?: string } }> };
        return String(parsed.choices?.[0]?.message?.content || '').trim();
    } finally {
        clearTimeout(timeout);
    }
};

const parseResearchJson = (raw: string): PersonaResearchResult => {
    const parsed = JSON.parse(String(raw || '{}')) as PersonaResearchResult;
    if (!parsed || typeof parsed !== 'object') {
        throw new Error('Advisor persona research result is invalid');
    }
    return parsed;
};

const loadAdvisorExistingContext = async (advisorId?: string): Promise<string> => {
    if (!advisorId) return '(无已有智囊团成员档案)';
    const advisorDir = path.join(getWorkspacePaths().advisors, advisorId);
    const configPath = path.join(advisorDir, 'config.json');
    try {
        const raw = await fs.readFile(configPath, 'utf-8');
        const config = JSON.parse(raw) as Record<string, unknown>;
        return [
            `Advisor ID: ${advisorId}`,
            `Name: ${String(config.name || '') || '(未命名)'}`,
            `Personality: ${String(config.personality || '') || '(无)'}`,
            `Existing System Prompt:\n${truncateText(String(config.systemPrompt || ''), 6000) || '(无)'}`,
        ].join('\n\n');
    } catch {
        return '(无已有智囊团成员档案)';
    }
};

const collectAdvisorKnowledgeEvidence = async (advisorId?: string): Promise<Array<{ file: string; excerpt: string }>> => {
    if (!advisorId) return [];
    const knowledgeDir = path.join(getWorkspacePaths().advisors, advisorId, 'knowledge');
    const files = await listMarkdownFilesRecursive(knowledgeDir, 2).catch(() => []);
    const selected = files.slice(0, MAX_KNOWLEDGE_FILES);
    const items: Array<{ file: string; excerpt: string }> = [];
    for (const filePath of selected) {
        const content = await fs.readFile(filePath, 'utf-8').catch(() => '');
        if (!content.trim()) continue;
        items.push({
            file: path.relative(knowledgeDir, filePath).replace(/\\/g, '/'),
            excerpt: buildExcerptAround(content, -1, MAX_KNOWLEDGE_SNIPPET_CHARS),
        });
    }
    return items;
};

const collectRelatedManuscriptEvidence = async (subjectNames: string[]): Promise<Array<{ file: string; excerpt: string }>> => {
    const manuscriptsRoot = getWorkspacePaths().manuscripts;
    const files = await listMarkdownFilesRecursive(manuscriptsRoot, 6).catch(() => []);
    const items: Array<{ file: string; excerpt: string; score: number }> = [];
    for (const filePath of files) {
        if (items.length >= MAX_MANUSCRIPT_FILES * 3) break;
        const content = await fs.readFile(filePath, 'utf-8').catch(() => '');
        if (!content.trim()) continue;
        const hitIndex = findNeedleIndex(content, subjectNames);
        if (hitIndex < 0) continue;
        const score = subjectNames.reduce((acc, subject) => {
            if (!subject.trim()) return acc;
            return acc + (content.toLowerCase().includes(subject.toLowerCase()) ? subject.length : 0);
        }, 0);
        items.push({
            file: path.relative(manuscriptsRoot, filePath).replace(/\\/g, '/'),
            excerpt: buildExcerptAround(content, hitIndex, MAX_MANUSCRIPT_SNIPPET_CHARS),
            score,
        });
    }
    return items
        .sort((a, b) => b.score - a.score || a.file.localeCompare(b.file, 'zh-CN'))
        .slice(0, MAX_MANUSCRIPT_FILES)
        .map(({ file, excerpt }) => ({ file, excerpt }));
};

export const generateAdvisorPersonaDocument = async (input: AdvisorPersonaGenerationInput): Promise<AdvisorPersonaGenerationOutput> => {
    const baseURL = normalizeApiBaseUrl(input.baseURL, 'https://api.openai.com/v1');
    const skillBundle = await loadInternalSkillBundle('agent-persona-creator');
    const subjectNames = Array.from(new Set([
        String(input.channelName || '').trim(),
    ].filter(Boolean)));

    const [searchResultsRaw, existingContext, knowledgeEvidence, manuscriptEvidence] = await Promise.all([
        searchWeb(`${input.channelName} YouTube 博主 创作者 频道定位 内容风格`, MAX_SEARCH_RESULTS).catch(() => []),
        loadAdvisorExistingContext(input.advisorId),
        collectAdvisorKnowledgeEvidence(input.advisorId),
        collectRelatedManuscriptEvidence(subjectNames),
    ]);

    const searchResults: SearchSummaryItem[] = searchResultsRaw.map((item: SearchResult) => ({
        title: truncateText(String(item.title || ''), 160),
        url: String(item.url || '').trim() || undefined,
        snippet: truncateText(String(item.snippet || ''), 260),
    })).filter((item) => item.title || item.snippet);

    const researchSystemPrompt = loadAndRenderPrompt(RESEARCH_SYSTEM_PROMPT_PATH, {
        skill_name: skillBundle.name,
        skill_body: skillBundle.skillBody,
        skill_references: Object.entries(skillBundle.references).map(([name, content]) => `## ${name}\n${content}`).join('\n\n'),
        skill_scripts: Object.entries(skillBundle.scripts).map(([name, content]) => `## ${name}\n${content}`).join('\n\n'),
    }, 'You are an expert advisor persona researcher. Output strict JSON only.');

    const researchUserPrompt = loadAndRenderPrompt(RESEARCH_USER_PROMPT_PATH, {
        channel_name: input.channelName,
        knowledge_language: String(input.knowledgeLanguage || '').trim() || '中文',
        channel_description: input.channelDescription || '(无频道描述)',
        video_titles: input.videoTitles.slice(0, MAX_VIDEO_TITLES).map((title, index) => `${index + 1}. ${title}`).join('\n') || '(无视频标题)',
        search_summary: renderSearchSummary(searchResults),
        existing_context: existingContext,
        advisor_knowledge_corpus: renderCorpus('Knowledge Evidence', knowledgeEvidence, '(无 advisor 知识文件)'),
        manuscript_corpus: renderCorpus('Manuscript Evidence', manuscriptEvidence, '(无关联稿件命中)'),
    }, '请分析这些资料并输出 JSON。');

    const researchRaw = await requestChatCompletion({
        baseURL,
        apiKey: input.apiKey,
        model: input.model,
        temperature: 0.2,
        requireJson: true,
        messages: [
            { role: 'system', content: researchSystemPrompt },
            { role: 'user', content: researchUserPrompt },
        ],
    });
    const research = parseResearchJson(researchRaw);

    const finalSystemPrompt = loadAndRenderPrompt(FINAL_SYSTEM_PROMPT_PATH, {
        skill_name: skillBundle.name,
        skill_body: skillBundle.skillBody,
        skill_references: Object.entries(skillBundle.references).map(([name, content]) => `## ${name}\n${content}`).join('\n\n'),
        skill_scripts: Object.entries(skillBundle.scripts).map(([name, content]) => `## ${name}\n${content}`).join('\n\n'),
    }, 'You are an expert advisor persona writer. Return only the final markdown document.');

    const finalUserPrompt = loadAndRenderPrompt(FINAL_USER_PROMPT_PATH, {
        channel_name: input.channelName,
        knowledge_language: String(input.knowledgeLanguage || '').trim() || '中文',
        research_json: JSON.stringify(research, null, 2),
        search_summary: renderSearchSummary(searchResults),
        advisor_knowledge_corpus: renderCorpus('Knowledge Evidence', knowledgeEvidence, '(无 advisor 知识文件)'),
        manuscript_corpus: renderCorpus('Manuscript Evidence', manuscriptEvidence, '(无关联稿件命中)'),
    }, '根据研究结果输出最终的角色文档。');

    const prompt = await requestChatCompletion({
        baseURL,
        apiKey: input.apiKey,
        model: input.model,
        temperature: 0.45,
        messages: [
            { role: 'system', content: finalSystemPrompt },
            { role: 'user', content: finalUserPrompt },
        ],
    });

    const personality = String(research.personality_summary || research.role_sentence || input.channelDescription || input.channelName).trim();

    return {
        prompt,
        personality: truncateText(personality, 120),
        searchResults,
        research,
    };
};
