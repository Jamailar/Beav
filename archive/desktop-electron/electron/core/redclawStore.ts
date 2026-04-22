import * as fs from 'fs/promises';
import * as path from 'path';
import matter from 'gray-matter';
import { getWorkspacePaths } from '../db';
import { ensurePlannedMediaAssetsForProject } from './mediaLibraryStore';
import { getWorkItemStore } from './workItemStore';

type RedClawProjectStatus = 'planning' | 'drafted' | 'reviewed';
export type RedClawContentPlatform = 'xiaohongshu' | 'wechat_official_account';
export type RedClawAuthoringTaskType = 'direct_write' | 'expand_from_xhs';
export type RedClawSourceMode = 'manual' | 'knowledge' | 'manuscript';

export interface RedClawProject {
  id: string;
  workItemId?: string;
  goal: string;
  platform: RedClawContentPlatform;
  taskType: RedClawAuthoringTaskType;
  targetAudience?: string;
  tone?: string;
  successCriteria?: string;
  sourcePlatform?: RedClawContentPlatform;
  sourceNoteId?: string;
  sourceMode?: RedClawSourceMode;
  sourceTitle?: string;
  sourceManuscriptPath?: string;
  tags: string[];
  status: RedClawProjectStatus;
  createdAt: string;
  updatedAt: string;
}

export interface RedClawImagePrompt {
  purpose?: string;
  prompt: string;
  style?: string;
  ratio?: string;
}

export interface RedClawRetrospectiveMetrics {
  views?: number;
  likes?: number;
  comments?: number;
  collects?: number;
  shares?: number;
  follows?: number;
}

const REDCLAW_DIR_NAME = 'redclaw';
const PROJECTS_DIR_NAME = 'projects';

const DEFAULT_PLATFORM: RedClawContentPlatform = 'xiaohongshu';
const DEFAULT_TASK_TYPE: RedClawAuthoringTaskType = 'direct_write';

function nowIso(): string {
  return new Date().toISOString();
}

function normalizePlatform(value: unknown): RedClawContentPlatform {
  return String(value || '').trim() === 'wechat_official_account'
    ? 'wechat_official_account'
    : DEFAULT_PLATFORM;
}

function normalizeTaskType(value: unknown): RedClawAuthoringTaskType {
  return String(value || '').trim() === 'expand_from_xhs'
    ? 'expand_from_xhs'
    : DEFAULT_TASK_TYPE;
}

function platformLabel(platform: RedClawContentPlatform): string {
  return platform === 'wechat_official_account' ? '公众号' : '小红书';
}

function taskTypeLabel(taskType: RedClawAuthoringTaskType): string {
  return taskType === 'expand_from_xhs' ? '小红书扩写公众号' : '直接写稿';
}

function normalizeProject(raw: Partial<RedClawProject> & { id: string; goal: string }): RedClawProject {
  return {
    id: raw.id,
    workItemId: raw.workItemId,
    goal: String(raw.goal || '').trim(),
    platform: normalizePlatform(raw.platform),
    taskType: normalizeTaskType(raw.taskType),
    targetAudience: raw.targetAudience?.trim() || undefined,
    tone: raw.tone?.trim() || undefined,
    successCriteria: raw.successCriteria?.trim() || undefined,
    sourcePlatform: raw.sourcePlatform ? normalizePlatform(raw.sourcePlatform) : undefined,
    sourceNoteId: raw.sourceNoteId?.trim() || undefined,
    sourceMode: raw.sourceMode || undefined,
    sourceTitle: raw.sourceTitle?.trim() || undefined,
    sourceManuscriptPath: raw.sourceManuscriptPath?.trim() || undefined,
    tags: Array.from(new Set((raw.tags || []).map((tag) => String(tag || '').trim()).filter(Boolean))),
    status: raw.status || 'planning',
    createdAt: raw.createdAt || nowIso(),
    updatedAt: raw.updatedAt || nowIso(),
  };
}

