import type { SpaceInitState } from '../../bridge/domains/spacesBridge';
import type { PendingChatMessage } from '../app-shell/types';
import type { AuthoringTaskHints } from '../../utils/redclawAuthoring';
import type { ClipboardCaptureCandidate, ServerCaptureJob } from '../capture/captureTypes';
import {
  captureResponseError,
  createServerCaptureJob,
  ingestServerCaptureJobEntries,
  pollServerCaptureJob,
  serverCaptureEntryCount,
} from '../capture/serverCaptureClient';
import { importCaptureJobToAccount } from '../accounts/accountCaptureImport';

export const SPACE_INIT_CONTEXT_TYPE = 'space-initialization';
export const SPACE_INIT_SKILL_NAME = 'redclaw-style-definition';
export const SPACE_INIT_CAPTURE_TARGET_COUNT = 25;

export interface AccountSummary {
  id?: string;
  platform?: string;
  platformUserId?: string;
  username?: string;
  homepageUrl?: string;
  avatarUrl?: string;
  followerCount?: number;
  totalPostCount?: number;
  totalLikeCount?: number;
}

interface AccountCreateFromHomepageResponse {
  success?: boolean;
  account?: AccountSummary;
  session?: {
    id?: string;
    status?: string;
  };
  homepageUrl?: string;
  platform?: string;
  limit?: number;
  error?: string;
}

interface AccountImportCompleteResponse {
  success?: boolean;
  status?: string;
  learningStatus?: string;
  pendingVideoTranscriptions?: number;
  failedVideoTranscriptions?: number;
}

export interface SpaceInitCaptureProgress {
  phase: 'creating' | 'capturing' | 'importing' | 'handoff' | 'failed';
  title: string;
  message: string;
  percent: number;
  account?: AccountSummary | null;
  posts: number;
  media: number;
  comments: number;
  requested: number;
  learningStatus?: string;
  pendingVideoTranscriptions?: number;
  failedVideoTranscriptions?: number;
}

export interface SpaceInitCaptureStartPayload {
  url: string;
  candidate: ClipboardCaptureCandidate;
}

export interface SpaceInitCaptureResult {
  nextState: SpaceInitState;
  message: PendingChatMessage;
}

interface RunSpaceInitAccountCaptureParams {
  homepageUrl: string;
  candidate: ClipboardCaptureCandidate;
  progressBase?: Record<string, unknown>;
  onProgress: (progress: SpaceInitCaptureProgress) => void;
}

export const SPACE_INIT_ALLOWED_OPERATE_ACTIONS = [
  'taskBrief.get',
  'taskBrief.update',
  'skills.invoke',
  'capture.collect',
  'capture.status',
  'knowledge.create',
  'media.transcribe',
  'profile.read',
  'profile.manage',
  'redclaw.profile.bundle',
  'redclaw.profile.read',
  'redclaw.profile.update',
  'redclaw.profile.completeStyleDefinition',
];

export const SPACE_INIT_INITIAL_CONTEXT = '当前会话是“创建账号空间”的初始化流程。用户已经完成入口分支选择。已有账号时，账号采集、入库、媒体本地化和内容准备由宿主程序先完成，AI agent 只在数据准备后负责账号诊断、定位归纳和空间档案生成。没有账号时进入账号定位访谈。完成后复用 redclaw-style-definition skill 和现有 profile 工具写入空间档案。';