function slugify(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-\u4e00-\u9fa5]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
  return normalized || 'project';
}

function buildProjectId(goal: string): string {
  const ts = Date.now();
  return `rc_${ts}_${slugify(goal).slice(0, 36)}`;
}

function normalizeProjectId(input: string): string {
  const raw = String(input || '').trim();
  if (!raw) return '';
  const matched = raw.match(/rc_[^\s/\\]+/i);
  return (matched ? matched[0] : raw).trim();
}

function resolveRedClawRoot(): string {
  return path.join(getWorkspacePaths().base, REDCLAW_DIR_NAME);
}

function resolveProjectsDir(): string {
  return path.join(resolveRedClawRoot(), PROJECTS_DIR_NAME);
}

function resolveProjectDir(projectId: string): string {
  return path.join(resolveProjectsDir(), projectId);
}

function resolveProjectJsonPath(projectId: string): string {
  return path.join(resolveProjectDir(projectId), 'project.json');
}

async function ensureDirStructure(): Promise<void> {
  await fs.mkdir(resolveProjectsDir(), { recursive: true });
}

async function writeJson(filePath: string, data: unknown): Promise<void> {
  await fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf-8');
}

function safeNumber(value: unknown): number | undefined {
  if (typeof value !== 'number' || Number.isNaN(value)) return undefined;
  return value;
}

export async function createRedClawProject(input: {
  goal: string;
  platform?: RedClawContentPlatform;
  taskType?: RedClawAuthoringTaskType;
  targetAudience?: string;
  tone?: string;
  successCriteria?: string;
  sourcePlatform?: RedClawContentPlatform;
  sourceNoteId?: string;
  sourceMode?: RedClawSourceMode;
  sourceTitle?: string;
  sourceManuscriptPath?: string;
  tags?: string[];
  workItemId?: string;
}): Promise<{ project: RedClawProject; projectDir: string }> {
  await ensureDirStructure();

  const workItemStore = getWorkItemStore();
  const linkedWorkItem = input.workItemId
    ? await workItemStore.getWorkItem(input.workItemId)
    : await workItemStore.createWorkItem({
      title: input.goal.trim(),
      description: input.successCriteria?.trim() || undefined,
      type: 'redclaw-project',
      status: 'active',
      tags: input.tags || [],
      metadata: {
        platform: normalizePlatform(input.platform),
        taskType: normalizeTaskType(input.taskType),
        targetAudience: input.targetAudience?.trim() || undefined,
        tone: input.tone?.trim() || undefined,
        sourcePlatform: input.sourcePlatform || undefined,
        sourceNoteId: input.sourceNoteId?.trim() || undefined,
        sourceMode: input.sourceMode || undefined,
        sourceTitle: input.sourceTitle?.trim() || undefined,
        sourceManuscriptPath: input.sourceManuscriptPath?.trim() || undefined,
      },
      summary: '已升级为 RedClaw 项目，进入持续创作/复盘链路。',
    });
  if (input.workItemId && !linkedWorkItem) {
    throw new Error(`Work item not found: ${input.workItemId}`);
  }

  const projectId = buildProjectId(input.goal);
  const projectDir = resolveProjectDir(projectId);
  await fs.mkdir(projectDir, { recursive: true });

  const project = normalizeProject({
    id: projectId,
    workItemId: linkedWorkItem?.id,
    goal: input.goal.trim(),
    platform: input.platform,
    taskType: input.taskType,
    targetAudience: input.targetAudience?.trim() || undefined,
    tone: input.tone?.trim() || undefined,
    successCriteria: input.successCriteria?.trim() || undefined,
    sourcePlatform: input.sourcePlatform,
    sourceNoteId: input.sourceNoteId,
    sourceMode: input.sourceMode,
    sourceTitle: input.sourceTitle,
    sourceManuscriptPath: input.sourceManuscriptPath,
    tags: input.tags || [],
    status: 'planning',
    createdAt: nowIso(),
    updatedAt: nowIso(),
  });

  await writeJson(resolveProjectJsonPath(projectId), project);
  if (linkedWorkItem?.id) {
    await workItemStore.attachRefs(linkedWorkItem.id, {
      projectIds: [project.id],
    });
    await workItemStore.updateWorkItem(linkedWorkItem.id, {
      type: 'redclaw-project',
      status: 'active',
      summary: `已创建 RedClaw 项目 ${project.id}`,
    });
  }

  const overview = [
    '# RedClaw Project',
    '',
    `- Project ID: ${project.id}`,
    `- Work Item ID: ${project.workItemId || '(未绑定)'}`,
    `- Goal: ${project.goal}`,
    `- Platform: ${platformLabel(project.platform)}`,
    `- Task Type: ${taskTypeLabel(project.taskType)}`,
    `- Audience: ${project.targetAudience || '(未设置)'}`,
    `- Tone: ${project.tone || '(未设置)'}`,
    `- Success Criteria: ${project.successCriteria || '(未设置)'}`,
    `- Source Mode: ${project.sourceMode || '(无)'}`,
    `- Source Platform: ${project.sourcePlatform ? platformLabel(project.sourcePlatform) : '(无)'}`,
    `- Source Note ID: ${project.sourceNoteId || '(无)'}`,
    `- Source Title: ${project.sourceTitle || '(无)'}`,
    `- Source Manuscript: ${project.sourceManuscriptPath || '(无)'}`,
    `- Status: ${project.status}`,
    `- Created At: ${project.createdAt}`,
    '',
    '## Files',
    '- `project.json` 项目元数据',
    '- `copy-pack.md/.json` 稿件包',
    '- `image-pack.md/.json` 配图包',
    '- `retrospective.md/.json` 复盘记录',
  ].join('\n');
  await fs.writeFile(path.join(projectDir, 'README.md'), overview, 'utf-8');

  return { project, projectDir };
}