export const SPACE_INIT_TASK_HINTS = {
  intent: 'space_initialization',
  taskIntent: 'space_initialization',
  forceLongRunningTask: true,
  activeSkills: [SPACE_INIT_SKILL_NAME],
  requiredSkill: SPACE_INIT_SKILL_NAME,
  allowedTools: ['resource', 'workflow'],
  allowedOperateActions: SPACE_INIT_ALLOWED_OPERATE_ACTIONS,
  allowedAppCliActions: SPACE_INIT_ALLOWED_OPERATE_ACTIONS,
  requireProfileRead: true,
  requireTaskBrief: true,
  taskBrief: {
    taskType: 'space_initialization',
    goal: '通过主页链接采集或新账号定位访谈完成当前空间初始化。已有账号时，宿主程序先完成账号数据下载和入库，AI agent 再在 app 对话页内完成诊断和空间档案生成。',
    currentStage: 'homepage_or_positioning',
    todo: [
      { id: 'homepage_or_positioning', text: '确认用户已有账号或还没有账号', status: 'todo' },
      { id: 'account_capture', text: '已有账号时采集账号资料、最近内容和高赞内容', status: 'todo' },
      { id: 'content_prepare', text: '复用知识库转录与视觉索引准备可分析内容', status: 'todo' },
      { id: 'account_diagnosis', text: '基于内容生成账号诊断', status: 'todo' },
      { id: 'positioning', text: '没有账号时完成账号定位访谈', status: 'todo' },
      { id: 'style_definition', text: '调用 redclaw-style-definition skill 整理空间档案', status: 'todo' },
      { id: 'complete_profile', text: '调用 redclaw.profile.completeStyleDefinition 完成入库', status: 'todo' },
    ],
    importantContext: [
      { kind: 'constraint', text: SPACE_INIT_INITIAL_CONTEXT },
      { kind: 'constraint', text: '入口页只负责分支选择；后续必须在 app 的 AI 对话页内由 agent 推进。' },
      { kind: 'constraint', text: '如果用户输入主页 URL，宿主程序会先完成账号内容下载和入库；AI 不要重复发起采集。' },
      { kind: 'constraint', text: '账号内容采集入库后，如果存在待转录视频，诊断时必须把这部分内容标记为低置信度或等待补齐，不要编造视频文字稿。' },
      { kind: 'constraint', text: '图片 OCR/视觉分析复用现有知识库 visual_index 链路；转录和内容数据沿用 transcript.md/meta.json、账号 posts/{postId}/meta.json 与 content.md。' },
      { kind: 'constraint', text: '不要对多个视频串行调用 media.transcribe 阻塞初始化会话；优先通过知识库后台处理触发现有同步逻辑。' },
      { kind: 'constraint', text: '不要因为少量转录或 OCR 失败卡死初始化；记录失败状态，并在诊断中降低相关内容置信度。' },
      { kind: 'constraint', text: '不要重复实现风格定义逻辑，必须复用 redclaw-style-definition skill 和现有 profile 工具。' },
    ],
    domain: {
      graph: {
        nodes: ['homepage_or_positioning', 'account_capture', 'content_prepare', 'account_diagnosis', 'positioning', 'style_definition', 'complete_profile'],
        edges: [
          ['homepage_or_positioning', 'account_capture'],
          ['homepage_or_positioning', 'positioning'],
          ['account_capture', 'content_prepare'],
          ['content_prepare', 'account_diagnosis'],
          ['account_diagnosis', 'style_definition'],
          ['positioning', 'style_definition'],
          ['style_definition', 'complete_profile'],
        ],
      },
    },
  },
} satisfies AuthoringTaskHints;

export function platformLabel(platform?: string | null): string {
  if (platform === 'xiaohongshu') return '小红书';
  if (platform === 'douyin') return '抖音';
  if (platform === 'bilibili') return 'Bilibili';
  if (platform === 'youtube') return 'YouTube';
  if (platform === 'tiktok') return 'TikTok';
  return String(platform || '').trim() || '平台';
}

export function captureProgressPercent(posts: number, fallback: number): number {
  const byPosts = Math.round((Math.min(posts, SPACE_INIT_CAPTURE_TARGET_COUNT) / SPACE_INIT_CAPTURE_TARGET_COUNT) * 68) + 20;
  return Math.max(fallback, Math.min(88, byPosts));
}