export async function getRedClawProject(projectId: string): Promise<{ project: RedClawProject; projectDir: string }> {
  const normalizedProjectId = normalizeProjectId(projectId);
  if (!normalizedProjectId) {
    throw new Error('projectId is required');
  }

  const projectPath = resolveProjectJsonPath(normalizedProjectId);
  let raw = '';
  try {
    raw = await fs.readFile(projectPath, 'utf-8');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Project not found: ${normalizedProjectId} (${projectPath}) - ${message}`);
  }
  return {
    project: normalizeProject(JSON.parse(raw) as RedClawProject),
    projectDir: resolveProjectDir(normalizedProjectId),
  };
}

async function saveProject(project: RedClawProject): Promise<void> {
  await writeJson(resolveProjectJsonPath(project.id), project);
}

async function updateProjectStatus(projectId: string, status: RedClawProjectStatus): Promise<RedClawProject> {
  const { project } = await getRedClawProject(projectId);
  const next = {
    ...project,
    status,
    updatedAt: nowIso(),
  };
  await saveProject(next);
  return next;
}

export async function listRedClawProjects(limit = 20): Promise<Array<RedClawProject & { projectDir: string }>> {
  await ensureDirStructure();
  const entries = await fs.readdir(resolveProjectsDir(), { withFileTypes: true });
  const projects: Array<RedClawProject & { projectDir: string }> = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const projectId = entry.name;
    try {
      const { project, projectDir } = await getRedClawProject(projectId);
      projects.push({ ...project, projectDir });
    } catch {
      // ignore broken project folders
    }
  }

  projects.sort((a, b) => {
    const at = new Date(a.updatedAt).getTime();
    const bt = new Date(b.updatedAt).getTime();
    return bt - at;
  });

  return projects.slice(0, Math.max(1, limit));
}

export async function saveRedClawCopyPack(input: {
  projectId: string;
  titleOptions: string[];
  finalTitle?: string;
  platform?: RedClawContentPlatform;
  taskType?: RedClawAuthoringTaskType;
  summary?: string;
  introduction?: string;
  content: string;
  hashtags?: string[];
  coverTexts?: string[];
  imageSuggestions?: string[];
  cta?: string;
  sourcePlatform?: RedClawContentPlatform;
  sourceNoteId?: string;
  sourceMode?: RedClawSourceMode;
  sourceTitle?: string;
  sourceManuscriptPath?: string;
  publishPlan?: string;
}): Promise<{ project: RedClawProject; filePath: string; manuscriptPath: string }> {
  const normalizedProjectId = normalizeProjectId(input.projectId);
  const { projectDir, project } = await getRedClawProject(normalizedProjectId);
  const platform = normalizePlatform(input.platform || project.platform);
  const taskType = normalizeTaskType(input.taskType || project.taskType);
  const hashtags = (input.hashtags || []).map((tag) => tag.trim()).filter(Boolean);
  const coverTexts = (input.coverTexts || []).map((text) => text.trim()).filter(Boolean);
  const imageSuggestions = (input.imageSuggestions || []).map((text) => text.trim()).filter(Boolean);
  const titleOptions = input.titleOptions.map((text) => text.trim()).filter(Boolean);

  const payload = {
    platform,
    taskType,
    titleOptions,
    finalTitle: input.finalTitle?.trim() || undefined,
    summary: input.summary?.trim() || undefined,
    introduction: input.introduction?.trim() || undefined,
    content: input.content.trim(),
    hashtags,
    coverTexts,
    imageSuggestions,
    cta: input.cta?.trim() || undefined,
    sourcePlatform: input.sourcePlatform || project.sourcePlatform,
    sourceNoteId: input.sourceNoteId?.trim() || project.sourceNoteId,
    sourceMode: input.sourceMode || project.sourceMode,
    sourceTitle: input.sourceTitle?.trim() || project.sourceTitle,
    sourceManuscriptPath: input.sourceManuscriptPath?.trim() || project.sourceManuscriptPath,
    publishPlan: input.publishPlan?.trim() || undefined,
    updatedAt: nowIso(),
  };

  const jsonPath = path.join(projectDir, 'copy-pack.json');
  await writeJson(jsonPath, payload);

  const markdown = platform === 'wechat_official_account'
    ? [
        '# 公众号文章文案包',
        '',
        '## 标题候选',
        ...(titleOptions.length > 0 ? titleOptions.map((title, index) => `${index + 1}. ${title}`) : ['(无)']),
        '',
        '## 最终标题',
        payload.finalTitle || '(待定)',
        '',
        '## 摘要',
        payload.summary || '(无)',
        '',
        '## 导语',
        payload.introduction || '(无)',
        '',
        '## 正文',
        payload.content || '(空)',
        '',
        '## 结尾 CTA',
        payload.cta || '(无)',
        '',
        '## 关键词 / 标签',
        hashtags.length > 0 ? hashtags.map((tag) => `- ${tag}`).join('\n') : '(无)',
        '',
        '## 配图建议',
        imageSuggestions.length > 0 ? imageSuggestions.map((item) => `- ${item}`).join('\n') : '(无)',
        '',
        '## 发布计划',
        payload.publishPlan || '(无)',
      ].join('\n')
    : [
        '# 小红书文案包',
        '',
        '## 标题候选',
        ...(titleOptions.length > 0 ? titleOptions.map((title, index) => `${index + 1}. ${title}`) : ['(无)']),
        '',
        '## 最终标题',
        payload.finalTitle || '(待定)',
        '',
        '## 正文',
        payload.content || '(空)',
        '',
        '## 话题标签',
        hashtags.length > 0 ? hashtags.map((tag) => `- ${tag}`).join('\n') : '(无)',
        '',
        '## 封面文案',
        coverTexts.length > 0 ? coverTexts.map((text) => `- ${text}`).join('\n') : '(无)',
        '',
        '## 发布计划',
        payload.publishPlan || '(无)',
      ].join('\n');
  await fs.writeFile(path.join(projectDir, 'copy-pack.md'), markdown, 'utf-8');

  const manuscriptsDir = getWorkspacePaths().manuscripts;
  const manuscriptPath = path.join('redclaw', `${project.id}.md`).replace(/\\/g, '/');
  const manuscriptAbsolutePath = path.join(manuscriptsDir, manuscriptPath);
  await fs.mkdir(path.dirname(manuscriptAbsolutePath), { recursive: true });

  let currentMetadata: Record<string, unknown> = {};
  try {
    const existing = await fs.readFile(manuscriptAbsolutePath, 'utf-8');
    currentMetadata = matter(existing).data || {};
  } catch {
    currentMetadata = {};
  }

  const manuscriptMetadata: Record<string, unknown> = {
    ...currentMetadata,
    title: payload.finalTitle || titleOptions[0] || project.goal,
    status: currentMetadata.status || 'writing',
    source: 'redclaw',
    platform,
    taskType,
    redclawProjectId: project.id,
    redclawUpdatedAt: payload.updatedAt,
    sourcePlatform: payload.sourcePlatform,
    sourceNoteId: payload.sourceNoteId,
    sourceMode: payload.sourceMode,
    sourceTitle: payload.sourceTitle,
    sourceManuscriptPath: payload.sourceManuscriptPath,
    formatTarget: 'markdown',
    tags: hashtags,
    createdAt: currentMetadata.createdAt || Date.now(),
    updatedAt: Date.now(),
  };

  const sourceReferenceLines = payload.sourceMode || payload.sourceNoteId || payload.sourceTitle || payload.sourceManuscriptPath
    ? [
        '## 来源信息',
        `- 来源模式: ${payload.sourceMode || '(无)'}`,
        `- 来源平台: ${payload.sourcePlatform ? platformLabel(payload.sourcePlatform) : '(无)'}`,
        `- 来源标题: ${payload.sourceTitle || '(无)'}`,
        `- 来源笔记 ID: ${payload.sourceNoteId || '(无)'}`,
        `- 来源稿件路径: ${payload.sourceManuscriptPath || '(无)'}`,
        '',
      ]
    : [];

  const manuscriptBody = platform === 'wechat_official_account'
    ? [
        '# 标题候选',
        ...(titleOptions.length > 0 ? titleOptions.map((title, index) => `${index + 1}. ${title}`) : ['(无)']),
        '',
        '## 最终标题',
        payload.finalTitle || '(待定)',
        '',
        ...sourceReferenceLines,
        '## 摘要',
        payload.summary || '(无)',
        '',
        '## 导语',
        payload.introduction || '(无)',
        '',
        '## 正文',
        payload.content || '(空)',
        '',
        '## 结尾 CTA',
        payload.cta || '(无)',
        '',
        '## 关键词 / 标签',
        hashtags.length > 0 ? hashtags.map((tag) => `- ${tag}`).join('\n') : '(无)',
        '',
        '## 配图建议',
        imageSuggestions.length > 0 ? imageSuggestions.map((item) => `- ${item}`).join('\n') : '(无)',
        '',
        '## 发布计划',
        payload.publishPlan || '(无)',
        '',
        '> 该稿件由 RedClaw 自动生成，可在稿件工作台继续编辑或执行公众号排版复制。',
      ].join('\n')
    : [
        '# 标题候选',
        ...(titleOptions.length > 0 ? titleOptions.map((title, index) => `${index + 1}. ${title}`) : ['(无)']),
        '',
        '## 最终标题',
        payload.finalTitle || '(待定)',
        '',
        '## 正文',
        payload.content || '(空)',
        '',
        '## 话题标签',
        hashtags.length > 0 ? hashtags.map((tag) => `- ${tag}`).join('\n') : '(无)',
        '',
        '## 封面文案',
        coverTexts.length > 0 ? coverTexts.map((text) => `- ${text}`).join('\n') : '(无)',
        '',
        '## 发布计划',
        payload.publishPlan || '(无)',
        '',
        '> 该稿件由 RedClaw 自动生成，可在稿件工作台继续编辑。',
      ].join('\n');

  await fs.writeFile(manuscriptAbsolutePath, matter.stringify(manuscriptBody, manuscriptMetadata), 'utf-8');

  const normalizedProject = normalizeProject({
    ...project,
    platform,
    taskType,
    sourcePlatform: payload.sourcePlatform,
    sourceNoteId: payload.sourceNoteId,
    sourceMode: payload.sourceMode,
    sourceTitle: payload.sourceTitle,
    sourceManuscriptPath: payload.sourceManuscriptPath,
    updatedAt: payload.updatedAt,
  });
  await saveProject(normalizedProject);

  const nextProject = await updateProjectStatus(normalizedProjectId, 'drafted');
  if (project.workItemId) {
    await getWorkItemStore().attachRefs(project.workItemId, {
      filePaths: [manuscriptPath],
    });
    await getWorkItemStore().updateWorkItem(project.workItemId, {
      status: 'active',
      summary: `稿件包已保存，稿件路径 ${manuscriptPath}`,
    });
  }
  return { project: nextProject, filePath: jsonPath, manuscriptPath };
}

export async function saveRedClawImagePack(input: {
  projectId: string;
  images: RedClawImagePrompt[];
  coverPrompt?: string;
  notes?: string;
}): Promise<{ project: RedClawProject; filePath: string; plannedAssetCount: number }> {
  const normalizedProjectId = normalizeProjectId(input.projectId);
  const { projectDir, project } = await getRedClawProject(normalizedProjectId);
  const images = input.images
    .map((item) => ({
      purpose: item.purpose?.trim() || undefined,
      prompt: item.prompt.trim(),
      style: item.style?.trim() || undefined,
      ratio: item.ratio?.trim() || undefined,
    }))
    .filter((item) => item.prompt);

  const payload = {
    coverPrompt: input.coverPrompt?.trim() || undefined,
    notes: input.notes?.trim() || undefined,
    images,
    updatedAt: nowIso(),
  };

  const jsonPath = path.join(projectDir, 'image-pack.json');
  await writeJson(jsonPath, payload);

  const markdown = [
    `# ${platformLabel(project.platform)}配图包`,
    '',
    '## 封面图提示词',
    payload.coverPrompt || '(无)',
    '',
    '## 配图列表',
    ...(images.length > 0
      ? images.flatMap((image, index) => [
          `### 图 ${index + 1}`,
          `- 用途: ${image.purpose || '(未标注)'}`,
          `- 比例: ${image.ratio || '(未标注)'}`,
          `- 风格: ${image.style || '(未标注)'}`,
          '- 提示词:',
          image.prompt,
          '',
        ])
      : ['(无)']),
    '## 备注',
    payload.notes || '(无)',
  ].join('\n');
  await fs.writeFile(path.join(projectDir, 'image-pack.md'), markdown, 'utf-8');

  const created = await ensurePlannedMediaAssetsForProject({
    projectId: normalizedProjectId,
    coverPrompt: payload.coverPrompt,
    prompts: images.map((image) => image.prompt),
  });

  const nextProject = await updateProjectStatus(normalizedProjectId, 'drafted');
  if (nextProject.workItemId) {
    await getWorkItemStore().updateWorkItem(nextProject.workItemId, {
      status: 'active',
      summary: `配图包已保存，规划了 ${created.length} 个媒体资产。`,
    });
  }
  return { project: nextProject, filePath: jsonPath, plannedAssetCount: created.length };
}

function percent(numerator?: number, denominator?: number): string {
  const a = safeNumber(numerator);
  const b = safeNumber(denominator);
  if (!a || !b || b <= 0) return '-';
  return `${((a / b) * 100).toFixed(2)}%`;
}

export async function saveRedClawRetrospective(input: {
  projectId: string;
  metrics?: RedClawRetrospectiveMetrics;
  whatWorked?: string;
  whatFailed?: string;
  nextHypotheses?: string[];
  nextActions?: string[];
}): Promise<{ project: RedClawProject; filePath: string }> {
  const normalizedProjectId = normalizeProjectId(input.projectId);
  const { projectDir } = await getRedClawProject(normalizedProjectId);
  const metrics = input.metrics || {};
  const likes = safeNumber(metrics.likes) || 0;
  const comments = safeNumber(metrics.comments) || 0;
  const collects = safeNumber(metrics.collects) || 0;
  const shares = safeNumber(metrics.shares) || 0;
  const follows = safeNumber(metrics.follows) || 0;
  const views = safeNumber(metrics.views) || 0;

  const payload = {
    metrics: {
      views,
      likes,
      comments,
      collects,
      shares,
      follows,
      engagementRate: percent(likes + comments + collects + shares, views),
      followRate: percent(follows, views),
      collectRate: percent(collects, views),
    },
    whatWorked: input.whatWorked?.trim() || '',
    whatFailed: input.whatFailed?.trim() || '',
    nextHypotheses: (input.nextHypotheses || []).map((item) => item.trim()).filter(Boolean),
    nextActions: (input.nextActions || []).map((item) => item.trim()).filter(Boolean),
    updatedAt: nowIso(),
  };

  const jsonPath = path.join(projectDir, 'retrospective.json');
  await writeJson(jsonPath, payload);

  const markdown = [
    '# RedClaw 复盘',
    '',
    '## 核心指标',
    `- 浏览: ${views || '-'}`,
    `- 点赞: ${likes || '-'}`,
    `- 评论: ${comments || '-'}`,
    `- 收藏: ${collects || '-'}`,
    `- 分享: ${shares || '-'}`,
    `- 关注: ${follows || '-'}`,
    `- 互动率: ${payload.metrics.engagementRate}`,
    `- 关注转化率: ${payload.metrics.followRate}`,
    `- 收藏率: ${payload.metrics.collectRate}`,
    '',
    '## 做得好的点',
    payload.whatWorked || '(待补充)',
    '',
    '## 待改进点',
    payload.whatFailed || '(待补充)',
    '',
    '## 下一轮假设',
    payload.nextHypotheses.length > 0 ? payload.nextHypotheses.map((item) => `- ${item}`).join('\n') : '(无)',
    '',
    '## 下一轮动作',
    payload.nextActions.length > 0 ? payload.nextActions.map((item) => `- ${item}`).join('\n') : '(无)',
  ].join('\n');
  await fs.writeFile(path.join(projectDir, 'retrospective.md'), markdown, 'utf-8');

  const nextProject = await updateProjectStatus(normalizedProjectId, 'reviewed');
  if (nextProject.workItemId) {
    await getWorkItemStore().updateWorkItem(nextProject.workItemId, {
      status: 'done',
      summary: '项目已完成复盘，本轮闭环结束。',
    });
  }
  return { project: nextProject, filePath: jsonPath };
}

export async function getRedClawProjectContextPrompt(limit = 8): Promise<string> {
  const projects = await listRedClawProjects(limit);
  if (projects.length === 0) return '';

  const lines: string[] = [];
  for (const project of projects) {
    lines.push(
      `- [${project.id}] status=${project.status}; platform=${project.platform}; taskType=${project.taskType}; workItemId=${project.workItemId || '-'}; goal=${project.goal}; audience=${project.targetAudience || '-'}; updatedAt=${project.updatedAt}`
    );
  }
  return lines.join('\n');
}