export function buildChoiceMessage(): PendingChatMessage {
  return {
    content: '我还没有账号。请进入新账号定位流程，通过访谈帮我生成这个空间的账号定位和初始档案。',
    displayContent: '还没有账号，帮我做新账号定位',
    sessionRouting: 'new',
    deliveryMode: 'send',
    taskHints: {
      ...SPACE_INIT_TASK_HINTS,
      taskBrief: {
        ...SPACE_INIT_TASK_HINTS.taskBrief,
        currentStage: 'positioning',
      },
    },
    skillMentions: [{ name: SPACE_INIT_SKILL_NAME }],
  };
}

export function buildHomepageMessage(
  homepageUrl: string,
  candidate: ClipboardCaptureCandidate,
  context: {
    account?: AccountSummary | null;
    importedPosts: number;
    importedMedia: number;
    importedComments: number;
    learningStatus?: string;
    pendingVideoTranscriptions?: number;
    failedVideoTranscriptions?: number;
  },
): PendingChatMessage {
  const label = platformLabel(candidate.platform);
  const account = context.account || null;
  const accountName = String(account?.username || account?.id || '').trim();
  const pendingVideos = Number(context.pendingVideoTranscriptions || 0);
  const failedVideos = Number(context.failedVideoTranscriptions || 0);
  return {
    content: [
      `账号主页链接：${homepageUrl}`,
      `平台：${label}`,
      accountName ? `账号：${accountName}` : '',
      account?.id ? `账号档案 ID：${account.id}` : '',
      `宿主程序已完成账号档案创建、内容采集和入库。已导入内容 ${context.importedPosts} 条，媒体 ${context.importedMedia} 个，评论 ${context.importedComments} 条。`,
      context.learningStatus ? `当前账号学习状态：${context.learningStatus}。` : '',
      pendingVideos > 0 ? `还有 ${pendingVideos} 个视频等待转录；请先基于已有标题、正文、图片和已完成文字稿做诊断，并明确标注视频内容置信度不足。` : '',
      failedVideos > 0 ? `${failedVideos} 个视频转录失败；不要编造这些视频的口播内容。` : '',
      '请不要重复发起账号采集任务。接下来直接进行账号诊断、内容定位归纳，并生成当前空间需要的档案。完成后调用 redclaw.profile.completeStyleDefinition 标记空间初始化完成。',
    ].filter(Boolean).join('\n'),
    displayContent: '账号空间分析',
    sessionRouting: 'new',
    deliveryMode: 'send-hidden' as PendingChatMessage['deliveryMode'],
    taskHints: {
      ...SPACE_INIT_TASK_HINTS,
      taskBrief: {
        ...SPACE_INIT_TASK_HINTS.taskBrief,
        currentStage: 'account_diagnosis',
      },
      spaceInitialization: {
        version: 'chat-agent-v1',
        branch: 'homepage',
        handoff: 'after_deterministic_capture',
        homepageUrl,
        platform: candidate.platform,
        candidateKind: candidate.kind,
        externalId: candidate.externalId || null,
        accountId: account?.id || null,
        importedPosts: context.importedPosts,
        importedMedia: context.importedMedia,
        importedComments: context.importedComments,
        learningStatus: context.learningStatus || null,
        pendingVideoTranscriptions: pendingVideos,
        failedVideoTranscriptions: failedVideos,
      },
    } as AuthoringTaskHints,
    skillMentions: [{ name: SPACE_INIT_SKILL_NAME }],
  };
}

export async function runSpaceInitAccountCapture({
  homepageUrl,
  candidate,
  progressBase = {},
  onProgress,
}: RunSpaceInitAccountCaptureParams): Promise<SpaceInitCaptureResult> {
  onProgress({
    phase: 'creating',
    title: '创建账号档案',
    message: '正在建立当前空间的账号档案。',
    percent: 8,
    account: null,
    posts: 0,
    media: 0,
    comments: 0,
    requested: SPACE_INIT_CAPTURE_TARGET_COUNT,
  });

  let createdSessionId = '';
  let importCompleted = false;
  try {
    await window.ipcRenderer.spaces.init.progress<SpaceInitState>({
      phase: 'capture',
      homepageUrl,
      platform: candidate.platform,
      progress: {
        ...progressBase,
        branch: 'homepage',
        uiStage: 'deterministic_capture',
        updatedAt: new Date().toISOString(),
      },
    });

    const result = await window.ipcRenderer.accounts.createFromHomepage<AccountCreateFromHomepageResponse>({
      homepageUrl,
      limit: 20,
    });
    if (result?.success === false) {
      throw new Error(result.error || '创建账号档案失败');
    }
    const account = result?.account || {};
    const accountId = String(account.id || '').trim();
    const platform = String(result?.platform || account.platform || candidate.platform).trim();
    createdSessionId = String(result?.session?.id || '').trim();
    if (!accountId) {
      throw new Error('账号档案创建成功，但没有返回账号 ID');
    }

    onProgress({
      phase: 'capturing',
      title: '采集账号内容',
      message: '账号信息已保存，正在创建内容采集任务。',
      percent: 18,
      account,
      posts: 0,
      media: 0,
      comments: 0,
      requested: SPACE_INIT_CAPTURE_TARGET_COUNT,
    });

    const captureResponses = await Promise.all([
      createServerCaptureJob(candidate, {
        includeComments: true,
        limit: 20,
        maxItems: 20,
        collectionMode: 'recent',
        clientRequestIdSuffix: 'space-init-recent-20',
      }),
      createServerCaptureJob(candidate, {
        includeComments: true,
        limit: 5,
        maxItems: 5,
        collectionMode: 'top_liked',
        sortBy: 'likes',
        clientRequestIdSuffix: 'space-init-top-liked-5',
      }),
    ]);
    const pendingJobs = captureResponses
      .filter((response) => response.success && (response.job?.id || response.jobId))
      .map((response) => ({
        id: String(response.job?.id || response.jobId || ''),
        initialJob: response.job || null,
      }))
      .filter((item) => item.id);
    const failedCaptureResponse = captureResponses.find((response) => !response.success);
    if (pendingJobs.length === 0 && failedCaptureResponse) {
      throw captureResponseError(failedCaptureResponse, '账号采集任务创建失败');
    }
    if (pendingJobs.length === 0) {
      throw new Error('账号采集任务创建失败');
    }

    const knowledgeImportedEntryKeys = new Set<string>();
    const accountImportedEntryKeys = new Set<string>();
    const importedStats = { posts: 0, media: 0, comments: 0 };
    let importQueue = Promise.resolve();
    const updateCaptureProgress = (message: string, fallbackPercent = 24) => {
      const posts = Math.max(importedStats.posts, accountImportedEntryKeys.size);
      onProgress({
        phase: 'capturing',
        title: '采集账号内容',
        message,
        percent: captureProgressPercent(posts, fallbackPercent),
        account,
        posts,
        media: importedStats.media,
        comments: importedStats.comments,
        requested: SPACE_INIT_CAPTURE_TARGET_COUNT,
      });
    };
    const importAvailableEntries = async (nextJob: ServerCaptureJob) => {
      const capturedEntries = serverCaptureEntryCount(nextJob);
      if (capturedEntries <= 0) return;
      await ingestServerCaptureJobEntries(nextJob, {
        seenEntryKeys: knowledgeImportedEntryKeys,
      });
      const imported = await importCaptureJobToAccount({
        accountId,
        sessionId: createdSessionId,
        platform,
        job: nextJob,
        seenEntryKeys: accountImportedEntryKeys,
        completeSession: false,
      });
      importedStats.posts += imported.posts.length;
      importedStats.media += imported.media.length;
      importedStats.comments += imported.comments.length;
      updateCaptureProgress(nextJob.progress?.message || '正在写入账号档案和知识库。', 28);
    };
    const enqueueImport = (job: ServerCaptureJob) => {
      importQueue = importQueue.then(() => importAvailableEntries(job));
      return importQueue;
    };

    updateCaptureProgress(pendingJobs[0]?.initialJob?.progress?.message || '账号采集任务已创建。', 24);
    const jobs = await Promise.all(pendingJobs.map(async ({ id, initialJob }) => {
      if (initialJob) await enqueueImport(initialJob);
      const completedJob = await pollServerCaptureJob(id, async (nextJob) => {
        updateCaptureProgress(nextJob.progress?.message || '账号采集任务处理中。', 30);
        await enqueueImport(nextJob);
      });
      await enqueueImport(completedJob);
      return completedJob;
    }));
    await importQueue;

    onProgress({
      phase: 'importing',
      title: '准备分析',
      message: '采集结果已入库，正在整理账号学习状态。',
      percent: 92,
      account,
      posts: Math.max(importedStats.posts, accountImportedEntryKeys.size),
      media: importedStats.media,
      comments: importedStats.comments,
      requested: SPACE_INIT_CAPTURE_TARGET_COUNT,
    });

    const capturedEntries = jobs.reduce((sum, job) => sum + serverCaptureEntryCount(job), 0);
    let completeResult: AccountImportCompleteResponse | null = null;
    if (createdSessionId) {
      completeResult = await window.ipcRenderer.accounts.completeImportSession<AccountImportCompleteResponse>({
        sessionId: createdSessionId,
        status: 'completed',
        importedPostCount: Math.max(importedStats.posts, accountImportedEntryKeys.size),
        failedPostCount: 0,
      });
      importCompleted = true;
    }
    const importedPosts = Math.max(importedStats.posts, accountImportedEntryKeys.size);
    const pendingVideoTranscriptions = Number(completeResult?.pendingVideoTranscriptions || 0);
    const failedVideoTranscriptions = Number(completeResult?.failedVideoTranscriptions || 0);

    onProgress({
      phase: 'handoff',
      title: '启动 AI 分析',
      message: '账号数据已准备好，正在进入诊断分析。',
      percent: 100,
      account,
      posts: importedPosts,
      media: importedStats.media,
      comments: importedStats.comments,
      requested: Math.max(SPACE_INIT_CAPTURE_TARGET_COUNT, capturedEntries),
      learningStatus: completeResult?.learningStatus,
      pendingVideoTranscriptions,
      failedVideoTranscriptions,
    });

    const nextState = await window.ipcRenderer.spaces.init.progress<SpaceInitState>({
      phase: 'chat',
      homepageUrl,
      platform,
      accountId,
      progress: {
        ...progressBase,
        branch: 'homepage',
        uiStage: 'analysis_handoff',
        accountId,
        importedPosts,
        importedMedia: importedStats.media,
        importedComments: importedStats.comments,
        capturedEntries,
        learningStatus: completeResult?.learningStatus || null,
        pendingVideoTranscriptions,
        failedVideoTranscriptions,
        updatedAt: new Date().toISOString(),
      },
    });

    return {
      nextState,
      message: buildHomepageMessage(homepageUrl, candidate, {
        account,
        importedPosts,
        importedMedia: importedStats.media,
        importedComments: importedStats.comments,
        learningStatus: completeResult?.learningStatus,
        pendingVideoTranscriptions,
        failedVideoTranscriptions,
      }),
    };
  } catch (error) {
    if (createdSessionId && !importCompleted) {
      await window.ipcRenderer.accounts.completeImportSession({
        sessionId: createdSessionId,
        status: 'failed',
        failedPostCount: 1,
        lastError: error instanceof Error ? error.message : '账号采集失败',
      }).catch((completeError) => {
        console.error('Failed to mark space initialization account import failed:', completeError);
      });
    }
    throw error;
  }
}
