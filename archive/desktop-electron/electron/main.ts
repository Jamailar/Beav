import { app, BrowserWindow, ipcMain, protocol, nativeImage, shell, clipboard, dialog, net } from 'electron'
import path from 'node:path'
import fs from 'node:fs/promises'
import fsSync from 'node:fs'
import { spawn } from 'node:child_process'
import { Blob as NodeBlob } from 'node:buffer'
import { pathToFileURL } from 'node:url'
import {
  getModelInputCapabilities,
  supportsAttachmentKindDirectInput,
} from '../shared/modelCapabilities';
import {
  ARTICLE_DRAFT_EXTENSION,
  AUDIO_DRAFT_EXTENSION,
  ensureManuscriptFileName,
  getDraftTypeFromFileName,
  getManuscriptExtension,
  getPackageKindFromFileName,
  isManuscriptPackageName,
  isSupportedManuscriptFile,
  POST_DRAFT_EXTENSION,
  stripManuscriptExtension,
  VIDEO_DRAFT_EXTENSION,
} from '../shared/manuscriptFiles';
import {
  saveSettings,
  getSettings,
  getWorkspacePaths,
  getWorkspacePathsForSpace,
  getDefaultWorkspaceDir,
  getActiveSpaceId,
  listSpaces,
  createSpace,
  renameSpace,
  setActiveSpace,
  listArchiveProfiles,
  createArchiveProfile,
  updateArchiveProfile,
  deleteArchiveProfile,
  listArchiveSamples,
  createArchiveSample,
  updateArchiveSample,
  deleteArchiveSample,
  getChatSessionByFile,
  getChatSessionByFileId,
  getChatSession,
  updateChatSessionMetadata,
  createChatSession,
  getChatSessions,
  getChatMessages,
  addChatMessage,
  deleteChatSession,
  clearChatMessages,
  updateChatSessionTitle,
  getChatSessionByContext,
  listSessionTranscriptRecords,
  listSessionCheckpoints,
  getDocumentKnowledgeIndexSummary,
  listDocumentKnowledgeIndexEntries,
  replaceDocumentKnowledgeIndexForSource,
} from './db'
import { indexManager } from './core/IndexManager'
import { embeddingService } from './core/vector/EmbeddingService'
import { normalizeNote, normalizeVideo, normalizeFile, normalizeArchiveSample } from './core/normalization'
import {
  createAgentExecutor,
  AgentExecutor,
  type AgentConfig,
  getAllKnowledgeItems
} from './core'
import { loadPrompt, renderPrompt } from './prompts/runtime';
import { fileWatcher } from './core/FileWatcherService'
import matter from 'gray-matter'
import { ulid } from 'ulid'
import { SkillManager } from './core/skillManager';
import {
  listUserMemoriesFromFile,
  listArchivedMemoriesFromFile,
  listMemoryHistoryFromFile,
  searchUserMemoriesInFile,
  addUserMemoryToFile,
  deleteUserMemoryFromFile,
  updateUserMemoryInFile,
} from './core/fileMemoryStore';
import { getRedClawProject, listRedClawProjects } from './core/redclawStore';
import {
  handleRedClawOnboardingTurn,
  loadRedClawProfilePromptBundle,
  updateRedClawProfileDocument,
} from './core/redclawProfileStore';
import {
  listMediaAssets,
  bindMediaAssetToManuscript,
  updateMediaAssetMetadata,
  deleteMediaAsset,
  importMediaFiles,
  importMediaSources,
  getAbsoluteMediaPath,
  type MediaAsset,
} from './core/mediaLibraryStore';
import { buildRuntimeBaseSystemPrompt } from './core/prompts/defaultPromptBuilder';
import {
  listCoverAssets,
  getAbsoluteCoverAssetPath,
  getCoverRootDir,
  saveCoverTemplateImage,
  type CoverAsset,
} from './core/coverStudioStore';
import {
  deleteCoverTemplate,
  importLegacyCoverTemplates,
  listCoverTemplates,
  saveCoverTemplate,
} from './core/coverTemplateStore';
import { loadOfficialFeatureModule } from './officialFeatureBridge';
import { applyGlobalNetworkProxy } from './core/networkProxy';
import {
  getDebugLogDirectory,
  getRecentDebugLogs,
  installDebugConsoleBridge,
  openDebugLogDirectory,
  setDebugLoggingEnabled,
} from './core/debugLogger';
import {
  listToolDiagnostics,
  runAiToolDiagnostic,
  runDirectToolDiagnostic,
} from './core/toolDiagnosticsService';
import { getAgentRuntime, getLongTaskCoordinator, getTaskGraphRuntime, listRoleSpecs, type RuntimeMode } from './core/ai';
import { getSessionRuntimeStore } from './core/sessionRuntimeStore';
import { listRuntimeHooks, registerRuntimeHook, unregisterRuntimeHook } from './core/runtimeHooks';
import { getWorkItemStore } from './core/workItemStore';
import { formatWechatArticleFromMarkdown } from './core/wechatFormatter';
import {
  bindWechatOfficialAccount,
  createWechatOfficialDraftFromMarkdown,
  getWechatOfficialAccountStatus,
  unbindWechatOfficialAccount,
} from './core/wechatOfficialAccountService';

if (typeof (globalThis as any).Blob === 'undefined' && typeof NodeBlob !== 'undefined') {
  (globalThis as any).Blob = NodeBlob;
}
if (typeof (globalThis as any).File === 'undefined' && typeof (globalThis as any).Blob !== 'undefined') {
  class FilePolyfill extends (globalThis as any).Blob {
    name: string;
    lastModified: number;
    constructor(parts: any[], fileName: string, options?: { type?: string; lastModified?: number }) {
      super(parts, options);
      this.name = String(fileName || '');
      this.lastModified = Number(options?.lastModified || Date.now());
    }
  }
  (globalThis as any).File = FilePolyfill;
}

installDebugConsoleBridge();
setDebugLoggingEnabled(Boolean((getSettings() as { debug_log_enabled?: boolean } | undefined)?.debug_log_enabled));
import {
  getMcpServers,
  saveMcpServers,
  testMcpServerConnection,
  discoverLocalMcpConfigs,
  importLocalMcpServers,
  getMcpOAuthStatus,
  type McpServerConfig,
} from './core/mcpStore';
import { normalizeApiBaseUrl, normalizeRemoteAssetUrl, safeUrlJoin } from './core/urlUtils';
import { resolveModelScopeFromContextType, resolveScopedModelName } from './core/modelScopeSettings';
import {
  isPathWithinRoots,
  resolveAssetSourceToPath,
  toAppAssetUrl,
} from './core/localAssetManager';
import {
  isLocalAssetSource,
  LEGACY_LOCAL_FILE_PROTOCOL,
  REDBOX_ASSET_PROTOCOL,
} from '../shared/localAsset';
import {
  createDocumentSourceId,
  ensureKnowledgeDocsDir,
  getKnowledgeDocsImportedDir,
  listDocumentFilesForSource,
  loadDocumentSources,
  saveDocumentSources,
  type DocumentSourceRecord,
  type DocumentSourceKind,
} from './core/documentKnowledgeStore';
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
} from './core/subjectsLibraryStore';

protocol.registerSchemesAsPrivileged([
  {
    scheme: REDBOX_ASSET_PROTOCOL,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
      corsEnabled: true,
      bypassCSP: true,
    },
  },
  {
    scheme: LEGACY_LOCAL_FILE_PROTOCOL,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
      corsEnabled: true,
      bypassCSP: true,
    },
  },
]);

// The built directory structure
process.env.DIST = path.join(__dirname, '../dist')
process.env.VITE_PUBLIC = app.isPackaged ? process.env.DIST : path.join(process.env.DIST, '../public')

let win: BrowserWindow | null
const VITE_DEV_SERVER_URL = process.env['VITE_DEV_SERVER_URL']
let redClawRunnerListenersAttached = false;
let backgroundTaskRegistryListenersAttached = false;
let advisorYoutubeRunnerListenersAttached = false;
let assistantDaemonListenersAttached = false;
let workItemStoreListenersAttached = false;
let appShutdownInProgress = false;
let appShutdownPromise: Promise<void> | null = null;
const MANUSCRIPT_TREE_CACHE_TTL_MS = 4000;
const manuscriptTreeCache = new Map<string, { tree: unknown[]; generatedAt: number }>();
type EditorRuntimeStateRecord = {
  filePath: string;
  sessionId?: string;
  playheadSeconds: number;
  selectedClipId?: string;
  selectedClipIds?: unknown;
  activeTrackId?: string;
  selectedTrackIds?: unknown;
  selectedSceneId?: string;
  previewTab?: string;
  canvasRatioPreset?: string;
  activePanel?: string;
  drawerPanel?: string;
  sceneItemTransforms?: unknown;
  sceneItemVisibility?: unknown;
  sceneItemOrder?: unknown;
  sceneItemLocks?: unknown;
  sceneItemGroups?: unknown;
  focusedGroupId?: string;
  trackUi?: unknown;
  viewportScrollLeft: number;
  viewportMaxScrollLeft: number;
  viewportScrollTop: number;
  viewportMaxScrollTop: number;
  timelineZoomPercent: number;
  undoStack: unknown[];
  redoStack: unknown[];
  updatedAt: number;
};
const editorRuntimeStates = new Map<string, EditorRuntimeStateRecord>();

function nowMs() {
  return Date.now();
}

function buildEmptyEditorRuntimeState(filePath: string): EditorRuntimeStateRecord {
  return {
    filePath,
    playheadSeconds: 0,
    viewportScrollLeft: 0,
    viewportMaxScrollLeft: 0,
    viewportScrollTop: 0,
    viewportMaxScrollTop: 0,
    timelineZoomPercent: 100,
    selectedClipIds: [],
    selectedTrackIds: [],
    undoStack: [],
    redoStack: [],
    updatedAt: nowMs(),
  };
}

function serializeEditorRuntimeState(filePath: string) {
  const state = editorRuntimeStates.get(filePath) || buildEmptyEditorRuntimeState(filePath);
  return {
    filePath: state.filePath,
    sessionId: state.sessionId ?? null,
    playheadSeconds: state.playheadSeconds,
    selectedClipId: state.selectedClipId ?? null,
    selectedClipIds: state.selectedClipIds ?? [],
    activeTrackId: state.activeTrackId ?? null,
    selectedTrackIds: state.selectedTrackIds ?? [],
    selectedSceneId: state.selectedSceneId ?? null,
    previewTab: state.previewTab ?? null,
    canvasRatioPreset: state.canvasRatioPreset ?? null,
    activePanel: state.activePanel ?? null,
    drawerPanel: state.drawerPanel ?? null,
    sceneItemTransforms: state.sceneItemTransforms ?? null,
    sceneItemVisibility: state.sceneItemVisibility ?? null,
    sceneItemOrder: state.sceneItemOrder ?? null,
    sceneItemLocks: state.sceneItemLocks ?? null,
    sceneItemGroups: state.sceneItemGroups ?? null,
    focusedGroupId: state.focusedGroupId ?? null,
    trackUi: state.trackUi ?? null,
    viewportScrollLeft: state.viewportScrollLeft,
    viewportMaxScrollLeft: state.viewportMaxScrollLeft,
    viewportScrollTop: state.viewportScrollTop,
    viewportMaxScrollTop: state.viewportMaxScrollTop,
    timelineZoomPercent: state.timelineZoomPercent,
    canUndo: state.undoStack.length > 0,
    canRedo: state.redoStack.length > 0,
    updatedAt: state.updatedAt,
  };
}

function normalizeBindingText(value: unknown): string {
  return String(value || '').trim();
}

function normalizeBindingMetadata(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? { ...(value as Record<string, unknown>) }
    : {};
}

function deriveEditorBindingInitialContext(
  binding: {
    filePath?: string;
    contextId: string;
    modeLabel?: string;
    targetTypeLabel?: string;
    targetPath?: string;
    initialContext?: string;
  },
  metadata: Record<string, unknown>,
): string | undefined {
  const explicit = normalizeBindingText(binding.initialContext);
  if (explicit) {
    return explicit;
  }

  const modeLabel = normalizeBindingText(binding.modeLabel)
    || normalizeBindingText(metadata.associatedPackageWorkspaceModeLabel)
    || normalizeBindingText(metadata.associatedPackageWorkspaceMode)
    || '文件';
  const targetTypeLabel = normalizeBindingText(binding.targetTypeLabel)
    || normalizeBindingText(metadata.associatedPackageKind)
    || '文件';
  const targetPath = normalizeBindingText(binding.targetPath)
    || normalizeBindingText(metadata.associatedFilePath)
    || normalizeBindingText(binding.filePath)
    || normalizeBindingText(binding.contextId);
  if (!targetPath) {
    return undefined;
  }

  return `当前聊天窗口正处于${modeLabel}模式，正在编辑的${targetTypeLabel}文件路径是${targetPath}`;
}

function emitRendererDataChanged(scope: string, payload: Record<string, unknown> = {}) {
  for (const browserWindow of BrowserWindow.getAllWindows()) {
    if (browserWindow.isDestroyed()) continue;
    browserWindow.webContents.send('data:changed', {
      scope,
      ...payload,
    });
  }
}

function invalidateManuscriptTreeCache(scopePath?: string) {
  if (scopePath) {
    manuscriptTreeCache.delete(scopePath);
    return;
  }
  manuscriptTreeCache.clear();
}

function attachWorkItemStoreListeners() {
  if (workItemStoreListenersAttached) return;
  workItemStoreListenersAttached = true;
  getWorkItemStore().on('work-item-updated', (item: { id?: string } | null | undefined) => {
    emitRendererDataChanged('work', {
      action: 'store-update',
      entityId: String(item?.id || '').trim() || undefined,
    });
  });
}

async function getRedClawBackgroundRunnerLazy() {
  const module = await import('./core/redclawBackgroundRunner');
  return module.getRedClawBackgroundRunner();
}

async function getAdvisorYoutubeRunnerLazy() {
  const module = await import('./core/advisorYoutubeRunner');
  return module.getAdvisorYoutubeBackgroundRunner();
}

async function getDefaultAdvisorYoutubeChannelConfigLazy(input?: unknown) {
  const module = await import('./core/advisorYoutubeRunner');
  return module.getDefaultAdvisorYoutubeChannelConfig(input as Parameters<typeof module.getDefaultAdvisorYoutubeChannelConfig>[0]);
}

async function getMemoryMaintenanceServiceLazy() {
  const module = await import('./core/memoryMaintenanceService');
  return module.getMemoryMaintenanceService();
}

async function getBackgroundTaskRegistryLazy() {
  const module = await import('./core/backgroundTaskRegistry');
  return module.getBackgroundTaskRegistry();
}

async function getAssistantDaemonServiceLazy() {
  const module = await import('./core/assistantDaemonService');
  return module.getAssistantDaemonService();
}

async function getSessionBridgeServiceLazy() {
  const module = await import('./core/sessionBridgeService');
  return module.getSessionBridgeService();
}

async function getHeadlessWorkerProcessManagerLazy() {
  const module = await import('./core/headlessWorkerProcessManager');
  return module.getHeadlessWorkerProcessManager();
}

async function shouldAutoStartAssistantDaemonAcrossSpaces(): Promise<boolean> {
  const knownSpaceIds = Array.from(new Set([
    ...listSpaces().map((item) => item.id),
    getActiveSpaceId(),
  ].filter(Boolean)));
  for (const spaceId of knownSpaceIds) {
    const configPath = path.join(getWorkspacePathsForSpace(spaceId).redclaw, 'assistant-daemon.json');
    try {
      const raw = await fs.readFile(configPath, 'utf-8');
      const parsed = JSON.parse(raw) as {
        enabled?: boolean;
        autoStart?: boolean;
      };
      if (Boolean(parsed?.enabled) && parsed?.autoStart !== false) {
        return true;
      }
    } catch {
      // ignore missing or malformed configs; the daemon service validates on demand
    }
  }
  return false;
}

const appStartupEpochMs = Date.now();
const startupPhaseMarks = new Map<string, number>();
const DOWNLOAD_RETRY_DELAYS_MS = [0, 600, 1600];
const XHS_ASSET_REQUEST_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36 RedBox/1.0',
  'Referer': 'https://www.xiaohongshu.com/',
  'Origin': 'https://www.xiaohongshu.com',
  'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
};
const APP_UPDATE_RELEASES_PAGE_URL = 'https://github.com/Jamailar/RedBox/releases';
const APP_UPDATE_LATEST_RELEASE_API_URL = 'https://api.github.com/repos/Jamailar/RedBox/releases/latest';
const APP_UPDATE_CHECK_TIMEOUT_MS = 10000;
const APP_UPDATE_CHECK_MIN_INTERVAL_MS = 6 * 60 * 60 * 1000;
let appUpdateCheckInFlight = false;
let appUpdateLastCheckedAt = 0;

function markStartupPhase(label: string): void {
  const now = Date.now();
  const last = startupPhaseMarks.get('__last__') ?? appStartupEpochMs;
  startupPhaseMarks.set('__last__', now);
  startupPhaseMarks.set(label, now);
  console.log('[Startup]', label, {
    sinceLaunchMs: now - appStartupEpochMs,
    sincePrevPhaseMs: now - last,
  });
}
const ADVISOR_OPTIMIZE_SYSTEM_PROMPT = loadPrompt(
  'runtime/advisors/optimize_system.txt',
  '你是一个专业的 Prompt 工程师，请根据用户描述优化系统提示词。'
);
const ADVISOR_OPTIMIZE_DEEP_SYSTEM_PROMPT = loadPrompt(
  'runtime/advisors/optimize_deep_system.txt',
  '你是一位专业的 AI 角色设计师和 Prompt 工程师。'
);
const ADVISOR_OPTIMIZE_DEEP_USER_TEMPLATE = loadPrompt(
  'runtime/advisors/optimize_deep_user.txt',
  '名称: {{name}}\n描述: {{personality}}\n当前设定: {{current_prompt}}\n搜索: {{search_summary}}\n知识: {{knowledge_summary}}'
);
const SIX_HAT_PROMPTS = {
  white: loadPrompt('runtime/six_hats/white.txt', '你是六顶思考帽中的白帽。'),
  red: loadPrompt('runtime/six_hats/red.txt', '你是六顶思考帽中的红帽。'),
  black: loadPrompt('runtime/six_hats/black.txt', '你是六顶思考帽中的黑帽。'),
  yellow: loadPrompt('runtime/six_hats/yellow.txt', '你是六顶思考帽中的黄帽。'),
  green: loadPrompt('runtime/six_hats/green.txt', '你是六顶思考帽中的绿帽。'),
  blue: loadPrompt('runtime/six_hats/blue.txt', '你是六顶思考帽中的蓝帽。'),
};
const REDCLAW_WRITE_XHS_TEMPLATE = loadPrompt(
  'runtime/redclaw/write_xiaohongshu.txt',
  '请按小红书创作要求完成任务，并最终保存文案包。\n\n{{user_brief}}',
);
const REDCLAW_WRITE_WECHAT_TEMPLATE = loadPrompt(
  'runtime/redclaw/write_wechat_article.txt',
  '请按公众号文章创作要求完成任务，并最终保存稿件包。\n\n{{user_brief}}',
);
const REDCLAW_EXPAND_XHS_TO_WECHAT_TEMPLATE = loadPrompt(
  'runtime/redclaw/expand_xhs_to_wechat.txt',
  '请把下面的小红书内容扩写成公众号文章，并最终保存稿件包。\n\n{{user_brief}}',
);
let appUpdateLastNotifiedVersion = '';
const advisorAvatarLocalizationInFlight = new Set<string>();
type AdvisorSummaryRecord = {
  id: string;
  name: string;
  avatar: string;
  personality: string;
  knowledgeLanguage: string;
  createdAt: string;
  hasYoutubeChannel: boolean;
};
type AdvisorDetailRecord = AdvisorSummaryRecord & {
  systemPrompt: string;
  knowledgeFiles: string[];
};
let advisorListCache: AdvisorSummaryRecord[] | null = null;
const advisorDetailCache = new Map<string, AdvisorDetailRecord>();

function invalidateAdvisorCache(advisorId?: string): void {
  advisorListCache = null;
  if (advisorId) {
    advisorDetailCache.delete(advisorId);
    return;
  }
  advisorDetailCache.clear();
}

async function buildAdvisorSummary(advisorId: string, config: Record<string, unknown>): Promise<AdvisorSummaryRecord> {
  const advisorDir = path.join(getAdvisorsDir(), advisorId);
  const configPath = path.join(advisorDir, 'config.json');
  const avatar = String(config.avatar || '').trim();
  if (avatar.startsWith('http')) {
    localizeAdvisorAvatarInBackground(advisorDir, configPath, config);
  }
  return {
    id: advisorId,
    name: String(config.name || ''),
    avatar: resolveAdvisorAvatarForList(advisorDir, config),
    personality: String(config.personality || ''),
    knowledgeLanguage: String(config.knowledgeLanguage || ''),
    createdAt: String(config.createdAt || ''),
    hasYoutubeChannel: Boolean((config.youtubeChannel as Record<string, unknown> | undefined)?.url),
  };
}

async function buildAdvisorDetail(advisorId: string): Promise<AdvisorDetailRecord> {
  const advisorDir = path.join(getAdvisorsDir(), advisorId);
  const configPath = path.join(advisorDir, 'config.json');
  const knowledgeDir = path.join(advisorDir, 'knowledge');
  const content = await fs.readFile(configPath, 'utf-8');
  const config = JSON.parse(content) as Record<string, unknown>;
  const summary = await buildAdvisorSummary(advisorId, config);

  let knowledgeFiles: string[] = [];
  try {
    const files = await fs.readdir(knowledgeDir);
    knowledgeFiles = files.filter((f: string) => f.endsWith('.txt') || f.endsWith('.md'));
  } catch {
    knowledgeFiles = [];
  }

  return {
    ...summary,
    systemPrompt: String(config.systemPrompt || ''),
    knowledgeFiles,
  };
}
let localAssetProtocolsRegistered = false;
const BROWSER_PLUGIN_BUNDLE_RELATIVE_PATH = path.join('.plugin-runtime', 'browser-extension');
const BROWSER_PLUGIN_EXPORT_RELATIVE_PATH = path.join('integrations', 'browser-extension', 'redbox-capture');

const appSingleInstanceLock = app.requestSingleInstanceLock();
type RedClawAuthoringHints = {
  platform: 'xiaohongshu' | 'wechat_official_account';
  taskType: 'direct_write' | 'expand_from_xhs';
  formatTarget?: 'markdown' | 'wechat_rich_text';
  sourcePlatform?: 'xiaohongshu' | 'wechat_official_account';
  sourceNoteId?: string;
  sourceMode?: 'manual' | 'knowledge' | 'manuscript';
  sourceTitle?: string;
  sourceManuscriptPath?: string;
};

const WECHAT_OFFICIAL_SKILL_NAME = 'wechat-official-formatter';

function normalizeRedClawAuthoringHints(raw: unknown): RedClawAuthoringHints | null {
  if (!raw || typeof raw !== 'object') return null;
  const record = raw as Record<string, unknown>;
  const platform = String(record.platform || '').trim();
  const taskType = String(record.taskType || '').trim();
  if ((platform !== 'xiaohongshu' && platform !== 'wechat_official_account')
    || (taskType !== 'direct_write' && taskType !== 'expand_from_xhs')) {
    return null;
  }
  const sourcePlatform = String(record.sourcePlatform || '').trim();
  const sourceMode = String(record.sourceMode || '').trim();
  return {
    platform,
    taskType,
    formatTarget: String(record.formatTarget || '').trim() === 'wechat_rich_text' ? 'wechat_rich_text' : 'markdown',
    sourcePlatform: (sourcePlatform === 'xiaohongshu' || sourcePlatform === 'wechat_official_account') ? sourcePlatform : undefined,
    sourceNoteId: String(record.sourceNoteId || '').trim() || undefined,
    sourceMode: (sourceMode === 'manual' || sourceMode === 'knowledge' || sourceMode === 'manuscript') ? sourceMode : undefined,
    sourceTitle: String(record.sourceTitle || '').trim() || undefined,
    sourceManuscriptPath: String(record.sourceManuscriptPath || '').trim() || undefined,
  };
}

function buildRedClawAuthoringPrompt(userBrief: string, hints: RedClawAuthoringHints): string {
  const template = hints.taskType === 'expand_from_xhs'
    ? REDCLAW_EXPAND_XHS_TO_WECHAT_TEMPLATE
    : hints.platform === 'wechat_official_account'
      ? REDCLAW_WRITE_WECHAT_TEMPLATE
      : REDCLAW_WRITE_XHS_TEMPLATE;
  return renderPrompt(template, {
    platform: hints.platform,
    task_type: hints.taskType,
    source_mode: hints.sourceMode || 'manual',
    source_platform: hints.sourcePlatform || '',
    source_note_id: hints.sourceNoteId || '',
    source_title: hints.sourceTitle || '',
    source_manuscript_path: hints.sourceManuscriptPath || '',
    user_brief: userBrief,
  }).trim();
}

function resolveForcedSkillNames(input: unknown): string[] {
  const record = (input && typeof input === 'object') ? input as Record<string, unknown> : null;
  if (!record) return [];
  const platform = String(record.platform || '').trim();
  const formatTarget = String(record.formatTarget || '').trim();
  if (platform === 'wechat_official_account' || formatTarget === 'wechat_rich_text') {
    return [WECHAT_OFFICIAL_SKILL_NAME];
  }
  return [];
}

function emitForcedSkillActivationEvents(sender: Electron.WebContents, skillNames: string[]): void {
  for (const skillName of skillNames) {
    if (skillName === WECHAT_OFFICIAL_SKILL_NAME) {
      sender.send('chat:skill-activated', {
        name: WECHAT_OFFICIAL_SKILL_NAME,
        description: '公众号写作、扩写、排版与草稿发布能力已激活。',
      });
    }
  }
}

if (!appSingleInstanceLock) {
  app.exit(0);
}

const getBundledBrowserPluginCandidateDirs = (): string[] => {
  const appPath = app.getAppPath();
  const resourcesPath = process.resourcesPath || path.resolve(appPath, '..');
  const candidates = [
    // Packaged app: prefer the unpacked location because directory traversal inside app.asar is unreliable.
    path.join(resourcesPath, 'app.asar.unpacked', BROWSER_PLUGIN_BUNDLE_RELATIVE_PATH),
    path.join(resourcesPath, BROWSER_PLUGIN_BUNDLE_RELATIVE_PATH),
    path.join(appPath, BROWSER_PLUGIN_BUNDLE_RELATIVE_PATH),
    path.join(process.cwd(), BROWSER_PLUGIN_BUNDLE_RELATIVE_PATH),
    path.join(process.cwd(), 'archive', 'desktop-electron', BROWSER_PLUGIN_BUNDLE_RELATIVE_PATH),
    path.join(process.cwd(), 'Plugin'),
    path.join(path.resolve(appPath, '..'), 'Plugin'),
  ];
  return Array.from(new Set(candidates.map((item) => path.resolve(item))));
};

const isUsableBrowserPluginDir = async (candidate: string): Promise<boolean> => {
  try {
    const stats = await fs.stat(candidate);
    if (!stats.isDirectory()) return false;
    await fs.access(path.join(candidate, 'manifest.json'));
    const dir = await fs.opendir(candidate);
    await dir.close();
    return true;
  } catch {
    return false;
  }
};

const findBundledBrowserPluginDir = async (): Promise<string | null> => {
  const candidates = getBundledBrowserPluginCandidateDirs();
  for (const candidate of candidates) {
    if (await isUsableBrowserPluginDir(candidate)) {
      return candidate;
    }
  }
  return null;
};

const getExportedBrowserPluginDir = (): string => {
  return path.join(app.getPath('userData'), BROWSER_PLUGIN_EXPORT_RELATIVE_PATH);
};

const getExportedBrowserPluginMetaPath = (): string => {
  return path.join(getExportedBrowserPluginDir(), '.redbox-plugin-meta.json');
};

const pathExists = async (targetPath: string): Promise<boolean> => {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
};

const ensureBrowserPluginPrepared = async (): Promise<{ path: string; alreadyPrepared: boolean }> => {
  const sourceDir = await findBundledBrowserPluginDir();
  if (!sourceDir) {
    throw new Error(`内置插件资源不存在，已检查：${getBundledBrowserPluginCandidateDirs().join(' | ')}`);
  }

  const targetDir = getExportedBrowserPluginDir();
  const metaPath = getExportedBrowserPluginMetaPath();
  const alreadyPrepared = await pathExists(targetDir);
  if (alreadyPrepared && app.isPackaged) {
    try {
      const raw = await fs.readFile(metaPath, 'utf-8');
      const parsed = JSON.parse(raw) as {
        appVersion?: string;
        sourceDir?: string;
      };
      if (parsed?.appVersion === app.getVersion() && parsed?.sourceDir === path.basename(sourceDir)) {
        return { path: targetDir, alreadyPrepared: true };
      }
    } catch {
      // stale or missing metadata; fall through and refresh the exported extension
    }
  }

  await fs.rm(targetDir, { recursive: true, force: true });
  await fs.mkdir(path.dirname(targetDir), { recursive: true });
  await fs.cp(sourceDir, targetDir, { recursive: true });
  await fs.writeFile(metaPath, JSON.stringify({
    appVersion: app.getVersion(),
    sourceDir: path.basename(sourceDir),
    preparedAt: new Date().toISOString(),
  }, null, 2), 'utf-8');
  return { path: targetDir, alreadyPrepared };
};

const warmupBrowserPluginPrepared = async (): Promise<void> => {
  try {
    await ensureBrowserPluginPrepared();
  } catch (error) {
    console.warn('[browser-plugin] warmup skipped:', error);
  }
};

const getAllowedLocalFileRoots = (): string[] => {
  const workspacePaths = getWorkspacePaths();
  const appPath = app.getAppPath();
  const distPath = process.env.DIST ? path.resolve(process.env.DIST) : path.join(appPath, 'dist');
  return Array.from(new Set([
    workspacePaths.workspaceRoot,
    workspacePaths.base,
    getDefaultWorkspaceDir(),
    app.getPath('userData'),
    app.getPath('home'),
    app.getPath('documents'),
    app.getPath('downloads'),
    app.getPath('temp'),
    appPath,
    distPath,
  ].map((item) => path.resolve(String(item || '')))));
};

const normalizeAiSourceListJson = (raw: unknown): string | undefined => {
  if (typeof raw !== 'string' || !raw.trim()) {
    return typeof raw === 'string' ? raw : undefined;
  }

  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return raw;
    }

    const normalized = parsed.map((item) => {
      if (!item || typeof item !== 'object') {
        return item;
      }
      const source = item as Record<string, unknown>;
      return {
        ...source,
        baseURL: normalizeApiBaseUrl(String(source.baseURL || source.baseUrl || '')),
      };
    });
    return JSON.stringify(normalized);
  } catch {
    return raw;
  }
};

const normalizeSettingsInput = (settings: Record<string, unknown>) => {
  const normalized: Record<string, unknown> = { ...settings };

  if (Object.prototype.hasOwnProperty.call(settings, 'api_endpoint')) {
    normalized.api_endpoint = normalizeApiBaseUrl(String(settings.api_endpoint || ''));
  }
  if (Object.prototype.hasOwnProperty.call(settings, 'transcription_endpoint')) {
    normalized.transcription_endpoint = normalizeApiBaseUrl(String(settings.transcription_endpoint || ''));
  }
  if (Object.prototype.hasOwnProperty.call(settings, 'embedding_endpoint')) {
    normalized.embedding_endpoint = normalizeApiBaseUrl(String(settings.embedding_endpoint || ''));
  }
  if (Object.prototype.hasOwnProperty.call(settings, 'image_endpoint')) {
    normalized.image_endpoint = normalizeApiBaseUrl(String(settings.image_endpoint || ''));
  }
  if (Object.prototype.hasOwnProperty.call(settings, 'search_endpoint')) {
    normalized.search_endpoint = normalizeApiBaseUrl(String(settings.search_endpoint || ''));
  }
  if (Object.prototype.hasOwnProperty.call(settings, 'model_name_wander')) {
    normalized.model_name_wander = String(settings.model_name_wander || '').trim();
  }
  if (Object.prototype.hasOwnProperty.call(settings, 'model_name_chatroom')) {
    normalized.model_name_chatroom = String(settings.model_name_chatroom || '').trim();
  }
  if (Object.prototype.hasOwnProperty.call(settings, 'model_name_knowledge')) {
    normalized.model_name_knowledge = String(settings.model_name_knowledge || '').trim();
  }
  if (Object.prototype.hasOwnProperty.call(settings, 'model_name_redclaw')) {
    normalized.model_name_redclaw = String(settings.model_name_redclaw || '').trim();
  }
  if (Object.prototype.hasOwnProperty.call(settings, 'ai_sources_json')) {
    normalized.ai_sources_json = normalizeAiSourceListJson(settings.ai_sources_json);
  }
  if (Object.prototype.hasOwnProperty.call(settings, 'search_provider')) {
    normalized.search_provider = String(settings.search_provider || 'duckduckgo').trim().toLowerCase() || 'duckduckgo';
  }
  if (Object.prototype.hasOwnProperty.call(settings, 'search_api_key')) {
    normalized.search_api_key = String(settings.search_api_key || '').trim();
  }
  if (Object.prototype.hasOwnProperty.call(settings, 'proxy_enabled')) {
    normalized.proxy_enabled = Boolean(settings.proxy_enabled);
  }
  if (Object.prototype.hasOwnProperty.call(settings, 'proxy_url')) {
    normalized.proxy_url = String(settings.proxy_url || '').trim();
  }
  if (Object.prototype.hasOwnProperty.call(settings, 'proxy_bypass')) {
    normalized.proxy_bypass = String(settings.proxy_bypass || '').trim();
  }

  return normalized;
};

const normalizeVersionTag = (raw: string): string => {
  return String(raw || '').trim().replace(/^v/i, '');
};

const compareSemverLike = (current: string, latest: string): number => {
  const parse = (input: string): number[] => {
    const normalized = normalizeVersionTag(input).split('-')[0];
    const parts = normalized.split('.').map((item) => Number.parseInt(item, 10));
    const safe = parts.map((item) => Number.isFinite(item) ? item : 0);
    while (safe.length < 4) safe.push(0);
    return safe.slice(0, 4);
  };

  const left = parse(current);
  const right = parse(latest);
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const a = left[i] || 0;
    const b = right[i] || 0;
    if (a > b) return 1;
    if (a < b) return -1;
  }
  return 0;
};

async function fetchLatestGithubRelease(): Promise<{
  version: string;
  htmlUrl: string;
  name: string;
  publishedAt: string;
  body: string;
}> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), APP_UPDATE_CHECK_TIMEOUT_MS);
  try {
    const response = await fetch(APP_UPDATE_LATEST_RELEASE_API_URL, {
      method: 'GET',
      headers: {
        'Accept': 'application/vnd.github+json',
        'User-Agent': `RedBox/${app.getVersion()}`,
      },
      signal: controller.signal,
    });
    if (response.status === 404) {
      throw new Error('GitHub latest release not found');
    }
    if (!response.ok) {
      throw new Error(`GitHub latest release request failed: HTTP ${response.status}`);
    }
    const data = await response.json() as {
      tag_name?: string;
      html_url?: string;
      name?: string;
      draft?: boolean;
      prerelease?: boolean;
      published_at?: string;
      body?: string;
    };
    if (data.draft) {
      throw new Error('Latest release is draft');
    }
    if (data.prerelease) {
      throw new Error('Latest release is prerelease');
    }
    const version = normalizeVersionTag(String(data.tag_name || ''));
    if (!version) {
      throw new Error('Latest release tag is empty');
    }
    return {
      version,
      htmlUrl: String(data.html_url || APP_UPDATE_RELEASES_PAGE_URL),
      name: String(data.name || ''),
      publishedAt: String(data.published_at || ''),
      body: String(data.body || ''),
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

interface AppUpdateNoticePayload {
  currentVersion: string;
  latestVersion: string;
  htmlUrl: string;
  name: string;
  publishedAt: string;
  body: string;
}

interface AppUpdateCheckResult {
  success: boolean;
  hasUpdate: boolean;
  throttled?: boolean;
  inFlight?: boolean;
  message?: string;
  notice?: AppUpdateNoticePayload;
}

const isHttpUrl = (value: string): boolean => /^https?:\/\//i.test(String(value || '').trim());

const notifyAppUpdateAvailable = (payload: AppUpdateNoticePayload, forceNotify = false): void => {
  if (!forceNotify && appUpdateLastNotifiedVersion === payload.latestVersion) {
    return;
  }
  appUpdateLastNotifiedVersion = payload.latestVersion;
  win?.webContents.send('app:update-available', payload);
};

async function checkForAppUpdate(force = false, forceNotify = false): Promise<AppUpdateCheckResult> {
  const now = Date.now();
  if (appUpdateCheckInFlight) {
    return {
      success: false,
      hasUpdate: false,
      inFlight: true,
      message: 'Update check already in flight',
    };
  }
  if (!force && now - appUpdateLastCheckedAt < APP_UPDATE_CHECK_MIN_INTERVAL_MS) {
    return {
      success: true,
      hasUpdate: false,
      throttled: true,
      message: 'Update check skipped due to interval throttling',
    };
  }
  appUpdateCheckInFlight = true;
  appUpdateLastCheckedAt = now;

  try {
    const latest = await fetchLatestGithubRelease();
    const currentVersion = normalizeVersionTag(app.getVersion());
    const hasUpdate = compareSemverLike(currentVersion, latest.version) < 0;
    const notice: AppUpdateNoticePayload = {
      currentVersion,
      latestVersion: latest.version,
      htmlUrl: latest.htmlUrl || APP_UPDATE_RELEASES_PAGE_URL,
      name: latest.name,
      publishedAt: latest.publishedAt,
      body: latest.body,
    };

    if (!hasUpdate) {
      return {
        success: true,
        hasUpdate: false,
        notice,
      };
    }

    notifyAppUpdateAvailable(notice, forceNotify);
    return {
      success: true,
      hasUpdate: true,
      notice,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message === 'GitHub latest release not found') {
      return {
        success: true,
        hasUpdate: false,
        message: 'No published release found',
      };
    }
    console.warn('[AppUpdate] check failed:', error);
    return {
      success: false,
      hasUpdate: false,
      message,
    };
  } finally {
    appUpdateCheckInFlight = false;
  }
}

function createWindow() {
  attachWorkItemStoreListeners();
  const iconPath = path.join(app.getAppPath(), 'redbox.png');
  const devIconPath = path.join(process.cwd(), 'archive', 'desktop-electron', 'redbox.png');
  const resolvedIconPath = app.isPackaged ? iconPath : devIconPath;

  win = new BrowserWindow({
    icon: resolvedIconPath,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      webviewTag: true,
    },
    width: 1200,
    height: 800,
    backgroundColor: '#FFFFFF',

  })

  win.webContents.on('did-finish-load', () => {
    win?.webContents.send('main-process-message', (new Date).toLocaleString())
  })

  if (VITE_DEV_SERVER_URL) {
    win.loadURL(VITE_DEV_SERVER_URL)
  } else {
    const distDir = process.env.DIST || path.join(__dirname, '../dist');
    win.loadFile(path.join(distDir, 'index.html'))
  }

  if (process.platform === 'darwin') {
    const dockIcon = nativeImage.createFromPath(resolvedIconPath);
    if (!dockIcon.isEmpty() && app.dock) {
      app.dock.setIcon(dockIcon);
    }
  }
}

function broadcastSettingsUpdated() {
  for (const win of BrowserWindow.getAllWindows()) {
    try {
      win.webContents.send('settings:updated');
    } catch {
      // ignore disposed windows
    }
  }
}

function stopHttpServer(): Promise<void> {
  if (!httpServer) {
    return Promise.resolve();
  }
  const server = httpServer;
  httpServer = null;
  return new Promise<void>((resolve) => {
    try {
      server.close(() => resolve());
    } catch {
      resolve();
    }
  });
}

async function shutdownBackgroundServices(): Promise<void> {
  if (appShutdownPromise) {
    return appShutdownPromise;
  }

  appShutdownPromise = (async () => {
    const errors: Array<{ label: string; error: unknown }> = [];
    const capture = async (label: string, task: () => Promise<unknown> | unknown) => {
      try {
        await task();
      } catch (error) {
        errors.push({ label, error });
      }
    };

    fileWatcher.stop();
    (await getMemoryMaintenanceServiceLazy()).stop();
    (await getAdvisorYoutubeRunnerLazy()).stop();

    await Promise.allSettled([
      capture('http-server', () => stopHttpServer()),
      capture('redclaw-runner', async () => (await getRedClawBackgroundRunnerLazy()).stop({ persist: false })),
      capture('assistant-daemon', async () => (await getAssistantDaemonServiceLazy()).dispose()),
      capture('headless-workers', async () => (await getHeadlessWorkerProcessManagerLazy()).dispose()),
      capture('session-bridge', async () => (await getSessionBridgeServiceLazy()).stop()),
    ]);

    if (errors.length > 0) {
      for (const item of errors) {
        console.error(`[Shutdown] Failed to stop ${item.label}:`, item.error);
      }
    }
  })();

  return appShutdownPromise;
}

app.on('window-all-closed', async () => {
  if (process.platform !== 'darwin') {
    if (process.platform === 'win32') {
      app.quit();
      win = null;
      return;
    }
    try {
      const [keepRedClawAlive, keepAdvisorYoutubeAlive, keepAssistantDaemonAlive] = await Promise.all([
        (await getRedClawBackgroundRunnerLazy()).shouldKeepAliveWhenNoWindow(),
        (await getAdvisorYoutubeRunnerLazy()).shouldKeepAliveWhenNoWindow(),
        (await getAssistantDaemonServiceLazy()).shouldKeepAliveWhenNoWindow(),
      ]);
      if (keepRedClawAlive || keepAdvisorYoutubeAlive || keepAssistantDaemonAlive) {
        console.log('[BackgroundRunner] Keep app alive in background (no window).', {
          redclaw: keepRedClawAlive,
          advisorYoutube: keepAdvisorYoutubeAlive,
          assistantDaemon: keepAssistantDaemonAlive,
        });
        win = null;
        return;
      }
    } catch (error) {
      console.warn('[BackgroundRunner] keep-alive check failed:', error);
    }
    app.quit()
    win = null
  }
})

app.on('before-quit', (event) => {
  if (appShutdownInProgress) {
    return;
  }
  appShutdownInProgress = true;
  event.preventDefault();
  void shutdownBackgroundServices()
    .catch((error) => {
      console.error('[Shutdown] Background shutdown failed:', error);
    })
    .finally(() => {
      app.exit(0);
    });
});

app.on('second-instance', () => {
  const existingWindow = BrowserWindow.getAllWindows()[0];
  if (existingWindow) {
    if (existingWindow.isMinimized()) {
      existingWindow.restore();
    }
    existingWindow.show();
    existingWindow.focus();
    return;
  }
  createWindow();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow()
  }
})

app.on('web-contents-created', (_event, contents) => {
  contents.setWindowOpenHandler(({ url }) => {
    const targetUrl = String(url || '').trim();
    const isHttpUrl = /^https?:\/\//i.test(targetUrl);

    if (contents.getType() === 'webview') {
      const hostContents = (contents as unknown as { hostWebContents?: Electron.WebContents }).hostWebContents;
      if (isHttpUrl) {
        hostContents?.send('xhs:open-in-tab', { url: targetUrl });
      }
      return { action: 'deny' };
    }

    if (isHttpUrl) {
      void shell.openExternal(targetUrl);
    }

    return { action: 'deny' };
  });
});

const registerLocalAssetProtocols = () => {
  if (localAssetProtocolsRegistered) return;
  localAssetProtocolsRegistered = true;

  const handleAssetRequest = (schemeName: string) => async (request: Request) => {
    let normalizedPath = '';
    try {
      normalizedPath = resolveAssetSourceToPath(request.url);
    } catch (error) {
      console.error(`[${schemeName}] Failed to parse URL:`, request.url, error);
      return new Response('Invalid asset URL', { status: 400 });
    }

    let resolvedPath = normalizedPath;
    try {
      resolvedPath = fsSync.realpathSync.native(normalizedPath);
    } catch {
      resolvedPath = normalizedPath;
    }

    const allowedRoots = getAllowedLocalFileRoots();
    if (!isPathWithinRoots(resolvedPath, allowedRoots)) {
      if (!path.isAbsolute(resolvedPath) || !fsSync.existsSync(resolvedPath)) {
        console.warn(`[${schemeName}] Access denied`, {
          requestUrl: request.url,
          resolvedPath,
          allowedRoots,
        });
        return new Response('Access denied', { status: 403 });
      }
    }

    return net.fetch(pathToFileURL(resolvedPath).href);
  };

  protocol.handle(REDBOX_ASSET_PROTOCOL, handleAssetRequest(REDBOX_ASSET_PROTOCOL));
  protocol.handle(LEGACY_LOCAL_FILE_PROTOCOL, handleAssetRequest(LEGACY_LOCAL_FILE_PROTOCOL));
};

async function ensureWorkspaceStructureFor(paths: ReturnType<typeof getWorkspacePaths>) {
  const fs = require('fs/promises');
  const dirs = [
    paths.base,
    paths.skills,
    paths.knowledge,
    paths.knowledgeRedbook,
    paths.knowledgeYoutube,
    path.join(paths.knowledge, 'docs'),
    paths.advisors,
    paths.manuscripts,
    paths.media,
    paths.cover || path.join(paths.base, 'cover'),
    paths.subjects || path.join(paths.base, 'subjects'),
    paths.redclaw,
    path.join(paths.redclaw, 'profile'),
    path.join(paths.base, 'memory'),
    path.join(paths.base, 'archives'),
    path.join(paths.base, 'chatrooms'),
  ];
  await Promise.all(dirs.map((dir) => fs.mkdir(dir, { recursive: true })));
}

const SUSPICIOUS_WORKSPACE_BASENAME_HINTS = [
  '稿件',
  '文稿',
  'documents',
  'document',
  'manuscripts',
  'manuscript',
];

const EXISTING_WORKSPACE_MARKERS = new Set([
  'skills',
  'knowledge',
  'advisors',
  'manuscripts',
  'media',
  'redclaw',
  'memory',
  'archives',
  'chatrooms',
]);

const MARKDOWN_FILE_EXTENSIONS = new Set(['.md', '.markdown', '.mdx']);

function normalizeWorkspaceHint(value: string): string {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[_-\s]+/g, '');
}

async function inspectWorkspaceBootstrapRisk(baseDir: string): Promise<{
  shouldConfirm: boolean;
  baseName: string;
  markdownCount: number;
}> {
  const normalizedDir = String(baseDir || '').trim();
  if (!normalizedDir) {
    return { shouldConfirm: false, baseName: '', markdownCount: 0 };
  }

  try {
    const stat = await fs.stat(normalizedDir);
    if (!stat.isDirectory()) {
      return { shouldConfirm: false, baseName: path.basename(normalizedDir), markdownCount: 0 };
    }

    const entries = await fs.readdir(normalizedDir, { withFileTypes: true });
    const hasWorkspaceMarkers = entries.some((entry) => entry.isDirectory() && EXISTING_WORKSPACE_MARKERS.has(entry.name.toLowerCase()));
    if (hasWorkspaceMarkers) {
      return { shouldConfirm: false, baseName: path.basename(normalizedDir), markdownCount: 0 };
    }

    const baseName = path.basename(normalizedDir);
    const normalizedBaseName = normalizeWorkspaceHint(baseName);
    const suspiciousBaseName = SUSPICIOUS_WORKSPACE_BASENAME_HINTS.some((hint) => {
      const normalizedHint = normalizeWorkspaceHint(hint);
      return normalizedBaseName === normalizedHint || normalizedBaseName.includes(normalizedHint);
    });
    if (!suspiciousBaseName) {
      return { shouldConfirm: false, baseName, markdownCount: 0 };
    }

    const markdownCount = entries.filter((entry) => {
      return entry.isFile() && MARKDOWN_FILE_EXTENSIONS.has(path.extname(entry.name).toLowerCase());
    }).length;

    return {
      shouldConfirm: markdownCount >= 5,
      baseName,
      markdownCount,
    };
  } catch {
    return { shouldConfirm: false, baseName: path.basename(normalizedDir), markdownCount: 0 };
  }
}

async function confirmWorkspaceBootstrapIfNeeded(
  parent: BrowserWindow | null | undefined,
  paths: ReturnType<typeof getWorkspacePaths>,
): Promise<boolean> {
  const risk = await inspectWorkspaceBootstrapRisk(paths.base);
  if (!risk.shouldConfirm) {
    return true;
  }

  const result = await showNativeMessageBox(parent, {
    type: 'warning',
    title: '确认工作区根目录',
    message: '当前工作区路径看起来像一个现有稿件目录。',
    detail: [
      `目录路径：${paths.base}`,
      `目录名：${risk.baseName}`,
      `已检测到 ${risk.markdownCount} 个 Markdown 文件。`,
      '如果继续，RedConvert 会在这个目录里创建 skills、knowledge、advisors、manuscripts、media、redclaw、memory、archives、chatrooms 等完整工作区结构。',
      '如果这本来就是你的稿件目录，请返回设置，把工作区改成它的上一级目录。',
    ].join('\n'),
    buttons: ['继续创建工作区结构', '暂不创建'],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
  });

  return result.response === 0;
}

function toLocalFileUrl(absolutePath: string): string {
  return toAppAssetUrl(absolutePath);
}

function extensionFromPath(rawPath: string): string {
  return path.extname(String(rawPath || '')).replace(/^\./, '').trim().toLowerCase();
}

const TEXT_ATTACHMENT_EXTENSIONS = new Set([
  'txt', 'md', 'markdown', 'mdx', 'json', 'yaml', 'yml', 'toml', 'csv', 'tsv',
  'xml', 'html', 'css', 'js', 'jsx', 'ts', 'tsx', 'py', 'java', 'go', 'rs',
  'c', 'cc', 'cpp', 'h', 'hpp', 'swift', 'kt', 'sql', 'sh', 'zsh', 'bat',
  'ps1', 'log', 'ini', 'conf', 'env',
]);
const IMAGE_ATTACHMENT_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'svg']);
const VIDEO_ATTACHMENT_EXTENSIONS = new Set(['mp4', 'mov', 'mkv', 'webm', 'avi', 'm4v']);
const AUDIO_ATTACHMENT_EXTENSIONS = new Set(['mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg', 'opus']);

function guessAttachmentMimeType(extension: string, kind?: string): string {
  const ext = String(extension || '').trim().toLowerCase();
  if (ext === 'txt') return 'text/plain';
  if (ext === 'md' || ext === 'markdown' || ext === 'mdx') return 'text/markdown';
  if (ext === 'json') return 'application/json';
  if (ext === 'csv') return 'text/csv';
  if (ext === 'tsv') return 'text/tab-separated-values';
  if (ext === 'xml') return 'application/xml';
  if (ext === 'html') return 'text/html';
  if (ext === 'css') return 'text/css';
  if (ext === 'js' || ext === 'mjs' || ext === 'cjs') return 'text/javascript';
  if (ext === 'ts' || ext === 'tsx') return 'text/typescript';
  if (ext === 'py') return 'text/x-python';
  if (ext === 'pdf') return 'application/pdf';
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
  if (ext === 'png') return 'image/png';
  if (ext === 'webp') return 'image/webp';
  if (ext === 'gif') return 'image/gif';
  if (ext === 'bmp') return 'image/bmp';
  if (ext === 'svg') return 'image/svg+xml';
  if (ext === 'mp4') return 'video/mp4';
  if (ext === 'mov') return 'video/quicktime';
  if (ext === 'webm') return 'video/webm';
  if (ext === 'mkv') return 'video/x-matroska';
  if (ext === 'avi') return 'video/x-msvideo';
  if (ext === 'mp3') return 'audio/mpeg';
  if (ext === 'wav') return 'audio/wav';
  if (ext === 'm4a') return 'audio/mp4';
  if (ext === 'aac') return 'audio/aac';
  if (ext === 'ogg' || ext === 'opus') return 'audio/ogg';
  if (ext === 'flac') return 'audio/flac';
  if (kind === 'text') return 'text/plain';
  if (kind === 'image') return 'image/png';
  if (kind === 'audio') return 'audio/mpeg';
  if (kind === 'video') return 'video/mp4';
  return 'application/octet-stream';
}

const buildAttachmentPromptSuffix = (attachment: Record<string, unknown>): string => {
  const absolutePath = String(attachment.absolutePath || '').trim();
  const originalAbsolutePath = String(attachment.originalAbsolutePath || '').trim();
  const localUrl = String(attachment.localUrl || '').trim();
  const fileName = String(attachment.name || '').trim();
  const kind = String(attachment.kind || '').trim();
  const summary = String(attachment.summary || '').trim();
  if (!absolutePath) return '';

  const lines = [
    '',
    '[用户上传附件]',
    `文件名: ${fileName || path.basename(absolutePath)}`,
    `工作暂存路径: ${absolutePath}`,
    `附件类型: ${kind || 'unknown'}`,
  ];
  if (originalAbsolutePath && originalAbsolutePath !== absolutePath) {
    lines.push(`原始路径: ${originalAbsolutePath}`);
  }
  if (localUrl) {
    lines.push(`本地URL: ${localUrl}`);
  }
  if (summary) {
    lines.push(`附件摘要: ${summary}`);
  }

  if (kind === 'text') {
    lines.push('请优先使用 bash（例如 cat/sed/head）读取工作暂存区里的文件原文后再回答。');
  } else if (kind === 'image') {
    lines.push('若当前模型支持图片理解，可直接查看图片；若需要进一步处理，请基于工作暂存路径继续操作。');
  } else {
    lines.push('请先基于工作暂存区里的文件判断是否需要转录、格式提取或其他预处理，再继续回答。');
  }

  return lines.join('\n');
};

async function buildAttachmentRuntimeInput(
  attachment: Record<string, unknown> | null,
  userText: string,
  modelName: string,
): Promise<string | Array<{ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }> | null> {
  if (!attachment || attachment.type !== 'uploaded-file') {
    return null;
  }

  const absolutePath = String(attachment.absolutePath || '').trim();
  const originalAbsolutePath = String(attachment.originalAbsolutePath || '').trim();
  const fileName = String(attachment.name || '').trim() || (absolutePath ? path.basename(absolutePath) : 'attachment');
  const kind = String(attachment.kind || '').trim();
  const mimeType = String(attachment.mimeType || '').trim() || guessAttachmentMimeType(String(attachment.ext || ''), kind);
  const summary = String(attachment.summary || '').trim();
  if (!absolutePath || kind !== 'image' || !supportsAttachmentKindDirectInput(modelName, kind)) {
    return null;
  }

  const imageBuffer = await fs.readFile(absolutePath);
  const dataUrl = `data:${mimeType};base64,${imageBuffer.toString('base64')}`;
  const textLines = [
    String(userText || '').trim() || `请查看这张图片附件：${fileName}`,
    '',
    '[当前轮已附带上传图片]',
    `文件名: ${fileName}`,
    `工作暂存路径: ${absolutePath}`,
  ];
  if (originalAbsolutePath && originalAbsolutePath !== absolutePath) {
    textLines.push(`原始路径: ${originalAbsolutePath}`);
  }
  if (summary) {
    textLines.push(`附件摘要: ${summary}`);
  }

  return [
    { type: 'text', text: textLines.filter(Boolean).join('\n') },
    { type: 'image_url', image_url: { url: dataUrl } },
  ];
}

function guessMimeTypeByExtension(extension: string): string {
  const ext = String(extension || '').trim().toLowerCase();
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
  if (ext === 'webp') return 'image/webp';
  if (ext === 'gif') return 'image/gif';
  if (ext === 'bmp') return 'image/bmp';
  return 'image/png';
}

async function readCoverTemplateSourceToBuffer(imageSource: string): Promise<{
  imageBuffer: Buffer;
  mimeType: string;
  extensionHint?: string;
}> {
  const raw = String(imageSource || '').trim();
  if (!raw) {
    throw new Error('imageSource is required');
  }

  if (/^data:/i.test(raw)) {
    const commaIndex = raw.indexOf(',');
    if (commaIndex <= 0) {
      throw new Error('Invalid data URL image source');
    }
    const metadata = raw.slice(5, commaIndex);
    if (!/;base64/i.test(metadata)) {
      throw new Error('Only base64 data URL is supported');
    }
    const mimeType = (metadata.split(';').find((segment) => segment.includes('/')) || 'image/png').trim().toLowerCase();
    const imageBuffer = Buffer.from(raw.slice(commaIndex + 1), 'base64');
    return {
      imageBuffer,
      mimeType: mimeType || 'image/png',
      extensionHint: extensionFromPath(`.${(mimeType.split('/')[1] || 'png').split('+')[0]}`),
    };
  }

  if (isLocalAssetSource(raw)) {
    const absolutePath = resolveAssetSourceToPath(raw);
    return {
      imageBuffer: await fs.readFile(absolutePath),
      mimeType: guessMimeTypeByExtension(extensionFromPath(absolutePath)),
      extensionHint: extensionFromPath(absolutePath),
    };
  }

  if (/^https?:\/\//i.test(raw)) {
    const response = await fetch(raw);
    if (!response.ok) {
      throw new Error(`Failed to fetch remote template image (${response.status} ${response.statusText})`);
    }
    const contentType = String(response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    const urlPath = (() => {
      try {
        return new URL(raw).pathname;
      } catch {
        return '';
      }
    })();
    const extensionHint = extensionFromPath(urlPath);
    return {
      imageBuffer: Buffer.from(await response.arrayBuffer()),
      mimeType: contentType || guessMimeTypeByExtension(extensionHint),
      extensionHint,
    };
  }

  if (path.isAbsolute(raw) || /^[a-zA-Z]:[\\/]/.test(raw) || raw.startsWith('\\\\')) {
    return {
      imageBuffer: await fs.readFile(raw),
      mimeType: guessMimeTypeByExtension(extensionFromPath(raw)),
      extensionHint: extensionFromPath(raw),
    };
  }

  throw new Error('Unsupported image source format');
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

async function enrichMediaAsset(asset: MediaAsset): Promise<MediaAsset & { absolutePath?: string; previewUrl?: string; exists: boolean }> {
  if (!asset.relativePath) {
    return { ...asset, exists: false };
  }
  const absolutePath = getAbsoluteMediaPath(asset.relativePath);
  try {
    await fs.access(absolutePath);
    return {
      ...asset,
      absolutePath,
      previewUrl: toLocalFileUrl(absolutePath),
      exists: true,
    };
  } catch {
    return {
      ...asset,
      absolutePath,
      exists: false,
    };
  }
}

async function enrichCoverAsset(asset: CoverAsset): Promise<CoverAsset & { absolutePath?: string; previewUrl?: string; exists: boolean }> {
  if (!asset.relativePath) {
    return { ...asset, exists: false };
  }
  const absolutePath = getAbsoluteCoverAssetPath(asset.relativePath);
  try {
    await fs.access(absolutePath);
    return {
      ...asset,
      absolutePath,
      previewUrl: toLocalFileUrl(absolutePath),
      exists: true,
    };
  } catch {
    return {
      ...asset,
      absolutePath,
      exists: false,
    };
  }
}

async function refreshForSpaceChange() {
  clearAllChatServices();
  fileWatcher.stop();
  fileWatcher.start();
  indexManager.clearQueue();

  const { vectorStore } = await import('./core/vector/VectorStore');
  await vectorStore.refreshCache();
  await (await getRedClawBackgroundRunnerLazy()).reloadForWorkspaceChange();
  await (await getMemoryMaintenanceServiceLazy()).reloadForWorkspaceChange();
  await (await getAssistantDaemonServiceLazy()).reloadForWorkspaceChange();

  win?.webContents.send('space:changed', { activeSpaceId: getActiveSpaceId() });
}

async function initializeRedClawBackgroundRunner() {
  const runner = await getRedClawBackgroundRunnerLazy();
  if (!redClawRunnerListenersAttached) {
    runner.on('status', (status) => {
      win?.webContents.send('redclaw:runner-status', status);
    });
    runner.on('log', (log) => {
      win?.webContents.send('redclaw:runner-log', log);
    });
    runner.on('message', (payload) => {
      win?.webContents.send('redclaw:runner-message', payload);
    });
    redClawRunnerListenersAttached = true;
  }
  await runner.init();
}

async function initializeBackgroundTaskRegistry() {
  const registry = await getBackgroundTaskRegistryLazy();
  if (!backgroundTaskRegistryListenersAttached) {
    registry.on('task-updated', (task) => {
      win?.webContents.send('background:task-updated', task);
    });
    backgroundTaskRegistryListenersAttached = true;
  }
}

async function initializeAssistantDaemon() {
  const daemon = await getAssistantDaemonServiceLazy();
  if (!assistantDaemonListenersAttached) {
    daemon.on('status', (status) => {
      win?.webContents.send('assistant:daemon-status', status);
    });
    daemon.on('log', (log) => {
      win?.webContents.send('assistant:daemon-log', log);
    });
    assistantDaemonListenersAttached = true;
  }
  await daemon.init();
}

async function initializeSessionBridge() {
  await (await getSessionBridgeServiceLazy()).start();
}

let startupCoreServicesPromise: Promise<void> | null = null;
async function initializeStartupCoreServices() {
  if (startupCoreServicesPromise) {
    return startupCoreServicesPromise;
  }
  startupCoreServicesPromise = (async () => {
    try {
      await applyGlobalNetworkProxy((getSettings() || {}) as Record<string, unknown>);
    } catch (error) {
      console.error('[NetworkProxy] Failed to apply startup proxy settings:', error);
    }

    const officialFeatureModule = await loadOfficialFeatureModule();
    if (officialFeatureModule?.registerOfficialFeatures) {
      try {
        await officialFeatureModule.registerOfficialFeatures({
          ipcMain,
          shell,
          getSettings: () => (getSettings() || {}) as Record<string, unknown>,
          saveSettings: (settings) => {
            saveSettings(
              normalizeSettingsInput(settings) as Parameters<typeof saveSettings>[0]
            );
          },
          normalizeSettingsInput,
        });
      } catch (error) {
        console.error('[official-feature] Failed to register official features on startup:', error);
      }
    }

    try {
      await officialFeatureModule?.syncOfficialAiRoutingOnStartup?.({
        getSettings: () => (getSettings() || {}) as Record<string, unknown>,
        saveSettings: (settings) => {
          saveSettings(
            normalizeSettingsInput(settings) as Parameters<typeof saveSettings>[0]
          );
        },
        normalizeSettingsInput,
      });
    } catch (e) {
      console.error('[official-feature] Failed to hydrate official auth on startup:', e);
    }
  })().catch((error) => {
    startupCoreServicesPromise = null;
    throw error;
  });

  return startupCoreServicesPromise;
}

let sessionBridgeStartupPromise: Promise<void> | null = null;
async function ensureSessionBridgeStarted() {
  if (sessionBridgeStartupPromise) {
    return sessionBridgeStartupPromise;
  }
  sessionBridgeStartupPromise = initializeSessionBridge().catch((error) => {
    sessionBridgeStartupPromise = null;
    throw error;
  });
  return sessionBridgeStartupPromise;
}

app.whenReady().then(async () => {
  markStartupPhase('app.whenReady');
  registerLocalAssetProtocols();
  markStartupPhase('local-asset-protocols-registered');
  createWindow();
  markStartupPhase('main-window-created');

  // 先让窗口尽快可交互，再分阶段初始化重量后台服务
  let backgroundServicesScheduled = false;
  const bootstrapBackgroundServices = async () => {
    if (backgroundServicesScheduled) return;
    backgroundServicesScheduled = true;

    void initializeStartupCoreServices();

    setTimeout(() => {
      void (async () => {
        markStartupPhase('background-phase-1-start');
        try {
          const workspacePaths = getWorkspacePaths();
          const shouldBootstrapWorkspace = await confirmWorkspaceBootstrapIfNeeded(win, workspacePaths);
          if (shouldBootstrapWorkspace) {
            await ensureWorkspaceStructureFor(workspacePaths);
          } else {
            console.warn('[Workspace] Skipped workspace bootstrap because the configured directory looks like an existing manuscripts folder:', workspacePaths.base);
          }
        } catch (e) {
          console.error('[Workspace] Failed to ensure workspace structure:', e);
        }

        await warmupBrowserPluginPrepared();
        try {
          await initializeRedClawBackgroundRunner();
        } catch (e) {
          console.error('[RedClawRunner] Init failed:', e);
        }

        try {
          await initializeBackgroundTaskRegistry();
        } catch (e) {
          console.error('[BackgroundTasks] Init failed:', e);
        }
        markStartupPhase('background-phase-1-done');
      })();
    }, 180);

    setTimeout(() => {
      void (async () => {
        markStartupPhase('background-phase-2-start');
        try {
          if (await shouldAutoStartAssistantDaemonAcrossSpaces()) {
            await initializeAssistantDaemon();
          }
        } catch (e) {
          console.error('[AssistantDaemon] Init failed:', e);
        }

        try {
          (await getMemoryMaintenanceServiceLazy()).start();
        } catch (e) {
          console.error('[MemoryMaintenance] Init failed:', e);
        }
        markStartupPhase('background-phase-2-done');
      })();
    }, 1200);

    setTimeout(() => {
      void (async () => {
        markStartupPhase('background-phase-3-start');
        try {
          initializeTaskQueueWithExecutors();
          const advisorYoutubeRunner = await getAdvisorYoutubeRunnerLazy();
          if (!advisorYoutubeRunnerListenersAttached) {
            advisorYoutubeRunner.on('progress', ({ advisorId, progress }) => {
              win?.webContents.send('advisors:download-progress', { advisorId, progress });
            });
            advisorYoutubeRunnerListenersAttached = true;
          }
          advisorYoutubeRunner.start();
        } catch (e) {
          console.error('[TaskQueue] Init failed:', e);
        }

        try {
          fileWatcher.start();
        } catch (e) {
          console.error('[FileWatcher] Start failed:', e);
        }
        markStartupPhase('background-phase-3-done');
      })();
    }, 2200);

    setTimeout(() => {
      import('./core/youtubeScraper').then(({ autoSetupYtdlp }) => {
        autoSetupYtdlp().then(result => {
          if (result.action !== 'none') {
            console.log(`[App] yt-dlp auto setup: ${result.action} - ${result.message}`);
          }
        }).catch(e => {
          console.error('[App] yt-dlp auto setup error:', e);
        });
      });
    }, 12000);
  };

  win?.webContents.once('did-finish-load', () => {
    markStartupPhase('renderer-did-finish-load');
    void initializeStartupCoreServices();
    void bootstrapBackgroundServices();
    setTimeout(() => {
      void checkForAppUpdate(false, false);
    }, 1800);
  });
  setTimeout(() => {
    void bootstrapBackgroundServices();
  }, 1200);
});

// ========== 任务队列管理 ==========
import { getTaskQueue, initializeTaskQueue, type Task } from './core/taskQueue';

function initializeTaskQueueWithExecutors() {
  const queue = initializeTaskQueue();

  // 注册字幕下载执行器
  queue.registerExecutor('subtitle_download', async (task, onProgress) => {
    const { queueSubtitleDownload } = await import('./core/subtitleQueue');
    const data = task.data as { videoId: string; outputDir: string };

    onProgress(0, 1, `下载字幕: ${data.videoId}`);
    const result = await queueSubtitleDownload(data.videoId, data.outputDir);
    onProgress(1, 1, result.success ? '下载完成' : '下载失败');

    return result;
  });

  // 转发任务事件到前端
  queue.on('task:started', (task: Task) => {
    win?.webContents.send('task-queue:task-started', task);
  });

  queue.on('task:progress', (task: Task) => {
    win?.webContents.send('task-queue:task-progress', task);
  });

  queue.on('task:completed', (task: Task) => {
    win?.webContents.send('task-queue:task-completed', task);
  });

  queue.on('task:failed', (task: Task) => {
    win?.webContents.send('task-queue:task-failed', task);
  });

  console.log('[TaskQueue] Executors registered');
}

// --------- IPC Handlers ---------

// Database
ipcMain.handle('db:save-settings', async (_, settings) => {
  const normalized = normalizeSettingsInput((settings || {}) as Record<string, unknown>) as Parameters<typeof saveSettings>[0];
  const result = saveSettings(normalized);
  setDebugLoggingEnabled(Boolean(normalized.debug_log_enabled));
  await applyGlobalNetworkProxy((getSettings() || {}) as Record<string, unknown>);
  broadcastSettingsUpdated();
  return result;
})

ipcMain.handle('db:get-settings', () => {
  return getSettings()
})

ipcMain.handle('settings:pick-workspace-dir', async () => {
  try {
    const picker = await dialog.showOpenDialog({
      title: '选择工作区目录',
      properties: ['openDirectory', 'createDirectory'],
      defaultPath: getDefaultWorkspaceDir(),
    });
    if (picker.canceled || !picker.filePaths.length) {
      return { success: true, canceled: true, path: null };
    }
    return {
      success: true,
      canceled: false,
      path: picker.filePaths[0],
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
});

ipcMain.handle('debug:get-status', () => {
  const settings = (getSettings() || {}) as { debug_log_enabled?: boolean } | undefined;
  return {
    enabled: Boolean(settings?.debug_log_enabled),
    logDirectory: getDebugLogDirectory(),
  };
});

ipcMain.handle('debug:get-recent', (_event, payload?: { limit?: number }) => {
  const limit = Number(payload?.limit || 200);
  return {
    lines: getRecentDebugLogs(Number.isFinite(limit) ? Math.max(1, Math.min(limit, 1000)) : 200),
  };
});

ipcMain.handle('debug:get-runtime-summary', () => {
  return {
    generatedAt: Date.now(),
    runtimeWarm: {
      lastWarmedAt: 0,
      entries: [],
    },
    phase0: {
      personaGeneration: { count: 0, byAdvisor: [], recent: [] },
      knowledgeIngest: { count: 0, byAdvisor: [], recent: [] },
      runtimeQueries: { count: 0, byAdvisor: [], byMode: [], recent: [] },
      skillInvocations: { count: 0, bySkill: [], recent: [] },
      toolCalls: { count: 0, successCount: 0, successRate: 0, byAdvisor: [], byTool: [], recent: [] },
    },
  };
});

ipcMain.handle('debug:open-log-dir', async () => {
  return openDebugLogDirectory();
});

ipcMain.handle('tools:diagnostics:list', () => {
  return listToolDiagnostics();
});

ipcMain.handle('tools:diagnostics:run-direct', async (_event, payload?: { toolName?: string }) => {
  const toolName = String(payload?.toolName || '').trim();
  if (!toolName) {
    return { success: false, mode: 'direct', toolName: '', error: 'toolName is required' };
  }
  return runDirectToolDiagnostic(toolName);
});

ipcMain.handle('tools:diagnostics:run-ai', async (_event, payload?: { toolName?: string }) => {
  const toolName = String(payload?.toolName || '').trim();
  if (!toolName) {
    return { success: false, mode: 'ai', toolName: '', error: 'toolName is required' };
  }
  return runAiToolDiagnostic(toolName);
});

ipcMain.handle('tools:hooks:list', () => {
  return listRuntimeHooks();
});

ipcMain.handle('tools:hooks:register', (_event, payload?: Record<string, unknown>) => {
  const id = String(payload?.id || `hook_${Date.now()}`).trim();
  const event = String(payload?.event || '').trim() as 'query.before' | 'query.after' | 'tool.before' | 'tool.after' | 'stop.failure';
  const type = String(payload?.type || '').trim() as 'command' | 'prompt' | 'http' | 'agent';
  if (!id || !event || !type) {
    return { success: false, error: 'id, event and type are required' };
  }
  return {
    success: true,
    hook: registerRuntimeHook({
      id,
      event,
      type,
      matcher: typeof payload?.matcher === 'string' ? payload.matcher : undefined,
      command: typeof payload?.command === 'string' ? payload.command : undefined,
      prompt: typeof payload?.prompt === 'string' ? payload.prompt : undefined,
      url: typeof payload?.url === 'string' ? payload.url : undefined,
      headers: payload?.headers && typeof payload.headers === 'object' ? payload.headers as Record<string, string> : undefined,
      timeoutMs: Number.isFinite(Number(payload?.timeoutMs)) ? Number(payload?.timeoutMs) : undefined,
      enabled: payload?.enabled === undefined ? true : Boolean(payload.enabled),
    }),
  };
});

ipcMain.handle('tools:hooks:remove', (_event, payload?: { id?: string }) => {
  const id = String(payload?.id || '').trim();
  if (!id) {
    return { success: false, error: 'id is required' };
  }
  unregisterRuntimeHook(id);
  return { success: true };
});

ipcMain.handle('sessions:list', () => {
  return getSessionRuntimeStore().listSessions().map((session) => ({
    ...session,
    chatSession: getChatSession(session.id),
  }));
});

ipcMain.handle('sessions:get', (_event, payload?: { sessionId?: string }) => {
  const sessionId = String(payload?.sessionId || '').trim();
  if (!sessionId) return null;
  return {
    chatSession: getChatSession(sessionId),
    transcript: getSessionRuntimeStore().listTranscript(sessionId),
    checkpoints: getSessionRuntimeStore().listCheckpoints(sessionId),
    toolResults: getSessionRuntimeStore().listToolResults(sessionId, 200),
  };
});

ipcMain.handle('sessions:resume', (_event, payload?: { sessionId?: string }) => {
  const sessionId = String(payload?.sessionId || '').trim();
  if (!sessionId) return null;
  const checkpoints = listSessionCheckpoints(sessionId, 1);
  return {
    chatSession: getChatSession(sessionId),
    lastCheckpoint: checkpoints[0] || null,
  };
});

ipcMain.handle('sessions:fork', (_event, payload?: { sessionId?: string; title?: string }) => {
  const sessionId = String(payload?.sessionId || '').trim();
  if (!sessionId) {
    return { success: false, error: 'sessionId is required' };
  }
  const session = getSessionRuntimeStore().forkSession(sessionId, typeof payload?.title === 'string' ? payload.title : undefined);
  return {
    success: true,
    session,
  };
});

ipcMain.handle('sessions:get-transcript', (_event, payload?: { sessionId?: string; limit?: number }) => {
  const sessionId = String(payload?.sessionId || '').trim();
  if (!sessionId) return [];
  const limit = Number(payload?.limit || 0);
  return getSessionRuntimeStore().listTranscript(sessionId, Number.isFinite(limit) && limit > 0 ? limit : undefined);
});

ipcMain.handle('sessions:get-tool-results', (_event, payload?: { sessionId?: string; limit?: number }) => {
  const sessionId = String(payload?.sessionId || '').trim();
  if (!sessionId) return [];
  const limit = Number(payload?.limit || 0);
  return getSessionRuntimeStore().listToolResults(sessionId, Number.isFinite(limit) && limit > 0 ? limit : undefined);
});

ipcMain.handle('runtime:get-trace', (_event, payload?: { sessionId?: string; limit?: number }) => {
  const sessionId = String(payload?.sessionId || '').trim();
  if (!sessionId) return [];
  const limit = Number(payload?.limit || 0);
  return getSessionRuntimeStore().listTranscript(sessionId, Number.isFinite(limit) && limit > 0 ? limit : undefined);
});

ipcMain.handle('runtime:get-checkpoints', (_event, payload?: { sessionId?: string; limit?: number }) => {
  const sessionId = String(payload?.sessionId || '').trim();
  if (!sessionId) return [];
  const limit = Number(payload?.limit || 0);
  return getSessionRuntimeStore().listCheckpoints(sessionId, Number.isFinite(limit) && limit > 0 ? limit : undefined);
});

ipcMain.handle('runtime:get-tool-results', (_event, payload?: { sessionId?: string; limit?: number }) => {
  const sessionId = String(payload?.sessionId || '').trim();
  if (!sessionId) return [];
  const limit = Number(payload?.limit || 0);
  return getSessionRuntimeStore().listToolResults(sessionId, Number.isFinite(limit) && limit > 0 ? limit : undefined);
});

ipcMain.handle('runtime:resume', (_event, payload?: { sessionId?: string }) => {
  const sessionId = String(payload?.sessionId || '').trim();
  if (!sessionId) return null;
  const checkpoints = listSessionCheckpoints(sessionId, 1);
  return {
    sessionId,
    checkpoint: checkpoints[0] || null,
  };
});

ipcMain.handle('runtime:fork-session', (_event, payload?: { sessionId?: string; title?: string }) => {
  const sessionId = String(payload?.sessionId || '').trim();
  if (!sessionId) {
    return { success: false, error: 'sessionId is required' };
  }
  return {
    success: true,
    session: getSessionRuntimeStore().forkSession(sessionId, typeof payload?.title === 'string' ? payload.title : undefined),
  };
});

ipcMain.handle('runtime:query', async (event, payload?: { sessionId?: string; message?: string }) => {
  const message = String(payload?.message || '').trim();
  if (!message) {
    return { success: false, error: 'message is required' };
  }
  let sessionId = String(payload?.sessionId || '').trim();
  if (!sessionId) {
    sessionId = `session_${Date.now()}`;
    createChatSession(sessionId, 'New Chat');
  }

  addChatMessage({
    id: `msg_${Date.now()}`,
    session_id: sessionId,
    role: 'user',
    content: message,
  });
  const service = await getOrCreateChatService(sessionId, event.sender);
  await service.sendMessage(message, sessionId);
  return {
    success: true,
    sessionId,
  };
});

ipcMain.handle('tasks:create', async (_event, payload?: {
  runtimeMode?: RuntimeMode;
  sessionId?: string;
  userInput?: string;
  metadata?: Record<string, unknown>;
}) => {
  const runtimeMode = (payload?.runtimeMode || 'redclaw') as RuntimeMode;
  const sessionId = String(payload?.sessionId || `session_${Date.now()}`);
  const userInput = String(payload?.userInput || '').trim();
  const settings = (getSettings() || {}) as Record<string, unknown>;
  const baseSystemPrompt = await buildRuntimeBaseSystemPrompt({ runtimeMode, interactive: true });
  const prepared = await getAgentRuntime().prepareExecution({
    runtimeContext: {
      sessionId,
      runtimeMode,
      userInput: userInput || '开发者手动创建任务',
      metadata: payload?.metadata || {},
    },
    baseSystemPrompt,
    llm: {
      apiKey: String(settings.api_key || '').trim(),
      baseURL: normalizeApiBaseUrl(String(settings.api_endpoint || '').trim()),
      model: String(resolveScopedModelName(settings, runtimeMode === 'background-maintenance' ? 'redclaw' : runtimeMode as any, String(settings.model_name || 'gpt-4o-mini'))).trim(),
    },
  });
  return prepared.task;
});

ipcMain.handle('tasks:list', async (_event, payload?: { status?: string; ownerSessionId?: string; limit?: number }) => {
  return getTaskGraphRuntime().listTasks({
    status: payload?.status as any,
    ownerSessionId: payload?.ownerSessionId,
    limit: payload?.limit,
  });
});

ipcMain.handle('tasks:get', async (_event, payload?: { taskId?: string }) => {
  const taskId = String(payload?.taskId || '').trim();
  if (!taskId) return null;
  return getTaskGraphRuntime().getTask(taskId);
});

ipcMain.handle('work:list', async (_event, payload?: { status?: string; type?: string; limit?: number; tag?: string }) => {
  return getWorkItemStore().listWorkItems({
    status: payload?.status as any,
    type: payload?.type as any,
    limit: payload?.limit,
    tag: payload?.tag,
  });
});

ipcMain.handle('work:get', async (_event, payload?: { id?: string }) => {
  const id = String(payload?.id || '').trim();
  if (!id) return null;
  return getWorkItemStore().getWorkItem(id);
});

ipcMain.handle('work:ready', async (_event, payload?: { limit?: number }) => {
  return getWorkItemStore().listReadyWorkItems(payload?.limit || 20);
});

ipcMain.handle('work:update', async (_event, payload?: {
  id?: string;
  title?: string;
  description?: string | null;
  status?: 'pending' | 'active' | 'waiting' | 'done' | 'cancelled';
  priority?: number;
  summary?: string | null;
}) => {
  const id = String(payload?.id || '').trim();
  if (!id) {
    throw new Error('work item id is required');
  }
  const updated = await getWorkItemStore().updateWorkItem(id, {
    title: payload?.title,
    description: payload?.description === null ? '' : payload?.description,
    status: payload?.status,
    priority: payload?.priority,
    summary: payload?.summary === null ? null : payload?.summary,
  });
  emitRendererDataChanged('work', { action: 'update', entityId: id });
  return updated;
});

ipcMain.handle('tasks:resume', async (_event, payload?: { taskId?: string }) => {
  const taskId = String(payload?.taskId || '').trim();
  if (!taskId) return null;
  const task = getTaskGraphRuntime().getTask(taskId);
  if (task?.route && (task.route.requiresLongRunningTask || task.route.requiresMultiAgent)) {
    return getLongTaskCoordinator().maybeRun(taskId);
  }
  return getTaskGraphRuntime().resumeTask(taskId);
});

ipcMain.handle('tasks:cancel', async (_event, payload?: { taskId?: string }) => {
  const taskId = String(payload?.taskId || '').trim();
  if (!taskId) return null;
  return getTaskGraphRuntime().cancelTask(taskId);
});

ipcMain.handle('tasks:trace', async (_event, payload?: { taskId?: string; limit?: number }) => {
  const taskId = String(payload?.taskId || '').trim();
  if (!taskId) return [];
  return getTaskGraphRuntime().listTraces(taskId, payload?.limit);
});

ipcMain.handle('tasks:resume-from-session', async (_event, payload?: { sessionId?: string }) => {
  const sessionId = String(payload?.sessionId || '').trim();
  if (!sessionId) return null;
  const tasks = getTaskGraphRuntime().listTasks({
    ownerSessionId: sessionId,
    limit: 20,
  });
  return tasks.find((task) => task.status === 'running' || task.status === 'paused') || tasks[0] || null;
});

ipcMain.handle('ai:roles:list', async () => {
  return listRoleSpecs();
});

ipcMain.handle('app:get-version', () => app.getVersion());
ipcMain.handle('plugin:browser-extension-status', async () => {
  try {
    const bundledDir = await findBundledBrowserPluginDir();
    const bundled = Boolean(bundledDir);
    const exportPath = getExportedBrowserPluginDir();
    const exported = await pathExists(exportPath);
    return { success: true, bundled, exportPath, exported, bundledPath: bundledDir || '' };
  } catch (error) {
    return {
      success: false,
      bundled: false,
      exportPath: getExportedBrowserPluginDir(),
      exported: false,
      error: String(error),
    };
  }
});
ipcMain.handle('plugin:prepare-browser-extension', async () => {
  try {
    const result = await ensureBrowserPluginPrepared();
    return { success: true, path: result.path, alreadyPrepared: result.alreadyPrepared };
  } catch (error) {
    console.error('Failed to prepare browser extension:', error);
    return { success: false, path: '', error: String(error) };
  }
});
ipcMain.handle('plugin:open-browser-extension-dir', async () => {
  try {
    const result = await ensureBrowserPluginPrepared();
    const openError = await shell.openPath(result.path);
    if (openError) {
      return { success: false, path: result.path, error: openError };
    }
    return { success: true, path: result.path };
  } catch (error) {
    console.error('Failed to open browser extension dir:', error);
    return { success: false, path: '', error: String(error) };
  }
});

ipcMain.handle('app:check-update', async (_, payload?: { force?: boolean }) => {
  const force = Boolean(payload?.force);
  return checkForAppUpdate(force, force);
});

ipcMain.handle('app:open-release-page', async (_, payload?: { url?: string }) => {
  const target = String(payload?.url || APP_UPDATE_RELEASES_PAGE_URL).trim();
  if (!isHttpUrl(target)) {
    return { success: false, error: 'Invalid release URL' };
  }
  try {
    await shell.openExternal(target);
    return { success: true };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
});

ipcMain.handle('app:open-path', async (_, payload?: { path?: string }) => {
  const targetPath = String(payload?.path || '').trim();
  if (!targetPath) {
    return { success: false, error: 'path is required' };
  }
  try {
    const openError = await shell.openPath(targetPath);
    if (openError) {
      return { success: false, error: openError };
    }
    return { success: true };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
});

ipcMain.handle('app:open-knowledge-api-guide', async () => {
  const guidePath = path.join(__dirname, '../Docs/openai-compatible-video-api.md');
  try {
    const openError = await shell.openPath(guidePath);
    if (openError) {
      return { success: false, error: openError, path: guidePath };
    }
    return { success: true, path: guidePath };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
      path: guidePath,
    };
  }
});

ipcMain.handle('app:open-richpost-theme-guide', async () => {
  const docsPath = path.join(__dirname, '../Docs');
  try {
    const openError = await shell.openPath(docsPath);
    if (openError) {
      return { success: false, error: openError, path: docsPath };
    }
    return { success: true, path: docsPath };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
      path: docsPath,
    };
  }
});

ipcMain.handle('clipboard:read-text', () => {
  try {
    return clipboard.readText() || '';
  } catch (error) {
    console.error('[clipboard] read text failed:', error);
    return '';
  }
});

ipcMain.handle('clipboard:write-html', async (_, payload?: { html?: string; text?: string }) => {
  try {
    const html = String(payload?.html || '').trim();
    const text = String(payload?.text || '').trim();
    if (!html) {
      throw new Error('html is required');
    }
    clipboard.writeHTML(html);
    clipboard.writeText(text || html.replace(/<[^>]+>/g, ' '));
    return { success: true };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
});

ipcMain.handle('wechat-official:get-status', async () => {
  try {
    return {
      success: true,
      ...(await getWechatOfficialAccountStatus()),
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
      bindings: [],
    };
  }
});

ipcMain.handle('wechat-official:bind', async (_, payload?: {
  name?: string;
  appId?: string;
  secret?: string;
  setActive?: boolean;
}) => {
  try {
    const binding = await bindWechatOfficialAccount({
      name: String(payload?.name || '').trim() || undefined,
      appId: String(payload?.appId || '').trim(),
      secret: String(payload?.secret || '').trim(),
      setActive: payload?.setActive !== false,
    });
    return { success: true, binding };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
});

ipcMain.handle('wechat-official:unbind', async (_, payload?: { bindingId?: string }) => {
  try {
    await unbindWechatOfficialAccount(String(payload?.bindingId || '').trim() || undefined);
    return { success: true };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
});

ipcMain.handle('file:copy-image', async (_, payload?: { source?: string }) => {
  try {
    const source = String(payload?.source || '').trim();
    const resolvedPath = resolveAssetSourceToPath(source);
    const allowedRoots = getAllowedLocalFileRoots();
    if (!isPathWithinRoots(resolvedPath, allowedRoots)) {
      throw new Error('Access denied');
    }
    await fs.access(resolvedPath);
    const image = nativeImage.createFromPath(resolvedPath);
    if (image.isEmpty()) {
      throw new Error('Invalid image file');
    }
    clipboard.writeImage(image);
    return { success: true };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
});

ipcMain.handle('file:show-in-folder', async (_, payload?: { source?: string }) => {
  try {
    const source = String(payload?.source || '').trim();
    const resolvedPath = resolveAssetSourceToPath(source);
    const allowedRoots = getAllowedLocalFileRoots();
    if (!isPathWithinRoots(resolvedPath, allowedRoots)) {
      throw new Error('Access denied');
    }
    await fs.access(resolvedPath);
    shell.showItemInFolder(resolvedPath);
    return { success: true };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
});

ipcMain.handle('spaces:list', async () => {
  return {
    spaces: listSpaces(),
    activeSpaceId: getActiveSpaceId(),
  };
});

ipcMain.handle('spaces:create', async (_, name: string) => {
  const space = createSpace(name || '');
  await ensureWorkspaceStructureFor(getWorkspacePathsForSpace(space.id));
  return { success: true, space };
});

ipcMain.handle('spaces:rename', async (_, { id, name }: { id: string; name: string }) => {
  const space = renameSpace(id, name);
  if (!space) {
    return { success: false, error: '空间不存在或名称无效' };
  }
  return { success: true, space };
});

ipcMain.handle('spaces:switch', async (_, spaceId: string) => {
  const space = setActiveSpace(spaceId);
  await ensureWorkspaceStructureFor(getWorkspacePaths());
  await refreshForSpaceChange();
  return { success: true, space };
});

// Memory
ipcMain.handle('memory:list', async () => {
  return listUserMemoriesFromFile();
});

ipcMain.handle('memory:archived', async () => {
  return listArchivedMemoriesFromFile();
});

ipcMain.handle('memory:history', async (_, originId?: string) => {
  return listMemoryHistoryFromFile(typeof originId === 'string' ? originId : undefined);
});

ipcMain.handle('memory:search', async (_, payload?: { query?: string; includeArchived?: boolean; limit?: number }) => {
  return searchUserMemoriesInFile(String(payload?.query || ''), {
    includeArchived: Boolean(payload?.includeArchived),
    limit: Number(payload?.limit || 20),
  });
});

ipcMain.handle('memory:maintenance-status', async () => {
  return (await getMemoryMaintenanceServiceLazy()).getStatus();
});

ipcMain.handle('memory:maintenance-run', async () => {
  return (await getMemoryMaintenanceServiceLazy()).runNow();
});

ipcMain.handle('background-tasks:list', async () => {
  return (await getBackgroundTaskRegistryLazy()).listTasks();
});

ipcMain.handle('background-tasks:get', async (_, payload?: { taskId?: string }) => {
  return (await getBackgroundTaskRegistryLazy()).getTask(String(payload?.taskId || ''));
});

ipcMain.handle('background-tasks:cancel', async (_, payload?: { taskId?: string }) => {
  return (await getBackgroundTaskRegistryLazy()).cancelTask(String(payload?.taskId || ''));
});

ipcMain.handle('background-workers:get-pool-state', async () => {
  return (await getHeadlessWorkerProcessManagerLazy()).getPoolSnapshot();
});

ipcMain.handle('assistant:daemon-status', async () => {
  return (await getAssistantDaemonServiceLazy()).getStatus();
});

ipcMain.handle('assistant:daemon-start', async (_, payload: {
  autoStart?: boolean;
  keepAliveWhenNoWindow?: boolean;
  host?: string;
  port?: number;
  feishu?: {
    enabled?: boolean;
    receiveMode?: 'webhook' | 'websocket';
    endpointPath?: string;
    verificationToken?: string;
    encryptKey?: string;
    appId?: string;
    appSecret?: string;
    replyUsingChatId?: boolean;
  };
  relay?: {
    enabled?: boolean;
    endpointPath?: string;
    authToken?: string;
  };
  weixin?: {
    enabled?: boolean;
    endpointPath?: string;
    authToken?: string;
    accountId?: string;
    autoStartSidecar?: boolean;
    cursorFile?: string;
    sidecarCommand?: string;
    sidecarArgs?: string[];
    sidecarCwd?: string;
    sidecarEnv?: Record<string, string>;
  };
} = {}) => {
  try {
    return await (await getAssistantDaemonServiceLazy()).start(payload);
  } catch (error) {
    return { success: false, error: String(error) };
  }
});

ipcMain.handle('assistant:daemon-stop', async () => {
  try {
    return await (await getAssistantDaemonServiceLazy()).stop();
  } catch (error) {
    return { success: false, error: String(error) };
  }
});

ipcMain.handle('assistant:daemon-set-config', async (_, payload: {
  enabled?: boolean;
  autoStart?: boolean;
  keepAliveWhenNoWindow?: boolean;
  host?: string;
  port?: number;
  feishu?: {
    enabled?: boolean;
    receiveMode?: 'webhook' | 'websocket';
    endpointPath?: string;
    verificationToken?: string;
    encryptKey?: string;
    appId?: string;
    appSecret?: string;
    replyUsingChatId?: boolean;
  };
  relay?: {
    enabled?: boolean;
    endpointPath?: string;
    authToken?: string;
  };
  weixin?: {
    enabled?: boolean;
    endpointPath?: string;
    authToken?: string;
    accountId?: string;
    autoStartSidecar?: boolean;
    cursorFile?: string;
    sidecarCommand?: string;
    sidecarArgs?: string[];
    sidecarCwd?: string;
    sidecarEnv?: Record<string, string>;
  };
} = {}) => {
  try {
    return await (await getAssistantDaemonServiceLazy()).setConfig(payload);
  } catch (error) {
    return { success: false, error: String(error) };
  }
});

ipcMain.handle('assistant:daemon-weixin-login-start', async (_, payload: {
  accountId?: string;
  force?: boolean;
} = {}) => {
  try {
    return await (await getAssistantDaemonServiceLazy()).startWeixinLogin(payload);
  } catch (error) {
    return {
      success: false,
      message: String(error),
      stateDir: '',
    };
  }
});

ipcMain.handle('assistant:daemon-weixin-login-wait', async (_, payload: {
  sessionKey?: string;
  timeoutMs?: number;
} = {}) => {
  try {
    return await (await getAssistantDaemonServiceLazy()).waitForWeixinLogin(payload);
  } catch (error) {
    return {
      success: false,
      connected: false,
      message: String(error),
    };
  }
});

ipcMain.handle('session-bridge:status', async () => {
  await ensureSessionBridgeStarted();
  return (await getSessionBridgeServiceLazy()).getStatus();
});

ipcMain.handle('session-bridge:list-sessions', async () => {
  await ensureSessionBridgeStarted();
  return (await getSessionBridgeServiceLazy()).listSessions();
});

ipcMain.handle('session-bridge:get-session', async (_, payload?: { sessionId?: string }) => {
  await ensureSessionBridgeStarted();
  const sessionId = String(payload?.sessionId || '').trim();
  if (!sessionId) return null;
  return (await getSessionBridgeServiceLazy()).getSessionSnapshot(sessionId);
});

ipcMain.handle('session-bridge:create-session', async (_, payload?: {
  title?: string;
  contextType?: string;
  runtimeMode?: string;
  metadata?: Record<string, unknown>;
}) => {
  await ensureSessionBridgeStarted();
  return (await getSessionBridgeServiceLazy()).createSession(payload);
});

ipcMain.handle('session-bridge:send-message', async (_, payload?: {
  sessionId?: string;
  message?: string;
}) => {
  await ensureSessionBridgeStarted();
  const sessionId = String(payload?.sessionId || '').trim();
  const message = String(payload?.message || '').trim();
  if (!sessionId || !message) {
    return { accepted: false, error: 'sessionId and message are required' };
  }
  return (await getSessionBridgeServiceLazy()).sendSessionMessage(sessionId, message);
});

ipcMain.handle('session-bridge:list-permissions', async (_, payload?: { sessionId?: string }) => {
  await ensureSessionBridgeStarted();
  const sessionId = String(payload?.sessionId || '').trim();
  return (await getSessionBridgeServiceLazy()).listPermissionRequests(sessionId || undefined);
});

ipcMain.handle('session-bridge:resolve-permission', async (_, payload?: {
  requestId?: string;
  outcome?: 'proceed_once' | 'proceed_always' | 'cancel';
}) => {
  const requestId = String(payload?.requestId || '').trim();
  const outcome = String(payload?.outcome || '').trim();
  if (!requestId) {
    return { success: false, error: 'requestId is required' };
  }
  await ensureSessionBridgeStarted();
  const { ToolConfirmationOutcome } = require('./core/toolRegistry');
  return (await getSessionBridgeServiceLazy()).resolvePermissionRequest(
    requestId,
    outcome === ToolConfirmationOutcome.ProceedAlways
      ? ToolConfirmationOutcome.ProceedAlways
      : outcome === ToolConfirmationOutcome.Cancel
        ? ToolConfirmationOutcome.Cancel
        : ToolConfirmationOutcome.ProceedOnce,
  );
});

ipcMain.handle('memory:add', async (_, { content, type, tags }) => {
  return addUserMemoryToFile(content, type, tags);
});

ipcMain.handle('memory:delete', async (_, id) => {
  return deleteUserMemoryFromFile(id);
});

ipcMain.handle('memory:update', async (_, { id, updates }) => {
  return updateUserMemoryInFile(id, updates);
});

// MCP
ipcMain.handle('mcp:list', async () => {
  return { success: true, servers: getMcpServers() };
});

ipcMain.handle('mcp:save', async (_, payload: { servers?: McpServerConfig[] }) => {
  try {
    const servers = saveMcpServers(Array.isArray(payload?.servers) ? payload.servers : []);
    return { success: true, servers };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { success: false, error: message, servers: [] };
  }
});

ipcMain.handle('mcp:test', async (_, payload: { server?: McpServerConfig }) => {
  try {
    if (!payload?.server) {
      return { success: false, message: 'server is required' };
    }
    return await testMcpServerConnection(payload.server);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { success: false, message };
  }
});

ipcMain.handle('mcp:discover-local', async () => {
  try {
    const items = await discoverLocalMcpConfigs();
    return {
      success: true,
      items: items.map((item) => ({
        sourcePath: item.sourcePath,
        count: item.servers.length,
        servers: item.servers,
      })),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { success: false, error: message, items: [] };
  }
});

ipcMain.handle('mcp:import-local', async () => {
  try {
    const result = await importLocalMcpServers();
    return { success: true, ...result };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { success: false, error: message };
  }
});

ipcMain.handle('mcp:oauth-status', async (_, payload: { serverId?: string }) => {
  try {
    const serverId = String(payload?.serverId || '').trim();
    if (!serverId) {
      return { success: false, error: 'serverId is required' };
    }
    const status = await getMcpOAuthStatus(serverId);
    return { success: true, ...status };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { success: false, error: message };
  }
});

ipcMain.handle('mcp:sessions', async () => {
  return { success: true, sessions: [] };
});

ipcMain.handle('mcp:list-tools', async () => {
  return { success: false, error: 'Not supported in Electron compatibility mode', tools: [] };
});

ipcMain.handle('mcp:list-resources', async () => {
  return { success: false, error: 'Not supported in Electron compatibility mode', resources: [] };
});

ipcMain.handle('mcp:list-resource-templates', async () => {
  return { success: false, error: 'Not supported in Electron compatibility mode', resourceTemplates: [] };
});

ipcMain.handle('mcp:call', async () => {
  return { success: false, error: 'Not supported in Electron compatibility mode' };
});

ipcMain.handle('mcp:disconnect', async () => {
  return { success: true };
});

ipcMain.handle('mcp:disconnect-all', async () => {
  return { success: true };
});

// AI Source: protocol detect / test / model list
ipcMain.handle('ai:detect-protocol', async (_, payload: {
  baseURL?: string;
  presetId?: string;
  protocol?: string;
}) => {
  try {
    const { detectAiProtocol } = await import('./core/aiSourceService');
    return {
      success: true,
      protocol: detectAiProtocol({
        baseURL: payload?.baseURL || '',
        presetId: payload?.presetId,
        protocol: payload?.protocol,
      }),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { success: false, protocol: 'openai', error: message };
  }
});

ipcMain.handle('ai:test-connection', async (_, payload: {
  apiKey?: string;
  baseURL?: string;
  presetId?: string;
  protocol?: 'openai' | 'anthropic' | 'gemini';
}) => {
  const { detectAiProtocol, testAiSourceConnection } = await import('./core/aiSourceService');
  try {
    const result = await testAiSourceConnection({
      apiKey: payload?.apiKey || '',
      baseURL: payload?.baseURL || '',
      presetId: payload?.presetId,
      protocol: payload?.protocol,
    });
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      success: false,
      protocol: detectAiProtocol({
        baseURL: payload?.baseURL || '',
        presetId: payload?.presetId,
        protocol: payload?.protocol,
      }),
      models: [],
      message,
    };
  }
});

ipcMain.handle('ai:fetch-models', async (_, payload: {
  apiKey?: string;
  baseURL?: string;
  presetId?: string;
  protocol?: 'openai' | 'anthropic' | 'gemini';
  purpose?: 'chat' | 'image';
}) => {
  try {
    const { fetchModelsForAiSource } = await import('./core/aiSourceService');
    const { models } = await fetchModelsForAiSource({
      apiKey: payload?.apiKey || '',
      baseURL: payload?.baseURL || '',
      presetId: payload?.presetId,
      protocol: payload?.protocol,
      purpose: payload?.purpose,
    });
    return models;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(message);
  }
});

// 会话级 ChatService 实例管理（保证切换 tab/并行会话时不中断）
type PiChatServiceInstance = import('./pi/PiChatService').PiChatService;
let piChatServiceCtorPromise: Promise<typeof import('./pi/PiChatService').PiChatService> | null = null;
const chatServices = new Map<string, PiChatServiceInstance>();

async function getPiChatServiceCtor(): Promise<typeof import('./pi/PiChatService').PiChatService> {
  if (!piChatServiceCtorPromise) {
    piChatServiceCtorPromise = import('./pi/PiChatService').then((module) => module.PiChatService);
  }
  return piChatServiceCtorPromise;
}

async function getOrCreateChatService(sessionId: string, sender?: Electron.WebContents): Promise<PiChatServiceInstance> {
  let service = chatServices.get(sessionId);
  if (!service) {
    const PiChatService = await getPiChatServiceCtor();
    service = new PiChatService();
    chatServices.set(sessionId, service);
  }
  if (sender) {
    const browserWindow = BrowserWindow.fromWebContents(sender);
    if (browserWindow) {
      service.setWindow(browserWindow);
    }
  }
  return service;
}

function cleanupChatService(sessionId: string): void {
  const service = chatServices.get(sessionId);
  if (!service) return;
  try {
    service.abort();
  } catch {
    // ignore
  }
  chatServices.delete(sessionId);
}

function clearAllChatServices(): void {
  for (const [sessionId] of chatServices) {
    cleanupChatService(sessionId);
  }
}

// 创建新的聊天会话
ipcMain.handle('chat:create-session', async (_, title?: string) => {
  const sessionId = `session_${Date.now()}`;
  const defaultTitle = title || 'New Chat';

  createChatSession(sessionId, defaultTitle);
  return { id: sessionId, title: defaultTitle, timestamp: Date.now() };
});

// 获取或创建文件关联的会话
ipcMain.handle('chat:getOrCreateFileSession', async (_, { filePath, fileId }: { filePath: string; fileId?: string }) => {
  if (!filePath) return null;

  // 1. 优先尝试通过 ID 查找 (更精准，防改名)
  if (fileId) {
    const sessionById = getChatSessionByFileId(fileId);
    if (sessionById) {
      // 检查路径是否变化 (例如文件被重命名)
      // 如果路径变了，更新元数据中的 path，确保 Agent 能找到最新文件
      try {
        const meta = JSON.parse(sessionById.metadata || '{}');
        if (meta.associatedFilePath !== filePath) {
          meta.associatedFilePath = filePath;
          updateChatSessionMetadata(sessionById.id, meta);
          // Update local object to return correct data
          sessionById.metadata = JSON.stringify(meta);
        }
      } catch (e) {
        console.error('Failed to update session path:', e);
      }
      return sessionById;
    }
  }

  // 2. 如果没有 ID 或通过 ID 没找到 (兼容旧数据)，尝试通过路径查找
  const existingSession = getChatSessionByFile(filePath);
  if (existingSession) {
    // 如果找到了旧会话但现在有了 ID，补全 ID 信息
    if (fileId) {
       try {
        const meta = JSON.parse(existingSession.metadata || '{}');
        if (!meta.associatedFileId) {
          meta.associatedFileId = fileId;
          updateChatSessionMetadata(existingSession.id, meta);
          existingSession.metadata = JSON.stringify(meta);
        }
      } catch (e) {
        console.error('Failed to migrate session ID:', e);
      }
    }
    return existingSession;
  }

  // 3. 创建新会话
  const sessionId = `session_${Date.now()}`;
  const fileName = path.basename(filePath);
  const title = `Manuscript: ${fileName}`;
  const metadata = {
    associatedFilePath: filePath,
    associatedFileId: fileId // Store UUID if available
  };

  createChatSession(sessionId, title, metadata);
  return { id: sessionId, title, timestamp: Date.now(), metadata: JSON.stringify(metadata) };
});

ipcMain.handle('chat:update-session-metadata', async (_, payload?: {
  sessionId?: string;
  metadata?: Record<string, unknown>;
}) => {
  const sessionId = String(payload?.sessionId || '').trim();
  if (!sessionId) {
    return { success: false, error: 'sessionId is required' };
  }

  const session = getChatSession(sessionId);
  if (!session) {
    return { success: false, error: 'session not found' };
  }

  let currentMetadata: Record<string, unknown> = {};
  if (session.metadata) {
    try {
      currentMetadata = JSON.parse(session.metadata);
    } catch (error) {
      console.warn('[chat:update-session-metadata] Failed to parse existing metadata:', error);
    }
  }

  const nextMetadata = {
    ...currentMetadata,
    ...(payload?.metadata || {}),
  };
  updateChatSessionMetadata(sessionId, nextMetadata);
  return { success: true };
});

ipcMain.handle('chat:bind-editor-session', async (_, payload?: {
  session?: {
    scope?: string;
    filePath?: string;
    contextType?: string;
    contextId?: string;
    title?: string;
    modeLabel?: string;
    targetTypeLabel?: string;
    targetPath?: string;
    initialContext?: string;
  };
  metadata?: Record<string, unknown>;
}) => {
  try {
    const binding = payload?.session;
    const scope = normalizeBindingText(binding?.scope).toLowerCase() || 'file';
    const contextType = normalizeBindingText(binding?.contextType) || 'file';
    const contextId = normalizeBindingText(binding?.contextId);
    const filePath = normalizeBindingText(binding?.filePath) || contextId;
    const metadata = normalizeBindingMetadata(payload?.metadata);
    const title = normalizeBindingText(binding?.title)
      || (filePath ? stripManuscriptExtension(path.basename(filePath)) : 'New Chat');

    let session = null as ReturnType<typeof getChatSession> | null;
    if (scope === 'context') {
      if (!contextId) {
        return { success: false, error: 'contextId is required for context-bound editor chat' };
      }
      session = getChatSessionByContext(contextId, contextType);
      if (!session) {
        const sessionId = `session_${Date.now()}`;
        session = createChatSession(sessionId, title, {
          contextType,
          contextId,
          isContextBound: true,
        });
      }
    } else if (scope === 'file') {
      if (!filePath) {
        return { success: false, error: 'filePath is required for file-bound editor chat' };
      }
      session = getChatSessionByFile(filePath);
      if (!session) {
        const sessionId = `session_${Date.now()}`;
        session = createChatSession(sessionId, title, {
          associatedFilePath: filePath,
        });
      }
    } else {
      return { success: false, error: `unsupported editor chat binding scope: ${scope}` };
    }

    if (!session) {
      return { success: false, error: 'failed to create editor chat session' };
    }

    const currentMetadata = (() => {
      if (!session?.metadata) return {};
      try {
        return JSON.parse(session.metadata) as Record<string, unknown>;
      } catch {
        return {};
      }
    })();
    const nextMetadata = {
      ...currentMetadata,
      ...metadata,
      contextType,
      contextId,
      isContextBound: true,
      editorBindingVersion: currentMetadata.editorBindingVersion ?? metadata.editorBindingVersion ?? 1,
      editorBindingScope: scope,
    } as Record<string, unknown>;
    if (!normalizeBindingText(nextMetadata.associatedFilePath) && filePath) {
      nextMetadata.associatedFilePath = filePath;
    }

    const derivedInitialContext = deriveEditorBindingInitialContext({
      filePath,
      contextId,
      modeLabel: binding?.modeLabel,
      targetTypeLabel: binding?.targetTypeLabel,
      targetPath: binding?.targetPath,
      initialContext: binding?.initialContext,
    }, nextMetadata);
    if (derivedInitialContext) {
      nextMetadata.initialContext = derivedInitialContext;
    }

    updateChatSessionMetadata(session.id, nextMetadata);
    return getChatSession(session.id) || session;
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
});

// 获取或创建上下文关联的会话 (知识库聊天)
ipcMain.handle('chat:getOrCreateContextSession', async (_, { contextId, contextType, title, initialContext }: { contextId: string; contextType: string; title: string; initialContext: string }) => {
  if (!contextId || !contextType) return null;

  // 1. 尝试查找现有会话
  const existingSession = getChatSessionByContext(contextId, contextType);

  if (existingSession) {
    // 更新上下文内容 (确保 Agent 拿到最新的知识库内容)
    try {
      const meta = JSON.parse(existingSession.metadata || '{}');
      if (meta.contextContent !== initialContext) {
        meta.contextContent = initialContext;
        updateChatSessionMetadata(existingSession.id, meta);
        existingSession.metadata = JSON.stringify(meta);
      }
    } catch (e) {
      console.error('Failed to update session context:', e);
    }
    return existingSession;
  }

  // 2. 创建新会话
  const sessionId = `session_${Date.now()}`;
  const metadata = {
    contextId,
    contextType,
    contextContent: initialContext, // 存储初始上下文内容
    isContextBound: true
  };

  createChatSession(sessionId, title, metadata);
  return { id: sessionId, title, timestamp: Date.now(), metadata: JSON.stringify(metadata) };
});

ipcMain.handle('chat:list-context-sessions', async (_, payload?: { contextId?: string; contextType?: string }) => {
  const contextId = String(payload?.contextId || '').trim();
  const contextType = String(payload?.contextType || '').trim();
  if (!contextId || !contextType) {
    return [];
  }

  return getChatSessions()
    .filter((session) => {
      if (!session.metadata) return false;
      try {
        const meta = JSON.parse(session.metadata) as Record<string, unknown>;
        return meta.contextId === contextId && meta.contextType === contextType;
      } catch {
        return false;
      }
    })
    .map((session) => ({
      id: session.id,
      messageCount: 0,
      summary: '',
      transcriptCount: 0,
      checkpointCount: 0,
      context: null,
      chatSession: {
        id: session.id,
        title: session.title,
        updatedAt: new Date(session.updated_at).toISOString(),
      },
    }));
});

ipcMain.handle('chat:create-context-session', async (_, payload?: {
  contextId?: string;
  contextType?: string;
  title?: string;
  initialContext?: string;
}) => {
  const contextId = String(payload?.contextId || '').trim();
  const contextType = String(payload?.contextType || '').trim();
  if (!contextId || !contextType) {
    return null;
  }

  const sessionId = `session_${Date.now()}`;
  const title = String(payload?.title || 'Context Chat').trim() || 'Context Chat';
  const metadata = {
    contextId,
    contextType,
    contextContent: String(payload?.initialContext || '').trim(),
    isContextBound: true,
  };
  const created = createChatSession(sessionId, title, metadata);
  return {
    id: created.id,
    title: created.title,
    updatedAt: new Date(created.updated_at).toISOString(),
  };
});

ipcMain.handle('chat:create-diagnostics-session', async (_, payload?: {
  title?: string;
  contextId?: string;
  contextType?: string;
}) => {
  const sessionId = `session_${Date.now()}`;
  const title = String(payload?.title || 'Diagnostics').trim() || 'Diagnostics';
  const metadata = {
    contextId: String(payload?.contextId || '').trim() || undefined,
    contextType: String(payload?.contextType || '').trim() || undefined,
    diagnostics: true,
  };
  const created = createChatSession(sessionId, title, metadata);
  return {
    id: created.id,
    title: created.title,
    updatedAt: new Date(created.updated_at).toISOString(),
  };
});

ipcMain.handle('redclaw:list-projects', async (_, { limit }: { limit?: number } = {}) => {
  try {
    return await listRedClawProjects(limit || 20);
  } catch (error) {
    console.error('Failed to list RedClaw projects:', error);
    return [];
  }
});

ipcMain.handle('redclaw:profile:get-bundle', async () => {
  try {
    const bundle = await loadRedClawProfilePromptBundle();
    return {
      success: true,
      profileRoot: bundle.profileRoot,
      agent: bundle.files.agent,
      soul: bundle.files.soul,
      identity: bundle.files.identity,
      user: bundle.files.user,
      creatorProfile: bundle.files.creatorProfile,
      bootstrap: bundle.files.bootstrap,
      onboardingState: bundle.onboardingState,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
});

ipcMain.handle('redclaw:profile:update-doc', async (_, payload?: {
  docType?: 'agent' | 'soul' | 'user' | 'creator_profile';
  markdown?: string;
  reason?: string;
}) => {
  const docType = payload?.docType;
  const markdown = String(payload?.markdown || '');
  if (!docType) {
    return { success: false, error: 'docType is required' };
  }
  if (!markdown.trim()) {
    return { success: false, error: 'markdown is required' };
  }

  try {
    const result = await updateRedClawProfileDocument(docType, markdown);
    return {
      success: true,
      docType: result.docType,
      fileName: path.basename(result.path),
      path: result.path,
      content: result.content,
      reason: String(payload?.reason || '').trim() || undefined,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
});

ipcMain.handle('redclaw:profile:onboarding-status', async () => {
  try {
    const bundle = await loadRedClawProfilePromptBundle();
    return {
      success: true,
      completed: Boolean(bundle.onboardingState.completedAt),
      state: bundle.onboardingState,
    };
  } catch (error) {
    return {
      success: false,
      completed: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
});

ipcMain.handle('redclaw:profile:onboarding-turn', async (_, payload?: { input?: string }) => {
  try {
    const result = await handleRedClawOnboardingTurn(String(payload?.input || ''));
    return {
      success: true,
      handled: result.handled,
      completed: Boolean(result.completed),
      responseText: result.responseText,
      result: {
        responseText: result.responseText,
        completed: Boolean(result.completed),
      },
    };
  } catch (error) {
    return {
      success: false,
      handled: false,
      completed: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
});

ipcMain.handle('redclaw:get-project', async (_, { projectId }: { projectId: string }) => {
  try {
    if (!projectId) {
      return { success: false, error: 'projectId is required' };
    }
    const detail = await getRedClawProject(projectId);
    return { success: true, ...detail };
  } catch (error) {
    console.error('Failed to get RedClaw project:', error);
    return { success: false, error: String(error) };
  }
});

ipcMain.handle('redclaw:open-project', async (_, { projectDir }: { projectDir: string }) => {
  try {
    if (!projectDir) {
      return { success: false, error: 'projectDir is required' };
    }
    const openError = await shell.openPath(projectDir);
    if (openError) {
      return { success: false, error: openError };
    }
    return { success: true };
  } catch (error) {
    console.error('Failed to open RedClaw project:', error);
    return { success: false, error: String(error) };
  }
});

ipcMain.handle('redclaw:runner-status', async () => {
  return (await getRedClawBackgroundRunnerLazy()).getStatus();
});

ipcMain.handle('redclaw:runner-start', async (_, payload: {
  intervalMinutes?: number;
  keepAliveWhenNoWindow?: boolean;
  maxProjectsPerTick?: number;
  maxAutomationPerTick?: number;
  heartbeatEnabled?: boolean;
  heartbeatIntervalMinutes?: number;
} = {}) => {
  try {
    return await (await getRedClawBackgroundRunnerLazy()).start(payload);
  } catch (error) {
    return { success: false, error: String(error) };
  }
});

ipcMain.handle('redclaw:runner-stop', async () => {
  try {
    return await (await getRedClawBackgroundRunnerLazy()).stop();
  } catch (error) {
    return { success: false, error: String(error) };
  }
});

ipcMain.handle('redclaw:runner-run-now', async (_, payload: { projectId?: string } = {}) => {
  try {
    return await (await getRedClawBackgroundRunnerLazy()).runNow(payload.projectId);
  } catch (error) {
    return { success: false, error: String(error) };
  }
});

ipcMain.handle('redclaw:runner-set-project', async (_, payload: {
  projectId: string;
  enabled: boolean;
  prompt?: string;
}) => {
  try {
    return await (await getRedClawBackgroundRunnerLazy()).setProjectState(payload);
  } catch (error) {
    return { success: false, error: String(error) };
  }
});

ipcMain.handle('redclaw:runner-set-config', async (_, payload: {
  intervalMinutes?: number;
  keepAliveWhenNoWindow?: boolean;
  maxProjectsPerTick?: number;
  maxAutomationPerTick?: number;
  heartbeatEnabled?: boolean;
  heartbeatIntervalMinutes?: number;
  heartbeatSuppressEmptyReport?: boolean;
  heartbeatReportToMainSession?: boolean;
  heartbeatPrompt?: string;
} = {}) => {
  try {
    return await (await getRedClawBackgroundRunnerLazy()).setRunnerConfig(payload);
  } catch (error) {
    return { success: false, error: String(error) };
  }
});

ipcMain.handle('redclaw:runner-list-scheduled', async () => {
  try {
    const tasks = (await getRedClawBackgroundRunnerLazy()).listScheduledTasks();
    return { success: true, tasks };
  } catch (error) {
    return { success: false, error: String(error), tasks: [] };
  }
});

ipcMain.handle('redclaw:runner-add-scheduled', async (_, payload: {
  name: string;
  mode: 'interval' | 'daily' | 'weekly' | 'once';
  prompt: string;
  projectId?: string;
  intervalMinutes?: number;
  time?: string;
  weekdays?: number[];
  runAt?: string;
  enabled?: boolean;
}) => {
  try {
    const task = await (await getRedClawBackgroundRunnerLazy()).addScheduledTask(payload);
    return { success: true, task };
  } catch (error) {
    return { success: false, error: String(error) };
  }
});

ipcMain.handle('redclaw:runner-remove-scheduled', async (_, payload: { taskId: string }) => {
  try {
    const status = await (await getRedClawBackgroundRunnerLazy()).removeScheduledTask(payload?.taskId || '');
    return { success: true, status };
  } catch (error) {
    return { success: false, error: String(error) };
  }
});

ipcMain.handle('redclaw:runner-set-scheduled-enabled', async (_, payload: { taskId: string; enabled: boolean }) => {
  try {
    const task = await (await getRedClawBackgroundRunnerLazy()).setScheduledTaskEnabled(payload?.taskId || '', Boolean(payload?.enabled));
    return { success: true, task };
  } catch (error) {
    return { success: false, error: String(error) };
  }
});

ipcMain.handle('redclaw:runner-run-scheduled-now', async (_, payload: { taskId: string }) => {
  try {
    const status = await (await getRedClawBackgroundRunnerLazy()).runScheduledTaskNow(payload?.taskId || '');
    return { success: true, status };
  } catch (error) {
    return { success: false, error: String(error) };
  }
});

ipcMain.handle('redclaw:runner-list-long-cycle', async () => {
  try {
    const tasks = (await getRedClawBackgroundRunnerLazy()).listLongCycleTasks();
    return { success: true, tasks };
  } catch (error) {
    return { success: false, error: String(error), tasks: [] };
  }
});

ipcMain.handle('redclaw:runner-add-long-cycle', async (_, payload: {
  name: string;
  objective: string;
  stepPrompt: string;
  projectId?: string;
  intervalMinutes?: number;
  totalRounds?: number;
  enabled?: boolean;
}) => {
  try {
    const task = await (await getRedClawBackgroundRunnerLazy()).addLongCycleTask(payload);
    return { success: true, task };
  } catch (error) {
    return { success: false, error: String(error) };
  }
});

ipcMain.handle('redclaw:runner-remove-long-cycle', async (_, payload: { taskId: string }) => {
  try {
    const status = await (await getRedClawBackgroundRunnerLazy()).removeLongCycleTask(payload?.taskId || '');
    return { success: true, status };
  } catch (error) {
    return { success: false, error: String(error) };
  }
});

ipcMain.handle('redclaw:runner-set-long-cycle-enabled', async (_, payload: { taskId: string; enabled: boolean }) => {
  try {
    const task = await (await getRedClawBackgroundRunnerLazy()).setLongCycleTaskEnabled(payload?.taskId || '', Boolean(payload?.enabled));
    return { success: true, task };
  } catch (error) {
    return { success: false, error: String(error) };
  }
});

ipcMain.handle('redclaw:runner-run-long-cycle-now', async (_, payload: { taskId: string }) => {
  try {
    const status = await (await getRedClawBackgroundRunnerLazy()).runLongCycleTaskNow(payload?.taskId || '');
    return { success: true, status };
  } catch (error) {
    return { success: false, error: String(error) };
  }
});

ipcMain.handle('media:list', async (_, { limit }: { limit?: number } = {}) => {
  try {
    const assets = await listMediaAssets(limit || 300);
    const enriched = await Promise.all(assets.map((asset) => enrichMediaAsset(asset)));
    return { success: true, assets: enriched };
  } catch (error) {
    console.error('Failed to list media assets:', error);
    return { success: false, error: String(error), assets: [] };
  }
});

ipcMain.handle('media:import-files', async () => {
  try {
    const picker = await dialog.showOpenDialog({
      title: '选择要导入到草稿媒体库的素材',
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: 'Media Files', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'svg', 'mp4', 'mov', 'webm', 'm4v', 'avi', 'mkv', 'mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg', 'opus'] },
        { name: 'All Files', extensions: ['*'] },
      ],
    });

    if (picker.canceled || !picker.filePaths.length) {
      return { success: true, canceled: true, imported: [] };
    }

    const imported = await importMediaFiles(picker.filePaths);
    const enriched = await Promise.all(imported.map((asset) => enrichMediaAsset(asset)));
    emitRendererDataChanged('media', { action: 'import' });
    return {
      success: true,
      imported: enriched,
      added: enriched.length,
    };
  } catch (error) {
    console.error('Failed to import media files:', error);
    return { success: false, error: String(error), imported: [] };
  }
});

ipcMain.handle('media:update', async (_, payload: { assetId: string; projectId?: string; title?: string; prompt?: string }) => {
  try {
    if (!payload?.assetId) {
      return { success: false, error: 'assetId is required' };
    }
    const updated = await updateMediaAssetMetadata(payload);
    emitRendererDataChanged('media', { action: 'update', entityId: payload.assetId });
    return { success: true, asset: await enrichMediaAsset(updated) };
  } catch (error) {
    console.error('Failed to update media asset:', error);
    return { success: false, error: String(error) };
  }
});

ipcMain.handle('media:delete', async (_, { assetId }: { assetId: string }) => {
  try {
    if (!assetId) {
      return { success: false, error: 'assetId is required' };
    }
    const deleted = await deleteMediaAsset(assetId);
    emitRendererDataChanged('media', { action: 'delete', entityId: assetId });
    return { success: true, deleted };
  } catch (error) {
    console.error('Failed to delete media asset:', error);
    return { success: false, error: String(error) };
  }
});

ipcMain.handle('media:bind', async (_, {
  assetId,
  manuscriptPath,
  role,
}: {
  assetId: string;
  manuscriptPath: string;
  role?: 'cover' | 'image' | 'asset';
}) => {
  try {
    if (!assetId || !manuscriptPath) {
      return { success: false, error: 'assetId and manuscriptPath are required' };
    }
    const normalizedManuscriptPath = normalizeRelativePath(manuscriptPath);
    const absoluteManuscriptPath = path.join(getWorkspacePaths().manuscripts, normalizedManuscriptPath);
    await fs.access(absoluteManuscriptPath);
    const updated = await bindMediaAssetToManuscript({
      assetId,
      manuscriptPath: normalizedManuscriptPath,
      role,
    });
    emitRendererDataChanged('media', { action: 'bind', entityId: assetId });
    return { success: true, asset: await enrichMediaAsset(updated) };
  } catch (error) {
    console.error('Failed to bind media asset:', error);
    return { success: false, error: String(error) };
  }
});

ipcMain.handle('media:open', async (_, { assetId }: { assetId: string }) => {
  try {
    if (!assetId) {
      return { success: false, error: 'assetId is required' };
    }
    const assets = await listMediaAssets(5000);
    const asset = assets.find((item) => item.id === assetId);
    if (!asset) {
      return { success: false, error: 'Media asset not found' };
    }

    const targetPath = asset.relativePath
      ? getAbsoluteMediaPath(asset.relativePath)
      : getWorkspacePaths().media;
    const openError = await shell.openPath(targetPath);
    if (openError) {
      return { success: false, error: openError };
    }
    return { success: true };
  } catch (error) {
    console.error('Failed to open media asset:', error);
    return { success: false, error: String(error) };
  }
});

ipcMain.handle('media:open-root', async () => {
  try {
    const openError = await shell.openPath(getWorkspacePaths().media);
    if (openError) {
      return { success: false, error: openError };
    }
    return { success: true };
  } catch (error) {
    console.error('Failed to open media library root:', error);
    return { success: false, error: String(error) };
  }
});

ipcMain.handle('subjects:list', async (_, { limit }: { limit?: number } = {}) => {
  try {
    const subjects = await listSubjects(limit || 500);
    return { success: true, subjects };
  } catch (error) {
    console.error('Failed to list subjects:', error);
    return { success: false, error: String(error), subjects: [] };
  }
});

ipcMain.handle('subjects:get', async (_, { id }: { id: string }) => {
  try {
    if (!id) {
      return { success: false, error: 'id is required' };
    }
    const subject = await getSubject(id);
    return { success: true, subject };
  } catch (error) {
    console.error('Failed to get subject:', error);
    return { success: false, error: String(error) };
  }
});

ipcMain.handle('subjects:create', async (_, payload: {
  name: string;
  categoryId?: string;
  description?: string;
  tags?: string[] | string;
  attributes?: Array<{ key: string; value: string }>;
  images?: Array<{ name?: string; dataUrl?: string; relativePath?: string }>;
  voice?: { name?: string; dataUrl?: string; relativePath?: string; scriptText?: string };
}) => {
  try {
    const subject = await createSubject(payload || { name: '' });
    emitRendererDataChanged('subjects', { action: 'create', entityId: subject.id });
    return { success: true, subject };
  } catch (error) {
    console.error('Failed to create subject:', error);
    return { success: false, error: String(error) };
  }
});

ipcMain.handle('subjects:update', async (_, payload: {
  id: string;
  name?: string;
  categoryId?: string;
  description?: string;
  tags?: string[] | string;
  attributes?: Array<{ key: string; value: string }>;
  images?: Array<{ name?: string; dataUrl?: string; relativePath?: string }>;
  voice?: { name?: string; dataUrl?: string; relativePath?: string; scriptText?: string };
}) => {
  try {
    if (!payload?.id) {
      return { success: false, error: 'id is required' };
    }
    const subject = await updateSubject(payload);
    emitRendererDataChanged('subjects', { action: 'update', entityId: payload.id });
    return { success: true, subject };
  } catch (error) {
    console.error('Failed to update subject:', error);
    return { success: false, error: String(error) };
  }
});

ipcMain.handle('subjects:delete', async (_, { id }: { id: string }) => {
  try {
    if (!id) {
      return { success: false, error: 'id is required' };
    }
    await deleteSubject(id);
    emitRendererDataChanged('subjects', { action: 'delete', entityId: id });
    return { success: true };
  } catch (error) {
    console.error('Failed to delete subject:', error);
    return { success: false, error: String(error) };
  }
});

ipcMain.handle('subjects:search', async (_, { query, categoryId, limit }: { query?: string; categoryId?: string; limit?: number } = {}) => {
  try {
    const subjects = await searchSubjects(String(query || ''), { categoryId, limit });
    return { success: true, subjects };
  } catch (error) {
    console.error('Failed to search subjects:', error);
    return { success: false, error: String(error), subjects: [] };
  }
});

ipcMain.handle('subjects:categories:list', async () => {
  try {
    const categories = await listSubjectCategories();
    return { success: true, categories };
  } catch (error) {
    console.error('Failed to list subject categories:', error);
    return { success: false, error: String(error), categories: [] };
  }
});

ipcMain.handle('subjects:categories:create', async (_, { name }: { name: string }) => {
  try {
    const category = await createSubjectCategory(name);
    emitRendererDataChanged('subjects', { action: 'category-create', entityId: category.id });
    return { success: true, category };
  } catch (error) {
    console.error('Failed to create subject category:', error);
    return { success: false, error: String(error) };
  }
});

ipcMain.handle('subjects:categories:update', async (_, payload: { id: string; name: string }) => {
  try {
    const category = await updateSubjectCategory(payload);
    emitRendererDataChanged('subjects', { action: 'category-update', entityId: payload.id });
    return { success: true, category };
  } catch (error) {
    console.error('Failed to update subject category:', error);
    return { success: false, error: String(error) };
  }
});

ipcMain.handle('subjects:categories:delete', async (_, { id }: { id: string }) => {
  try {
    await deleteSubjectCategory(id);
    emitRendererDataChanged('subjects', { action: 'category-delete', entityId: id });
    return { success: true };
  } catch (error) {
    console.error('Failed to delete subject category:', error);
    return { success: false, error: String(error) };
  }
});

ipcMain.handle('cover:list', async (_, { limit }: { limit?: number } = {}) => {
  try {
    const assets = await listCoverAssets(limit || 300);
    const enriched = await Promise.all(assets.map((asset) => enrichCoverAsset(asset)));
    return { success: true, assets: enriched };
  } catch (error) {
    console.error('Failed to list cover assets:', error);
    return { success: false, error: String(error), assets: [] };
  }
});

ipcMain.handle('cover:templates:list', async () => {
  try {
    return {
      success: true,
      templates: await listCoverTemplates(),
    };
  } catch (error) {
    return { success: false, error: String(error), templates: [] };
  }
});

ipcMain.handle('cover:templates:save', async (_, payload?: { template?: Record<string, unknown> }) => {
  try {
    const template = await saveCoverTemplate(payload?.template || {});
    return {
      success: true,
      template,
      templates: await listCoverTemplates(),
    };
  } catch (error) {
    return { success: false, error: String(error), templates: [] };
  }
});

ipcMain.handle('cover:templates:delete', async (_, payload?: { templateId?: string }) => {
  try {
    const templates = await deleteCoverTemplate(String(payload?.templateId || '').trim());
    return { success: true, templates };
  } catch (error) {
    return { success: false, error: String(error), templates: [] };
  }
});

ipcMain.handle('cover:templates:import-legacy', async (_, payload?: { templates?: Record<string, unknown>[] }) => {
  try {
    const templates = await importLegacyCoverTemplates(Array.isArray(payload?.templates) ? payload!.templates! : []);
    return {
      success: true,
      imported: templates.length,
      templates,
    };
  } catch (error) {
    return { success: false, error: String(error), templates: [] };
  }
});

ipcMain.handle('cover:open', async (_, { assetId }: { assetId: string }) => {
  try {
    if (!assetId) {
      return { success: false, error: 'assetId is required' };
    }
    const assets = await listCoverAssets(5000);
    const asset = assets.find((item) => item.id === assetId);
    if (!asset) {
      return { success: false, error: 'Cover asset not found' };
    }

    const targetPath = asset.relativePath
      ? getAbsoluteCoverAssetPath(asset.relativePath)
      : getCoverRootDir();
    const openError = await shell.openPath(targetPath);
    if (openError) {
      return { success: false, error: openError };
    }
    return { success: true };
  } catch (error) {
    console.error('Failed to open cover asset:', error);
    return { success: false, error: String(error) };
  }
});

ipcMain.handle('cover:open-root', async () => {
  try {
    const openError = await shell.openPath(getCoverRootDir());
    if (openError) {
      return { success: false, error: openError };
    }
    return { success: true };
  } catch (error) {
    console.error('Failed to open cover root:', error);
    return { success: false, error: String(error) };
  }
});

ipcMain.handle('cover:save-template-image', async (_, {
  imageSource,
}: {
  imageSource: string;
}) => {
  try {
    const source = String(imageSource || '').trim();
    if (!source) {
      return { success: false, error: 'imageSource is required' };
    }
    const resolved = await readCoverTemplateSourceToBuffer(source);
    const saved = await saveCoverTemplateImage({
      imageBuffer: resolved.imageBuffer,
      mimeType: resolved.mimeType,
      extensionHint: resolved.extensionHint,
    });
    const absolutePath = getAbsoluteCoverAssetPath(saved.relativePath);
    return {
      success: true,
      relativePath: saved.relativePath,
      absolutePath,
      previewUrl: toLocalFileUrl(absolutePath),
      mimeType: saved.mimeType,
    };
  } catch (error) {
    console.error('Failed to save cover template image:', error);
    return { success: false, error: String(error) };
  }
});

ipcMain.handle('cover:generate', async (_, {
  templateImage,
  baseImage,
  titles,
  styleHint,
  promptSwitches,
  templateName,
  count,
  model,
  provider,
  providerTemplate,
  endpoint,
  apiKey,
  quality,
}: {
  templateImage: string;
  baseImage: string;
  titles: Array<{ type: string; text: string }>;
  styleHint?: string;
  promptSwitches?: {
    learnTypography?: boolean;
    learnColorMood?: boolean;
    beautifyFace?: boolean;
    replaceBackground?: boolean;
  };
  templateName?: string;
  count?: number;
  model?: string;
  provider?: string;
  providerTemplate?: string;
  endpoint?: string;
  apiKey?: string;
  quality?: string;
}) => {
  try {
    const { generateCoverAssets } = await import('./core/coverGenerationService');
    const result = await generateCoverAssets({
      templateImage,
      baseImage,
      titles,
      styleHint,
      promptSwitches,
      templateName,
      count,
      model,
      provider,
      providerTemplate,
      endpoint,
      apiKey,
      quality,
    });
    const assets = await Promise.all(result.assets.map((asset) => enrichCoverAsset(asset)));
    return { success: true, assets };
  } catch (error) {
    console.error('Failed to generate cover assets:', error);
    return { success: false, error: String(error) };
  }
});

ipcMain.handle('image-gen:generate', async (_, {
  prompt,
  projectId,
  title,
  generationMode,
  referenceImages,
  count,
  size,
  quality,
  model,
  provider,
  providerTemplate,
  aspectRatio,
}: {
  prompt: string;
  projectId?: string;
  title?: string;
  generationMode?: 'text-to-image' | 'image-to-image' | 'reference-guided' | string;
  referenceImages?: string[];
  count?: number;
  size?: string;
  quality?: string;
  model?: string;
  provider?: string;
  providerTemplate?: string;
  aspectRatio?: string;
}) => {
  try {
    const { generateImagesToMediaLibrary } = await import('./core/imageGenerationService');
    const result = await generateImagesToMediaLibrary({
      prompt,
      projectId,
      title,
      generationMode,
      referenceImages,
      count,
      size,
      quality,
      model,
      provider,
      providerTemplate,
      aspectRatio,
    });
    const assets = await Promise.all(result.assets.map((asset) => enrichMediaAsset(asset)));
    emitRendererDataChanged('media', { action: 'generate-image' });
    return { success: true, assets };
  } catch (error) {
    console.error('Failed to generate images:', error);
    return { success: false, error: String(error) };
  }
});

ipcMain.handle('video-gen:generate', async (_, {
  prompt,
  projectId,
  title,
  model,
  generationMode,
  referenceImages,
  aspectRatio,
  count,
  durationSeconds,
  resolution,
  generateAudio,
  drivingAudio,
  firstClip,
}: {
  prompt: string;
  projectId?: string;
  title?: string;
  model?: string;
  generationMode?: 'text-to-video' | 'reference-guided' | 'first-last-frame' | 'continuation' | string;
  referenceImages?: string[];
  aspectRatio?: string;
  count?: number;
  durationSeconds?: number;
  resolution?: '720p' | '1080p';
  generateAudio?: boolean;
  drivingAudio?: string;
  firstClip?: string;
}) => {
  try {
    const { generateVideosToMediaLibrary } = await import('./core/videoGenerationService');
    const normalizedGenerationMode = (() => {
      const value = String(generationMode || '').trim().toLowerCase();
      if (value === 'text-to-video' || value === 'reference-guided' || value === 'first-last-frame' || value === 'continuation') {
        return value as 'text-to-video' | 'reference-guided' | 'first-last-frame' | 'continuation';
      }
      return undefined;
    })();
    const result = await generateVideosToMediaLibrary({
      prompt,
      projectId,
      title,
      model,
      generationMode: normalizedGenerationMode,
      referenceImages,
      aspectRatio,
      count,
      durationSeconds,
      resolution,
      generateAudio,
      drivingAudio,
      firstClip,
    });
    const assets = await Promise.all(result.assets.map((asset) => enrichMediaAsset(asset)));
    emitRendererDataChanged('media', { action: 'generate-video' });
    return { success: true, assets };
  } catch (error) {
    console.error('Failed to generate videos:', error);
    return { success: false, error: String(error) };
  }
});

// 获取所有会话
ipcMain.handle('chat:get-sessions', async () => {
  return getChatSessions();
});

// 删除会话
ipcMain.handle('chat:delete-session', async (_, sessionId: string) => {
  deleteChatSession(sessionId);
  cleanupChatService(sessionId);
  return { success: true };
});

// 获取会话消息
ipcMain.handle('chat:get-messages', async (_, sessionId: string) => {
  return getChatMessages(sessionId);
});

// 清空会话消息
ipcMain.handle('chat:clear-messages', async (_, sessionId: string) => {
  clearChatMessages(sessionId);
  const session = getChatSession(sessionId);
  if (session?.metadata) {
    try {
      const metadata = JSON.parse(session.metadata);
      delete metadata.compactSummary;
      delete metadata.compactBaseMessageCount;
      delete metadata.compactRounds;
      delete metadata.compactUpdatedAt;
      updateChatSessionMetadata(sessionId, metadata);
    } catch (error) {
      console.warn('[chat:clear-messages] Failed to clear compact metadata:', error);
    }
  }
  const service = chatServices.get(sessionId);
  if (service) {
    service.clearHistory();
  }
  return { success: true };
});

ipcMain.handle('chat:compact-context', async (event, sessionId: string) => {
  if (!sessionId) {
    return { success: false, compacted: false, message: 'sessionId is required' };
  }

  try {
    const service = await getOrCreateChatService(sessionId, event.sender);
    return await service.compactContextNow(sessionId);
  } catch (error) {
    console.error('[chat:compact-context] Failed:', error);
    return { success: false, compacted: false, message: String(error) };
  }
});

ipcMain.handle('chat:get-context-usage', async (_, sessionId: string) => {
  if (!sessionId) {
    return {
      success: false,
      error: 'sessionId is required',
    };
  }

  const session = getChatSession(sessionId);
  const messages = getChatMessages(sessionId).filter((msg) => msg.role === 'user' || msg.role === 'assistant');
  const estimateTokens = (text: string) => Math.ceil(String(text || '').length / 4);

  let metadata: Record<string, unknown> = {};
  if (session?.metadata) {
    try {
      metadata = JSON.parse(session.metadata) as Record<string, unknown>;
    } catch {
      metadata = {};
    }
  }

  const compactBaseMessageCount = Number(metadata.compactBaseMessageCount || 0);
  const compactSummary = String(metadata.compactSummary || '');
  const compactSummaryTokens = compactSummary ? estimateTokens(compactSummary) : 0;
  const activeMessages = messages.slice(Math.max(0, Math.min(messages.length, compactBaseMessageCount)));
  const activeHistoryTokens = activeMessages.reduce((acc, msg) => acc + estimateTokens(msg.content || ''), 0);
  const estimatedTotalTokens = activeHistoryTokens + compactSummaryTokens;

  const settings = (getSettings() || {}) as Record<string, unknown>;
  const targetTokensRaw = Number(settings.redclaw_compact_target_tokens);
  const compactTargetTokens = Number.isFinite(targetTokensRaw) && targetTokensRaw > 0
    ? Math.floor(targetTokensRaw)
    : 256000;
  const contextWindowFallback = 64000;
  const safeUpperBound = Math.max(24000, Math.floor(contextWindowFallback * 0.88));
  const compactThreshold = Math.max(16000, Math.min(compactTargetTokens, safeUpperBound));
  const compactRounds = Number(metadata.compactRounds || 0);
  const compactUpdatedAt = String(metadata.compactUpdatedAt || '');
  const compactRatio = compactThreshold > 0 ? estimatedTotalTokens / compactThreshold : 0;

  return {
    success: true,
    sessionId,
    contextType: String(metadata.contextType || ''),
    messageCount: messages.length,
    compactBaseMessageCount,
    compactRounds,
    compactUpdatedAt: compactUpdatedAt || null,
    estimatedTotalTokens,
    compactSummaryTokens,
    activeHistoryTokens,
    compactThreshold,
    compactRatio: Number.isFinite(compactRatio) ? compactRatio : 0,
  };
});

ipcMain.handle('chat:get-runtime-state', async (event, sessionId: string) => {
  if (!sessionId) {
    return {
      success: false,
      error: 'sessionId is required',
      isProcessing: false,
      partialResponse: '',
      updatedAt: 0,
    };
  }

  try {
    const service = chatServices.get(sessionId);
    if (!service) {
      return {
        success: true,
        sessionId,
        isProcessing: false,
        partialResponse: '',
        updatedAt: 0,
      };
    }
    const browserWindow = BrowserWindow.fromWebContents(event.sender);
    if (browserWindow) {
      service.setWindow(browserWindow);
    }
    const runtime = service.getRuntimeState();
    return {
      success: true,
      sessionId,
      isProcessing: Boolean(runtime.isProcessing),
      partialResponse: runtime.partialResponse || '',
      updatedAt: Number(runtime.updatedAt || 0),
    };
  } catch (error) {
    return {
      success: false,
      error: String(error),
      isProcessing: false,
      partialResponse: '',
      updatedAt: 0,
    };
  }
});

// 自动生成聊天标题
ipcMain.handle('chat:generate-title', async (_, { sessionId, message }) => {
    // TODO: Implement title generation with new engine
    return message.substring(0, 30);
});

ipcMain.handle('chat:pick-attachment', async (_, payload?: { sessionId?: string }) => {
  try {
    const picker = await dialog.showOpenDialog({
      title: '选择要上传的文件',
      properties: ['openFile'],
    });
    if (picker.canceled || !picker.filePaths.length) {
      return { success: true, canceled: true };
    }

    const selectedPath = path.resolve(path.normalize(picker.filePaths[0]));
    const fileStat = await fs.stat(selectedPath);
    if (!fileStat.isFile()) {
      return { success: false, error: '只能上传文件' };
    }

    const workspacePaths = getWorkspacePaths();
    const uploadsDir = path.join(workspacePaths.redclaw, 'uploads');
    await fs.mkdir(uploadsDir, { recursive: true });

    const ext = extensionFromPath(selectedPath);
    const safeBaseName = path.basename(selectedPath).replace(/[^\w.\-\u4e00-\u9fa5]+/g, '_');
    const targetName = `${Date.now()}_${safeBaseName}`;
    const targetPath = path.join(uploadsDir, targetName);
    await fs.copyFile(selectedPath, targetPath);

    const lowerExt = ext.toLowerCase();
    const kind = TEXT_ATTACHMENT_EXTENSIONS.has(lowerExt)
      ? 'text'
      : IMAGE_ATTACHMENT_EXTENSIONS.has(lowerExt)
        ? 'image'
        : VIDEO_ATTACHMENT_EXTENSIONS.has(lowerExt)
          ? 'video'
          : AUDIO_ATTACHMENT_EXTENSIONS.has(lowerExt)
            ? 'audio'
            : 'binary';

    let summary = '';
    if (kind === 'text') {
      try {
        const preview = await fs.readFile(targetPath, 'utf-8');
        summary = String(preview || '').replace(/\s+/g, ' ').trim().slice(0, 220);
      } catch {
        summary = '';
      }
    }

    return {
      success: true,
      canceled: false,
      attachment: {
        type: 'uploaded-file',
        name: path.basename(selectedPath),
        ext: lowerExt,
        size: Number(fileStat.size || 0),
        absolutePath: targetPath,
        originalAbsolutePath: selectedPath,
        localUrl: toLocalFileUrl(targetPath),
        kind,
        mimeType: guessAttachmentMimeType(lowerExt, kind),
        storageMode: 'staged',
        directUploadEligible: kind === 'image',
        processingStrategy: kind === 'image' ? 'direct-image-or-staged' : kind === 'text' ? 'staged-text' : 'staged-file',
        requiresMultimodal: kind === 'image',
        summary,
      },
    };
  } catch (error) {
    console.error('Failed to pick chat attachment:', error);
    return { success: false, error: String(error) };
  }
});

ipcMain.handle('chat:transcribe-audio', async (_event, payload?: {
  audioBase64?: string;
  mimeType?: string;
  fileName?: string;
}) => {
  const audioBase64 = String(payload?.audioBase64 || '').trim();
  if (!audioBase64) {
    return { success: false, error: '缺少音频数据' };
  }

  const mimeType = String(payload?.mimeType || 'audio/webm').trim().toLowerCase();
  const requestedName = String(payload?.fileName || '').trim();
  const extFromMime = (() => {
    if (mimeType.includes('webm')) return '.webm';
    if (mimeType.includes('wav')) return '.wav';
    if (mimeType.includes('mpeg') || mimeType.includes('mp3')) return '.mp3';
    if (mimeType.includes('mp4')) return '.mp4';
    if (mimeType.includes('ogg')) return '.ogg';
    if (mimeType.includes('aac')) return '.aac';
    if (mimeType.includes('m4a')) return '.m4a';
    return '.webm';
  })();

  const tempFileName = `${requestedName.replace(/[^\w.\-\u4e00-\u9fa5]+/g, '_') || `chat_audio_${Date.now()}`}${path.extname(requestedName) || extFromMime}`;
  const tempFilePath = path.join(app.getPath('temp'), tempFileName);

  try {
    const audioBuffer = Buffer.from(audioBase64, 'base64');
    await fs.writeFile(tempFilePath, audioBuffer);
    const result = await transcribeVideoToText(tempFilePath);
    if (!result.text) {
      return { success: false, error: result.error || '转录失败' };
    }
    return { success: true, text: result.text };
  } catch (error) {
    console.error('[chat:transcribe-audio] Failed:', error);
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  } finally {
    try {
      await fs.unlink(tempFilePath);
    } catch {
      // ignore cleanup failures
    }
  }
});

// 开始聊天（使用 ChatServiceV2）
ipcMain.on('chat:send-message', async (event, { sessionId, message, displayContent, attachment, modelConfig, taskHints }) => {
  const resolveRuntimeModeForSession = (value: string): RuntimeMode => {
    const normalized = String(value || '').trim().toLowerCase();
    if (normalized === 'redclaw') return 'redclaw';
    if (normalized === 'knowledge' || normalized === 'note' || normalized === 'video' || normalized === 'youtube' || normalized === 'document' || normalized === 'link-article' || normalized === 'wechat-article') return 'knowledge';
    if (normalized === 'advisor-discussion') return 'advisor-discussion';
    if (normalized === 'background-maintenance') return 'background-maintenance';
    return 'chatroom';
  };
  const sender = event.sender;
  const settings = (getSettings() || {}) as Record<string, unknown>;
  const selectedModelConfig = (modelConfig && typeof modelConfig === 'object')
    ? modelConfig as { apiKey?: string; baseURL?: string; modelName?: string }
    : null;
  const resolvedChatApiKey = String(selectedModelConfig?.apiKey || settings.api_key || '').trim();
  const resolvedChatBaseURL = normalizeApiBaseUrl(String(selectedModelConfig?.baseURL || settings.api_endpoint || '').trim());
  const resolvedModelName = String(selectedModelConfig?.modelName || settings.model_name || 'gpt-4o').trim();
  const rawAttachment = (attachment && typeof attachment === 'object')
    ? (attachment as Record<string, unknown>)
    : null;
  let outgoingMessage = String(message || '');
  let attachmentRuntimeInput: string | Array<{ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }> | null = null;
  console.log('[chat:send-message] incoming', {
    sessionId: sessionId || null,
    messageLength: typeof message === 'string' ? message.length : 0,
    hasAttachment: Boolean(attachment),
    modelFromSettings: settings.model_name || null,
  });

  if (rawAttachment?.type === 'uploaded-file') {
    const sessionMeta = sessionId ? (() => {
      try {
        const session = getChatSession(sessionId);
        if (!session?.metadata) return {};
        return JSON.parse(session.metadata) as Record<string, unknown>;
      } catch {
        return {} as Record<string, unknown>;
      }
    })() : {};
    const attachmentKind = String(rawAttachment.kind || 'file').trim().toLowerCase();
    const directInputSupported = supportsAttachmentKindDirectInput(resolvedModelName, attachmentKind);
    const modelInputCapabilities = getModelInputCapabilities(resolvedModelName);
    const requiresMultimodal = Boolean(rawAttachment.requiresMultimodal);
    if (requiresMultimodal && !directInputSupported) {
      const kind = String(rawAttachment.kind || 'file');
      const capabilityHint = modelInputCapabilities.length > 0
        ? `当前登记的输入能力: ${modelInputCapabilities.join(', ')}`
        : '当前未登记该模型的输入能力';
      const failMessage = `当前模型 "${resolvedModelName}" 不支持 ${kind} 附件直传。${capabilityHint}。请切换到支持该输入类型的模型后重试。`;
      sender.send('chat:error', {
        message: 'AI 请求失败（模型不支持附件）',
        category: 'request',
        hint: failMessage,
        raw: failMessage,
      });
      return;
    }

    try {
      attachmentRuntimeInput = await buildAttachmentRuntimeInput(rawAttachment, outgoingMessage, resolvedModelName);
    } catch (error) {
      console.warn('[chat:send-message] failed to prepare direct attachment input, falling back to staged prompt', error);
      attachmentRuntimeInput = null;
    }
    if (!attachmentRuntimeInput) {
      outgoingMessage = `${outgoingMessage}${buildAttachmentPromptSuffix(rawAttachment)}`;
    }
  }

  // 如果没有 sessionId，创建新会话
  if (!sessionId) {
    sessionId = `session_${Date.now()}`;

    createChatSession(sessionId, 'New Chat');
    sender.send('chat:session-created', { sessionId });
  }

  // 保存用户消息到数据库
  const userMsgId = `msg_${Date.now()}`;
  addChatMessage({
    id: userMsgId,
    session_id: sessionId,
    role: 'user',
    content: outgoingMessage,
    display_content: displayContent || undefined,
    attachment: attachment ? JSON.stringify(attachment) : undefined,
  });

  try {
    const sessionMeta = (() => {
      try {
        const session = getChatSession(sessionId);
        if (!session?.metadata) return {} as Record<string, unknown>;
        return JSON.parse(session.metadata) as Record<string, unknown>;
      } catch {
        return {} as Record<string, unknown>;
      }
    })();
    const redClawAuthoringHints = normalizeRedClawAuthoringHints(taskHints);
    const forcedSkillNames = resolveForcedSkillNames(taskHints);
    if (redClawAuthoringHints) {
      outgoingMessage = buildRedClawAuthoringPrompt(outgoingMessage, redClawAuthoringHints);
    }

    const runtimeMode = resolveRuntimeModeForSession(String(sessionMeta.contextType || ''));
    const routeAnalysis = getAgentRuntime().analyzeRuntimeContext({
      runtimeContext: {
        sessionId,
        runtimeMode,
        userInput: outgoingMessage,
        metadata: {
          ...sessionMeta,
          attachmentType: rawAttachment?.type || null,
          ...(taskHints && typeof taskHints === 'object' ? taskHints : {}),
        },
      },
    });

    if (routeAnalysis.shouldUseCoordinator && runtimeMode !== 'background-maintenance') {
      emitForcedSkillActivationEvents(sender, forcedSkillNames);
      sender.send('chat:phase-start', { name: '任务已进入协作模式' });
      sender.send('chat:thought-start', {});
      sender.send('chat:thought-delta', {
        content: routeAnalysis.route.intent === 'manuscript_creation'
          ? '正在接管创作任务并准备读取素材...'
          : '正在接管任务并准备协作执行...',
      });
      const baseSystemPrompt = await buildRuntimeBaseSystemPrompt({
        runtimeMode,
        interactive: true,
        forcedSkillNames,
      });
      console.log('[chat:send-message] routed-to-coordinator', {
        sessionId,
        runtimeMode,
        intent: routeAnalysis.route.intent,
        requiresMultiAgent: routeAnalysis.route.requiresMultiAgent,
        requiresLongRunningTask: routeAnalysis.route.requiresLongRunningTask,
      });
      const prepared = await getAgentRuntime().prepareExecution({
        runtimeContext: {
          sessionId,
          runtimeMode,
          userInput: outgoingMessage,
          metadata: {
            ...sessionMeta,
            attachmentType: rawAttachment?.type || null,
            ...(taskHints && typeof taskHints === 'object' ? taskHints : {}),
          },
        },
        baseSystemPrompt,
        llm: {
          apiKey: resolvedChatApiKey,
          baseURL: resolvedChatBaseURL,
          model: resolvedModelName || String(resolveScopedModelName(settings, 'redclaw', String(settings.model_name || 'gpt-4o-mini'))).trim(),
        },
      });
      await getLongTaskCoordinator().maybeRun(prepared.task.id, {
        baseSystemPrompt,
        emitChatEvent: (channel, data) => sender.send(channel, data),
      });
      console.log('[chat:send-message] coordinator-completed', { sessionId, taskId: prepared.task.id });
      return;
    }

    const service = await getOrCreateChatService(sessionId, sender);
    if (forcedSkillNames.length > 0) {
      await service.activateSkills(forcedSkillNames);
    }

    // 发送消息
    await service.sendMessage(
      outgoingMessage,
      sessionId,
      {
        apiKey: resolvedChatApiKey,
        baseURL: resolvedChatBaseURL,
        modelName: resolvedModelName,
      },
      {
        userInputContent: attachmentRuntimeInput || undefined,
      },
    );
    console.log('[chat:send-message] completed', { sessionId });

  } catch (err: unknown) {
    console.error('ChatV2 Error:', err);
    const explicit = (err && typeof err === 'object')
      ? err as {
        chatErrorMessage?: unknown;
        chatErrorHint?: unknown;
        chatErrorCategory?: unknown;
        chatErrorStatusCode?: unknown;
        chatErrorCode?: unknown;
      }
      : null;
    const raw = err instanceof Error ? (err.message || String(err)) : String(err || 'Unknown error occurred');
    const lower = raw.toLowerCase();
    const statusMatch = raw.match(/\b([1-5]\d{2})\b/);
    const statusCode = statusMatch ? Number(statusMatch[1]) : undefined;
    const codeMatch = raw.match(/\b(invalid_api_key|incorrect_api_key|insufficient_quota|quota_exceeded|rate_limit_exceeded|authentication_error)\b/i);
    const errorCode = codeMatch ? codeMatch[1] : undefined;
    const explicitCategory = String(explicit?.chatErrorCategory || '').trim();
    const isInsufficientBalance =
      lower.includes('insufficient balance') ||
      lower.includes('insufficient_balance') ||
      lower.includes('insufficient_quota') ||
      /\b1008\b/.test(lower);
    const message = String(explicit?.chatErrorMessage || '').trim() || (
      isInsufficientBalance
      ? 'AI 请求失败（余额不足）'
      : statusCode || errorCode
      ? `AI 请求失败（${[statusCode ? `HTTP ${statusCode}` : '', errorCode || ''].filter(Boolean).join(' · ')}）`
      : 'AI 请求失败'
    );
    const hint = String(explicit?.chatErrorHint || '').trim() || (
      isInsufficientBalance
      ? '账号余额/额度不足。请充值或切换到有余额的 AI 源。'
      : '请检查 API Key、模型和 AI 源地址配置。'
    );
    sender.send('chat:error', {
      message,
      raw: raw.slice(0, 6000),
      statusCode: Number.isFinite(Number(explicit?.chatErrorStatusCode)) ? Number(explicit?.chatErrorStatusCode) : statusCode,
      errorCode: String(explicit?.chatErrorCode || '').trim() || errorCode,
      hint,
      category: explicitCategory || (isInsufficientBalance ? 'quota' : undefined),
    });
  }
});

// 取消执行
ipcMain.on('chat:cancel', (_, payload?: { sessionId?: string } | string) => {
    const sessionId = typeof payload === 'string'
      ? payload
      : payload?.sessionId;

    if (sessionId) {
      const service = chatServices.get(sessionId);
      if (service) {
        service.abort();
      }
      return;
    }

    for (const service of chatServices.values()) {
      service.abort();
    }
});

// ========== 保留旧的 ai:start-chat 以兼容旧 UI ==========
let currentAgent: AgentExecutor | null = null;

ipcMain.on('ai:start-chat', async (event, message, modelConfig) => {
  const sender = event.sender

  const settings = (getSettings() || {}) as Record<string, unknown>

  const config: AgentConfig = {
    apiKey: (modelConfig?.apiKey || settings.api_key || '') as string,
    baseURL: normalizeApiBaseUrl((modelConfig?.baseURL || settings.api_endpoint || '') as string),
    model: (modelConfig?.modelName || settings.model_name || '') as string,
    projectRoot: process.cwd(),
    maxTurns: 40,
    maxTimeMinutes: 20,
    temperature: 0.7,
  }

  if (!config.apiKey) {
    sender.send('ai:error', 'API Key is missing. Please configure it in Settings.')
    return
  }

  if (!config.model) {
    sender.send('ai:error', 'Model Name is missing. Please configure a default model in Settings.')
    return
  }

  try {
    currentAgent = await createAgentExecutor(config, (agentEvent) => {
      switch (agentEvent.type) {
        case 'thinking':
          sender.send('ai:stream-event', { type: 'stage_start', data: { stage: 'thinking', content: agentEvent.content } })
          break
        case 'tool_start':
          sender.send('ai:stream-event', { type: 'tool_start', data: { callId: agentEvent.callId, name: agentEvent.name, input: agentEvent.params, description: agentEvent.description } })
          break
        case 'tool_end':
          sender.send('ai:stream-event', { type: 'tool_end', data: { callId: agentEvent.callId, name: agentEvent.name, output: agentEvent.result } })
          break
        case 'tool_confirm_request':
          sender.send('ai:tool-confirm-request', { callId: agentEvent.callId, name: agentEvent.name, details: agentEvent.details })
          break
        case 'response_chunk':
          sender.send('ai:stream-event', { type: 'token_stream', data: { content: agentEvent.content } })
          break
        case 'skill_activated':
          sender.send('ai:stream-event', { type: 'skill_activated', data: { name: agentEvent.name, description: agentEvent.description } })
          break
        case 'error':
          sender.send('ai:error', agentEvent.message)
          break
        case 'done':
          sender.send('ai:stream-end')
          break
      }
    })
    await currentAgent.run(message)
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error occurred';
    sender.send('ai:error', message)
  } finally {
    currentAgent = null
  }
})

// 工具确认响应（旧版）
ipcMain.on('ai:confirm-tool', (_, callId: string, confirmed: boolean) => {
  if (currentAgent) {
    const { ToolConfirmationOutcome } = require('./core/toolRegistry');
    const outcome = confirmed
      ? ToolConfirmationOutcome.ProceedOnce
      : ToolConfirmationOutcome.Cancel;
    currentAgent.confirmToolCall(callId, outcome)
  }
})

ipcMain.on('chat:confirm-tool', (_, payload?: { callId?: string; confirmed?: boolean }) => {
  const callId = String(payload?.callId || '').trim();
  if (!callId) return;
  ipcMain.emit('ai:confirm-tool', {} as Electron.IpcMainEvent, callId, payload?.confirmed === true)
})

// 取消 Agent 执行（旧版）
ipcMain.on('ai:cancel', () => {
  if (currentAgent) {
    currentAgent.cancel()
  }
})

// Skills 管理
ipcMain.handle('skills:list', async () => {
  try {
    const manager = new SkillManager();
    const paths = getWorkspacePaths();
    await manager.discoverSkills(paths.base);
    const skills = manager.getAllSkills();
    console.log('[skills:list] Found skills:', skills.length, 'in workspace:', paths.base);
    return skills;
  } catch (error) {
    console.error('Failed to list skills:', error);
    return [];
  }
})

const SKILL_FRONTMATTER_REGEX = /^---\r?\n[\s\S]*?\r?\n---/;
const SKILL_NAME_REGEX = /^\s*name:\s*(.+)$/m;
const SKILL_DESC_REGEX = /^\s*description:\s*(.+)$/m;

const CLAWHUB_BASE_URL = 'https://clawhub.ai';

const sanitizeSkillFileName = (value: string): string => {
  const normalized = value.trim().replace(/\s+/g, '-').replace(/[^a-zA-Z0-9._-\u4e00-\u9fa5]/g, '-');
  return normalized || `skill-${Date.now()}`;
};

const parseSkillHeader = (content: string): { name?: string; description?: string } => {
  const nameMatch = content.match(SKILL_NAME_REGEX);
  const descMatch = content.match(SKILL_DESC_REGEX);
  const name = nameMatch?.[1]?.trim().replace(/^["']|["']$/g, '');
  const description = descMatch?.[1]?.trim().replace(/^["']|["']$/g, '');
  return { name, description };
};

const buildSkillFileName = async (skillsDir: string, preferredName: string): Promise<string> => {
  const base = sanitizeSkillFileName(preferredName).replace(/\.md$/i, '');
  let candidate = `${base}.md`;
  let index = 1;
  while (true) {
    try {
      await fs.access(path.join(skillsDir, candidate));
      candidate = `${base}-${index}.md`;
      index += 1;
    } catch {
      return candidate;
    }
  }
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const clawHubRequest = async (
  pathname: string,
  options?: {
    query?: Record<string, string | number | boolean | undefined>;
    responseType?: 'json' | 'text';
    retries?: number;
  }
): Promise<any> => {
  const query = options?.query || {};
  const url = new URL(pathname, CLAWHUB_BASE_URL);
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '') continue;
    url.searchParams.set(key, String(value));
  }

  let retries = options?.retries ?? 1;
  while (true) {
    const response = await fetch(url.toString(), {
      headers: {
        'Accept': options?.responseType === 'text' ? 'text/plain,*/*' : 'application/json',
        'User-Agent': 'RedConvert-Skill-Market/1.0',
      },
    });

    if (response.ok) {
      if (options?.responseType === 'text') {
        return response.text();
      }
      return response.json();
    }

    if (response.status === 429 && retries > 0) {
      const retryAfter = Number(response.headers.get('retry-after') || '2');
      await sleep(Math.max(1, retryAfter) * 1000);
      retries -= 1;
      continue;
    }

    const errorText = await response.text().catch(() => '');
    throw new Error(`ClawHub API error (${response.status}): ${errorText || response.statusText}`);
  }
};

const toMarketSkill = (item: any, index: number) => ({
  id: item.slug || `skill-${index}`,
  slug: item.slug || '',
  skillName: item.displayName || item.slug || 'Unknown Skill',
  description: item.summary || '',
  stars: Number(item.stats?.stars || 0),
  installs: Number(item.stats?.installsCurrent || item.stats?.installsAllTime || 0),
  updatedAt: typeof item.updatedAt === 'number'
    ? new Date(item.updatedAt).toISOString()
    : (item.updatedAt || ''),
  marketUrl: item.slug ? `https://clawhub.ai/skills/${item.slug}` : 'https://clawhub.ai',
  version: item.tags?.latest || item.version || '',
});

const installSkillFromMarket = async (slugInput: string, tagInput?: string) => {
  const slug = (slugInput || '').trim().toLowerCase();
  const tag = (tagInput || 'latest').trim() || 'latest';
  if (!slug) {
    throw new Error('技能 slug 不能为空');
  }

  const detail = await clawHubRequest(`/api/v1/skills/${encodeURIComponent(slug)}`, { retries: 1 });
  const detailSkill = detail?.skill || {};
  const candidatePaths = ['SKILL.md', 'skill.md'];
  let content = '';

  for (const filePath of candidatePaths) {
    try {
      const text = await clawHubRequest(`/api/v1/skills/${encodeURIComponent(slug)}/file`, {
        query: { path: filePath, tag },
        responseType: 'text',
        retries: 1,
      });
      if (typeof text === 'string' && text.trim()) {
        content = text;
        break;
      }
    } catch {
      // try next path
    }
  }

  if (!content.trim()) {
    throw new Error('未获取到技能文件（SKILL.md）');
  }

  const parsedHeader = parseSkillHeader(content);
  const inferredName = parsedHeader.name || detailSkill.displayName || detailSkill.slug || slug;
  const inferredDesc = parsedHeader.description || detailSkill.summary || `Imported from ClawHub (${slug})`;

  if (!SKILL_FRONTMATTER_REGEX.test(content)) {
    content = `---\nname: ${inferredName}\ndescription: ${inferredDesc}\n---\n\n${content}`;
  }

  const skillsDir = getWorkspacePaths().skills;
  await fs.mkdir(skillsDir, { recursive: true });
  const fileName = await buildSkillFileName(skillsDir, inferredName);
  const savePath = path.join(skillsDir, fileName);
  await fs.writeFile(savePath, content, 'utf-8');

  return {
    success: true,
    location: savePath,
    slug,
    tag,
    displayName: detailSkill.displayName || inferredName,
  };
};

ipcMain.handle('skills:enable', async (_, { name }: { name: string }) => {
  try {
    const manager = new SkillManager();
    await manager.discoverSkills(getWorkspacePaths().base);
    const changed = await manager.enableSkill(name);
    return { success: true, changed };
  } catch (error) {
    console.error('Failed to enable skill:', error);
    return { success: false, error: String(error) };
  }
});

ipcMain.handle('skills:disable', async (_, { name }: { name: string }) => {
  try {
    const manager = new SkillManager();
    await manager.discoverSkills(getWorkspacePaths().base);
    const changed = await manager.disableSkill(name);
    return { success: true, changed };
  } catch (error) {
    console.error('Failed to disable skill:', error);
    return { success: false, error: String(error) };
  }
});

ipcMain.handle('skills:market-search', async (_, { query }: { query?: string }) => {
  const keyword = (query || '').trim();
  try {
    if (keyword) {
      const data = await clawHubRequest('/api/v1/search', {
        query: { q: keyword, limit: 20, nonSuspiciousOnly: true },
        retries: 1,
      });
      const items = Array.isArray(data?.results) ? data.results : [];
      return items.map(toMarketSkill);
    }

    const trending = await clawHubRequest('/api/v1/skills', {
      query: { limit: 20, sort: 'trending', nonSuspiciousOnly: true },
      retries: 1,
    });
    const items = Array.isArray(trending?.items) ? trending.items : [];
    return items.map(toMarketSkill);
  } catch (error) {
    console.error('Failed to search skill market:', error);
    return [];
  }
});

ipcMain.handle('skills:market-install', async (_, { slug, tag }: { slug: string; tag?: string }) => {
  try {
    return await installSkillFromMarket(slug, tag);
  } catch (error) {
    console.error('Failed to install skill from market:', error);
    return { success: false, error: String(error) };
  }
});

// Legacy channel kept for compatibility with old renderer calls.
ipcMain.handle('skills:install-from-github', async (_, { repoFullName, skillPath }: { repoFullName: string; skillPath?: string }) => {
  const raw = (repoFullName || '').trim();
  const slug = raw.replace(/^https?:\/\/clawhub\.ai\/skills\//i, '').replace(/^clawhub\//i, '').replace(/^\/+|\/+$/g, '');
  try {
    if (!slug || slug.includes('/')) {
      return { success: false, error: '旧接口已切换为 ClawHub。请输入技能 slug（例如 redbook-browser-ops）。' };
    }
    return await installSkillFromMarket(slug, skillPath || 'latest');
  } catch (error) {
    console.error('Failed to install skill from legacy channel:', error);
    return { success: false, error: String(error) };
  }
});

ipcMain.handle('skills:save', async (_, { location, content }: { location: string; content: string }) => {
  try {
    await fs.writeFile(location, content, 'utf-8');
    return { success: true };
  } catch (error) {
    console.error('Failed to save skill:', error);
    return { success: false, error: String(error) };
  }
})

ipcMain.handle('skills:create', async (_, { name }: { name: string }) => {
  try {
    const paths = getWorkspacePaths();
    const skillsDir = paths.skills;
    await fs.mkdir(skillsDir, { recursive: true });

    const skillDirName = sanitizeSkillFileName(name).replace(/\.md$/i, '');
    const skillDir = path.join(skillsDir, skillDirName);
    const filePath = path.join(skillDir, 'SKILL.md');

    // Check if file already exists
    try {
      await fs.access(skillDir);
      return { success: false, error: '同名技能已存在' };
    } catch {
      // Directory doesn't exist, we can create it
    }

    await fs.mkdir(path.join(skillDir, 'agents'), { recursive: true });

    const template = `---
name: ${skillDirName}
description: 请添加技能描述
---

# ${skillDirName}

在这里编写技能的详细指令...
`;

    await fs.writeFile(filePath, template, 'utf-8');
    return { success: true, location: filePath };
  } catch (error) {
    console.error('Failed to create skill:', error);
    return { success: false, error: String(error) };
  }
})

// --------- Advisors (智囊团) ---------
function getAdvisorsDir() {
  return path.join(getWorkspacePaths().base, 'advisors');
}

function findCachedAdvisorAvatarPath(advisorDir: string): string | null {
  try {
    const entries = fsSync.readdirSync(advisorDir, { withFileTypes: true });
    const avatarFile = entries
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
      .find((name) => /^avatar(?:_\d+)?\.(png|jpe?g|webp|gif|bmp)$/i.test(name));
    if (!avatarFile) return null;
    return path.join(advisorDir, avatarFile);
  } catch {
    return null;
  }
}

async function localizeAdvisorAvatar(advisorDir: string, config: Record<string, unknown>): Promise<void> {
  const avatar = String(config.avatar || '').trim();
  if (!avatar) return;

  if (avatar.startsWith('http')) {
    const cachedAvatarPath = findCachedAdvisorAvatarPath(advisorDir);
    if (cachedAvatarPath) {
      config.avatar = path.basename(cachedAvatarPath);
      return;
    }
    const localized = await saveAdvisorAvatar(advisorDir, avatar);
    config.avatar = localized;
    return;
  }

  if (!avatar.startsWith('data:') && !avatar.match(/^[\w\u4e00-\u9fa5]+$/)) {
    const avatarPath = path.join(advisorDir, avatar);
    await fs.access(avatarPath);
    config.avatar = toLocalFileUrl(avatarPath);
  }
}

function resolveAdvisorAvatarForList(advisorDir: string, config: Record<string, unknown>): string {
  const avatar = String(config.avatar || '').trim();
  if (!avatar) return '🧠';
  if (avatar.startsWith('http')) {
    const cachedAvatarPath = findCachedAdvisorAvatarPath(advisorDir);
    if (cachedAvatarPath) {
      return toLocalFileUrl(cachedAvatarPath);
    }
    return avatar;
  }
  if (avatar.startsWith('data:') || /^(local-file|redbox-asset):\/\//i.test(avatar)) {
    return avatar;
  }
  if (avatar.match(/^[\w\u4e00-\u9fa5]+$/)) {
    return avatar;
  }
  const avatarPath = path.join(advisorDir, avatar);
  if (!fsSync.existsSync(avatarPath)) {
    return '🧠';
  }
  return toLocalFileUrl(avatarPath);
}

function localizeAdvisorAvatarInBackground(
  advisorDir: string,
  configPath: string,
  config: Record<string, unknown>,
): void {
  const cacheKey = `${advisorDir}::${String(config.avatar || '').trim()}`;
  if (!cacheKey || advisorAvatarLocalizationInFlight.has(cacheKey)) {
    return;
  }
  advisorAvatarLocalizationInFlight.add(cacheKey);
  void (async () => {
    try {
      const nextConfig = { ...config };
      const originalAvatar = String(nextConfig.avatar || '').trim();
      await localizeAdvisorAvatar(advisorDir, nextConfig);
      const localizedAvatar = String(nextConfig.avatar || '').trim();
      if (!localizedAvatar || localizedAvatar === originalAvatar || /^(local-file|redbox-asset):\/\//i.test(localizedAvatar)) {
        return;
      }
      await fs.writeFile(configPath, JSON.stringify(nextConfig, null, 2), 'utf-8');
    } catch (error) {
      console.warn('[advisors:list] avatar localization skipped:', error);
    } finally {
      advisorAvatarLocalizationInFlight.delete(cacheKey);
    }
  })();
}

ipcMain.handle('advisors:list', async () => {
  const advisorsDir = getAdvisorsDir();

  try {
    if (advisorListCache) {
      return advisorListCache;
    }
    await fs.mkdir(advisorsDir, { recursive: true });
    const dirs = await fs.readdir(advisorsDir, { withFileTypes: true });
    const advisorDirs = dirs.filter((dir) => dir.isDirectory());
    const advisors = (await Promise.all(advisorDirs.map(async (dir) => {
      const configPath = path.join(advisorsDir, dir.name, 'config.json');
      try {
        const content = await fs.readFile(configPath, 'utf-8');
        const config = JSON.parse(content) as Record<string, unknown>;
        return await buildAdvisorSummary(dir.name, config);
      } catch {
        return null;
      }
    }))).filter((item): item is {
      id: string;
      name: string;
      avatar: string;
      personality: string;
      knowledgeLanguage: string;
      createdAt: string;
      hasYoutubeChannel: boolean;
    } => Boolean(item));

    advisorListCache = advisors.sort((a, b) =>
      (b.createdAt || '').localeCompare(a.createdAt || '')
    );
    return advisorListCache;
  } catch (error) {
    console.error('Failed to list advisors:', error);
    return [];
  }
});

ipcMain.handle('advisors:list-templates', async () => {
  return [];
});

ipcMain.handle('advisors:get', async (_, advisorId: string) => {
  try {
    const cached = advisorDetailCache.get(advisorId);
    if (cached) {
      return {
        success: true,
        advisor: cached,
      };
    }
    const advisor = await buildAdvisorDetail(advisorId);
    advisorDetailCache.set(advisorId, advisor);
    return { success: true, advisor };
  } catch (error) {
    console.error('Failed to get advisor:', error);
    return { success: false, error: String(error) };
  }
});

// 辅助函数：保存头像（下载URL或复制本地文件）
async function saveAdvisorAvatar(advisorDir: string, avatarInput: string): Promise<string> {
  const fs = require('fs/promises');

  // 1. 如果是简单的 Emoji (长度短且无扩展名)，直接返回
  if (avatarInput.length < 10 && !avatarInput.includes('/') && !avatarInput.includes('.')) {
    return avatarInput;
  }

  // 2. 如果是 URL (YouTube 头像)，下载它
  if (avatarInput.startsWith('http')) {
    try {
      const ext = path.extname(new URL(avatarInput).pathname) || '.jpg';
      const fileName = `avatar${ext}`;
      const destPath = path.join(advisorDir, fileName);
      await downloadImageToFile(avatarInput, destPath);
      return fileName;
    } catch (e) {
      console.error('Failed to download avatar:', e);
      return '🧠';
    }
  }

  // 3. 如果是本地文件路径 (用户上传)，复制它
  // 判断逻辑：绝对路径
  if (path.isAbsolute(avatarInput)) {
    try {
      const ext = path.extname(avatarInput);
      const fileName = `avatar_${Date.now()}${ext}`;
      const destPath = path.join(advisorDir, fileName);
      await fs.copyFile(avatarInput, destPath);
      return fileName;
    } catch (e) {
      console.error('Failed to copy avatar:', e);
      return '🧠'; // 失败返回默认 Emoji
    }
  }

  // 4. 其他情况（已经是相对路径等），直接返回
  return avatarInput;
}

ipcMain.handle('advisors:create', async (_, data: { name: string; avatar: string; personality: string; systemPrompt: string; knowledgeLanguage?: string; youtubeChannel?: { url: string; channelId: string } }) => {
  const fs = require('fs/promises');
  const advisorId = `advisor_${Date.now()}`;
  const advisorDir = path.join(getAdvisorsDir(), advisorId);

  try {
    await fs.mkdir(advisorDir, { recursive: true });
    await fs.mkdir(path.join(advisorDir, 'knowledge'), { recursive: true });

    // 处理头像保存
    const savedAvatar = await saveAdvisorAvatar(advisorDir, data.avatar);

    const config: Record<string, unknown> = {
      name: data.name,
      avatar: savedAvatar,
      personality: data.personality,
      systemPrompt: data.systemPrompt,
      knowledgeLanguage: String(data.knowledgeLanguage || '').trim() || '中文',
      createdAt: new Date().toISOString()
    };

    // If YouTube channel provided, save it
    if (data.youtubeChannel) {
      config.youtubeChannel = await getDefaultAdvisorYoutubeChannelConfigLazy({
        url: data.youtubeChannel.url,
        channelId: data.youtubeChannel.channelId,
        lastRefreshed: new Date().toISOString()
      });
      config.videos = []; // Initialize empty video list
    }

    await fs.writeFile(path.join(advisorDir, 'config.json'), JSON.stringify(config, null, 2), 'utf-8');
    invalidateAdvisorCache(advisorId);
    win?.webContents.send('advisors:changed', { action: 'create', advisorId });
    emitRendererDataChanged('advisors', { action: 'create', entityId: advisorId });
    return { success: true, id: advisorId };
  } catch (error) {
    console.error('Failed to create advisor:', error);
    return { success: false, error: String(error) };
  }
});

ipcMain.handle('advisors:update', async (_, data: { id: string; name: string; avatar: string; personality: string; systemPrompt: string; knowledgeLanguage?: string }) => {
  const fs = require('fs/promises');
  const advisorDir = path.join(getAdvisorsDir(), data.id);
  const configPath = path.join(advisorDir, 'config.json');

  try {
    const existingContent = await fs.readFile(configPath, 'utf-8');
    const existing = JSON.parse(existingContent);

    // 检查头像是否改变
    let newAvatar = data.avatar;
    // 如果传入的是托管本地资源协议，说明没变，还原为 config 中的相对路径
    if (/^(local-file|redbox-asset):\/\//i.test(newAvatar)) {
        newAvatar = existing.avatar;
    } else if (newAvatar !== existing.avatar) {
        // 头像变了，保存新头像
        newAvatar = await saveAdvisorAvatar(advisorDir, newAvatar);
    }

    const updated = {
      ...existing,
      name: data.name,
      avatar: newAvatar,
      personality: data.personality,
      systemPrompt: data.systemPrompt,
      knowledgeLanguage: String(data.knowledgeLanguage || '').trim() || existing.knowledgeLanguage || '中文',
    };

    await fs.writeFile(configPath, JSON.stringify(updated, null, 2), 'utf-8');
    invalidateAdvisorCache(data.id);
    win?.webContents.send('advisors:changed', { action: 'update', advisorId: data.id });
    emitRendererDataChanged('advisors', { action: 'update', entityId: data.id });
    return { success: true };
  } catch (error) {
    console.error('Failed to update advisor:', error);
    return { success: false, error: String(error) };
  }
});

ipcMain.handle('advisors:select-avatar', async () => {
  const { dialog } = require('electron');
  const result = await dialog.showOpenDialog(win!, {
    properties: ['openFile'],
    filters: [{ name: 'Images', extensions: ['jpg', 'png', 'jpeg', 'webp', 'gif'] }]
  });

  if (result.canceled || result.filePaths.length === 0) {
    return null;
  }

  try {
    const selectedPath = result.filePaths[0];
    const ext = path.extname(selectedPath) || '.jpg';
    const stagingDir = path.join(app.getPath('userData'), 'tmp', 'avatar-picker');
    await fs.mkdir(stagingDir, { recursive: true });
    const stagedPath = path.join(stagingDir, `avatar_${Date.now()}${ext}`);
    await fs.copyFile(selectedPath, stagedPath);
    return stagedPath;
  } catch (error) {
    console.error('[advisors:select-avatar] Failed to stage selected file:', error);
    return result.filePaths[0];
  }
});

ipcMain.handle('advisors:pick-knowledge-files', async () => {
  const result = await dialog.showOpenDialog(win!, {
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'Text Files', extensions: ['txt', 'md', 'markdown'] }],
  });

  if (result.canceled || result.filePaths.length === 0) {
    return { success: true, canceled: true, filePaths: [], files: [] };
  }

  const files = result.filePaths.map((filePath) => ({
    path: filePath,
    name: path.basename(filePath),
  }));

  return {
    success: true,
    canceled: false,
    filePaths: result.filePaths,
    files,
  };
});

ipcMain.handle('advisors:delete', async (_, advisorId: string) => {
  const fs = require('fs/promises');
  const advisorDir = path.join(getAdvisorsDir(), advisorId);

  try {
    await fs.rm(advisorDir, { recursive: true, force: true });
    invalidateAdvisorCache(advisorId);
    win?.webContents.send('advisors:changed', { action: 'delete', advisorId });
    emitRendererDataChanged('advisors', { action: 'delete', entityId: advisorId });
    return { success: true };
  } catch (error) {
    console.error('Failed to delete advisor:', error);
    return { success: false };
  }
});

ipcMain.handle('advisors:upload-knowledge', async (_, payload: string | { advisorId?: string; filePaths?: string[] }) => {
  const fs = require('fs/promises');
  const advisorId = typeof payload === 'string'
    ? payload
    : String(payload?.advisorId || '').trim();
  if (!advisorId) {
    return { success: false, error: 'advisorId is required' };
  }

  let filePaths = Array.isArray((payload as { filePaths?: string[] } | undefined)?.filePaths)
    ? ((payload as { filePaths?: string[] }).filePaths || []).filter(Boolean)
    : [];

  if (filePaths.length === 0) {
    const result = await dialog.showOpenDialog(win!, {
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'Text Files', extensions: ['txt', 'md', 'markdown'] }]
    });

    if (result.canceled || result.filePaths.length === 0) {
      return { success: false };
    }
    filePaths = result.filePaths;
  }

  const knowledgeDir = path.join(getAdvisorsDir(), advisorId, 'knowledge');
  await fs.mkdir(knowledgeDir, { recursive: true });

  for (const filePath of filePaths) {
    const fileName = path.basename(filePath);
    const destPath = path.join(knowledgeDir, fileName);
    await fs.copyFile(filePath, destPath);

    // Index advisor knowledge
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      indexManager.addToQueue(normalizeFile(
        `advisor_${advisorId}_${fileName}`,
        fileName,
        content,
        'advisor',
        advisorId
      ));
    } catch (e) {
      console.error(`Failed to index advisor file ${fileName}:`, e);
    }
  }

  invalidateAdvisorCache(advisorId);
  emitRendererDataChanged('advisors', { action: 'update', entityId: advisorId });
  return { success: true, count: filePaths.length };
});

ipcMain.handle('advisors:delete-knowledge', async (_, { advisorId, fileName }: { advisorId: string; fileName: string }) => {
  const fs = require('fs/promises');
  const filePath = path.join(getAdvisorsDir(), advisorId, 'knowledge', fileName);

  try {
    await fs.unlink(filePath);
    invalidateAdvisorCache(advisorId);
    emitRendererDataChanged('advisors', { action: 'update', entityId: advisorId });
    return { success: true };
  } catch (error) {
    console.error('Failed to delete knowledge file:', error);
    return { success: false };
  }
});

ipcMain.handle('advisors:optimize-prompt', async (_, { info }: { info: string }) => {
  const OpenAI = require('openai').default;
  const settings = getSettings() as { api_endpoint?: string; api_key?: string; model_name?: string } | undefined;

  if (!settings?.api_endpoint || !settings?.api_key || !settings?.model_name) {
    return { success: false, error: '请先在设置中配置 API' };
  }

  try {
    const client = new OpenAI({
      apiKey: settings.api_key,
      baseURL: normalizeApiBaseUrl(settings.api_endpoint, 'https://api.openai.com/v1'),
    });

    const response = await client.chat.completions.create({
      model: settings.model_name,
      messages: [
        {
          role: 'system',
          content: ADVISOR_OPTIMIZE_SYSTEM_PROMPT
        },
        { role: 'user', content: `请优化以下角色描述：\n${info}` }
      ]
    });

    const optimizedPrompt = response.choices[0]?.message?.content || '';
    return { success: true, prompt: optimizedPrompt };
  } catch (error) {
    console.error('Failed to optimize prompt:', error);
    return { success: false, error: String(error) };
  }
});

// Deep AI Optimization - 搜索 + 知识库 + LLM 生成更全面的角色设定
ipcMain.handle('advisors:optimize-prompt-deep', async (_, {
  advisorId,
  name,
  personality,
  currentPrompt
}: {
  advisorId: string;
  name: string;
  personality: string;
  currentPrompt: string;
}) => {
  const OpenAI = require('openai').default;
  const { searchWeb } = await import('./core/bingSearch');
  const settings = getSettings() as { api_endpoint?: string; api_key?: string; model_name?: string } | undefined;

  if (!settings?.api_endpoint || !settings?.api_key || !settings?.model_name) {
    return { success: false, error: '请先在设置中配置 API' };
  }

  try {
    console.log(`[optimize-prompt-deep] Starting deep optimization for: ${name}`);

    // Step 1: 搜索这个人的信息
    let searchSummary = '';
    try {
      console.log(`[optimize-prompt-deep] Searching for: ${name}`);
      const searchResults = await searchWeb(`${name} 博主 创作者 介绍`, 5);
      if (searchResults.length > 0) {
        searchSummary = searchResults.map(r => `- ${r.title}: ${r.snippet}`).join('\n');
        console.log(`[optimize-prompt-deep] Found ${searchResults.length} search results`);
      }
    } catch (e) {
      console.warn('[optimize-prompt-deep] Search failed:', e);
    }

    // Step 2: 读取知识库内容摘要
    let knowledgeSummary = '';
    try {
      const fs = require('fs/promises');
      const advisorDir = path.join(getWorkspacePaths().base, 'advisors', advisorId);
      const knowledgeDir = path.join(advisorDir, 'knowledge');

      const files = await fs.readdir(knowledgeDir).catch(() => [] as string[]);
      const textFiles = files.filter((f: string) => f.endsWith('.txt') || f.endsWith('.md'));

      if (textFiles.length > 0) {
        const samples: string[] = [];
        // 读取最多3个文件的前500字符作为样本
        for (const file of textFiles.slice(0, 3)) {
          const content = await fs.readFile(path.join(knowledgeDir, file), 'utf-8');
          samples.push(`[${file}]\n${content.slice(0, 500)}...`);
        }
        knowledgeSummary = samples.join('\n\n');
        console.log(`[optimize-prompt-deep] Loaded ${textFiles.length} knowledge files`);
      }
    } catch (e) {
      console.warn('[optimize-prompt-deep] Knowledge read failed:', e);
    }

    // Step 3: 使用 LLM 生成优化后的角色设定
    const client = new OpenAI({
      apiKey: settings.api_key,
      baseURL: normalizeApiBaseUrl(settings.api_endpoint, 'https://api.openai.com/v1'),
    });

    const userPromptForOptimization = renderPrompt(ADVISOR_OPTIMIZE_DEEP_USER_TEMPLATE, {
      name,
      personality: personality || '(未填写)',
      current_prompt: currentPrompt || '(未填写)',
      search_summary: searchSummary || '(未找到相关信息)',
      knowledge_summary: knowledgeSummary || '(无知识库内容)',
    });

    const response = await client.chat.completions.create({
      model: settings.model_name,
      messages: [
        { role: 'system', content: ADVISOR_OPTIMIZE_DEEP_SYSTEM_PROMPT },
        { role: 'user', content: userPromptForOptimization }
      ],
      temperature: 0.7,
    });

    const optimizedPrompt = response.choices[0]?.message?.content || '';
    console.log(`[optimize-prompt-deep] Generated ${optimizedPrompt.length} chars prompt`);

    return { success: true, prompt: optimizedPrompt };
  } catch (error) {
    console.error('Failed to deep optimize prompt:', error);
    return { success: false, error: String(error) };
  }
});

// AI Persona Generation (for YouTube import)
ipcMain.handle('advisors:generate-persona', async (_, {
  advisorId,
  channelName,
  channelDescription,
  videoTitles,
  knowledgeLanguage,
}: {
  advisorId?: string;
  channelName: string;
  channelDescription: string;
  videoTitles: string[];
  knowledgeLanguage?: string;
}) => {
  const settings = getSettings() as {
    api_endpoint?: string;
    api_key?: string;
    model_name?: string;
    model_name_knowledge?: string;
  } | undefined;

  if (!settings?.api_endpoint || !settings?.api_key || !settings?.model_name) {
    return { success: false, error: '请先在设置中配置 API' };
  }

  try {
    const model = resolveScopedModelName((settings || {}) as Record<string, unknown>, 'knowledge', 'gpt-4o');
    console.log('[generate-persona] start', {
      advisorId: advisorId || null,
      channelName,
      model,
    });

    const { generateAdvisorPersonaDocument } = await import('./core/advisorPersonaGenerator');
    const result = await generateAdvisorPersonaDocument({
      advisorId,
      channelName,
      channelDescription,
      videoTitles,
      knowledgeLanguage,
      apiKey: settings.api_key,
      baseURL: normalizeApiBaseUrl(settings.api_endpoint, 'https://api.openai.com/v1'),
      model,
    });

    console.log('[generate-persona] completed', {
      advisorId: advisorId || null,
      promptLength: result.prompt.length,
      personalityLength: result.personality.length,
      searchResultCount: result.searchResults.length,
    });

    return { success: true, prompt: result.prompt, personality: result.personality, searchResults: result.searchResults, research: result.research };
  } catch (error) {
    console.error('Failed to generate persona:', error);
    return { success: false, error: String(error) };
  }
});

// YouTube Import
ipcMain.handle('youtube:check-ytdlp', async () => {
  const { checkYtdlp } = await import('./core/youtubeScraper');
  return checkYtdlp();
});

async function showNativeMessageBox(
  parent: BrowserWindow | null | undefined,
  options: Electron.MessageBoxOptions
): Promise<Electron.MessageBoxReturnValue> {
  if (parent) {
    return dialog.showMessageBox(parent, options);
  }
  return dialog.showMessageBox(options);
}

async function ensureYtdlpReadyForCapture(parent: BrowserWindow | null | undefined): Promise<{ ok: boolean; error?: string }> {
  const {
    checkYtdlp,
    installYtdlp,
    updateYtdlp,
    shouldCheckForUpdate,
  } = await import('./core/youtubeScraper');

  const current = await checkYtdlp();
  let installedInThisRun = false;
  if (!current.installed) {
    const installChoice = await showNativeMessageBox(parent, {
      type: 'warning',
      title: '需要安装 yt-dlp',
      message: 'YouTube 采集需要先安装 yt-dlp。',
      detail: '点击“立即安装”后会自动安装，完成后继续本次采集。',
      buttons: ['立即安装', '取消采集'],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    });

    if (installChoice.response !== 0) {
      return { ok: false, error: '已取消采集：yt-dlp 未安装。' };
    }

    try {
      const installed = await installYtdlp((progress) => {
        parent?.webContents.send('youtube:install-progress', progress);
      });
      if (!installed) {
        await showNativeMessageBox(parent, {
          type: 'error',
          title: '安装失败',
          message: 'yt-dlp 安装失败，无法继续 YouTube 采集。',
          buttons: ['确定'],
          defaultId: 0,
          noLink: true,
        });
        return { ok: false, error: 'yt-dlp 安装失败。' };
      }
      installedInThisRun = true;
    } catch (error) {
      await showNativeMessageBox(parent, {
        type: 'error',
        title: '安装失败',
        message: 'yt-dlp 安装失败，无法继续 YouTube 采集。',
        detail: String(error),
        buttons: ['确定'],
        defaultId: 0,
        noLink: true,
      });
      return { ok: false, error: `yt-dlp 安装失败: ${String(error)}` };
    }
  }

  const needsUpdate = !installedInThisRun && shouldCheckForUpdate();
  if (needsUpdate) {
    const updateChoice = await showNativeMessageBox(parent, {
      type: 'info',
      title: '检测到 yt-dlp 可能需要更新',
      message: '建议先更新 yt-dlp，再执行 YouTube 采集。',
      detail: '你可以立即更新，或跳过本次更新继续采集。',
      buttons: ['立即更新', '跳过本次', '取消采集'],
      defaultId: 0,
      cancelId: 2,
      noLink: true,
    });

    if (updateChoice.response === 2) {
      return { ok: false, error: '已取消采集：用户取消更新。' };
    }

    if (updateChoice.response === 0) {
      try {
        const updated = await updateYtdlp();
        if (!updated) {
          const failChoice = await showNativeMessageBox(parent, {
            type: 'warning',
            title: '更新未完成',
            message: 'yt-dlp 更新未完成，是否继续本次采集？',
            buttons: ['继续采集', '取消采集'],
            defaultId: 0,
            cancelId: 1,
            noLink: true,
          });
          if (failChoice.response !== 0) {
            return { ok: false, error: '已取消采集：yt-dlp 更新未完成。' };
          }
        }
      } catch (error) {
        const failChoice = await showNativeMessageBox(parent, {
          type: 'warning',
          title: '更新失败',
          message: 'yt-dlp 更新失败，是否继续本次采集？',
          detail: String(error),
          buttons: ['继续采集', '取消采集'],
          defaultId: 0,
          cancelId: 1,
          noLink: true,
        });
        if (failChoice.response !== 0) {
          return { ok: false, error: `已取消采集：yt-dlp 更新失败 (${String(error)})` };
        }
      }
    }
  }

  return { ok: true };
}

ipcMain.handle('advisors:fetch-youtube-info', async (event, { channelUrl }: { channelUrl: string }) => {
  const { fetchChannelInfo } = await import('./core/youtubeScraper');
  const win = BrowserWindow.fromWebContents(event.sender);
  try {
    const ytdlpReady = await ensureYtdlpReadyForCapture(win);
    if (!ytdlpReady.ok) {
      return { success: false, error: ytdlpReady.error || 'yt-dlp 未就绪' };
    }

    const info = await fetchChannelInfo(channelUrl, (msg) => {
      win?.webContents.send('youtube:fetch-info-progress', msg);
    });
    return { success: true, data: info };
  } catch (error) {
    console.error('Failed to fetch channel info:', error);
    return { success: false, error: String(error) };
  }
});

ipcMain.handle('advisors:update-youtube-settings', async (_event, payload: {
  advisorId: string;
  settings?: {
    backgroundEnabled?: boolean;
    refreshIntervalMinutes?: number;
    subtitleDownloadIntervalSeconds?: number;
    maxVideosPerRefresh?: number;
    maxDownloadsPerRun?: number;
  };
}) => {
  const advisorId = String(payload?.advisorId || '').trim();
  if (!advisorId) {
    return { success: false, error: 'advisorId is required' };
  }

  const advisorDir = path.join(getAdvisorsDir(), advisorId);
  const configPath = path.join(advisorDir, 'config.json');

  try {
    const configRaw = await fs.readFile(configPath, 'utf-8');
    const config = JSON.parse(configRaw);
    config.youtubeChannel = await getDefaultAdvisorYoutubeChannelConfigLazy({
      ...config.youtubeChannel,
      ...payload?.settings,
    });
    await fs.writeFile(configPath, JSON.stringify(config, null, 2), 'utf-8');
    invalidateAdvisorCache(advisorId);
    emitRendererDataChanged('advisors', { action: 'update', entityId: advisorId });
    return { success: true, youtubeChannel: config.youtubeChannel };
  } catch (error) {
    console.error('Failed to update advisor youtube settings:', error);
    return { success: false, error: String(error) };
  }
});

ipcMain.handle('advisors:youtube-runner-status', async () => {
  try {
    return { success: true, status: (await getAdvisorYoutubeRunnerLazy()).getStatus() };
  } catch (error) {
    return { success: false, error: String(error) };
  }
});

ipcMain.handle('advisors:youtube-runner-run-now', async (_event, payload: { advisorId?: string } = {}) => {
  try {
    return await (await getAdvisorYoutubeRunnerLazy()).runNow(payload?.advisorId);
  } catch (error) {
    return { success: false, processed: 0, error: String(error) };
  }
});

ipcMain.handle('advisors:download-youtube-subtitles', async (event, { channelUrl, videoCount, advisorId }: { channelUrl: string; videoCount: number; advisorId: string }) => {
  const { fetchVideoList } = await import('./core/youtubeScraper');
  const win = BrowserWindow.fromWebContents(event.sender);
  const fs = require('fs/promises');
  const advisorDir = path.join(getAdvisorsDir(), advisorId);
  const outputDir = path.join(advisorDir, 'knowledge');
  const configPath = path.join(advisorDir, 'config.json');

  try {
    const ytdlpReady = await ensureYtdlpReadyForCapture(win);
    if (!ytdlpReady.ok) {
      return { success: false, error: ytdlpReady.error || 'yt-dlp 未就绪' };
    }

    await fs.mkdir(outputDir, { recursive: true });

    // Step 1: 获取视频列表
    win?.webContents.send('advisors:download-progress', { advisorId, progress: '正在获取视频列表...' });
    const videos = await fetchVideoList(channelUrl, videoCount);

    if (videos.length === 0) {
      win?.webContents.send('advisors:download-progress', { advisorId, progress: '未找到视频' });
      return { success: false, error: 'No videos found' };
    }

    // Step 2: 保存视频列表到 config.json
    const configRaw = await fs.readFile(configPath, 'utf-8');
    const config = JSON.parse(configRaw);
    config.videos = videos;
    config.youtubeChannel = await getDefaultAdvisorYoutubeChannelConfigLazy({
      ...config.youtubeChannel,
      lastRefreshed: new Date().toISOString()
    });
    await fs.writeFile(configPath, JSON.stringify(config, null, 2), 'utf-8');

    win?.webContents.send('advisors:download-progress', { advisorId, progress: `找到 ${videos.length} 个视频，开始下载字幕...` });

    // Step 3: 逐个下载字幕（使用字幕队列，自动控制间隔）
    const { queueSubtitleDownload } = await import('./core/subtitleQueue');
    let successCount = 0;
    let failCount = 0;

    for (let i = 0; i < videos.length; i++) {
      const video = videos[i];

      // 发送进度
      win?.webContents.send('advisors:download-progress', {
        advisorId,
        progress: `下载中 (${i + 1}/${videos.length}): ${video.title.slice(0, 30)}...`
      });

      // 使用队列下载，队列内部会自动控制间隔
      const result = await queueSubtitleDownload(video.id, outputDir, {
        minIntervalMs: Math.max(3000, Number(config.youtubeChannel?.subtitleDownloadIntervalSeconds || 8) * 1000),
      });

      // 更新视频状态
      if (result.success) {
        video.status = 'success';
        video.subtitleFile = result.subtitleFile;
        successCount++;

        // Index subtitle content
        if (result.subtitleFile) {
          try {
            const subtitleContent = await fs.readFile(path.join(outputDir, result.subtitleFile), 'utf-8');
            indexManager.addToQueue(normalizeVideo(
              `advisor_${advisorId}_youtube_${video.id}`,
              {
                videoId: video.id,
                title: video.title,
                description: '', // Not available here, but subtitle is main content
                videoUrl: `https://www.youtube.com/watch?v=${video.id}`
              },
              subtitleContent,
              'advisor',
              advisorId
            ));
          } catch (e) {
            console.error('Failed to index subtitle:', e);
          }
        }

      } else {
        video.status = 'failed';
        video.errorMessage = result.error;
        video.retryCount = 1;
        failCount++;
      }

      // 每下载一个就保存一次状态（支持断点续传）
      config.videos = videos;
      await fs.writeFile(configPath, JSON.stringify(config, null, 2), 'utf-8');
    }

    win?.webContents.send('advisors:download-progress', {
      advisorId,
      progress: `下载完成！成功 ${successCount} 个，失败 ${failCount} 个`
    });

    return { success: true, successCount, failCount };
  } catch (error) {
    console.error('Failed to download subtitles:', error);
    win?.webContents.send('advisors:download-progress', { advisorId, progress: `下载失败: ${error}` });
    return { success: false, error: String(error) };
  }
});

ipcMain.handle('youtube:install', async (event) => {
  const { installYtdlp } = await import('./core/youtubeScraper');
  const win = BrowserWindow.fromWebContents(event.sender);
  try {
    const result = await installYtdlp((progress) => {
      win?.webContents.send('youtube:install-progress', progress);
    });
    return { success: result };
  } catch (error) {
    console.error('Failed to install yt-dlp:', error);
    return { success: false, error: String(error) };
  }
});

ipcMain.handle('youtube:update', async () => {
  const { updateYtdlp } = await import('./core/youtubeScraper');
  try {
    const success = await updateYtdlp();
    return { success };
  } catch (error) {
    console.error('Failed to update yt-dlp:', error);
    return { success: false, error: String(error) };
  }
});

// Video Management
ipcMain.handle('advisors:refresh-videos', async (event, { advisorId, limit = 50 }: { advisorId: string; limit?: number }) => {
  const { fetchVideoList } = await import('./core/youtubeScraper');
  const fs = require('fs/promises');
  const advisorDir = path.join(getAdvisorsDir(), advisorId);
  const configPath = path.join(advisorDir, 'config.json');
  const win = BrowserWindow.fromWebContents(event.sender);

  try {
    const ytdlpReady = await ensureYtdlpReadyForCapture(win);
    if (!ytdlpReady.ok) {
      return { success: false, error: ytdlpReady.error || 'yt-dlp 未就绪' };
    }

    const configRaw = await fs.readFile(configPath, 'utf-8');
    const config = JSON.parse(configRaw);

    if (!config.youtubeChannel?.url) {
      return { success: false, error: 'No YouTube channel configured' };
    }

    const newVideos = await fetchVideoList(config.youtubeChannel.url, limit);
    const existingVideos = config.videos || [];
    const existingIds = new Set(existingVideos.map((v: { id: string }) => v.id));

    // Merge: keep existing statuses, add new ones as pending
    const mergedVideos = [
      ...existingVideos,
      ...newVideos.filter(v => !existingIds.has(v.id))
    ];

    config.videos = mergedVideos;
    config.youtubeChannel = await getDefaultAdvisorYoutubeChannelConfigLazy({
      ...config.youtubeChannel,
      lastRefreshed: new Date().toISOString(),
    });

    await fs.writeFile(configPath, JSON.stringify(config, null, 2), 'utf-8');
    return { success: true, videos: mergedVideos };
  } catch (error) {
    console.error('Failed to refresh videos:', error);
    return { success: false, error: String(error) };
  }
});

ipcMain.handle('advisors:get-videos', async (_, { advisorId }: { advisorId: string }) => {
  const fs = require('fs/promises');
  const advisorDir = path.join(getAdvisorsDir(), advisorId);
  const configPath = path.join(advisorDir, 'config.json');

  try {
    const configRaw = await fs.readFile(configPath, 'utf-8');
    const config = JSON.parse(configRaw);
    return {
      success: true,
      videos: config.videos || [],
      youtubeChannel: config.youtubeChannel ? await getDefaultAdvisorYoutubeChannelConfigLazy(config.youtubeChannel) : null,
    };
  } catch (error) {
    return { success: false, error: String(error) };
  }
});

ipcMain.handle('advisors:download-video', async (_event, { advisorId, videoId }: { advisorId: string; videoId: string }) => {
  const { queueSubtitleDownload } = await import('./core/subtitleQueue');
  const fsSync = require('fs');
  const fs = require('fs/promises');
  const advisorDir = path.join(getAdvisorsDir(), advisorId);
  const knowledgeDir = path.join(advisorDir, 'knowledge');
  const configPath = path.join(advisorDir, 'config.json');

  if (!fsSync.existsSync(knowledgeDir)) {
    fsSync.mkdirSync(knowledgeDir, { recursive: true });
  }

  try {
    const senderWin = BrowserWindow.fromWebContents(_event.sender);
    const ytdlpReady = await ensureYtdlpReadyForCapture(senderWin);
    if (!ytdlpReady.ok) {
      return { success: false, error: ytdlpReady.error || 'yt-dlp 未就绪' };
    }

    // Update status to downloading
    const configRaw = await fs.readFile(configPath, 'utf-8');
    const config = JSON.parse(configRaw);
    const video = config.videos?.find((v: { id: string }) => v.id === videoId);
    if (video) {
      video.status = 'downloading';
      await fs.writeFile(configPath, JSON.stringify(config, null, 2), 'utf-8');
    }

    const result = await queueSubtitleDownload(videoId, knowledgeDir, {
      minIntervalMs: Math.max(3000, Number(config.youtubeChannel?.subtitleDownloadIntervalSeconds || 8) * 1000),
    });

    // Update status based on result
    const updatedConfigRaw = await fs.readFile(configPath, 'utf-8');
    const updatedConfig = JSON.parse(updatedConfigRaw);
    const updatedVideo = updatedConfig.videos?.find((v: { id: string }) => v.id === videoId);
    if (updatedVideo) {
      if (result.success) {
        updatedVideo.status = 'success';
        updatedVideo.subtitleFile = result.subtitleFile;
        updatedVideo.errorMessage = undefined;
      } else {
        updatedVideo.status = 'failed';
        updatedVideo.retryCount = (updatedVideo.retryCount || 0) + 1;
        updatedVideo.errorMessage = result.error;
      }
      await fs.writeFile(configPath, JSON.stringify(updatedConfig, null, 2), 'utf-8');
    }

    return result;
  } catch (error) {
    console.error('Failed to download video:', error);
    return { success: false, error: String(error) };
  }
});

ipcMain.handle('advisors:retry-failed', async (event, { advisorId }: { advisorId: string }) => {
  const { queueSubtitleDownload } = await import('./core/subtitleQueue');
  const fsSync = require('fs');
  const fs = require('fs/promises');
  const advisorDir = path.join(getAdvisorsDir(), advisorId);
  const knowledgeDir = path.join(advisorDir, 'knowledge');
  const configPath = path.join(advisorDir, 'config.json');
  const win = BrowserWindow.fromWebContents(event.sender);

  if (!fsSync.existsSync(knowledgeDir)) {
    fsSync.mkdirSync(knowledgeDir, { recursive: true });
  }

  try {
    const ytdlpReady = await ensureYtdlpReadyForCapture(win);
    if (!ytdlpReady.ok) {
      return { success: false, error: ytdlpReady.error || 'yt-dlp 未就绪' };
    }

    const configRaw = await fs.readFile(configPath, 'utf-8');
    const config = JSON.parse(configRaw);
    const failedVideos = (config.videos || []).filter((v: { status: string; retryCount: number }) =>
      v.status === 'failed' && (v.retryCount || 0) < 5
    );

    let successCount = 0;
    let failCount = 0;

    for (let i = 0; i < failedVideos.length; i++) {
      const video = failedVideos[i];
      win?.webContents.send('advisors:retry-progress', { current: i + 1, total: failedVideos.length, videoId: video.id });

      // 使用队列下载，队列内部会自动控制间隔
      const result = await queueSubtitleDownload(video.id, knowledgeDir, {
        minIntervalMs: Math.max(3000, Number(config.youtubeChannel?.subtitleDownloadIntervalSeconds || 8) * 1000),
      });

      // Re-read config each time to avoid race conditions
      const currentRaw = await fs.readFile(configPath, 'utf-8');
      const currentConfig = JSON.parse(currentRaw);
      const currentVideo = currentConfig.videos?.find((v: { id: string }) => v.id === video.id);

      if (currentVideo) {
        if (result.success) {
          currentVideo.status = 'success';
          currentVideo.subtitleFile = result.subtitleFile;
          currentVideo.errorMessage = undefined;
          successCount++;
        } else {
          currentVideo.status = 'failed';
          currentVideo.retryCount = (currentVideo.retryCount || 0) + 1;
          currentVideo.errorMessage = result.error;
          failCount++;
        }
        await fs.writeFile(configPath, JSON.stringify(currentConfig, null, 2), 'utf-8');
      }
    }

    return { success: true, successCount, failCount };
  } catch (error) {
    console.error('Failed to retry downloads:', error);
    return { success: false, error: String(error) };
  }
});

// 向量索引管理 (Deprecated) -> Removed
// 检查是否需要自动索引 (Deprecated) -> Removed

// --------- Chat Rooms (创意聊天室) ---------
function getChatroomsDir() {
  return path.join(getWorkspacePaths().base, 'chatrooms');
}

// ========== 六顶思考帽系统聊天室 ==========
const SIX_HATS_ROOM_ID = 'system_six_thinking_hats';
const SIX_HATS_ROOM_NAME = '六顶思考帽';
const SYSTEM_ROOMS_STATE_FILE = '.system_rooms_state.json';

// 六顶思考帽角色定义（增强版：支持工具调用和深度思考）
const SIX_THINKING_HATS = [
  {
    id: 'hat_white',
    name: '白帽',
    avatar: '⚪',
    color: '#FFFFFF',
    personality: '客观事实',
    systemPrompt: SIX_HAT_PROMPTS.white
  },
  {
    id: 'hat_red',
    name: '红帽',
    avatar: '🔴',
    color: '#EF4444',
    personality: '情感直觉',
    systemPrompt: SIX_HAT_PROMPTS.red
  },
  {
    id: 'hat_black',
    name: '黑帽',
    avatar: '⚫',
    color: '#1F2937',
    personality: '谨慎批判',
    systemPrompt: SIX_HAT_PROMPTS.black
  },
  {
    id: 'hat_yellow',
    name: '黄帽',
    avatar: '🟡',
    color: '#EAB308',
    personality: '积极乐观',
    systemPrompt: SIX_HAT_PROMPTS.yellow
  },
  {
    id: 'hat_green',
    name: '绿帽',
    avatar: '🟢',
    color: '#22C55E',
    personality: '创意创新',
    systemPrompt: SIX_HAT_PROMPTS.green
  },
  {
    id: 'hat_blue',
    name: '蓝帽',
    avatar: '🔵',
    color: '#3B82F6',
    personality: '总结统筹',
    systemPrompt: SIX_HAT_PROMPTS.blue
  }
];

// 确保六顶思考帽聊天室存在
async function ensureSixHatsRoom() {
  const fs = require('fs/promises');
  const roomsDir = getChatroomsDir();
  const roomPath = path.join(roomsDir, `${SIX_HATS_ROOM_ID}.json`);
  const statePath = path.join(roomsDir, SYSTEM_ROOMS_STATE_FILE);

  try {
    await fs.mkdir(roomsDir, { recursive: true });

    // 如果用户已显式删除系统群，则不再自动重建
    try {
      const stateRaw = await fs.readFile(statePath, 'utf-8');
      const state = JSON.parse(stateRaw) as { disabledRoomIds?: string[] };
      const disabled = Array.isArray(state?.disabledRoomIds) ? state.disabledRoomIds : [];
      if (disabled.includes(SIX_HATS_ROOM_ID)) {
        return;
      }
    } catch {
      // ignore state parse/read errors
    }

    // 检查是否已存在
    try {
      await fs.access(roomPath);
      return; // 已存在
    } catch {
      // 不存在，创建
    }

    const room = {
      id: SIX_HATS_ROOM_ID,
      name: SIX_HATS_ROOM_NAME,
      advisorIds: SIX_THINKING_HATS.map(h => h.id),
      messages: [],
      createdAt: new Date().toISOString(),
      isSystem: true, // 标记为系统聊天室
      systemType: 'six_thinking_hats'
    };

    await fs.writeFile(roomPath, JSON.stringify(room, null, 2), 'utf-8');
    console.log('[Six Hats] Created default room');
  } catch (error) {
    console.error('[Six Hats] Failed to create room:', error);
  }
}

ipcMain.handle('chatrooms:list', async () => {
  const fs = require('fs/promises');
  const roomsDir = getChatroomsDir();

  // 确保六顶思考帽聊天室存在
  await ensureSixHatsRoom();

  try {
    await fs.mkdir(roomsDir, { recursive: true });
    const files = await fs.readdir(roomsDir);
    const rooms: Array<{
      id: string;
      name: string;
      advisorIds: string[];
      messages: unknown[];
      createdAt: string;
      isSystem?: boolean;
      systemType?: string;
    }> = [];

    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      if (file === SYSTEM_ROOMS_STATE_FILE) continue;
      try {
        const content = await fs.readFile(path.join(roomsDir, file), 'utf-8');
        const raw = JSON.parse(content) as Record<string, unknown>;
        const id = String(raw.id || '').trim();
        if (!id) continue;

        const advisorIds = Array.isArray(raw.advisorIds)
          ? raw.advisorIds.map((v) => String(v || '').trim()).filter(Boolean)
          : [];

        const room = {
          id,
          name: String(raw.name || '未命名群聊').trim() || '未命名群聊',
          advisorIds,
          messages: Array.isArray(raw.messages) ? raw.messages : [],
          createdAt: String(raw.createdAt || ''),
          isSystem: Boolean(raw.isSystem),
          systemType: typeof raw.systemType === 'string' ? raw.systemType : undefined,
        };

        rooms.push(room);
      } catch { /* skip invalid */ }
    }

    // 系统聊天室排在最前面
    return rooms.sort((a: { isSystem?: boolean; createdAt?: string }, b: { isSystem?: boolean; createdAt?: string }) => {
      if (a.isSystem && !b.isSystem) return -1;
      if (!a.isSystem && b.isSystem) return 1;
      return (b.createdAt || '').localeCompare(a.createdAt || '');
    });
  } catch (error) {
    console.error('Failed to list chatrooms:', error);
    return [];
  }
});

ipcMain.handle('chatrooms:create', async (_, { name, advisorIds }: { name: string; advisorIds: string[] }) => {
  const fs = require('fs/promises');
  const roomId = `room_${Date.now()}`;
  const roomPath = path.join(getChatroomsDir(), `${roomId}.json`);

  try {
    await fs.mkdir(getChatroomsDir(), { recursive: true });

    const room = {
      id: roomId,
      name: String(name || '').trim() || '未命名群聊',
      advisorIds: Array.isArray(advisorIds)
        ? advisorIds.map((id) => String(id || '').trim()).filter(Boolean)
        : [],
      messages: [],
      createdAt: new Date().toISOString()
    };

    await fs.writeFile(roomPath, JSON.stringify(room, null, 2), 'utf-8');
    return room;
  } catch (error) {
    console.error('Failed to create chatroom:', error);
    return null;
  }
});

ipcMain.handle('chatrooms:messages', async (_, roomId: string) => {
  const fs = require('fs/promises');
  const roomPath = path.join(getChatroomsDir(), `${roomId}.json`);

  try {
    const content = await fs.readFile(roomPath, 'utf-8');
    const room = JSON.parse(content);
    return room.messages || [];
  } catch (error) {
    console.error('Failed to get messages:', error);
    return [];
  }
});

ipcMain.handle('chatrooms:update', async (_, { roomId, name, advisorIds }: { roomId: string; name?: string; advisorIds?: string[] }) => {
  const fs = require('fs/promises');
  const roomPath = path.join(getChatroomsDir(), `${roomId}.json`);

  try {
    const content = await fs.readFile(roomPath, 'utf-8');
    const room = JSON.parse(content);

    if (name !== undefined) room.name = String(name || '').trim() || '未命名群聊';
    if (advisorIds !== undefined) {
      room.advisorIds = Array.isArray(advisorIds)
        ? advisorIds.map((id) => String(id || '').trim()).filter(Boolean)
        : [];
    }

    await fs.writeFile(roomPath, JSON.stringify(room, null, 2), 'utf-8');
    return { success: true, room };
  } catch (error) {
    console.error('Failed to update chatroom:', error);
    return { success: false, error: String(error) };
  }
});

ipcMain.handle('chatrooms:delete', async (_, roomId: string) => {
  const fs = require('fs/promises');
  const roomsDir = getChatroomsDir();
  const roomPath = path.join(roomsDir, `${roomId}.json`);
  const statePath = path.join(roomsDir, SYSTEM_ROOMS_STATE_FILE);

  try {
    await fs.mkdir(roomsDir, { recursive: true });

    if (roomId === SIX_HATS_ROOM_ID) {
      let disabledRoomIds: string[] = [];
      try {
        const stateRaw = await fs.readFile(statePath, 'utf-8');
        const state = JSON.parse(stateRaw) as { disabledRoomIds?: string[] };
        disabledRoomIds = Array.isArray(state?.disabledRoomIds) ? state.disabledRoomIds : [];
      } catch {
        // ignore read/parse error
      }
      if (!disabledRoomIds.includes(SIX_HATS_ROOM_ID)) {
        disabledRoomIds.push(SIX_HATS_ROOM_ID);
      }
      await fs.writeFile(
        statePath,
        JSON.stringify({ disabledRoomIds }, null, 2),
        'utf-8'
      );
    }

    try {
      await fs.unlink(roomPath);
    } catch (error: unknown) {
      const code = (error as { code?: string })?.code;
      if (code !== 'ENOENT') {
        throw error;
      }
    }
    return { success: true };
  } catch (error) {
    console.error('Failed to delete chatroom:', error);
    return { success: false, error: String(error) };
  }
});

ipcMain.handle('chatrooms:clear', async (_, roomId: string) => {
  const fs = require('fs/promises');
  const roomPath = path.join(getChatroomsDir(), `${roomId}.json`);

  try {
    const content = await fs.readFile(roomPath, 'utf-8');
    const room = JSON.parse(content);
    room.messages = [];
    await fs.writeFile(roomPath, JSON.stringify(room, null, 2), 'utf-8');
    return { success: true };
  } catch (error) {
    console.error('Failed to clear chatroom messages:', error);
    return { success: false, error: String(error) };
  }
});

ipcMain.handle('chatrooms:send', async (_, { roomId, message, context, clientMessageId }: { roomId: string; message: string; context?: { filePath: string; fileContent: string }; clientMessageId?: string }) => {
  const fs = require('fs/promises');
  const roomPath = path.join(getChatroomsDir(), `${roomId}.json`);
  const { createDiscussionFlowService, DIRECTOR_ID } = await import('./core/director');

  try {
    // Load room
    const roomContent = await fs.readFile(roomPath, 'utf-8');
    const room = JSON.parse(roomContent);

    // Add user message
    const safeClientMessageId = typeof clientMessageId === 'string' && clientMessageId.trim() ? clientMessageId.trim() : '';
    const userMsg = {
      id: safeClientMessageId || `msg_${Date.now()}`,
      role: 'user',
      content: message,
      timestamp: new Date().toISOString()
    };
    room.messages.push(userMsg);

    // 通知前端有新的用户消息（用于从其他页面发送消息的场景）
    win?.webContents.send('creative-chat:user-message', {
      roomId,
      message: userMsg
    });

    // Get settings (兼容旧字段与新字段，未配置时提供默认端点/模型)
    const settings = (getSettings() || {}) as Record<string, unknown>;
    const resolvedApiKey = String(settings.api_key || settings.openaiApiKey || process.env.OPENAI_API_KEY || '').trim();
    const resolvedBaseUrl = normalizeApiBaseUrl(
      String(settings.api_endpoint || settings.openaiApiBase || 'https://api.openai.com/v1'),
      'https://api.openai.com/v1',
    );
    const resolvedModelName = resolveScopedModelName(settings, 'chatroom', String(settings.openaiModel || 'gpt-4o').trim());

    if (!resolvedApiKey) {
      win?.webContents.send('creative-chat:done', { roomId });
      return { success: false, error: 'API not configured' };
    }
    console.log('[chatrooms:send] model-resolved', {
      roomId,
      modelName: resolvedModelName,
      baseURL: resolvedBaseUrl,
      hasApiKey: Boolean(resolvedApiKey),
    });

    // ========== 检查是否是六顶思考帽模式 ==========
    const isSixHatsMode = room.isSystem && room.systemType === 'six_thinking_hats';

    const roomAdvisorIds = Array.isArray(room.advisorIds)
      ? room.advisorIds.map((id: unknown) => String(id || '').trim()).filter(Boolean)
      : [];

    let advisorInfos: { id: string; name: string; avatar: string; systemPrompt: string; knowledgeDir: string; knowledgeLanguage?: string }[] = [];

    if (isSixHatsMode) {
      // 六顶思考帽模式：使用预定义的帽子角色
      advisorInfos = SIX_THINKING_HATS.map(hat => ({
        id: hat.id,
        name: hat.name,
        avatar: hat.avatar,
        systemPrompt: hat.systemPrompt,
        knowledgeDir: '', // 六顶思考帽不使用知识库
        knowledgeLanguage: '',
      }));
    } else {
      // 普通模式：从智囊团加载顾问
      const advisorsDir = getAdvisorsDir();

      for (const advisorId of roomAdvisorIds) {
        // 跳过总监ID（总监由DiscussionFlowService自动处理）
        if (advisorId === DIRECTOR_ID) continue;

        try {
          const configPath = path.join(advisorsDir, advisorId, 'config.json');
          const advisorContent = await fs.readFile(configPath, 'utf-8');
          const advisor = JSON.parse(advisorContent);
          const advisorDir = path.join(advisorsDir, advisorId);
          const avatar = String(advisor.avatar || '').trim();
          if (avatar.startsWith('http')) {
            localizeAdvisorAvatarInBackground(advisorDir, configPath, advisor);
          }
          const knowledgeDir = path.join(advisorsDir, advisorId, 'knowledge');

          advisorInfos.push({
            id: advisorId,
            name: advisor.name,
            avatar: resolveAdvisorAvatarForList(advisorDir, advisor),
            systemPrompt: advisor.systemPrompt || '',
            knowledgeDir,
            knowledgeLanguage: String(advisor.knowledgeLanguage || '').trim() || '中文',
          });
        } catch (err) {
          console.error(`Failed to load advisor ${advisorId}:`, err);
        }
      }
    }

    if (advisorInfos.length === 0) {
      win?.webContents.send('creative-chat:done', { roomId });
      return { success: false, error: 'No valid advisors in room' };
    }

    // 构建 Embedding 配置（已废弃）
    const embeddingConfig = null;

    // 创建讨论流程服务
    const discussionService = createDiscussionFlowService({
      apiKey: resolvedApiKey,
      baseURL: resolvedBaseUrl,
      model: resolvedModelName,
      roomName: String(room.name || '').trim() || roomId,
    }, win);

    // 执行讨论流程
    // 六顶思考帽模式：按固定顺序（白→红→黑→黄→绿→蓝）
    // 普通模式：总监开场 -> 成员随机发言 -> 总监总结
    const newMessages = await discussionService.orchestrateDiscussion(
      roomId,
      message,
      advisorInfos,
      room.messages,
      isSixHatsMode, // 传递模式标记
      room.name, // 传递群聊目标
      context // 传递文件上下文
    );

    // 保存所有新消息到房间
    for (const msg of newMessages) {
      room.messages.push({
        id: msg.id,
        role: msg.role,
        advisorId: msg.advisorId,
        advisorName: msg.advisorName,
        advisorAvatar: msg.advisorAvatar,
        content: msg.content,
        timestamp: msg.timestamp,
        phase: msg.phase,
      });
    }

    // Save room
    await fs.writeFile(roomPath, JSON.stringify(room, null, 2), 'utf-8');
    win?.webContents.send('creative-chat:done', { roomId });
    return { success: true };

  } catch (error) {
    console.error('Failed to send message:', error);
    win?.webContents.send('creative-chat:done', { roomId });
    return { success: false, error: String(error) };
  }
});

// --------- Manuscripts (稿件编辑器) ---------
function getManuscriptsDir() {
  return getWorkspacePaths().manuscripts;
}

function getManuscriptDisplayName(fileName: string) {
  return stripManuscriptExtension(fileName);
}

function getManuscriptPackageManifestPath(packagePath: string) {
  return path.join(packagePath, 'manifest.json');
}

function getManuscriptPackageScriptPath(packagePath: string) {
  return path.join(packagePath, 'script.md');
}

function getManuscriptPackageTimelinePath(packagePath: string) {
  return path.join(packagePath, 'timeline.otio.json');
}

function getManuscriptPackageAssetsPath(packagePath: string) {
  return path.join(packagePath, 'assets.json');
}

function getManuscriptPackageCoverPath(packagePath: string) {
  return path.join(packagePath, 'cover.json');
}

function getManuscriptPackageImagesPath(packagePath: string) {
  return path.join(packagePath, 'images.json');
}

function getManuscriptPackageLayoutHtmlPath(packagePath: string) {
  return path.join(packagePath, 'layout.html');
}

function getManuscriptPackageWechatHtmlPath(packagePath: string) {
  return path.join(packagePath, 'wechat.html');
}

function getDefaultManuscriptPackageEntry(fileName: string) {
  const packageKind = getPackageKindFromFileName(fileName);
  if (packageKind === 'video' || packageKind === 'audio') {
    return 'script.md';
  }
  return 'content.md';
}

function getManuscriptPackageEntryPath(packagePath: string, fileName: string, manifest?: Record<string, unknown>) {
  const entry = String(manifest?.entry || '').trim() || getDefaultManuscriptPackageEntry(fileName);
  return path.join(packagePath, entry);
}

type ManuscriptTreeNode = {
  name: string;
  path: string;
  isDirectory: boolean;
  children?: ManuscriptTreeNode[];
  status?: string;
  title?: string;
  draftType?: string;
  updatedAt?: number;
  summary?: string;
};

function summarizeManuscriptContent(content: string) {
  return String(content || '')
    .replace(/^#+\s+/gm, '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/\[(.*?)\]\((.*?)\)/g, '$1')
    .replace(/[*_>`~-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 72);
}

async function readManuscriptListMetadata(fullPath: string, fileName: string, isPackage: boolean) {
  const stats = await fs.stat(fullPath);
  const fallbackTitle = '未命名';
  const fallbackDraftType = getDraftTypeFromFileName(fileName);
  const fallbackUpdatedAt = Number.isFinite(stats.mtimeMs) ? Math.trunc(stats.mtimeMs) : Date.now();

  try {
    if (isPackage) {
      const { content, metadata } = await readManuscriptPackage(fullPath);
      return {
        status: String(metadata?.status || 'writing'),
        title: String(metadata?.title || '').trim() || fallbackTitle,
        draftType: String(metadata?.draftType || '').trim() || fallbackDraftType,
        updatedAt: Number(metadata?.updatedAt || metadata?.createdAt || fallbackUpdatedAt) || fallbackUpdatedAt,
        summary: summarizeManuscriptContent(content),
      };
    }

    const rawContent = await fs.readFile(fullPath, 'utf-8');
    const parsed = matter(rawContent);
    const metadata = (parsed.data || {}) as Record<string, unknown>;
    return {
      status: String(metadata?.status || 'writing'),
      title: String(metadata?.title || '').trim() || fallbackTitle,
      draftType: String(metadata?.draftType || '').trim() || fallbackDraftType,
      updatedAt: Number(metadata?.updatedAt || metadata?.createdAt || fallbackUpdatedAt) || fallbackUpdatedAt,
      summary: summarizeManuscriptContent(parsed.content || ''),
    };
  } catch {
    return {
      status: 'writing',
      title: fallbackTitle,
      draftType: fallbackDraftType,
      updatedAt: fallbackUpdatedAt,
      summary: '',
    };
  }
}

async function readManuscriptPackage(packagePath: string): Promise<{ content: string; metadata: Record<string, unknown> }> {
  const manifestPath = getManuscriptPackageManifestPath(packagePath);
  const fileName = path.basename(packagePath);
  let metadata: Record<string, unknown> = {};
  let content = '';

  try {
    const rawManifest = await fs.readFile(manifestPath, 'utf-8');
    const parsed = JSON.parse(rawManifest);
    if (parsed && typeof parsed === 'object') {
      metadata = parsed as Record<string, unknown>;
    }
  } catch {
    metadata = {};
  }

  try {
    content = await fs.readFile(getManuscriptPackageEntryPath(packagePath, fileName, metadata), 'utf-8');
  } catch {
    content = '';
  }

  let needsUpdate = false;
  if (!metadata.id) {
    metadata.id = ulid();
    needsUpdate = true;
  }
  if (!metadata.createdAt) {
    metadata.createdAt = Date.now();
    needsUpdate = true;
  }
  if (!metadata.updatedAt) {
    metadata.updatedAt = Number(metadata.createdAt) || Date.now();
    needsUpdate = true;
  }
  if (!metadata.title) {
    metadata.title = getManuscriptDisplayName(fileName);
    needsUpdate = true;
  }
  if (!metadata.packageKind) {
    metadata.packageKind = getPackageKindFromFileName(fileName);
    needsUpdate = true;
  }
  if (!metadata.draftType) {
    metadata.draftType = getDraftTypeFromFileName(fileName);
    needsUpdate = true;
  }
  if (!metadata.entry) {
    metadata.entry = getDefaultManuscriptPackageEntry(fileName);
    needsUpdate = true;
  }

  if (needsUpdate) {
    await fs.writeFile(manifestPath, JSON.stringify(metadata, null, 2), 'utf-8');
  }

  return { content, metadata };
}

async function saveManuscriptPackage(packagePath: string, content: string, metadata?: Record<string, unknown>) {
  const fileName = path.basename(packagePath);
  let existingMetadata: Record<string, unknown> = {};
  try {
    existingMetadata = JSON.parse(await fs.readFile(getManuscriptPackageManifestPath(packagePath), 'utf-8')) as Record<string, unknown>;
  } catch {
    existingMetadata = {};
  }
  const packageMetadata = {
    ...existingMetadata,
    ...(metadata || {}),
    updatedAt: Date.now(),
  } as Record<string, unknown>;
  await fs.mkdir(packagePath, { recursive: true });
  await fs.writeFile(getManuscriptPackageEntryPath(packagePath, fileName, packageMetadata), String(content || ''), 'utf-8');
  await fs.writeFile(getManuscriptPackageManifestPath(packagePath), JSON.stringify(packageMetadata, null, 2), 'utf-8');
}

async function touchManuscriptPackageUpdatedAt(packagePath: string) {
  try {
    const manifestPath = getManuscriptPackageManifestPath(packagePath);
    const existing = await readJsonFromFile<Record<string, unknown>>(manifestPath, {});
    const next = {
      ...existing,
      updatedAt: Date.now(),
    };
    await fs.writeFile(manifestPath, JSON.stringify(next, null, 2), 'utf-8');
  } catch (error) {
    console.error('Failed to touch manuscript package updatedAt:', error);
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
        {
          OTIO_SCHEMA: 'Track.1',
          name: 'V1',
          kind: 'Video',
          children: [],
        },
        {
          OTIO_SCHEMA: 'Track.1',
          name: 'A1',
          kind: 'Audio',
          children: [],
        },
      ],
    },
    metadata: {
      owner: 'redbox',
      engine: 'ai-editing',
      version: 1,
    },
  };
}

function createTimelineClipId(): string {
  return `clip_${ulid()}`;
}

function guessMediaMimeTypeByFilePath(inputPath: string): string {
  const ext = path.extname(inputPath).toLowerCase();
  if (['.jpg', '.jpeg'].includes(ext)) return 'image/jpeg';
  if (ext === '.png') return 'image/png';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.gif') return 'image/gif';
  if (ext === '.bmp') return 'image/bmp';
  if (ext === '.svg') return 'image/svg+xml';
  if (ext === '.mp4') return 'video/mp4';
  if (ext === '.mov') return 'video/quicktime';
  if (ext === '.webm') return 'video/webm';
  if (ext === '.m4v') return 'video/x-m4v';
  if (ext === '.avi') return 'video/x-msvideo';
  if (ext === '.mkv') return 'video/x-matroska';
  if (ext === '.mp3') return 'audio/mpeg';
  if (ext === '.wav') return 'audio/wav';
  if (ext === '.m4a') return 'audio/mp4';
  if (ext === '.aac') return 'audio/aac';
  if (ext === '.flac') return 'audio/flac';
  if (ext === '.ogg') return 'audio/ogg';
  if (ext === '.opus') return 'audio/opus';
  return 'application/octet-stream';
}

function inferAssetKindFromPathOrMime(inputPath: string, mimeType?: string): 'image' | 'video' | 'audio' | 'unknown' {
  const mime = String(mimeType || '').toLowerCase();
  const ref = String(inputPath || '').toLowerCase();
  if (mime.startsWith('image/') || /\.(png|jpg|jpeg|webp|gif|bmp|svg)$/i.test(ref)) return 'image';
  if (mime.startsWith('video/') || /\.(mp4|mov|webm|m4v|avi|mkv)$/i.test(ref)) return 'video';
  if (mime.startsWith('audio/') || /\.(mp3|wav|m4a|aac|flac|ogg|opus)$/i.test(ref)) return 'audio';
  return 'unknown';
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

async function attachExternalFileToPackage(packagePath: string, input: {
  absolutePath: string;
  title?: string;
  mimeType?: string;
}): Promise<void> {
  const normalizedAbsolutePath = path.resolve(input.absolutePath);
  const mimeType = String(input.mimeType || guessMediaMimeTypeByFilePath(normalizedAbsolutePath)).trim();
  const assetKind = inferAssetKindFromPathOrMime(normalizedAbsolutePath, mimeType);
  const assetId = `external_${ulid()}`;
  const title = String(input.title || path.basename(normalizedAbsolutePath)).trim() || path.basename(normalizedAbsolutePath);

  const assetsPath = getManuscriptPackageAssetsPath(packagePath);
  const assetsJson = await readJsonFromFile<{ items: Array<Record<string, unknown>> }>(assetsPath, { items: [] });
  assetsJson.items.push({
    assetId,
    mediaPath: normalizedAbsolutePath,
    source: 'external-file',
    mimeType,
    title,
    role: 'asset',
    boundAt: new Date().toISOString(),
  });
  await fs.writeFile(assetsPath, JSON.stringify(assetsJson, null, 2), 'utf-8');

  const timelinePath = getManuscriptPackageTimelinePath(packagePath);
  const timeline = await readJsonFromFile<Record<string, unknown>>(timelinePath, createEmptyOtioTimeline(path.basename(packagePath)));
  const preferredTrackName = assetKind === 'audio' ? 'A1' : 'V1';
  const preferredKind = preferredTrackName.startsWith('A') ? 'Audio' as const : 'Video' as const;
  const targetTrack = ensureTimelineTrack(timeline, preferredTrackName, preferredKind);
  const targetChildren = Array.isArray((targetTrack as any)?.children) ? targetTrack.children : [];
  const desiredOrder = targetChildren.length;
  targetChildren.push({
    OTIO_SCHEMA: 'Clip.2',
    name: title,
    source_range: null,
    media_references: {
      DEFAULT_MEDIA: {
        OTIO_SCHEMA: 'ExternalReference.1',
        target_url: normalizedAbsolutePath,
        available_range: null,
        metadata: {
          assetId,
          mimeType,
        },
      },
    },
    active_media_reference_key: 'DEFAULT_MEDIA',
    metadata: {
      clipId: createTimelineClipId(),
      assetId,
      assetKind,
      source: 'external-file',
      order: desiredOrder,
      durationMs: null,
      trimInMs: 0,
      trimOutMs: 0,
      enabled: true,
      addedAt: new Date().toISOString(),
    },
  });
  targetTrack.children = targetChildren;
  normalizePackageTimeline(timeline);
  await fs.writeFile(timelinePath, JSON.stringify(timeline, null, 2), 'utf-8');
}

async function readJsonFromFile<T>(filePath: string, fallback: T): Promise<T> {
  try {
    const raw = await fs.readFile(filePath, 'utf-8');
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
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

  const clips: Array<Record<string, unknown>> = [];
  for (const track of tracks) {
    const trackName = String((track as any)?.name || '').trim();
    const trackKind = String((track as any)?.kind || '').trim();
    const children = Array.isArray((track as any)?.children) ? (track as any).children : [];
    for (let index = 0; index < children.length; index += 1) {
      const clip = children[index] as any;
      const metadata = (clip?.metadata && typeof clip.metadata === 'object') ? clip.metadata : {};
      const mediaRef = clip?.media_references?.DEFAULT_MEDIA;
      const assetId = String(metadata.assetId || mediaRef?.metadata?.assetId || '').trim();
      const sourceRef = assetId ? sourceRefByAssetId.get(assetId) : null;
      clips.push({
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
      });
    }
  }
  return { tracks, sourceRefs, clips };
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

async function getManuscriptPackageState(packagePath: string) {
  const fileName = path.basename(packagePath);
  const manifest = await readJsonFromFile<Record<string, unknown>>(getManuscriptPackageManifestPath(packagePath), {});
  const assets = await readJsonFromFile<{ items: Array<Record<string, unknown>> }>(getManuscriptPackageAssetsPath(packagePath), { items: [] });
  const cover = await readJsonFromFile<Record<string, unknown>>(getManuscriptPackageCoverPath(packagePath), { assetId: null });
  const images = await readJsonFromFile<{ items: Array<Record<string, unknown>> }>(getManuscriptPackageImagesPath(packagePath), { items: [] });
  const timeline = await readJsonFromFile<Record<string, unknown>>(getManuscriptPackageTimelinePath(packagePath), {});
  const { tracks, sourceRefs, clips } = buildTimelineClipSummaries(timeline);
  const clipCount = tracks.reduce((count: number, track: any) => {
    const children = Array.isArray(track?.children) ? track.children : [];
    return count + children.length;
  }, 0);
  let hasLayoutHtml = false;
  let hasWechatHtml = false;
  let layoutHtml = '';
  let wechatHtml = '';
  try {
    await fs.access(getManuscriptPackageLayoutHtmlPath(packagePath));
    layoutHtml = await fs.readFile(getManuscriptPackageLayoutHtmlPath(packagePath), 'utf-8');
    hasLayoutHtml = Boolean(layoutHtml.trim());
  } catch {}
  try {
    await fs.access(getManuscriptPackageWechatHtmlPath(packagePath));
    wechatHtml = await fs.readFile(getManuscriptPackageWechatHtmlPath(packagePath), 'utf-8');
    hasWechatHtml = Boolean(wechatHtml.trim());
  } catch {}

  const enrichedAssets = await Promise.all((assets.items || []).map(async (item) => {
    const mediaPath = String(item.mediaPath || '').trim();
    if (!mediaPath) {
      return { ...item, exists: false };
    }
    const absolutePath = path.isAbsolute(mediaPath) ? mediaPath : getAbsoluteMediaPath(mediaPath);
    try {
      await fs.access(absolutePath);
      return {
        ...item,
        absolutePath,
        previewUrl: toLocalFileUrl(absolutePath),
        exists: true,
      };
    } catch {
      return {
        ...item,
        absolutePath,
        previewUrl: toLocalFileUrl(absolutePath),
        exists: false,
      };
    }
  }));

  return {
    manifest: {
      ...manifest,
      packageKind: manifest.packageKind || getPackageKindFromFileName(fileName),
      draftType: manifest.draftType || getDraftTypeFromFileName(fileName),
    },
    assets: {
      ...assets,
      items: enrichedAssets,
    },
    cover,
    images,
    timelineSummary: {
      trackCount: tracks.length,
      clipCount,
      sourceRefs,
      clips,
    },
    hasLayoutHtml,
    hasWechatHtml,
    layoutHtml,
    wechatHtml,
  };
}

async function createManuscriptPackage(packagePath: string, content: string, fileName: string, titleOverride?: string) {
  const now = Date.now();
  const title = String(titleOverride || '').trim() || '未命名';
  const packageKind = getPackageKindFromFileName(fileName);
  const draftType = getDraftTypeFromFileName(fileName);
  const entryFile = getDefaultManuscriptPackageEntry(fileName);
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
    entry: entryFile,
    timeline: packageKind === 'video' || packageKind === 'audio' ? 'timeline.otio.json' : undefined,
  };

  await fs.mkdir(packagePath, { recursive: true });
  await fs.mkdir(path.join(packagePath, 'cache'), { recursive: true });
  await fs.mkdir(path.join(packagePath, 'exports'), { recursive: true });
  await fs.writeFile(getManuscriptPackageManifestPath(packagePath), JSON.stringify(manifest, null, 2), 'utf-8');
  await fs.writeFile(getManuscriptPackageEntryPath(packagePath, fileName, manifest), content || '', 'utf-8');
  if (packageKind === 'video' || packageKind === 'audio') {
    await fs.writeFile(path.join(packagePath, 'assets.json'), JSON.stringify({ items: [] }, null, 2), 'utf-8');
    await fs.writeFile(
      getManuscriptPackageTimelinePath(packagePath),
      JSON.stringify(createEmptyOtioTimeline(title), null, 2),
      'utf-8'
    );
    if (packageKind === 'audio') {
      await fs.writeFile(path.join(packagePath, 'segments.json'), JSON.stringify({ items: [] }, null, 2), 'utf-8');
      await fs.writeFile(path.join(packagePath, 'transcript.json'), JSON.stringify({ items: [] }, null, 2), 'utf-8');
    } else {
      await fs.writeFile(path.join(packagePath, 'storyboard.json'), JSON.stringify({ scenes: [] }, null, 2), 'utf-8');
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

async function upgradeMarkdownManuscriptToPackage(sourcePath: string, targetPackageExtension: string) {
  const sourceFullPath = path.join(getManuscriptsDir(), sourcePath);
  const sourceDir = path.dirname(sourceFullPath);
  const sourceFileName = path.basename(sourceFullPath);
  const targetFileName = `${stripManuscriptExtension(sourceFileName)}${targetPackageExtension}`;
  const targetFullPath = path.join(sourceDir, targetFileName);

  const rawContent = await fs.readFile(sourceFullPath, 'utf-8');
  const parsed = matter(rawContent);
  const metadata = (parsed.data || {}) as Record<string, unknown>;
  const packageMetadata = {
    ...metadata,
    title: String(metadata.title || '').trim() || stripManuscriptExtension(sourceFileName),
    draftType: targetPackageExtension === ARTICLE_DRAFT_EXTENSION ? 'longform' : 'richpost',
    packageKind: targetPackageExtension === ARTICLE_DRAFT_EXTENSION ? 'article' : 'post',
    migratedFrom: sourcePath,
    migratedAt: Date.now(),
  };

  try {
    await fs.access(targetFullPath);
    throw new Error('目标工程已存在');
  } catch (error: any) {
    if (error?.code !== 'ENOENT') {
      throw error;
    }
  }

  await createManuscriptPackage(targetFullPath, parsed.content || '', targetFileName);
  await saveManuscriptPackage(targetFullPath, parsed.content || '', packageMetadata);
  await fs.rm(sourceFullPath, { force: true });
  return path.relative(getManuscriptsDir(), targetFullPath);
}

async function ensureManuscriptsDir() {
  const fs = require('fs/promises');
  try {
    await fs.mkdir(getManuscriptsDir(), { recursive: true });
  } catch { }
}

// 递归构建文件树
async function buildFileTree(dirPath: string, basePath: string): Promise<ManuscriptTreeNode[]> {
  const fs = require('fs/promises');
  const entries = await fs.readdir(dirPath, { withFileTypes: true });
  const result: ManuscriptTreeNode[] = [];

  // Sort: directories first, then alphabetically
  const sorted = entries.sort((a: { isDirectory: () => boolean; name: string }, b: { isDirectory: () => boolean; name: string }) => {
    if (a.isDirectory() && !b.isDirectory()) return -1;
    if (!a.isDirectory() && b.isDirectory()) return 1;
    return a.name.localeCompare(b.name);
  });

  for (const entry of sorted) {
    const fullPath = path.join(dirPath, entry.name);
    const relativePath = path.relative(basePath, fullPath);

    if (entry.isDirectory()) {
      if (isManuscriptPackageName(entry.name)) {
        const metadata = await readManuscriptListMetadata(fullPath, entry.name, true);
        try {
          result.push({
            name: entry.name,
            path: relativePath,
            isDirectory: false,
            status: metadata.status,
            title: metadata.title,
            draftType: metadata.draftType,
            updatedAt: metadata.updatedAt,
            summary: metadata.summary,
          });
        } catch {
          result.push({
            name: entry.name,
            path: relativePath,
            isDirectory: false,
            status: 'writing',
            title: '未命名',
            draftType: getDraftTypeFromFileName(entry.name),
            updatedAt: undefined,
            summary: '',
          });
        }
        continue;
      }
      const children = await buildFileTree(fullPath, basePath);
      result.push({
        name: entry.name,
        path: relativePath,
        isDirectory: true,
        children
      });
    } else if (isSupportedManuscriptFile(entry.name)) {
      const metadata = await readManuscriptListMetadata(fullPath, entry.name, false);
      result.push({
        name: entry.name,
        path: relativePath,
        isDirectory: false,
        status: metadata.status,
        title: metadata.title,
        draftType: metadata.draftType,
        updatedAt: metadata.updatedAt,
        summary: metadata.summary,
      });
    }
  }

  return result;
}

async function listManuscriptTreeWithCache() {
  await ensureManuscriptsDir();
  const baseDir = getManuscriptsDir();
  const cacheKey = baseDir;
  const cached = manuscriptTreeCache.get(cacheKey);
  if (cached && Date.now() - cached.generatedAt < MANUSCRIPT_TREE_CACHE_TTL_MS) {
    return cached.tree as ManuscriptTreeNode[];
  }
  const tree = await buildFileTree(baseDir, baseDir);
  manuscriptTreeCache.set(cacheKey, {
    tree,
    generatedAt: Date.now(),
  });
  return tree;
}

// 列出文件树
ipcMain.handle('manuscripts:list', async () => {
  try {
    const tree = await listManuscriptTreeWithCache();
    return tree;
  } catch (error) {
    console.error('Failed to list manuscripts:', error);
    return [];
  }
});

// 读取文件内容
ipcMain.handle('manuscripts:read', async (_, filePath: string) => {
  const fs = require('fs/promises');
  const fullPath = path.join(getManuscriptsDir(), filePath);

  try {
    const stat = await fs.stat(fullPath);
    if (stat.isDirectory()) {
      return await readManuscriptPackage(fullPath);
    }

    const rawContent = await fs.readFile(fullPath, 'utf-8');

    // Parse frontmatter
    const parsed = matter(rawContent);
    let { data, content } = parsed;
    let needsUpdate = false;

    // Ensure ID exists
    if (!data.id) {
      data.id = ulid();
      data.createdAt = Date.now();
      needsUpdate = true;
    }

    // If metadata was added/generated, write it back immediately
    if (needsUpdate) {
      const newContent = matter.stringify(content, data);
      await fs.writeFile(fullPath, newContent, 'utf-8');
    }

    return { content, metadata: data };
  } catch (error: any) {
    if (error.code === 'ENOENT') {
      // File not found - likely deleted. Return empty quietly.
      return { content: '', metadata: {} };
    }
    console.error('Failed to read manuscript:', error);
    // Return structure matching success case but empty
    return { content: '', metadata: {} };
  }
});

// 保存文件内容
ipcMain.handle('manuscripts:save', async (_, { path: filePath, content, metadata }: { path: string; content: string; metadata?: any }) => {
  const fullPath = path.join(getManuscriptsDir(), filePath);

  try {
    const stat = await fs.stat(fullPath);
    if (stat.isDirectory()) {
      await saveManuscriptPackage(fullPath, content, metadata || {});
      const title = metadata?.title || getManuscriptDisplayName(path.basename(filePath));
      if (content && content.trim().length > 0) {
        indexManager.addToQueue({
          id: `manuscript_${filePath}`,
          sourceId: filePath,
          title,
          content,
          sourceType: 'file',
          scope: 'user',
          displayData: {
            platform: 'manuscript',
            url: filePath
          }
        });
      }
      invalidateManuscriptTreeCache(getManuscriptsDir());
      emitRendererDataChanged('manuscripts', { action: 'save', entityId: filePath });
      return { success: true };
    }

    // If metadata provided, update timestamp
    const data = metadata || {};
    data.updatedAt = Date.now();

    // Recombine content and metadata
    const fileContent = matter.stringify(content, data);

    await fs.writeFile(fullPath, fileContent, 'utf-8');

    // 自动将稿件加入索引队列计算 embedding
    if (content && content.trim().length > 0) {
      const title = data.title || getManuscriptDisplayName(path.basename(filePath));
      indexManager.addToQueue({
        id: `manuscript_${filePath}`,
        sourceId: filePath,
        title,
        content,
        sourceType: 'file',
        scope: 'user',
        displayData: {
          platform: 'manuscript',
          url: filePath
        }
      });
    }

    invalidateManuscriptTreeCache(getManuscriptsDir());
    emitRendererDataChanged('manuscripts', { action: 'save', entityId: filePath });
    return { success: true };
  } catch (error) {
    console.error('Failed to save manuscript:', error);
    return { success: false, error: String(error) };
  }
});

ipcMain.handle('manuscripts:format-wechat', async (_, payload?: {
  content?: string;
  title?: string;
  metadata?: Record<string, unknown>;
}) => {
  try {
    const content = String(payload?.content || '').trim();
    if (!content) {
      throw new Error('content is required');
    }
    const metadata = payload?.metadata && typeof payload.metadata === 'object'
      ? payload.metadata
      : {};
    const title = String(payload?.title || metadata.title || '').trim();
    const formatted = formatWechatArticleFromMarkdown({
      content,
      title,
      metadata,
    });
    return {
      success: true,
      ...formatted,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
});

ipcMain.handle('wechat-official:create-draft', async (_, payload?: {
  bindingId?: string;
  content?: string;
  title?: string;
  metadata?: Record<string, unknown>;
  sourcePath?: string;
}) => {
  try {
    const content = String(payload?.content || '').trim();
    if (!content) {
      throw new Error('content is required');
    }
    const result = await createWechatOfficialDraftFromMarkdown({
      bindingId: String(payload?.bindingId || '').trim() || undefined,
      content,
      title: String(payload?.title || '').trim() || undefined,
      metadata: payload?.metadata && typeof payload.metadata === 'object'
        ? payload.metadata
        : undefined,
      sourcePath: String(payload?.sourcePath || '').trim() || undefined,
    });
    return { success: true, ...result };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
});

// 获取布局信息
ipcMain.handle('manuscripts:get-layout', async () => {
  const fs = require('fs/promises');
  await ensureManuscriptsDir();
  const layoutPath = path.join(getManuscriptsDir(), 'layout.json');

  try {
    const content = await fs.readFile(layoutPath, 'utf-8');
    return JSON.parse(content);
  } catch (error) {
    return {};
  }
});

// 保存布局信息
ipcMain.handle('manuscripts:save-layout', async (_, layout: any) => {
  const fs = require('fs/promises');
  await ensureManuscriptsDir();
  const layoutPath = path.join(getManuscriptsDir(), 'layout.json');

  try {
    await fs.writeFile(layoutPath, JSON.stringify(layout, null, 2), 'utf-8');
    invalidateManuscriptTreeCache(getManuscriptsDir());
    emitRendererDataChanged('manuscripts', { action: 'layout-save' });
    return { success: true };
  } catch (error) {
    console.error('Failed to save layout:', error);
    return { success: false, error: String(error) };
  }
});

// 创建文件夹
ipcMain.handle('manuscripts:create-folder', async (_, { parentPath, name }: { parentPath: string; name: string }) => {
  const fs = require('fs/promises');
  const fullPath = path.join(getManuscriptsDir(), parentPath, name);

  try {
    await fs.mkdir(fullPath, { recursive: true });
    invalidateManuscriptTreeCache(getManuscriptsDir());
    emitRendererDataChanged('manuscripts', { action: 'create-folder', entityId: path.relative(getManuscriptsDir(), fullPath) });
    return { success: true };
  } catch (error) {
    console.error('Failed to create folder:', error);
    return { success: false, error: String(error) };
  }
});

// 创建文件
ipcMain.handle('manuscripts:create-file', async (_, { parentPath, name, content, title }: { parentPath: string; name: string; content?: string; title?: string }) => {
  const fallbackExtension = getManuscriptExtension(name) || '.md';
  const fileName = ensureManuscriptFileName(name, fallbackExtension);
  const fullPath = path.join(getManuscriptsDir(), parentPath, fileName);

  try {
    // Check if exists
    try {
      await fs.access(fullPath);
      return { success: false, error: '文件已存在' };
    } catch {
      // File doesn't exist, create it
    }

    // Ensure parent directory exists
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    if (isManuscriptPackageName(fileName)) {
      await createManuscriptPackage(fullPath, content || '', fileName, String(title || '').trim() || '未命名');
    } else {
      await fs.writeFile(fullPath, content || '', 'utf-8');
    }
    invalidateManuscriptTreeCache(getManuscriptsDir());
    emitRendererDataChanged('manuscripts', { action: 'create-file', entityId: path.relative(getManuscriptsDir(), fullPath) });
    return { success: true, path: path.relative(getManuscriptsDir(), fullPath) };
  } catch (error) {
    console.error('Failed to create file:', error);
    return { success: false, error: String(error) };
  }
});

// 删除文件或文件夹
ipcMain.handle('manuscripts:delete', async (_, filePath: string) => {
  const fs = require('fs/promises');
  const fullPath = path.join(getManuscriptsDir(), filePath);

  try {
    await fs.rm(fullPath, { recursive: true, force: true });
    invalidateManuscriptTreeCache(getManuscriptsDir());
    emitRendererDataChanged('manuscripts', { action: 'delete', entityId: filePath });
    return { success: true };
  } catch (error) {
    console.error('Failed to delete manuscript:', error);
    return { success: false, error: String(error) };
  }
});

// 重命名文件或文件夹
ipcMain.handle('manuscripts:rename', async (_, { oldPath, newName }: { oldPath: string; newName: string }) => {
  const fs = require('fs/promises');
  const oldFullPath = path.join(getManuscriptsDir(), oldPath);
  const parentDir = path.dirname(oldFullPath);
  const newFullPath = path.join(parentDir, newName);

  try {
    await fs.rename(oldFullPath, newFullPath);
    invalidateManuscriptTreeCache(getManuscriptsDir());
    emitRendererDataChanged('manuscripts', {
      action: 'rename',
      entityId: path.relative(getManuscriptsDir(), newFullPath),
      oldPath,
    });
    return { success: true, newPath: path.relative(getManuscriptsDir(), newFullPath) };
  } catch (error) {
    console.error('Failed to rename manuscript:', error);
    return { success: false, error: String(error) };
  }
});

ipcMain.handle('manuscripts:upgrade-to-package', async (_, {
  sourcePath,
  targetKind,
}: {
  sourcePath: string;
  targetKind: 'article' | 'post';
}) => {
  try {
    const targetExtension = targetKind === 'article' ? ARTICLE_DRAFT_EXTENSION : POST_DRAFT_EXTENSION;
    const newPath = await upgradeMarkdownManuscriptToPackage(sourcePath, targetExtension);
    invalidateManuscriptTreeCache(getManuscriptsDir());
    emitRendererDataChanged('manuscripts', {
      action: 'upgrade',
      entityId: newPath,
      sourcePath,
    });
    return { success: true, newPath };
  } catch (error) {
    console.error('Failed to upgrade manuscript to package:', error);
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
});

ipcMain.handle('manuscripts:get-package-state', async (_, filePath: string) => {
  try {
    if (!filePath) {
      return { success: false, error: 'filePath is required' };
    }
    const fullPath = path.join(getManuscriptsDir(), filePath);
    const stats = await fs.stat(fullPath);
    if (!stats.isDirectory() || !isManuscriptPackageName(path.basename(fullPath))) {
      return { success: false, error: 'Not a manuscript package' };
    }
    return { success: true, state: await getManuscriptPackageState(fullPath) };
  } catch (error) {
    console.error('Failed to get manuscript package state:', error);
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
});

ipcMain.handle('manuscripts:get-editor-runtime-state', async (_, payload?: string | { filePath?: string }) => {
  const filePath = typeof payload === 'string'
    ? payload.trim()
    : String(payload?.filePath || '').trim();
  if (!filePath) {
    return { success: false, error: 'filePath is required' };
  }
  return {
    success: true,
    state: serializeEditorRuntimeState(filePath),
  };
});

ipcMain.handle('manuscripts:update-editor-runtime-state', async (_, payload?: {
  filePath?: string;
  sessionId?: string;
  playheadSeconds?: number;
  selectedClipId?: string;
  selectedClipIds?: unknown;
  activeTrackId?: string;
  selectedTrackIds?: unknown;
  selectedSceneId?: string;
  previewTab?: string;
  canvasRatioPreset?: string;
  activePanel?: string;
  drawerPanel?: string;
  sceneItemTransforms?: unknown;
  sceneItemVisibility?: unknown;
  sceneItemOrder?: unknown;
  sceneItemLocks?: unknown;
  sceneItemGroups?: unknown;
  focusedGroupId?: string;
  trackUi?: unknown;
  viewportScrollLeft?: number;
  viewportMaxScrollLeft?: number;
  viewportScrollTop?: number;
  viewportMaxScrollTop?: number;
  timelineZoomPercent?: number;
}) => {
  const filePath = String(payload?.filePath || '').trim();
  if (!filePath) {
    return { success: false, error: 'filePath is required' };
  }

  const previous = editorRuntimeStates.get(filePath) || buildEmptyEditorRuntimeState(filePath);
  const next: EditorRuntimeStateRecord = {
    ...previous,
    filePath,
    sessionId: String(payload?.sessionId || '').trim() || undefined,
    playheadSeconds: Number.isFinite(Number(payload?.playheadSeconds))
      ? Number(payload?.playheadSeconds)
      : previous.playheadSeconds,
    selectedClipId: String(payload?.selectedClipId || '').trim() || undefined,
    selectedClipIds: payload && Object.prototype.hasOwnProperty.call(payload, 'selectedClipIds')
      ? payload.selectedClipIds
      : previous.selectedClipIds,
    activeTrackId: String(payload?.activeTrackId || '').trim() || undefined,
    selectedTrackIds: payload && Object.prototype.hasOwnProperty.call(payload, 'selectedTrackIds')
      ? payload.selectedTrackIds
      : previous.selectedTrackIds,
    selectedSceneId: String(payload?.selectedSceneId || '').trim() || undefined,
    previewTab: String(payload?.previewTab || '').trim() || undefined,
    canvasRatioPreset: String(payload?.canvasRatioPreset || '').trim() || undefined,
    activePanel: String(payload?.activePanel || '').trim() || undefined,
    drawerPanel: String(payload?.drawerPanel || '').trim() || undefined,
    sceneItemTransforms: payload && Object.prototype.hasOwnProperty.call(payload, 'sceneItemTransforms')
      ? payload.sceneItemTransforms
      : previous.sceneItemTransforms,
    sceneItemVisibility: payload && Object.prototype.hasOwnProperty.call(payload, 'sceneItemVisibility')
      ? payload.sceneItemVisibility
      : previous.sceneItemVisibility,
    sceneItemOrder: payload && Object.prototype.hasOwnProperty.call(payload, 'sceneItemOrder')
      ? payload.sceneItemOrder
      : previous.sceneItemOrder,
    sceneItemLocks: payload && Object.prototype.hasOwnProperty.call(payload, 'sceneItemLocks')
      ? payload.sceneItemLocks
      : previous.sceneItemLocks,
    sceneItemGroups: payload && Object.prototype.hasOwnProperty.call(payload, 'sceneItemGroups')
      ? payload.sceneItemGroups
      : previous.sceneItemGroups,
    focusedGroupId: String(payload?.focusedGroupId || '').trim() || undefined,
    trackUi: payload && Object.prototype.hasOwnProperty.call(payload, 'trackUi')
      ? payload.trackUi
      : previous.trackUi,
    viewportScrollLeft: Number.isFinite(Number(payload?.viewportScrollLeft))
      ? Number(payload?.viewportScrollLeft)
      : previous.viewportScrollLeft,
    viewportMaxScrollLeft: Number.isFinite(Number(payload?.viewportMaxScrollLeft))
      ? Number(payload?.viewportMaxScrollLeft)
      : previous.viewportMaxScrollLeft,
    viewportScrollTop: Number.isFinite(Number(payload?.viewportScrollTop))
      ? Number(payload?.viewportScrollTop)
      : previous.viewportScrollTop,
    viewportMaxScrollTop: Number.isFinite(Number(payload?.viewportMaxScrollTop))
      ? Number(payload?.viewportMaxScrollTop)
      : previous.viewportMaxScrollTop,
    timelineZoomPercent: Number.isFinite(Number(payload?.timelineZoomPercent))
      ? Number(payload?.timelineZoomPercent)
      : previous.timelineZoomPercent,
    updatedAt: nowMs(),
  };

  editorRuntimeStates.set(filePath, next);
  return {
    success: true,
    state: serializeEditorRuntimeState(filePath),
  };
});

ipcMain.handle('manuscripts:update-package-clip', async (_, payload?: {
  filePath?: string;
  clipId?: string;
  assetId?: string;
  track?: string;
  order?: number;
  durationMs?: number | null;
  trimInMs?: number;
  trimOutMs?: number;
  enabled?: boolean;
}) => {
  try {
    const filePath = String(payload?.filePath || '').trim();
    const clipId = String(payload?.clipId || '').trim();
    const assetId = String(payload?.assetId || '').trim();
    if (!filePath || (!clipId && !assetId)) {
      return { success: false, error: 'filePath and clipId/assetId are required' };
    }
    const fullPath = path.join(getManuscriptsDir(), filePath);
    const stats = await fs.stat(fullPath);
    if (!stats.isDirectory() || !isManuscriptPackageName(path.basename(fullPath))) {
      return { success: false, error: 'Not a manuscript package' };
    }

    const timelinePath = getManuscriptPackageTimelinePath(fullPath);
    const timeline = await readJsonFromFile<Record<string, unknown>>(timelinePath, createEmptyOtioTimeline(path.basename(fullPath)));
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
      return { success: false, error: 'Clip not found in timeline' };
    }

    const nextTrackName = String(payload?.track || currentTrack?.name || '').trim() || String(currentTrack?.name || '');
    const targetTrack = tracks.find((track: any) => String(track?.name || '').trim() === nextTrackName) || currentTrack;
    const targetChildren = Array.isArray(targetTrack.children) ? targetTrack.children : [];
    const nextMetadata = (clipToMove?.metadata && typeof clipToMove.metadata === 'object') ? clipToMove.metadata : {};
    clipToMove = {
      ...clipToMove,
      metadata: {
        ...nextMetadata,
        clipId: String(nextMetadata.clipId || '').trim() || clipId || createTimelineClipId(),
        durationMs: payload?.durationMs === null ? null : (payload?.durationMs ?? nextMetadata.durationMs ?? null),
        trimInMs: payload?.trimInMs ?? nextMetadata.trimInMs ?? 0,
        trimOutMs: payload?.trimOutMs ?? nextMetadata.trimOutMs ?? 0,
        enabled: payload?.enabled ?? nextMetadata.enabled ?? true,
      },
    };
    const desiredOrder = typeof payload?.order === 'number' && Number.isFinite(payload.order)
      ? Math.max(0, Math.min(Math.trunc(payload.order), targetChildren.length))
      : targetChildren.length;
    targetChildren.splice(desiredOrder, 0, clipToMove);
    targetTrack.children = targetChildren;

    normalizePackageTimeline(timeline);
    await fs.writeFile(timelinePath, JSON.stringify(timeline, null, 2), 'utf-8');
    await touchManuscriptPackageUpdatedAt(fullPath);
    invalidateManuscriptTreeCache(getManuscriptsDir());
    emitRendererDataChanged('manuscripts', { action: 'clip-update', entityId: filePath });
    return { success: true, state: await getManuscriptPackageState(fullPath) };
  } catch (error) {
    console.error('Failed to update manuscript package clip:', error);
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
});

ipcMain.handle('manuscripts:add-package-track', async (_, payload?: {
  filePath?: string;
  kind?: 'video' | 'audio';
}) => {
  try {
    const filePath = String(payload?.filePath || '').trim();
    const kind = String(payload?.kind || 'video').trim().toLowerCase() === 'audio' ? 'audio' : 'video';
    if (!filePath) {
      return { success: false, error: 'filePath is required' };
    }
    const fullPath = path.join(getManuscriptsDir(), filePath);
    const stats = await fs.stat(fullPath);
    if (!stats.isDirectory() || !isManuscriptPackageName(path.basename(fullPath))) {
      return { success: false, error: 'Not a manuscript package' };
    }

    const timelinePath = getManuscriptPackageTimelinePath(fullPath);
    const timeline = await readJsonFromFile<Record<string, unknown>>(timelinePath, createEmptyOtioTimeline(path.basename(fullPath)));
    const tracks = Array.isArray((timeline as any)?.tracks?.children) ? (timeline as any).tracks.children : [];
    const prefix = kind === 'audio' ? 'A' : 'V';
    const kindLabel = kind === 'audio' ? 'Audio' as const : 'Video' as const;
    const existingIndexes = tracks
      .map((track: any) => String(track?.name || '').trim())
      .filter((name: string) => name.startsWith(prefix))
      .map((name: string) => Number(name.slice(1)))
      .filter((value: number) => Number.isFinite(value));
    const nextIndex = existingIndexes.length > 0 ? Math.max(...existingIndexes) + 1 : 1;
    ensureTimelineTrack(timeline, `${prefix}${nextIndex}`, kindLabel);
    normalizePackageTimeline(timeline);
    await fs.writeFile(timelinePath, JSON.stringify(timeline, null, 2), 'utf-8');
    await touchManuscriptPackageUpdatedAt(fullPath);
    invalidateManuscriptTreeCache(getManuscriptsDir());
    emitRendererDataChanged('manuscripts', { action: 'track-add', entityId: filePath });
    return { success: true, state: await getManuscriptPackageState(fullPath) };
  } catch (error) {
    console.error('Failed to add manuscript package track:', error);
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
});

ipcMain.handle('manuscripts:add-package-clip', async (_, payload?: {
  filePath?: string;
  assetId?: string;
  track?: string;
  order?: number;
  durationMs?: number | null;
}) => {
  try {
    const filePath = String(payload?.filePath || '').trim();
    const assetId = String(payload?.assetId || '').trim();
    if (!filePath || !assetId) {
      return { success: false, error: 'filePath and assetId are required' };
    }
    const fullPath = path.join(getManuscriptsDir(), filePath);
    const stats = await fs.stat(fullPath);
    if (!stats.isDirectory() || !isManuscriptPackageName(path.basename(fullPath))) {
      return { success: false, error: 'Not a manuscript package' };
    }

    const asset = (await listMediaAssets(5000)).find((item) => item.id === assetId);
    if (!asset) {
      return { success: false, error: 'Media asset not found' };
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

    const timelinePath = getManuscriptPackageTimelinePath(fullPath);
    const timeline = await readJsonFromFile<Record<string, unknown>>(timelinePath, createEmptyOtioTimeline(path.basename(fullPath)));
    const preferredTrackName = String(payload?.track || '').trim()
      || (assetKind === 'audio' ? 'A1' : 'V1');
    const targetTrack = ensureTimelineTrack(
      timeline,
      preferredTrackName,
      preferredTrackName.startsWith('A') ? 'Audio' : 'Video'
    );
    const targetChildren = Array.isArray((targetTrack as any)?.children) ? targetTrack.children : [];
    const desiredOrder = typeof payload?.order === 'number' && Number.isFinite(payload.order)
      ? Math.max(0, Math.min(Math.trunc(payload.order), targetChildren.length))
      : targetChildren.length;

    const nextClip = {
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
        durationMs: payload?.durationMs ?? null,
        trimInMs: 0,
        trimOutMs: 0,
        enabled: true,
        addedAt: new Date().toISOString(),
      },
    };

    targetChildren.splice(desiredOrder, 0, nextClip);
    targetTrack.children = targetChildren;
    normalizePackageTimeline(timeline);
    await fs.writeFile(timelinePath, JSON.stringify(timeline, null, 2), 'utf-8');
    await touchManuscriptPackageUpdatedAt(fullPath);
    invalidateManuscriptTreeCache(getManuscriptsDir());
    emitRendererDataChanged('manuscripts', { action: 'clip-add', entityId: filePath });
    return { success: true, state: await getManuscriptPackageState(fullPath) };
  } catch (error) {
    console.error('Failed to add manuscript package clip:', error);
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
});

ipcMain.handle('manuscripts:delete-package-clip', async (_, payload?: {
  filePath?: string;
  clipId?: string;
}) => {
  try {
    const filePath = String(payload?.filePath || '').trim();
    const clipId = String(payload?.clipId || '').trim();
    if (!filePath || !clipId) {
      return { success: false, error: 'filePath and clipId are required' };
    }
    const fullPath = path.join(getManuscriptsDir(), filePath);
    const stats = await fs.stat(fullPath);
    if (!stats.isDirectory() || !isManuscriptPackageName(path.basename(fullPath))) {
      return { success: false, error: 'Not a manuscript package' };
    }
    const timelinePath = getManuscriptPackageTimelinePath(fullPath);
    const timeline = await readJsonFromFile<Record<string, unknown>>(timelinePath, createEmptyOtioTimeline(path.basename(fullPath)));
    const tracks = Array.isArray((timeline as any)?.tracks?.children) ? (timeline as any).tracks.children : [];
    let removed = false;
    for (const track of tracks) {
      const trackName = String((track as any)?.name || '').trim();
      const children = Array.isArray((track as any)?.children) ? track.children : [];
      const nextChildren = children.filter((clip: any, index: number) => {
        const matches = getTimelineClipIdentity(clip, trackName, index) === clipId;
        if (matches) removed = true;
        return !matches;
      });
      track.children = nextChildren;
    }
    if (!removed) {
      return { success: false, error: 'Clip not found in timeline' };
    }
    normalizePackageTimeline(timeline);
    await fs.writeFile(timelinePath, JSON.stringify(timeline, null, 2), 'utf-8');
    await touchManuscriptPackageUpdatedAt(fullPath);
    invalidateManuscriptTreeCache(getManuscriptsDir());
    emitRendererDataChanged('manuscripts', { action: 'clip-delete', entityId: filePath });
    return { success: true, state: await getManuscriptPackageState(fullPath) };
  } catch (error) {
    console.error('Failed to delete manuscript package clip:', error);
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
});

ipcMain.handle('manuscripts:split-package-clip', async (_, payload?: {
  filePath?: string;
  clipId?: string;
  splitRatio?: number;
}) => {
  try {
    const filePath = String(payload?.filePath || '').trim();
    const clipId = String(payload?.clipId || '').trim();
    const splitRatioRaw = Number(payload?.splitRatio);
    const splitRatio = Number.isFinite(splitRatioRaw) ? Math.min(Math.max(splitRatioRaw, 0.1), 0.9) : 0.5;
    if (!filePath || !clipId) {
      return { success: false, error: 'filePath and clipId are required' };
    }
    const fullPath = path.join(getManuscriptsDir(), filePath);
    const stats = await fs.stat(fullPath);
    if (!stats.isDirectory() || !isManuscriptPackageName(path.basename(fullPath))) {
      return { success: false, error: 'Not a manuscript package' };
    }
    const timelinePath = getManuscriptPackageTimelinePath(fullPath);
    const timeline = await readJsonFromFile<Record<string, unknown>>(timelinePath, createEmptyOtioTimeline(path.basename(fullPath)));
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
      return { success: false, error: 'Clip not found in timeline' };
    }
    normalizePackageTimeline(timeline);
    await fs.writeFile(timelinePath, JSON.stringify(timeline, null, 2), 'utf-8');
    await touchManuscriptPackageUpdatedAt(fullPath);
    invalidateManuscriptTreeCache(getManuscriptsDir());
    emitRendererDataChanged('manuscripts', { action: 'clip-split', entityId: filePath });
    return { success: true, state: await getManuscriptPackageState(fullPath) };
  } catch (error) {
    console.error('Failed to split manuscript package clip:', error);
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
});

ipcMain.handle('manuscripts:save-formatted-html', async (_, payload?: {
  sourcePath?: string;
  layoutHtml?: string;
  wechatHtml?: string;
}) => {
  try {
    const sourcePath = String(payload?.sourcePath || '').trim();
    if (!sourcePath) {
      return { success: false, error: 'sourcePath is required' };
    }
    const fullPath = path.join(getManuscriptsDir(), sourcePath);
    const stats = await fs.stat(fullPath);
    if (!stats.isDirectory() || !isManuscriptPackageName(path.basename(fullPath))) {
      return { success: false, error: 'Not a manuscript package' };
    }
    const layoutHtml = String(payload?.layoutHtml || '');
    const wechatHtml = String(payload?.wechatHtml || layoutHtml);
    await fs.writeFile(getManuscriptPackageLayoutHtmlPath(fullPath), layoutHtml, 'utf-8');
    await fs.writeFile(getManuscriptPackageWechatHtmlPath(fullPath), wechatHtml, 'utf-8');
    await touchManuscriptPackageUpdatedAt(fullPath);
    invalidateManuscriptTreeCache(getManuscriptsDir());
    emitRendererDataChanged('manuscripts', { action: 'save-formatted-html', entityId: sourcePath });
    return { success: true };
  } catch (error) {
    console.error('Failed to save manuscript formatted html:', error);
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
});

ipcMain.handle('manuscripts:attach-external-files', async (_, payload?: {
  filePath?: string;
}) => {
  try {
    const filePath = String(payload?.filePath || '').trim();
    if (!filePath) {
      return { success: false, error: 'filePath is required' };
    }
    const fullPath = path.join(getManuscriptsDir(), filePath);
    const stats = await fs.stat(fullPath);
    if (!stats.isDirectory() || !isManuscriptPackageName(path.basename(fullPath))) {
      return { success: false, error: 'Not a manuscript package' };
    }

    const picked = await dialog.showOpenDialog({
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: '媒体文件', extensions: ['mp4', 'mov', 'webm', 'm4v', 'avi', 'mkv', 'mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg', 'opus', 'png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'svg'] },
        { name: '所有文件', extensions: ['*'] },
      ],
    });
    if (picked.canceled || !picked.filePaths.length) {
      return { success: true, canceled: true, imported: [] };
    }

    const imported: Array<Record<string, unknown>> = [];
    for (const pickedPath of picked.filePaths) {
      const absolutePath = path.resolve(pickedPath);
      const pickedStats = await fs.stat(absolutePath).catch(() => null);
      if (!pickedStats?.isFile()) continue;
      await attachExternalFileToPackage(fullPath, {
        absolutePath,
        title: path.basename(absolutePath),
        mimeType: guessMediaMimeTypeByFilePath(absolutePath),
      });
      imported.push({
        absolutePath,
        title: path.basename(absolutePath),
        mimeType: guessMediaMimeTypeByFilePath(absolutePath),
      });
    }

    await touchManuscriptPackageUpdatedAt(fullPath);
    invalidateManuscriptTreeCache(getManuscriptsDir());
    emitRendererDataChanged('manuscripts', { action: 'attach-external-files', entityId: filePath });
    return {
      success: true,
      canceled: false,
      imported,
      state: await getManuscriptPackageState(fullPath),
    };
  } catch (error) {
    console.error('Failed to attach external files to manuscript package:', error);
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
});

// 移动文件（拖拽）
ipcMain.handle('manuscripts:move', async (_, { sourcePath, targetDir }: { sourcePath: string; targetDir: string }) => {
  const fs = require('fs/promises');
  const sourceFullPath = path.join(getManuscriptsDir(), sourcePath);
  const fileName = path.basename(sourceFullPath);
  const targetFullPath = path.join(getManuscriptsDir(), targetDir, fileName);

  try {
    await fs.mkdir(path.dirname(targetFullPath), { recursive: true });
    await fs.rename(sourceFullPath, targetFullPath);
    invalidateManuscriptTreeCache(getManuscriptsDir());
    emitRendererDataChanged('manuscripts', {
      action: 'move',
      entityId: path.relative(getManuscriptsDir(), targetFullPath),
      sourcePath,
    });
    return { success: true, newPath: path.relative(getManuscriptsDir(), targetFullPath) };
  } catch (error) {
    console.error('Failed to move manuscript:', error);
    return { success: false, error: String(error) };
  }
});

// --------- Knowledge Base ---------
function getKnowledgeRedbookDir() {
  return getWorkspacePaths().knowledgeRedbook;
}

function getKnowledgeYoutubeDir() {
  return getWorkspacePaths().knowledgeYoutube;
}

async function ensureKnowledgeRedbookDir() {
  const fs = require('fs/promises');
  try {
    await fs.mkdir(getKnowledgeRedbookDir(), { recursive: true });
  } catch { }
}

async function ensureKnowledgeYoutubeDir() {
  const fs = require('fs/promises');
  try {
    await fs.mkdir(getKnowledgeYoutubeDir(), { recursive: true });
  } catch { }
}

type DocumentKnowledgeSourceView = {
  id: string;
  kind: DocumentSourceKind;
  name: string;
  rootPath: string;
  locked: boolean;
  indexing: boolean;
  indexError?: string;
  fileCount: number;
  sampleFiles: string[];
  createdAt: string;
  updatedAt: string;
};

const DOC_INDEX_REFRESH_INTERVAL_MS = 15 * 60 * 1000;
const DOC_INDEX_MAX_SCAN_FILES = 50000;
let docIndexRefreshRunning = false;

const copyIntoImportedKnowledgeDir = async (sourcePath: string) => {
  const workspacePaths = getWorkspacePaths();
  await ensureKnowledgeDocsDir(workspacePaths);
  const importedRoot = getKnowledgeDocsImportedDir(workspacePaths);
  const sourceId = createDocumentSourceId();
  const destinationRoot = path.join(importedRoot, sourceId);
  await fs.mkdir(destinationRoot, { recursive: true });

  const basename = path.basename(sourcePath);
  const destinationPath = path.join(destinationRoot, basename);

  await fs.copyFile(sourcePath, destinationPath);

  const now = new Date().toISOString();
  return {
    sourceId,
    destinationRoot,
    createdAt: now,
    updatedAt: now,
  };
};

const extractDocumentTitle = async (absolutePath: string, fallback: string): Promise<string> => {
  try {
    const content = await fs.readFile(absolutePath, 'utf-8');
    const firstHeading = String(content || '').match(/^#\s+(.+)$/m)?.[1];
    const title = String(firstHeading || '').trim();
    return title || fallback;
  } catch {
    return fallback;
  }
};

const indexSingleDocumentSource = async (source: DocumentSourceRecord): Promise<number> => {
  const files = await listDocumentFilesForSource(source, { maxFiles: DOC_INDEX_MAX_SCAN_FILES });
  const entries: Array<{
    sourceId: string;
    absolutePath: string;
    relativePath: string;
    title?: string;
    fileSize: number;
    mtimeMs: number;
    updatedAt: number;
  }> = [];

  for (const file of files) {
    const stat = await fs.stat(file.absolutePath).catch(() => null);
    if (!stat?.isFile()) continue;
    const fallbackTitle = path.basename(file.relativePath, path.extname(file.relativePath)) || file.relativePath;
    const title = await extractDocumentTitle(file.absolutePath, fallbackTitle);
    entries.push({
      sourceId: source.id,
      absolutePath: file.absolutePath,
      relativePath: file.relativePath,
      title,
      fileSize: Number(stat.size || 0),
      mtimeMs: Number((stat as any).mtimeMs || 0),
      updatedAt: Date.now(),
    });
  }

  replaceDocumentKnowledgeIndexForSource(source.id, entries);
  return entries.length;
};

const indexDocumentSources = async (sources: DocumentSourceRecord[]): Promise<boolean> => {
  if (!sources.length) return false;
  const workspacePaths = getWorkspacePaths();
  let changed = false;
  const nowIso = new Date().toISOString();
  for (const source of sources) {
    source.indexing = true;
    source.indexError = undefined;
    source.updatedAt = new Date().toISOString();
  }
  await saveDocumentSources(workspacePaths, sources);
  win?.webContents.send('knowledge:docs-updated');

  for (const source of sources) {
    try {
      await indexSingleDocumentSource(source);
      source.indexing = false;
      source.indexError = undefined;
      source.indexedAt = nowIso;
      source.updatedAt = new Date().toISOString();
      changed = true;
    } catch (error) {
      source.indexing = false;
      source.indexError = String(error || '索引失败');
      source.updatedAt = new Date().toISOString();
      console.error('Failed to index document source:', source.id, error);
      changed = true;
    }
    await saveDocumentSources(workspacePaths, sources);
    win?.webContents.send('knowledge:docs-updated');
  }
  return changed;
};

const buildDocumentKnowledgeSourceViews = async (): Promise<{ views: DocumentKnowledgeSourceView[]; sources: DocumentSourceRecord[] }> => {
  const workspacePaths = getWorkspacePaths();
  const sources = await loadDocumentSources(workspacePaths);
  const summary = getDocumentKnowledgeIndexSummary();
  const summaryMap = new Map(summary.map((row) => [row.sourceId, row]));
  const views = sources
    .map((source) => {
      const aggregate = summaryMap.get(source.id);
      const sampleFiles = listDocumentKnowledgeIndexEntries(source.id, 5).map((item) => item.relativePath);
      return {
        id: source.id,
        kind: source.kind,
        name: source.name,
        rootPath: source.rootPath,
        locked: Boolean(source.locked),
        indexing: Boolean(source.indexing),
        indexError: source.indexError || undefined,
        fileCount: Number(aggregate?.fileCount || 0),
        sampleFiles,
        createdAt: source.createdAt,
        updatedAt: source.updatedAt,
      } satisfies DocumentKnowledgeSourceView;
    })
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return { views, sources };
};

const scheduleStaleDocumentIndexRefresh = async (sources: DocumentSourceRecord[]) => {
  if (docIndexRefreshRunning) return;
  const now = Date.now();
  const staleSources = sources.filter((source) => {
    if (source.indexing) return false;
    if (!source.indexedAt) return true;
    const indexedMs = new Date(source.indexedAt).getTime();
    return !Number.isFinite(indexedMs) || now - indexedMs >= DOC_INDEX_REFRESH_INTERVAL_MS;
  });
  if (!staleSources.length) return;

  docIndexRefreshRunning = true;
  try {
    const changed = await indexDocumentSources(staleSources);
    if (changed) {
      win?.webContents.send('knowledge:docs-updated');
    }
  } catch (error) {
    console.error('Failed to refresh stale document index:', error);
  } finally {
    docIndexRefreshRunning = false;
  }
};

const listKnowledgeCatalogNotes = async () => {
  await ensureKnowledgeRedbookDir();
  const dirs = await fs.readdir(getKnowledgeRedbookDir(), { withFileTypes: true }).catch(() => []);
  const notes: Array<Record<string, any>> = [];

  for (const dir of dirs) {
    if (!dir.isDirectory()) continue;
    const noteDir = path.join(getKnowledgeRedbookDir(), dir.name);
    const metaPath = path.join(noteDir, 'meta.json');
    try {
      const metaContent = await fs.readFile(metaPath, 'utf-8');
      const meta = JSON.parse(metaContent) as Record<string, any>;
      let cover = String(meta.cover || '').trim();
      if (cover && !cover.startsWith('http')) {
        cover = toLocalFileUrl(path.join(noteDir, cover));
      }
      const tags = Array.isArray(meta.tags) ? meta.tags.map((value: unknown) => String(value || '').trim()).filter(Boolean) : [];
      notes.push({
        id: dir.name,
        title: String(meta.title || dir.name),
        author: String(meta.author || meta.siteName || '原文链接'),
        content: String(meta.content || ''),
        excerpt: String(meta.excerpt || meta.summary || meta.content || ''),
        siteName: String(meta.siteName || ''),
        sourceUrl: String(meta.sourceUrl || meta.url || ''),
        folderPath: noteDir,
        coverUrl: cover || undefined,
        createdAt: String(meta.createdAt || meta.updatedAt || new Date().toISOString()),
        updatedAt: String(meta.updatedAt || meta.createdAt || new Date().toISOString()),
        noteType: String(meta.type || ''),
        captureKind: String(meta.captureKind || ''),
        hasVideo: Boolean(meta.video),
        hasTranscript: Boolean(String(meta.transcript || '').trim()),
        status: String(meta.transcriptionStatus || ''),
        tags,
      });
    } catch {
      continue;
    }
  }

  return notes;
};

const listKnowledgeCatalogYoutubeVideos = async () => {
  await ensureKnowledgeYoutubeDir();
  const dirs = await fs.readdir(getKnowledgeYoutubeDir(), { withFileTypes: true }).catch(() => []);
  const videos: Array<Record<string, any>> = [];

  for (const dir of dirs) {
    if (!dir.isDirectory()) continue;
    const videoDir = path.join(getKnowledgeYoutubeDir(), dir.name);
    const metaPath = path.join(videoDir, 'meta.json');
    try {
      const metaContent = await fs.readFile(metaPath, 'utf-8');
      const meta = JSON.parse(metaContent) as Record<string, any>;
      let thumbnailUrl = String(meta.thumbnailUrl || '').trim();
      if (meta.thumbnail) {
        thumbnailUrl = toLocalFileUrl(path.join(videoDir, String(meta.thumbnail)));
      }
      let subtitleContent = '';
      if (meta.subtitleFile) {
        subtitleContent = await fs.readFile(path.join(videoDir, String(meta.subtitleFile)), 'utf-8').catch(() => '');
      }
      videos.push({
        id: dir.name,
        title: String(meta.title || dir.name),
        description: String(meta.description || ''),
        summary: String(meta.summary || subtitleContent || meta.description || ''),
        thumbnailUrl: thumbnailUrl || undefined,
        sourceUrl: String(meta.videoUrl || ''),
        folderPath: videoDir,
        createdAt: String(meta.createdAt || meta.updatedAt || new Date().toISOString()),
        updatedAt: String(meta.updatedAt || meta.createdAt || new Date().toISOString()),
        hasSubtitle: Boolean(meta.hasSubtitle),
        subtitleContent,
        status: String(meta.status || ''),
        tags: [],
      });
    } catch {
      continue;
    }
  }

  return videos;
};

const buildKnowledgeCatalogItems = async () => {
  const [notes, videos, { views, sources }] = await Promise.all([
    listKnowledgeCatalogNotes(),
    listKnowledgeCatalogYoutubeVideos(),
    buildDocumentKnowledgeSourceViews(),
  ]);

  const items = [
    ...notes.map((note) => ({
      itemId: note.id,
      kind: 'redbook-note' as const,
      noteType: note.noteType,
      captureKind: note.captureKind,
      title: note.title,
      author: note.author,
      siteName: note.siteName || undefined,
      sourceUrl: note.sourceUrl || undefined,
      folderPath: note.folderPath,
      coverUrl: note.coverUrl,
      thumbnailUrl: undefined,
      previewText: note.excerpt || note.content || '',
      createdAt: note.createdAt,
      updatedAt: note.updatedAt,
      hasVideo: note.hasVideo,
      hasTranscript: note.hasTranscript,
      tags: note.tags,
      status: note.status || undefined,
      sampleFiles: [],
      fileCount: 0,
    })),
    ...videos.map((video) => ({
      itemId: video.id,
      kind: 'youtube-video' as const,
      title: video.title,
      author: 'YouTube',
      siteName: 'YouTube',
      sourceUrl: video.sourceUrl || undefined,
      folderPath: video.folderPath,
      coverUrl: undefined,
      thumbnailUrl: video.thumbnailUrl,
      previewText: video.summary || video.description || '',
      createdAt: video.createdAt,
      updatedAt: video.updatedAt,
      hasVideo: true,
      hasTranscript: Boolean(video.subtitleContent),
      tags: video.tags,
      status: video.status || undefined,
      sampleFiles: [],
      fileCount: 0,
    })),
    ...views.map((source) => ({
      itemId: source.id,
      kind: 'document-source' as const,
      title: source.name,
      author: source.kind === 'obsidian-vault' ? 'Obsidian' : 'Docs',
      siteName: 'Documents',
      sourceUrl: undefined,
      folderPath: undefined,
      rootPath: source.rootPath,
      coverUrl: undefined,
      thumbnailUrl: undefined,
      previewText: source.sampleFiles.join('\n'),
      createdAt: source.createdAt,
      updatedAt: source.updatedAt,
      hasVideo: false,
      hasTranscript: false,
      tags: [],
      status: source.indexing ? 'processing' : source.indexError ? 'failed' : 'completed',
      sampleFiles: source.sampleFiles,
      fileCount: source.fileCount,
    })),
  ];

  return {
    items: items.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)),
    sources,
  };
};

ipcMain.handle('knowledge:docs:list', async () => {
  try {
    const { views, sources } = await buildDocumentKnowledgeSourceViews();
    void scheduleStaleDocumentIndexRefresh(sources);
    return views;
  } catch (error) {
    console.error('Failed to list document knowledge sources:', error);
    return [];
  }
});

ipcMain.handle('knowledge:docs:add-files', async () => {
  try {
    const picker = await dialog.showOpenDialog({
      title: '选择要添加到知识库的文件',
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: 'Text/Markdown', extensions: ['md', 'markdown', 'mdx', 'txt', 'text'] },
        { name: 'All Files', extensions: ['*'] },
      ],
    });
    if (picker.canceled || !picker.filePaths.length) {
      return { success: true, added: 0, canceled: true };
    }

    const workspacePaths = getWorkspacePaths();
    const sources = await loadDocumentSources(workspacePaths);
    let added = 0;
    const now = new Date().toISOString();

    for (const filePath of picker.filePaths) {
      const normalizedPath = path.resolve(path.normalize(filePath));
      const stat = await fs.stat(normalizedPath).catch(() => null);
      if (!stat?.isFile()) continue;
      const copied = await copyIntoImportedKnowledgeDir(normalizedPath);
      const source: DocumentSourceRecord = {
        id: copied.sourceId,
        kind: 'copied-file',
        name: path.basename(normalizedPath),
        rootPath: copied.destinationRoot,
        locked: false,
        indexing: false,
        createdAt: copied.createdAt,
        updatedAt: now,
        indexedAt: undefined,
      };
      sources.push(source);
      await indexSingleDocumentSource(source);
      source.indexedAt = new Date().toISOString();
      added += 1;
    }

    await saveDocumentSources(workspacePaths, sources);
    const { views } = await buildDocumentKnowledgeSourceViews();
    win?.webContents.send('knowledge:docs-updated');
    return { success: true, added, sources: views };
  } catch (error) {
    console.error('Failed to add document files:', error);
    return { success: false, error: String(error) };
  }
});

ipcMain.handle('knowledge:docs:add-folder', async () => {
  try {
    const picker = await dialog.showOpenDialog({
      title: '选择要添加到知识库的文件夹',
      properties: ['openDirectory', 'multiSelections'],
    });
    if (picker.canceled || !picker.filePaths.length) {
      return { success: true, added: 0, canceled: true };
    }

    const workspacePaths = getWorkspacePaths();
    const sources = await loadDocumentSources(workspacePaths);
    let added = 0;
    const now = new Date().toISOString();

    for (const folderPath of picker.filePaths) {
      const normalizedPath = path.resolve(path.normalize(folderPath));
      const stat = await fs.stat(normalizedPath).catch(() => null);
      if (!stat?.isDirectory()) continue;
      const existing = sources.find((item) =>
        item.kind === 'tracked-folder' &&
        path.resolve(path.normalize(item.rootPath)) === normalizedPath
      );
      if (existing) {
        existing.updatedAt = now;
        existing.locked = true;
        existing.indexing = true;
        existing.indexError = undefined;
        existing.indexedAt = undefined;
      } else {
        sources.push({
          id: createDocumentSourceId(),
          kind: 'tracked-folder',
          name: path.basename(normalizedPath) || '文件夹',
          rootPath: normalizedPath,
          locked: true,
          indexing: true,
          createdAt: now,
          updatedAt: now,
          indexedAt: undefined,
        });
        added += 1;
      }
    }

    const changedFolders = picker.filePaths
      .map((folderPath) => path.resolve(path.normalize(folderPath)))
      .map((folderPath) => sources.find((item) => item.kind === 'tracked-folder' && path.resolve(path.normalize(item.rootPath)) === folderPath))
      .filter((item): item is DocumentSourceRecord => Boolean(item));

    await saveDocumentSources(workspacePaths, sources);
    const { views } = await buildDocumentKnowledgeSourceViews();
    win?.webContents.send('knowledge:docs-updated');
    void indexDocumentSources(changedFolders);
    return { success: true, added, sources: views };
  } catch (error) {
    console.error('Failed to add document folders:', error);
    return { success: false, error: String(error) };
  }
});

ipcMain.handle('knowledge:docs:add-obsidian-vault', async () => {
  try {
    const picker = await dialog.showOpenDialog({
      title: '选择 Obsidian 仓库目录',
      properties: ['openDirectory'],
    });
    if (picker.canceled || !picker.filePaths.length) {
      return { success: true, added: 0, canceled: true };
    }

    const vaultPath = path.resolve(path.normalize(picker.filePaths[0]));
    const stat = await fs.stat(vaultPath).catch(() => null);
    if (!stat?.isDirectory()) {
      return { success: false, error: '无效目录' };
    }

    const workspacePaths = getWorkspacePaths();
    const sources = await loadDocumentSources(workspacePaths);
    const now = new Date().toISOString();
    const already = sources.find((item) =>
      item.kind === 'obsidian-vault' &&
      path.resolve(path.normalize(item.rootPath)) === vaultPath
    );
    if (already) {
      already.updatedAt = now;
      already.indexing = true;
      already.indexError = undefined;
      already.indexedAt = undefined;
    } else {
      sources.push({
        id: createDocumentSourceId(),
        kind: 'obsidian-vault',
        name: path.basename(vaultPath) || 'Obsidian Vault',
        rootPath: vaultPath,
        locked: true,
        indexing: true,
        createdAt: now,
        updatedAt: now,
        indexedAt: undefined,
      });
    }

    await saveDocumentSources(workspacePaths, sources);
    const { views } = await buildDocumentKnowledgeSourceViews();
    win?.webContents.send('knowledge:docs-updated');
    const indexTargets = already ? [already] : [sources[sources.length - 1]];
    void indexDocumentSources(indexTargets);
    return { success: true, added: already ? 0 : 1, sources: views };
  } catch (error) {
    console.error('Failed to add Obsidian vault:', error);
    return { success: false, error: String(error) };
  }
});

ipcMain.handle('knowledge:docs:delete-source', async (_, sourceId: string) => {
  try {
    const workspacePaths = getWorkspacePaths();
    const sources = await loadDocumentSources(workspacePaths);
    const target = sources.find((item) => item.id === sourceId);
    if (!target) {
      return { success: false, error: '文档源不存在' };
    }

    const nextSources = sources.filter((item) => item.id !== sourceId);
    await saveDocumentSources(workspacePaths, nextSources);
    replaceDocumentKnowledgeIndexForSource(sourceId, []);

    const importedRoot = path.resolve(path.normalize(getKnowledgeDocsImportedDir(workspacePaths)));
    const targetRoot = path.resolve(path.normalize(target.rootPath));
    if (
      target.kind === 'copied-file' &&
      (targetRoot === importedRoot || targetRoot.startsWith(`${importedRoot}${path.sep}`))
    ) {
      await fs.rm(targetRoot, { recursive: true, force: true }).catch(() => undefined);
    }

    win?.webContents.send('knowledge:docs-updated');
    return { success: true };
  } catch (error) {
    console.error('Failed to delete document source:', error);
    return { success: false, error: String(error) };
  }
});

ipcMain.handle('knowledge:get-index-status', async () => {
  try {
    const { items } = await buildKnowledgeCatalogItems();
    const failedCount = items.filter((item) => item.status === 'failed').length;
    const pendingCount = items.filter((item) => item.status === 'processing').length;
    return {
      indexedCount: Math.max(0, items.length - failedCount - pendingCount),
      pendingCount,
      failedCount,
      lastIndexedAt: items[0]?.updatedAt || null,
      isBuilding: pendingCount > 0,
      lastError: null,
    };
  } catch (error) {
    return {
      indexedCount: 0,
      pendingCount: 0,
      failedCount: 0,
      lastIndexedAt: null,
      isBuilding: false,
      lastError: error instanceof Error ? error.message : String(error),
    };
  }
});

ipcMain.handle('knowledge:list-page', async (_, payload?: {
  payload?: {
    cursor?: string | null;
    limit?: number;
    kind?: 'redbook-note' | 'youtube-video' | 'document-source';
    query?: string;
    sort?: string;
  };
}) => {
  const query = String(payload?.payload?.query || '').trim().toLowerCase();
  const kind = String(payload?.payload?.kind || '').trim();
  const limit = Math.max(1, Math.min(Number(payload?.payload?.limit || 200) || 200, 500));
  const cursor = Math.max(0, Number(payload?.payload?.cursor || 0) || 0);

  const { items } = await buildKnowledgeCatalogItems();
  const filtered = items.filter((item) => {
    if (kind && item.kind !== kind) return false;
    if (!query) return true;
    const haystack = [
      item.title,
      item.author,
      item.siteName,
      item.previewText,
      item.sourceUrl,
      ...(Array.isArray(item.tags) ? item.tags : []),
      ...(Array.isArray(item.sampleFiles) ? item.sampleFiles : []),
    ].join('\n').toLowerCase();
    return haystack.includes(query);
  });

  const pageItems = filtered.slice(cursor, cursor + limit);
  const nextCursor = cursor + limit < filtered.length ? String(cursor + limit) : null;
  const kindCounts = filtered.reduce<Record<string, number>>((acc, item) => {
    acc[item.kind] = (acc[item.kind] || 0) + 1;
    return acc;
  }, {});

  return {
    items: pageItems,
    nextCursor,
    total: filtered.length,
    kindCounts,
  };
});

ipcMain.handle('knowledge:get-item-detail', async (_, payload?: {
  payload?: {
    itemId?: string;
    kind?: 'redbook-note' | 'youtube-video' | 'document-source';
  };
}) => {
  const itemId = String(payload?.payload?.itemId || '').trim();
  const kind = String(payload?.payload?.kind || '').trim();
  if (!itemId || !kind) {
    return null;
  }

  if (kind === 'redbook-note') {
    const notes = await (async () => {
      const list = await listKnowledgeCatalogNotes();
      return list.map((item) => ({
        id: item.id,
        title: item.title,
        author: item.author,
        content: item.content,
        excerpt: item.excerpt,
        siteName: item.siteName,
        sourceUrl: item.sourceUrl,
        images: [],
        tags: item.tags,
        cover: item.coverUrl,
        video: undefined,
        videoUrl: undefined,
        transcript: item.hasTranscript ? '' : undefined,
        transcriptionStatus: item.status || undefined,
        stats: { likes: 0, collects: 0 },
        createdAt: item.createdAt,
        folderPath: item.folderPath,
      }));
    })();
    return notes.find((item) => item.id === itemId) || null;
  }

  if (kind === 'youtube-video') {
    const videos = await listKnowledgeCatalogYoutubeVideos();
    const video = videos.find((item) => item.id === itemId);
    if (!video) return null;
    return {
      id: video.id,
      videoId: video.id,
      videoUrl: video.sourceUrl || '',
      title: video.title,
      description: video.description,
      summary: video.summary,
      thumbnailUrl: video.thumbnailUrl,
      hasSubtitle: video.hasSubtitle,
      subtitleContent: video.subtitleContent,
      status: video.status || undefined,
      createdAt: video.createdAt,
      folderPath: video.folderPath,
    };
  }

  if (kind === 'document-source') {
    const { views } = await buildDocumentKnowledgeSourceViews();
    return views.find((item) => item.id === itemId) || null;
  }

  return null;
});

ipcMain.handle('knowledge:rebuild-catalog', async () => {
  return { success: true };
});

ipcMain.handle('knowledge:open-index-root', async () => {
  try {
    const docsRoot = ensureKnowledgeDocsDir(getWorkspacePaths()).then(() => getKnowledgeDocsImportedDir(getWorkspacePaths()));
    const targetPath = await docsRoot;
    const openError = await shell.openPath(targetPath);
    if (openError) {
      return { success: false, error: openError };
    }
    return { success: true, path: targetPath };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
});

ipcMain.handle('knowledge:list', async () => {
  const fs = require('fs/promises');
  await ensureKnowledgeRedbookDir();

  try {
    const dirs = await fs.readdir(getKnowledgeRedbookDir(), { withFileTypes: true });
    const notes = [];

    for (const dir of dirs) {
      if (!dir.isDirectory()) continue;
      const metaPath = path.join(getKnowledgeRedbookDir(), dir.name, 'meta.json');
      try {
        const metaContent = await fs.readFile(metaPath, 'utf-8');
        const meta = JSON.parse(metaContent);
        const noteDir = path.join(getKnowledgeRedbookDir(), dir.name);

        // Extract tags from meta.tags or content hashtags
        let tags: string[] = [];
        if (Array.isArray(meta.tags)) {
          tags = meta.tags;
        }
        // Also parse hashtags from content if present
        if (meta.content) {
          const hashtags = meta.content.match(/#[^\s#]+/g);
          if (hashtags) {
            // Remove the # prefix and merge
            const cleanTags = hashtags.map((t: string) => t.slice(1));
            tags = [...new Set([...tags, ...cleanTags])];
          }
        }

        const images = Array.isArray(meta.images)
          ? meta.images.map((img: string) => {
              if (typeof img !== 'string') return img;
              if (img.startsWith('http')) return img;
              const absolutePath = path.join(noteDir, img);
              return toLocalFileUrl(absolutePath);
            })
          : [];

        let cover = meta.cover;
        if (cover && typeof cover === 'string' && !cover.startsWith('http')) {
          const absolutePath = path.join(noteDir, cover);
          cover = toLocalFileUrl(absolutePath);
        }

        // Process video path
        let video = meta.video;
        if (video && typeof video === 'string' && !video.startsWith('http')) {
          const absolutePath = path.join(noteDir, video);
          video = toLocalFileUrl(absolutePath);
        }

        let htmlFileUrl = meta.htmlFile;
        if (htmlFileUrl && typeof htmlFileUrl === 'string' && !htmlFileUrl.startsWith('http')) {
          try {
            await ensureRichHtmlUsesAbsoluteAssetUrls(noteDir, htmlFileUrl);
          } catch (error) {
            console.error('Failed to normalize rich html asset URLs:', error);
          }
          const absolutePath = path.join(noteDir, htmlFileUrl);
          htmlFileUrl = toLocalFileUrl(absolutePath);
        }

        notes.push({ id: dir.name, ...meta, images, cover, video, htmlFileUrl, transcript: meta.transcript || '', tags, folderPath: noteDir });
      } catch {
        // Skip notes without valid meta
      }
    }

    return notes.sort((a: { createdAt?: string }, b: { createdAt?: string }) =>
      (b.createdAt || '').localeCompare(a.createdAt || '')
    );
  } catch (error) {
    console.error('Failed to list notes:', error);
    return [];
  }
})

ipcMain.handle('knowledge:delete', async (_, noteId: string) => {
  const fs = require('fs/promises');
  const notePath = path.join(getKnowledgeRedbookDir(), noteId);

  try {
    await fs.rm(notePath, { recursive: true, force: true });
    return { success: true };
  } catch (error) {
    console.error('Failed to delete note:', error);
    return { success: false };
  }
})

ipcMain.handle('knowledge:transcribe', async (_event, noteId: string) => {
  const fs = require('fs/promises');
  const noteDir = path.join(getKnowledgeRedbookDir(), noteId);
  const metaPath = path.join(noteDir, 'meta.json');
  try {
    const metaContent = await fs.readFile(metaPath, 'utf-8');
    const meta = JSON.parse(metaContent) as { video?: string; transcript?: string; transcriptFile?: string; transcriptionStatus?: 'processing' | 'completed' | 'failed' };
    if (!meta.video) {
      return { success: false, error: 'No video found' };
    }
    if (meta.transcript && meta.transcript.trim()) {
      return { success: true, transcript: meta.transcript };
    }
    meta.transcriptionStatus = 'processing';
    await fs.writeFile(metaPath, JSON.stringify(meta, null, 2));
    win?.webContents.send('knowledge:note-updated', { noteId, hasTranscript: false, transcriptionStatus: 'processing' });
    const videoPath = path.join(noteDir, meta.video);
    const transcriptResult = await transcribeVideoToText(videoPath);
    const transcript = transcriptResult.text;
    if (!transcript) {
      meta.transcriptionStatus = 'failed';
      await fs.writeFile(metaPath, JSON.stringify(meta, null, 2));
      win?.webContents.send('knowledge:note-updated', { noteId, hasTranscript: false, transcriptionStatus: 'failed' });
      return { success: false, error: transcriptResult.error || 'Transcription failed' };
    }
    meta.transcript = transcript;
    meta.transcriptFile = 'transcript.txt';
    meta.transcriptionStatus = 'completed';
    await fs.writeFile(path.join(noteDir, meta.transcriptFile), transcript);
    await fs.writeFile(metaPath, JSON.stringify(meta, null, 2));

    // Index the transcript
    indexManager.addToQueue(normalizeVideo(
      noteId,
      meta,
      transcript,
      'user'
    ));

    win?.webContents.send('knowledge:note-updated', { noteId, hasTranscript: true, transcriptionStatus: 'completed' });
    return { success: true, transcript };
  } catch (error) {
    console.error('Failed to transcribe note video:', error);
    return { success: false, error: String(error) };
  }
});

// --------- YouTube Knowledge Base ---------
ipcMain.handle('knowledge:list-youtube', async () => {
  const fs = require('fs/promises');
  await ensureKnowledgeYoutubeDir();

  try {
    const dirs = await fs.readdir(getKnowledgeYoutubeDir(), { withFileTypes: true });
    const videos = [];

    for (const dir of dirs) {
      if (!dir.isDirectory()) continue;
      const metaPath = path.join(getKnowledgeYoutubeDir(), dir.name, 'meta.json');
      try {
        const metaContent = await fs.readFile(metaPath, 'utf-8');
        const meta = JSON.parse(metaContent);
        const videoDir = path.join(getKnowledgeYoutubeDir(), dir.name);

        // Convert local thumbnail path to local-file protocol
        let thumbnailUrl = meta.thumbnailUrl;
        if (meta.thumbnail) {
          const absolutePath = path.join(videoDir, meta.thumbnail);
          thumbnailUrl = toLocalFileUrl(absolutePath);
        }

        // Read subtitle content if available
        let subtitleContent = '';
        if (meta.subtitleFile) {
          try {
            subtitleContent = await fs.readFile(path.join(videoDir, meta.subtitleFile), 'utf-8');
          } catch { /* no subtitle */ }
        }

        videos.push({
          id: dir.name,
          ...meta,
          thumbnailUrl,
          subtitleContent,
          folderPath: videoDir,
        });
      } catch {
        // Skip videos without valid meta
      }
    }

    return videos.sort((a: { createdAt?: string }, b: { createdAt?: string }) =>
      (b.createdAt || '').localeCompare(a.createdAt || '')
    );
  } catch (error) {
    console.error('Failed to list YouTube videos:', error);
    return [];
  }
})

ipcMain.handle('knowledge:delete-youtube', async (_, videoId: string) => {
  const fs = require('fs/promises');
  const videoPath = path.join(getKnowledgeYoutubeDir(), videoId);

  try {
    await fs.rm(videoPath, { recursive: true, force: true });
    return { success: true };
  } catch (error) {
    console.error('Failed to delete YouTube video:', error);
    return { success: false };
  }
})

ipcMain.handle('knowledge:read-youtube-subtitle', async (_, videoId: string) => {
  const fs = require('fs/promises');
  const videoDir = path.join(getKnowledgeYoutubeDir(), videoId);
  const metaPath = path.join(videoDir, 'meta.json');

  try {
    const metaContent = await fs.readFile(metaPath, 'utf-8');
    const meta = JSON.parse(metaContent);

    if (!meta.subtitleFile) {
      return { success: true, subtitleContent: '', hasSubtitle: false };
    }

    const subtitleContent = await fs.readFile(path.join(videoDir, meta.subtitleFile), 'utf-8');
    return {
      success: true,
      subtitleContent,
      hasSubtitle: !!meta.hasSubtitle
    };
  } catch (error) {
    console.error('Failed to read YouTube subtitle:', error);
    return { success: false, error: String(error) };
  }
});

// 重新获取字幕
ipcMain.handle('knowledge:retry-youtube-subtitle', async (_, videoId: string) => {
  const fs = require('fs/promises');
  const videoDir = path.join(getKnowledgeYoutubeDir(), videoId);
  const metaPath = path.join(videoDir, 'meta.json');

  try {
    // 读取现有 meta
    const metaContent = await fs.readFile(metaPath, 'utf-8');
    const meta = JSON.parse(metaContent);

    // 更新状态为处理中
    meta.status = 'processing';
    await fs.writeFile(metaPath, JSON.stringify(meta, null, 2));

    // 通知前端状态变化
    win?.webContents.send('knowledge:youtube-video-updated', {
      noteId: videoId,
      status: 'processing'
    });

    // 后台重新下载字幕
    (async () => {
      console.log(`[YouTube] Retrying subtitle download for ${meta.videoId}...`);

      try {
        const { queueSubtitleDownload } = await import('./core/subtitleQueue');
        const subtitleResult = await queueSubtitleDownload(meta.videoId, videoDir);

        if (subtitleResult.success && subtitleResult.subtitleFile) {
          meta.subtitleFile = subtitleResult.subtitleFile;
          meta.hasSubtitle = true;
          meta.status = 'completed';
          meta.originalTitle = String(meta.originalTitle || meta.title || '').trim() || String(meta.title || '').trim();
          meta.summary = String(meta.summary || '');
          try {
            const subtitleContent = await fs.readFile(path.join(videoDir, meta.subtitleFile), 'utf-8');
            const summaryResult = await summarizeYoutubeVideoFromSubtitle({
              originalTitle: String(meta.originalTitle || meta.title || ''),
              description: String(meta.description || ''),
              subtitleContent,
              videoUrl: String(meta.videoUrl || ''),
            });
            meta.title = summaryResult.title;
            meta.summary = summaryResult.summary;
          } catch (summaryError) {
            console.warn(`[YouTube] Subtitle summary retry failed for ${meta.videoId}:`, summaryError);
          }
          console.log(`[YouTube] Subtitle retry succeeded for ${meta.videoId}: ${subtitleResult.subtitleFile}`);
        } else {
          meta.hasSubtitle = false;
          meta.status = 'completed';
          meta.subtitleError = subtitleResult.error || 'No subtitles available';
          console.log(`[YouTube] Subtitle retry failed for ${meta.videoId}: ${subtitleResult.error}`);
        }

        await fs.writeFile(metaPath, JSON.stringify(meta, null, 2));

        // 通知前端
        win?.webContents.send('knowledge:youtube-video-updated', {
          noteId: videoId,
          status: 'completed',
          hasSubtitle: meta.hasSubtitle,
          title: String(meta.title || ''),
          summary: String(meta.summary || ''),
        });
      } catch (err) {
        console.error(`[YouTube] Subtitle retry error for ${meta.videoId}:`, err);
        meta.status = 'completed';
        meta.subtitleError = String(err);
        await fs.writeFile(metaPath, JSON.stringify(meta, null, 2));

        win?.webContents.send('knowledge:youtube-video-updated', {
          noteId: videoId,
          status: 'completed',
          hasSubtitle: false
        });
      }
    })();

    return { success: true };
  } catch (error) {
    console.error('Failed to retry subtitle:', error);
    return { success: false, error: String(error) };
  }
})

ipcMain.handle('knowledge:youtube-regenerate-summaries', async (_event, payload?: { videoIds?: string[] }) => {
  try {
    await ensureKnowledgeYoutubeDir();
    const targetIds = Array.isArray(payload?.videoIds) && payload?.videoIds.length > 0
      ? payload.videoIds.map((value) => String(value || '').trim()).filter(Boolean)
      : (await fs.readdir(getKnowledgeYoutubeDir(), { withFileTypes: true }))
          .filter((entry) => entry.isDirectory())
          .map((entry) => entry.name);

    let updated = 0;
    let skipped = 0;
    const errors: Array<{ videoId: string; error: string }> = [];

    for (const videoId of targetIds) {
      const result = await regenerateYoutubeSummaryForVideo(videoId);
      if (result.success) {
        if (result.skipped) {
          skipped += 1;
        } else {
          updated += 1;
        }
      } else {
        errors.push({ videoId, error: String(result.error || 'unknown error') });
      }
    }

    return {
      success: errors.length === 0,
      updated,
      skipped,
      failed: errors.length,
      errors,
    };
  } catch (error) {
    return {
      success: false,
      updated: 0,
      skipped: 0,
      failed: 1,
      errors: [{ videoId: '', error: String(error) }],
    };
  }
})

// --------- Wander (Random Brainstorm) ---------
ipcMain.handle('wander:get-random', async () => {
  try {
    const items = await getAllKnowledgeItems();
    if (items.length < 3) {
      return items; // Return all if less than 3
    }

    // Fisher-Yates shuffle
    for (let i = items.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [items[i], items[j]] = [items[j], items[i]];
    }

    return items.slice(0, 3);
  } catch (error) {
    console.error('Failed to get random wander items:', error);
    return [];
  }
});

const buildWanderItemsText = (items: any[]) => items.map((item, index) =>
  `Item ${index + 1}:
Title: ${item.title}
Type: ${item.type}
Content Summary: ${item.content?.slice(0, 500) || ''}...`
).join('\n\n');

const readTextFileSnippet = async (filePath: string, maxChars = 1800): Promise<string> => {
  try {
    const raw = await fs.readFile(filePath, 'utf-8');
    return String(raw || '').trim().slice(0, maxChars);
  } catch {
    return '';
  }
};

const toTwoLinePreview = (raw: string): string => {
  const normalized = String(raw || '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .trim();
  if (!normalized) return '';
  const lines = normalized
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  if (!lines.length) return '';
  const picked = lines.slice(0, 2).map((line) => line.length > 120 ? `${line.slice(0, 120)}…` : line);
  const hasMore = lines.length > 2 || picked.some((line) => line.endsWith('…'));
  const joined = picked.join('\n');
  return hasMore && !joined.endsWith('…') ? `${joined}…` : joined;
};

const extractSseDeltaText = (payload: any): string => {
  const delta = payload?.choices?.[0]?.delta;
  if (!delta) return '';
  const content = delta.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part && typeof part === 'object') {
          if (typeof part.text === 'string') return part.text;
          if (typeof part.content === 'string') return part.content;
        }
        return '';
      })
      .join('');
  }
  return '';
};

const buildWanderLongTermContext = async (): Promise<string> => {
  const workspacePaths = getWorkspacePaths();
  const profileRoot = path.join(workspacePaths.redclaw, 'profile');
  const memoryPath = path.join(workspacePaths.base, 'memory', 'MEMORY.md');
  const userProfilePath = path.join(profileRoot, 'user.md');
  const creatorProfilePath = path.join(profileRoot, 'CreatorProfile.md');
  const soulPath = path.join(profileRoot, 'Soul.md');

  const [
    memorySnippet,
    userProfileSnippet,
    creatorProfileSnippet,
    soulSnippet,
  ] = await Promise.all([
    readTextFileSnippet(memoryPath, 2200),
    readTextFileSnippet(userProfilePath, 1800),
    readTextFileSnippet(creatorProfilePath, 2200),
    readTextFileSnippet(soulPath, 1200),
  ]);

  const sections: string[] = [];
  if (userProfileSnippet) {
    sections.push(`### user.md\n${userProfileSnippet}`);
  }
  if (creatorProfileSnippet) {
    sections.push(`### CreatorProfile.md\n${creatorProfileSnippet}`);
  }
  if (memorySnippet) {
    sections.push(`### MEMORY.md\n${memorySnippet}`);
  }
  if (soulSnippet) {
    sections.push(`### Soul.md\n${soulSnippet}`);
  }
  return sections.join('\n\n');
};

const buildWanderDeepAgentPrompt = (params: {
  itemsText: string;
  longTermContextSection: string;
  multiChoice: boolean;
}): string => {
  const outputRequirement = params.multiChoice
    ? [
      '硬性输出要求（多选题模式）：',
      '1) 仅输出 JSON，不要输出 Markdown、解释、前后缀文本；',
      '2) JSON 顶层必须包含：thinking_process, options；',
      '3) options 必须是长度为 3 的数组；',
      '4) 每个 option 必须包含：content_direction, topic；',
      '5) topic 必须包含：title, connections（数组，取值只能是 1-3）；',
      '6) thinking_process 为 3-6 条简洁思考要点。',
    ].join('\n')
    : [
      '硬性输出要求（单选题模式）：',
      '1) 仅输出 JSON，不要输出 Markdown、解释、前后缀文本；',
      '2) JSON 顶层必须包含：content_direction, thinking_process, topic；',
      '3) topic 必须包含：title, connections（数组，取值只能是 1-3）；',
      '4) thinking_process 为 3-6 条简洁思考要点；',
      '5) content_direction 必须是可直接创作的内容方向说明。',
    ].join('\n');

  return [
    '你现在处于 RedBox 的「漫步深度思考」Agent 模式。',
    '你需要自主完成：分析素材 -> 发散选题 -> 收敛方向 -> 产出最终结构化结果。',
    '你必须先调用工具补充上下文，再给结论。',
    '',
    '工具调用要求（必须满足）：',
    '1) 至少发起 1 次工具调用；',
    '2) 优先使用 app_cli 读取素材目录或相关文档；',
    '3) 如果 app_cli 不可用，可回退 bash（cat/rg/find 等）；',
    '4) 未发生工具调用时，不允许直接输出最终结论。',
    '',
    outputRequirement,
    '',
    '你收到的随机素材如下：',
    params.itemsText,
    '',
    params.longTermContextSection ? `补充上下文：\n${params.longTermContextSection}` : '',
  ].join('\n');
};

const runWanderDeepThinkWithAgent = async (params: {
  requestId: string;
  items: any[];
  longTermContextSection: string;
  multiChoice: boolean;
  reportProgress: (status: string) => void;
}): Promise<string> => {
  const safeRequestId = params.requestId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64) || `${Date.now()}`;
  const sessionId = `session_wander_${safeRequestId}`;
  const contextId = `wander:${safeRequestId}`;
  const itemsText = buildWanderItemsText(params.items);
  const prompt = buildWanderDeepAgentPrompt({
    itemsText,
    longTermContextSection: params.longTermContextSection,
    multiChoice: params.multiChoice,
  });

  const existingSession = getChatSession(sessionId);
  const metadata = {
    contextId,
    contextType: 'redclaw',
    contextContent: itemsText,
    isContextBound: true,
  };
  if (!existingSession) {
    createChatSession(sessionId, 'Wander Deep Think', metadata);
  } else {
    updateChatSessionMetadata(sessionId, {
      ...(existingSession.metadata ? (() => {
        try {
          return JSON.parse(existingSession.metadata);
        } catch {
          return {};
        }
      })() : {}),
      ...metadata,
    });
  }

  const PiChatService = await getPiChatServiceCtor();
  const service = new PiChatService();
  let responseBuffer = '';
  let lastPreview = '';
  let lastToolName = '';
  let upstreamError = '';
  let sawAnyToolCall = false;
  let toolCallCount = 0;
  const startedAt = Date.now();
  params.reportProgress(params.multiChoice ? '多选题 Agent 已启动...' : '漫步 Agent 已启动...');

  addChatMessage({
    id: `msg_wander_user_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    session_id: sessionId,
    role: 'user',
    content: prompt,
  });

  const emitPreview = (raw: string) => {
    const preview = toTwoLinePreview(raw);
    if (!preview) return;
    if (preview === lastPreview) return;
    lastPreview = preview;
    params.reportProgress(preview);
  };

  service.setEventSink((channel, payload) => {
    if (channel === 'chat:thought-delta') {
      const text = String((payload as { content?: unknown } | null)?.content || '').trim();
      if (text) {
        emitPreview(text);
      }
      return;
    }
    if (channel === 'chat:tool-start') {
      const toolName = String((payload as { name?: unknown } | null)?.name || '').trim();
      sawAnyToolCall = true;
      toolCallCount += 1;
      lastToolName = toolName;
      if (toolName) {
        params.reportProgress(`调用工具：${toolName}`);
      }
      return;
    }
    if (channel === 'chat:tool-update') {
      const partial = String((payload as { partial?: unknown } | null)?.partial || '').trim();
      if (partial) {
        emitPreview(partial);
      }
      return;
    }
    if (channel === 'chat:tool-end') {
      if (lastToolName) {
        params.reportProgress(`工具完成：${lastToolName}`);
      }
      return;
    }
    if (channel === 'chat:response-chunk') {
      const chunk = String((payload as { content?: unknown } | null)?.content || '');
      if (!chunk) return;
      responseBuffer += chunk;
      emitPreview(responseBuffer);
      return;
    }
    if (channel === 'chat:error') {
      const data = payload as { message?: unknown; hint?: unknown; raw?: unknown } | null;
      const message = String(data?.message || '').trim();
      const hint = String(data?.hint || '').trim();
      const raw = String(data?.raw || '').trim();
      upstreamError = [message, hint, raw].filter(Boolean).join(' | ').slice(0, 2000);
      if (upstreamError) {
        params.reportProgress(upstreamError);
      }
    }
  });

  try {
    await service.sendMessage(prompt, sessionId);
    if (!sawAnyToolCall) {
      const retryPrompt = [
        '你上一轮没有调用工具，这不符合要求。',
        '请先调用至少 1 次工具（优先 app_cli）读取素材或文档，再重新输出最终 JSON。',
        '注意：最终回复仍然只能是 JSON。',
      ].join('\n');
      params.reportProgress('检测到未调用工具，正在触发强制工具轮次...');
      addChatMessage({
        id: `msg_wander_user_retry_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        session_id: sessionId,
        role: 'user',
        content: retryPrompt,
      });
      await service.sendMessage(retryPrompt, sessionId);
    }
  } finally {
    service.setEventSink(null);
  }

  const assistantMessages = getChatMessages(sessionId)
    .filter((msg) => msg.role === 'assistant' && Number(msg.timestamp || 0) >= startedAt)
    .map((msg) => String(msg.content || '').trim())
    .filter(Boolean);
  const finalContent = assistantMessages.length > 0
    ? assistantMessages[assistantMessages.length - 1]
    : String(responseBuffer || '').trim();
  if (!finalContent) {
    if (upstreamError) {
      throw new Error(upstreamError);
    }
    throw new Error('深度思考未返回有效内容');
  }
  console.log('[wander:brainstorm][agent-mode] completed', {
    requestId: params.requestId,
    toolCallCount,
    sawAnyToolCall,
    responseLength: finalContent.length,
  });
  return finalContent;
};

const normalizeWanderConnections = (raw: unknown): number[] => {
  if (!Array.isArray(raw)) return [1];
  const normalized = raw
    .map((item) => Number(item))
    .filter((item) => Number.isFinite(item))
    .map((item) => Math.max(1, Math.min(3, Math.floor(item))));
  const unique = Array.from(new Set(normalized));
  return unique.length ? unique : [1];
};

const parseWanderJsonPayload = (payload: string): Record<string, unknown> | null => {
  const trimmed = String(payload || '').trim();
  if (!trimmed) return null;
  const stripCodeFence = (text: string) => text
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/```$/i, '')
    .trim();
  const tryParse = (text: string) => {
    try {
      const parsed = JSON.parse(text) as unknown;
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? parsed as Record<string, unknown>
        : null;
    } catch {
      return null;
    }
  };
  const direct = tryParse(trimmed);
  if (direct) return direct;
  const noFence = tryParse(stripCodeFence(trimmed));
  if (noFence) return noFence;
  const normalized = stripCodeFence(trimmed);
  const firstBrace = normalized.indexOf('{');
  const lastBrace = normalized.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    return tryParse(normalized.slice(firstBrace, lastBrace + 1));
  }
  return null;
};

const normalizeWanderOption = (raw: any): { content_direction: string; topic: { title: string; connections: number[] } } => {
  const topic = raw?.topic && typeof raw.topic === 'object' ? raw.topic : {};
  const title = String(topic?.title || raw?.title || '').trim() || '未命名选题';
  const contentDirection = String(raw?.content_direction || raw?.direction || raw?.contentDirection || '').trim()
    || '围绕素材提炼一个可执行的内容方向。';
  return {
    content_direction: contentDirection,
    topic: {
      title,
      connections: normalizeWanderConnections(topic?.connections || raw?.connections),
    },
  };
};

const normalizeWanderResult = (raw: any, multiChoice: boolean) => {
  const thinkingProcess = Array.isArray(raw?.thinking_process)
    ? raw.thinking_process.map((item: unknown) => String(item || '').trim()).filter(Boolean).slice(0, 6)
    : [];

  if (multiChoice) {
    const candidateOptions = Array.isArray(raw?.options)
      ? raw.options
      : Array.isArray(raw?.choices)
        ? raw.choices
        : [];
    const normalizedOptions = candidateOptions
      .map((item: unknown) => normalizeWanderOption(item))
      .filter((item: { content_direction: string; topic: { title: string } }) => Boolean(item.topic.title))
      .slice(0, 3);
    if (!normalizedOptions.length) {
      normalizedOptions.push(normalizeWanderOption(raw));
    }
    while (normalizedOptions.length < 3) {
      normalizedOptions.push({ ...normalizedOptions[normalizedOptions.length - 1] });
    }
    return {
      thinking_process: thinkingProcess,
      options: normalizedOptions,
      content_direction: normalizedOptions[0].content_direction,
      topic: normalizedOptions[0].topic,
      selected_index: 0,
    };
  }

  const single = normalizeWanderOption(raw);
  return {
    content_direction: single.content_direction,
    thinking_process: thinkingProcess,
    topic: single.topic,
  };
};

const requestWanderCompletion = async ({
  baseURL,
  apiKey,
  model,
  temperature,
  messages,
  requireJson = false,
  allowJsonFallback = true,
  enableThinking,
  timeoutMs = 90000,
  retryOnTimeout = true,
  retryTimeoutMs,
  streamPreview = false,
  onProgress,
}: {
  baseURL: string;
  apiKey: string;
  model: string;
  temperature: number;
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
  requireJson?: boolean;
  allowJsonFallback?: boolean;
  enableThinking?: boolean;
  timeoutMs?: number;
  retryOnTimeout?: boolean;
  retryTimeoutMs?: number;
  streamPreview?: boolean;
  onProgress?: (previewText: string) => void;
}) => {
  const sendRequest = async (withResponseFormat: boolean, effectiveTimeoutMs: number, useStream: boolean) => {
    const startedAt = Date.now();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), effectiveTimeoutMs);
    const lower = `${model} ${baseURL}`.toLowerCase();
    const isQwenFamily = lower.includes('qwen') || lower.includes('dashscope.aliyuncs.com');
    const payload = {
      model,
      temperature,
      messages,
      response_format: withResponseFormat ? { type: 'json_object' } : undefined,
      stream: useStream ? true : undefined,
      // DashScope 的 Qwen3/3.5 混合推理模型默认可能启用思考，这里显式控制。
      enable_thinking: isQwenFamily && typeof enableThinking === 'boolean' ? enableThinking : undefined,
    };

    console.log('[wander:brainstorm] request-start', {
      withResponseFormat,
      enableThinking: payload.enable_thinking,
      timeoutMs: effectiveTimeoutMs,
      model,
      baseURL,
    });

    let response: Response;
    try {
      response = await fetch(safeUrlJoin(baseURL, '/chat/completions'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
    } catch (error) {
      clearTimeout(timeout);
      if (controller.signal.aborted) {
        throw new Error(`OpenAI API timeout after ${effectiveTimeoutMs}ms`);
      }
      throw error;
    }
    clearTimeout(timeout);

    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      console.error('[wander:brainstorm] request-failed', {
        status: response.status,
        statusText: response.statusText,
        elapsedMs: Date.now() - startedAt,
        enableThinking: payload.enable_thinking,
      });
      throw new Error(`OpenAI API error: ${response.status} ${response.statusText}${errorText ? ` - ${errorText}` : ''}`);
    }

    if (useStream) {
      if (!response.body) {
        throw new Error('OpenAI API stream response body is empty');
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder('utf-8');
      let buffered = '';
      let assembled = '';
      let lastEmitAt = 0;
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffered += decoder.decode(value, { stream: true });
        const lines = buffered.split('\n');
        buffered = lines.pop() || '';
        for (const lineRaw of lines) {
          const line = lineRaw.trim();
          if (!line.startsWith('data:')) continue;
          const chunk = line.slice(5).trim();
          if (!chunk || chunk === '[DONE]') continue;
          let parsed: any = null;
          try {
            parsed = JSON.parse(chunk);
          } catch {
            continue;
          }
          const deltaText = extractSseDeltaText(parsed);
          if (!deltaText) continue;
          assembled += deltaText;
          const now = Date.now();
          if (now - lastEmitAt > 280) {
            lastEmitAt = now;
            const preview = toTwoLinePreview(assembled);
            if (preview && onProgress) {
              onProgress(preview);
            }
          }
        }
      }
      const finalPreview = toTwoLinePreview(assembled);
      if (finalPreview && onProgress) {
        onProgress(finalPreview);
      }
      console.log('[wander:brainstorm] request-complete', {
        withResponseFormat,
        enableThinking: payload.enable_thinking,
        elapsedMs: Date.now() - startedAt,
      });
      return assembled;
    }

    const data = await response.json() as { choices?: { message: { content: string } }[] };
    console.log('[wander:brainstorm] request-complete', {
      withResponseFormat,
      enableThinking: payload.enable_thinking,
      elapsedMs: Date.now() - startedAt,
    });
    return data.choices?.[0]?.message?.content || '';
  };

  try {
    return await sendRequest(requireJson, timeoutMs, streamPreview);
  } catch (error) {
    const errorMessage = String(error || '');
    const isTimeout = /timeout after \d+ms/i.test(errorMessage);
    const isResponseFormatUnsupported =
      /response[_\s-]?format|json_object|unsupported|not supported|invalid parameter/i.test(errorMessage);
    if (retryOnTimeout && isTimeout) {
      const nextTimeoutMs = Math.max(retryTimeoutMs || timeoutMs, timeoutMs + 45000);
      console.warn('[wander:brainstorm] retry-after-timeout', {
        model,
        baseURL,
        previousTimeoutMs: timeoutMs,
        nextTimeoutMs,
        requireJson,
      });
      return await sendRequest(requireJson, nextTimeoutMs, streamPreview);
    }
    if (requireJson && allowJsonFallback && isResponseFormatUnsupported) {
      // 仅当明确不支持 response_format 时才回退一次，避免普通错误导致额外慢一次
      console.log('[wander:brainstorm] fallback-without-response-format');
      return await sendRequest(false, timeoutMs, streamPreview);
    }
    // 某些兼容网关不支持 stream，退回非流式。
    if (streamPreview && /stream|sse|event-stream|not supported|invalid parameter/i.test(errorMessage)) {
      console.warn('[wander:brainstorm] fallback-without-stream', { errorMessage });
      return await sendRequest(requireJson, timeoutMs, false);
    }
    throw error;
  }
};

ipcMain.handle('wander:brainstorm', async (event, items: any[], options?: { multiChoice?: boolean; deepThink?: boolean; requestId?: string }) => {
  const requestId = String(options?.requestId || '').trim() || `wander-${Date.now()}`;
  const reportProgress = (status: string) => {
    event.sender.send('wander:progress', {
      requestId,
      status,
      at: Date.now(),
    });
  };
  try {
    reportProgress('正在初始化漫步任务...');
    const settings = getSettings() as {
      api_key?: string;
      api_endpoint?: string;
      model_name?: string;
      model_name_wander?: string;
      wander_deep_think_enabled?: boolean;
    } | undefined;
    if (!settings?.api_key) {
      return { error: 'API Key not configured' };
    }

    const baseURL = normalizeApiBaseUrl(settings.api_endpoint || 'https://api.openai.com/v1', 'https://api.openai.com/v1');
    const model = resolveScopedModelName((settings || {}) as Record<string, unknown>, 'wander', 'gpt-4o');
    const multiChoice = typeof options?.multiChoice === 'boolean'
      ? options.multiChoice
      : typeof options?.deepThink === 'boolean'
        ? options.deepThink
      : Boolean(settings.wander_deep_think_enabled);

    console.log('[wander:brainstorm] mode', {
      runtime: 'agent',
      multiChoice,
      itemCount: Array.isArray(items) ? items.length : 0,
      model,
      baseURL,
    });
    reportProgress(`已准备模型与参数（${model}）`);

    const itemsText = buildWanderItemsText(items);
    reportProgress(`已装载 ${Array.isArray(items) ? items.length : 0} 条随机素材`);
    reportProgress('正在加载用户档案与长期记忆...');
    const longTermContext = await buildWanderLongTermContext();
    const longTermContextSection = longTermContext
      ? `\n\n## 用户长期上下文（供你参考）\n${longTermContext}\n\n使用要求：\n- 与长期定位保持一致；\n- 若素材与长期定位冲突，优先选择可落地、可执行的方向。`
      : '';
    const content = await runWanderDeepThinkWithAgent({
      requestId,
      items,
      longTermContextSection,
      multiChoice,
      reportProgress,
    });

    reportProgress('正在解析结果并写入历史...');
    // 解析 JSON 结果
    const parsedPayload = parseWanderJsonPayload(content);
    const result = parsedPayload
      ? normalizeWanderResult(parsedPayload, multiChoice)
      : normalizeWanderResult({ content_direction: content }, multiChoice);

    // 保存到历史记录
    const { saveWanderHistory } = await import('./db');
    const historyId = `wander-${Date.now()}`;
    saveWanderHistory(historyId, items, result);
    reportProgress('漫步完成');

    return { result: JSON.stringify(result), historyId };
  } catch (error) {
    console.error('Failed to brainstorm:', error);
    reportProgress('漫步失败');
    return { error: String(error) };
  }
});

// --------- Embedding & Similarity ---------
ipcMain.handle('embedding:compute', async (_, text: string) => {
  try {
    const embedding = await embeddingService.embedQuery(text);
    return { success: true, embedding };
  } catch (error) {
    console.error('Failed to compute embedding:', error);
    return { success: false, error: String(error) };
  }
});

ipcMain.handle('embedding:get-sorted-sources', async (_, embedding: number[]) => {
  try {
    const { getSimilaritySortedSourceIds } = await import('./db');
    const sorted = getSimilaritySortedSourceIds(embedding);
    return { success: true, sorted };
  } catch (error) {
    console.error('Failed to get sorted sources:', error);
    return { success: false, error: String(error) };
  }
});

// 批量重建知识库索引
ipcMain.handle('embedding:rebuild-all', async () => {
  try {
    const items = await getAllKnowledgeItems();
    let indexed = 0;

    for (const item of items) {
      // 将 WanderItem 转换为 KnowledgeItem 格式
      const knowledgeItem = {
        id: item.id,
        sourceId: item.id,
        title: item.title,
        content: item.content,
        sourceType: item.type as 'note' | 'video' | 'file',
        scope: 'user' as const,
        displayData: {
          coverUrl: item.cover
        }
      };

      indexManager.addToQueue(knowledgeItem);
      indexed++;
    }

    return { success: true, queued: indexed };
  } catch (error) {
    console.error('Failed to rebuild embeddings:', error);
    return { success: false, error: String(error) };
  }
});

// 获取索引状态
ipcMain.handle('embedding:get-status', async () => {
  return indexManager.getStatus();
});

// 获取稿件缓存的 embedding
ipcMain.handle('embedding:get-manuscript-cache', async (_, filePath: string) => {
  try {
    const { getManuscriptEmbedding } = await import('./db');
    const cached = getManuscriptEmbedding(filePath);
    return { success: true, cached };
  } catch (error) {
    console.error('Failed to get manuscript embedding cache:', error);
    return { success: false, error: String(error) };
  }
});

// 保存稿件的 embedding
ipcMain.handle('embedding:save-manuscript-cache', async (_, { filePath, contentHash, embedding }: { filePath: string; contentHash: string; embedding: number[] }) => {
  try {
    const { saveManuscriptEmbedding } = await import('./db');
    saveManuscriptEmbedding(filePath, contentHash, embedding);
    return { success: true };
  } catch (error) {
    console.error('Failed to save manuscript embedding cache:', error);
    return { success: false, error: String(error) };
  }
});

// 获取相似度排序缓存
ipcMain.handle('similarity:get-cache', async (_, manuscriptId: string) => {
  try {
    const { getSimilarityCache, getKnowledgeVersion } = await import('./db');
    const cache = getSimilarityCache(manuscriptId);
    const currentVersion = getKnowledgeVersion();
    return { success: true, cache, currentKnowledgeVersion: currentVersion };
  } catch (error) {
    console.error('Failed to get similarity cache:', error);
    return { success: false, error: String(error) };
  }
});

// 保存相似度排序缓存
ipcMain.handle('similarity:save-cache', async (_, cache: { manuscriptId: string; contentHash: string; knowledgeVersion: number; sortedIds: string[] }) => {
  try {
    const { saveSimilarityCache } = await import('./db');
    saveSimilarityCache(cache);
    return { success: true };
  } catch (error) {
    console.error('Failed to save similarity cache:', error);
    return { success: false, error: String(error) };
  }
});

// 获取当前知识库版本
ipcMain.handle('similarity:get-knowledge-version', async () => {
  const { getKnowledgeVersion } = await import('./db');
  return getKnowledgeVersion();
});

// --------- Wander History ---------
ipcMain.handle('wander:list-history', async () => {
  const { listWanderHistory } = await import('./db');
  return listWanderHistory();
});

ipcMain.handle('wander:get-history', async (_, id: string) => {
  const { getWanderHistory } = await import('./db');
  return getWanderHistory(id);
});

ipcMain.handle('wander:delete-history', async (_, id: string) => {
  const { deleteWanderHistory } = await import('./db');
  deleteWanderHistory(id);
  return { success: true };
});

// --------- Archives (Profiles & Samples) ---------
const buildExcerpt = (content?: string, maxLength = 120) => {
  if (!content) return '';
  const trimmed = content.replace(/\s+/g, ' ').trim();
  return trimmed.length > maxLength ? `${trimmed.slice(0, maxLength)}...` : trimmed;
};

const rewriteRichHtmlTokens = (
  html: string,
  replacements: Array<{ token: string; localPath: string }>
): string => {
  let next = String(html || '');
  for (const replacement of replacements) {
    const token = String(replacement.token || '').trim();
    const localPath = String(replacement.localPath || '').trim();
    if (!token || !localPath) continue;
    next = next.split(token).join(localPath);
  }
  return next;
};

const absolutizeEmbeddedLocalAssetReferences = (html: string, noteDir: string): string => {
  const raw = String(html || '');
  if (!raw) return '';

  return raw.replace(
    /\b(src|href|poster)=("|')(images\/[^"']+)\2/gi,
    (_match, attrName: string, quote: string, relativePath: string) => {
      const absolutePath = path.join(noteDir, relativePath);
      return `${attrName}=${quote}${toLocalFileUrl(absolutePath)}${quote}`;
    },
  );
};

const ensureRichHtmlUsesAbsoluteAssetUrls = async (noteDir: string, htmlFileName: string): Promise<string> => {
  const htmlPath = path.join(noteDir, htmlFileName);
  const current = await fs.readFile(htmlPath, 'utf-8');
  const rewritten = absolutizeEmbeddedLocalAssetReferences(current, noteDir);
  if (rewritten !== current) {
    await fs.writeFile(htmlPath, rewritten, 'utf-8');
  }
  return rewritten;
};

const extractArticleFromHtmlSnapshot = (input: {
  htmlSnapshot?: string;
  url?: string;
  fallbackTitle?: string;
  fallbackExcerpt?: string;
  fallbackAuthor?: string;
  fallbackSiteName?: string;
}): {
  title: string;
  markdown: string;
  excerpt: string;
  author: string;
  siteName: string;
  contentHtml: string;
} | null => {
  const htmlSnapshot = String(input.htmlSnapshot || '').trim();
  if (!htmlSnapshot) return null;

  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { JSDOM } = require('jsdom') as typeof import('jsdom');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { Readability } = require('@mozilla/readability') as typeof import('@mozilla/readability');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const TurndownService = require('turndown') as typeof import('turndown');

    const dom = new JSDOM(htmlSnapshot, {
      url: String(input.url || 'https://example.com'),
    });
    const reader = new Readability(dom.window.document);
    const article = reader.parse();
    if (!article || !String(article.content || '').trim()) {
      return null;
    }

    const turndownService = new TurndownService({
      headingStyle: 'atx',
      codeBlockStyle: 'fenced',
      bulletListMarker: '-',
      emDelimiter: '_',
      strongDelimiter: '**',
    });

    turndownService.remove(['script', 'style', 'noscript', 'iframe']);
    const markdown = String(turndownService.turndown(article.content || '') || '').trim();
    const excerpt = String(article.excerpt || input.fallbackExcerpt || buildExcerpt(markdown, 180)).trim();

    return {
      title: String(article.title || input.fallbackTitle || 'Untitled Page').trim(),
      markdown,
      excerpt,
      author: String(article.byline || input.fallbackAuthor || '').trim(),
      siteName: String(article.siteName || input.fallbackSiteName || '').trim(),
      contentHtml: String(article.content || '').trim(),
    };
  } catch (error) {
    console.error('Failed to extract article from html snapshot:', error);
    return null;
  }
};

const localizeGenericArticleHtml = async (
  html: string,
  noteDir: string,
  persistImage: (imageSource: string, preferredName?: string) => Promise<string>,
  onPersistedImage?: (relativePath: string) => void,
): Promise<string> => {
  const rawHtml = String(html || '').trim();
  if (!rawHtml) return '';

  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { JSDOM } = require('jsdom') as typeof import('jsdom');
    const dom = new JSDOM('<!doctype html><html><body></body></html>');
    const { document } = dom.window;
    const root = document.createElement('div');
    root.innerHTML = rawHtml;

    const images = Array.from(root.querySelectorAll('img'));
    for (let index = 0; index < images.length; index += 1) {
      const img = images[index];
      const source = String(
        img.getAttribute('src')
        || img.getAttribute('data-src')
        || img.getAttribute('data-original')
        || '',
      ).trim();
      if (!source) continue;
      try {
        const localPath = await persistImage(source, index === 0 ? 'cover.jpg' : undefined);
        if (!localPath) continue;
        img.setAttribute('src', localPath);
        img.removeAttribute('srcset');
        img.removeAttribute('data-src');
        img.removeAttribute('data-original');
        onPersistedImage?.(localPath);
      } catch (error) {
        console.error('Failed to localize generic article image:', error);
      }
    }

    for (const anchor of Array.from(root.querySelectorAll('a[href]'))) {
      const href = String(anchor.getAttribute('href') || '').trim();
      if (!href || href.startsWith('#') || href.startsWith('mailto:') || href.startsWith('tel:')) continue;
      try {
        anchor.setAttribute('href', new URL(href, 'https://example.com').toString());
      } catch {
        // keep original href when it is not a valid URL-like string
      }
    }

    return absolutizeEmbeddedLocalAssetReferences(root.innerHTML, noteDir);
  } catch (error) {
    console.error('Failed to localize generic article html:', error);
    return absolutizeEmbeddedLocalAssetReferences(rawHtml, noteDir);
  }
};

type KnowledgeEntryPayload = {
  kind?: string;
  source?: {
    sourceLink?: string;
    sourceUrl?: string;
    sourceDomain?: string;
    externalId?: string;
  };
  content?: {
    title?: string;
    text?: string;
    excerpt?: string;
    description?: string;
    html?: string;
    indexText?: string;
    author?: string;
    authorProfileUrl?: string;
    siteName?: string;
    tags?: string[];
    publishedAt?: string;
    commentsSnapshot?: Array<{
      author?: string;
      text?: string;
      likes?: number;
      replies?: number;
      createdAt?: string;
      location?: string;
    }>;
    stats?: {
      likes?: number;
      collects?: number;
      comments?: number;
      shares?: number;
    };
  };
  assets?: {
    coverUrl?: string;
    imageUrls?: string[];
    videoUrl?: string;
    thumbnailUrl?: string;
  };
  options?: {
    allowUpdate?: boolean;
    transcribe?: boolean;
  };
};

function extByMimeLoose(mimeType: string, fallback = 'bin'): string {
  const lower = String(mimeType || '').toLowerCase();
  if (lower.includes('jpeg') || lower.includes('jpg')) return 'jpg';
  if (lower.includes('png')) return 'png';
  if (lower.includes('webp')) return 'webp';
  if (lower.includes('gif')) return 'gif';
  if (lower.includes('bmp')) return 'bmp';
  if (lower.includes('svg')) return 'svg';
  if (lower.includes('mp4')) return 'mp4';
  if (lower.includes('webm')) return 'webm';
  if (lower.includes('quicktime') || lower.includes('mov')) return 'mov';
  if (lower.includes('mpeg')) return 'mp3';
  if (lower.includes('wav')) return 'wav';
  return fallback;
}

function decodeBase64DataUrl(raw: string): { mimeType: string; buffer: Buffer } | null {
  const match = String(raw || '').trim().match(/^data:([^;]+);base64,(.+)$/i);
  if (!match) return null;
  return {
    mimeType: String(match[1] || 'application/octet-stream').toLowerCase(),
    buffer: Buffer.from(String(match[2] || ''), 'base64'),
  };
}

function inferExtensionFromUrl(raw: string, fallback = 'bin'): string {
  try {
    const pathname = new URL(String(raw || '').trim()).pathname || '';
    const ext = path.extname(pathname).replace(/^\./, '').trim().toLowerCase();
    return ext || fallback;
  } catch {
    return fallback;
  }
}

function ensureFileNameWithExtension(fileName: string, ext: string): string {
  const normalized = String(fileName || '').trim();
  if (!normalized) {
    return `asset.${ext}`;
  }
  if (path.extname(normalized)) {
    return normalized;
  }
  return `${normalized}.${ext}`;
}

function sanitizeKnowledgeEntryId(raw: string, fallbackPrefix: string): string {
  const normalized = String(raw || '').trim();
  if (!normalized) {
    return `${fallbackPrefix}_${Date.now()}`;
  }
  const sanitized = normalized
    .normalize('NFKD')
    .replace(/[^\w\-.一-龥]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
  return sanitized || `${fallbackPrefix}_${Date.now()}`;
}

function countTruthyDirectoryEntries(entries: Array<string | fsSync.Dirent>): number {
  return entries.filter(Boolean).length;
}

function createKnowledgeAssetPersister(noteDir: string) {
  const persistedBySource = new Map<string, string>();
  let nextImageIndex = 0;

  const persistAsset = async (input: {
    source: string;
    preferredName?: string;
    kind: 'image' | 'video';
  }): Promise<string> => {
    const source = String(input.source || '').trim();
    if (!source) return '';
    if (persistedBySource.has(source)) {
      return persistedBySource.get(source) || '';
    }

    const targetDir = input.kind === 'image' ? path.join(noteDir, 'images') : noteDir;
    await fs.mkdir(targetDir, { recursive: true });

    const decoded = decodeBase64DataUrl(source);
    const fallbackExt = input.kind === 'image'
      ? 'jpg'
      : 'mp4';
    const ext = decoded
      ? extByMimeLoose(decoded.mimeType, fallbackExt)
      : inferExtensionFromUrl(source, fallbackExt);
    const defaultFileName = input.kind === 'image'
      ? `${nextImageIndex++}.${ext}`
      : `video.${ext}`;
    const fileName = ensureFileNameWithExtension(input.preferredName || defaultFileName, ext);
    const outputPath = path.join(targetDir, fileName);

    if (decoded) {
      await fs.writeFile(outputPath, decoded.buffer);
    } else if (/^https?:\/\//i.test(source)) {
      if (input.kind === 'image') {
        await downloadImageToFile(source, outputPath);
      } else {
        await downloadFile(source, outputPath);
      }
    } else {
      return '';
    }

    const relativePath = path.relative(noteDir, outputPath).replace(/\\/g, '/');
    persistedBySource.set(source, relativePath);
    return relativePath;
  };

  return {
    persistImage: async (source: string, preferredName?: string) => {
      return persistAsset({ source, preferredName, kind: 'image' });
    },
    persistVideo: async (source: string, preferredName?: string) => {
      return persistAsset({ source, preferredName, kind: 'video' });
    },
  };
}

async function queueKnowledgeVideoTranscription(input: {
  noteId: string;
  noteDir: string;
  metaPath: string;
  meta: Record<string, any>;
}) {
  if (!input?.meta?.video) {
    return;
  }

  const noteId = String(input.noteId || '').trim();
  const noteDir = input.noteDir;
  const metaPath = input.metaPath;
  const meta = input.meta;

  (async () => {
    const videoPath = path.join(noteDir, String(meta.video));
    const transcriptResult = await transcribeVideoToText(videoPath);
    const transcript = transcriptResult.text;
    if (transcript) {
      meta.transcript = transcript;
      meta.transcriptFile = 'transcript.txt';
      meta.transcriptionStatus = 'completed';
      await fs.writeFile(path.join(noteDir, meta.transcriptFile), transcript);
      await fs.writeFile(metaPath, JSON.stringify(meta, null, 2));
      indexManager.addToQueue(normalizeVideo(
        noteId,
        meta,
        transcript,
        'user'
      ));
      win?.webContents.send('knowledge:note-updated', { noteId, hasTranscript: true, transcriptionStatus: 'completed' });
    } else if (transcriptResult.error) {
      meta.transcriptionStatus = 'failed';
      await fs.writeFile(metaPath, JSON.stringify(meta, null, 2));
      console.warn(`[Transcription] Skipped background transcript for ${noteId}: ${transcriptResult.error}`);
      win?.webContents.send('knowledge:note-updated', { noteId, hasTranscript: false, transcriptionStatus: 'failed' });
    }
  })().catch((err) => {
    console.error('Failed to transcribe video:', err);
    meta.transcriptionStatus = 'failed';
    fs.writeFile(metaPath, JSON.stringify(meta, null, 2)).catch(() => {});
    win?.webContents.send('knowledge:note-updated', { noteId, hasTranscript: false, transcriptionStatus: 'failed' });
  });
}

async function persistStructuredKnowledgeNote(input: {
  noteId: string;
  kind: string;
  title: string;
  content: string;
  indexText?: string;
  sourceUrl?: string;
  siteName?: string;
  author?: string;
  authorProfileUrl?: string;
  excerpt?: string;
  tags?: string[];
  publishedAt?: string;
  commentsSnapshot?: Array<{
    author?: string;
    text?: string;
    likes?: number;
    replies?: number;
    createdAt?: string;
    location?: string;
  }>;
  stats?: { likes?: number; collects?: number; comments?: number; shares?: number };
  coverUrl?: string;
  imageUrls?: string[];
  videoUrl?: string;
  videoSourceUrl?: string;
  html?: string;
  allowUpdate?: boolean;
  transcribe?: boolean;
}): Promise<{ success: boolean; noteId?: string; duplicate?: boolean; updated?: boolean; error?: string }> {
  const noteId = sanitizeKnowledgeEntryId(input.noteId, 'entry');
  const noteDir = path.join(getKnowledgeRedbookDir(), noteId);
  const metaPath = path.join(noteDir, 'meta.json');

  try {
    await fs.mkdir(noteDir, { recursive: true });

    let existingMeta: Record<string, any> | null = null;
    try {
      existingMeta = JSON.parse(await fs.readFile(metaPath, 'utf-8'));
    } catch {
      existingMeta = null;
    }

    if (existingMeta && !input.allowUpdate) {
      return { success: true, noteId, duplicate: true };
    }

    const { persistImage, persistVideo } = createKnowledgeAssetPersister(noteDir);
    const meta: Record<string, any> = {
      id: noteId,
      type: input.kind || 'webpage',
      title: input.title || existingMeta?.title || '未命名内容',
      author: input.author || existingMeta?.author || '未知',
      authorProfileUrl: input.authorProfileUrl || existingMeta?.authorProfileUrl || '',
      content: input.content || '',
      indexText: input.indexText || existingMeta?.indexText || input.content || '',
      sourceUrl: input.sourceUrl || existingMeta?.sourceUrl || '',
      siteName: input.siteName || existingMeta?.siteName || '',
      excerpt: input.excerpt || buildExcerpt(input.content || '', 180),
      publishedAt: input.publishedAt || existingMeta?.publishedAt || '',
      stats: {
        likes: Number(input.stats?.likes ?? existingMeta?.stats?.likes ?? 0),
        collects: Number(input.stats?.collects ?? existingMeta?.stats?.collects ?? 0),
        comments: Number(input.stats?.comments ?? existingMeta?.stats?.comments ?? 0),
        shares: Number(input.stats?.shares ?? existingMeta?.stats?.shares ?? 0),
      },
      commentsSnapshot: Array.isArray(input.commentsSnapshot)
        ? input.commentsSnapshot.filter((item) => item && (item.author || item.text))
        : Array.isArray(existingMeta?.commentsSnapshot)
          ? existingMeta.commentsSnapshot
          : [],
      images: [],
      cover: '',
      tags: Array.isArray(input.tags) ? input.tags.filter(Boolean) : [],
      createdAt: String(existingMeta?.createdAt || new Date().toISOString()),
      updatedAt: new Date().toISOString(),
    };

    if (typeof input.coverUrl === 'string' && input.coverUrl.trim()) {
      try {
        const coverPath = await persistImage(input.coverUrl.trim(), 'cover');
        if (coverPath) {
          meta.cover = coverPath;
          meta.images.push(coverPath);
        }
      } catch (error) {
        console.error('Failed to persist knowledge cover:', error);
      }
    }

    if (Array.isArray(input.imageUrls)) {
      for (const imageSource of input.imageUrls) {
        try {
          const imagePath = await persistImage(String(imageSource || '').trim());
          if (imagePath && !meta.images.includes(imagePath)) {
            meta.images.push(imagePath);
          }
        } catch (error) {
          console.error('Failed to persist knowledge image:', error);
        }
      }
    }

    if (!meta.cover && meta.images.length > 0) {
      meta.cover = meta.images[0];
    }

    if (typeof input.videoUrl === 'string' && input.videoUrl.trim()) {
      try {
        const videoPath = await persistVideo(input.videoUrl.trim(), 'video');
        if (videoPath) {
          const absoluteVideoPath = path.join(noteDir, videoPath);
          await verifyVideoFileDecodable(absoluteVideoPath);
          meta.video = videoPath;
          meta.videoUrl = input.videoSourceUrl || input.videoUrl;
          if (input.transcribe) {
            meta.transcriptionStatus = 'processing';
          }
        }
      } catch (error) {
        console.error('Failed to persist knowledge video:', error);
        if (input.transcribe) {
          meta.transcriptionStatus = 'failed';
        }
      }
    }

    if (typeof input.html === 'string' && input.html.trim()) {
      const htmlFile = 'content.html';
      const localizedHtml = await localizeGenericArticleHtml(
        input.html,
        noteDir,
        async (imageSource, preferredName) => {
          const imagePath = await persistImage(imageSource, preferredName);
          if (imagePath && !meta.images.includes(imagePath)) {
            meta.images.push(imagePath);
          }
          return imagePath;
        },
      );
      if (!meta.cover && meta.images.length > 0) {
        meta.cover = meta.images[0];
      }
      await fs.writeFile(path.join(noteDir, htmlFile), localizedHtml, 'utf-8');
      meta.htmlFile = htmlFile;
    }

    await fs.writeFile(metaPath, JSON.stringify(meta, null, 2));
    await fs.writeFile(path.join(noteDir, 'content.md'), meta.content || '', 'utf-8');

    indexManager.addToQueue(normalizeNote(noteId, meta, meta.indexText || meta.content || ''));
    if (existingMeta) {
      win?.webContents.send('knowledge:note-updated', { noteId, hasTranscript: Boolean(meta.transcript), transcriptionStatus: meta.transcriptionStatus });
    } else {
      win?.webContents.send('knowledge:new-note', { noteId, title: meta.title });
    }
    win?.webContents.send('knowledge-updated');

    if (meta.video && input.transcribe) {
      await queueKnowledgeVideoTranscription({
        noteId,
        noteDir,
        metaPath,
        meta,
      });
    }

    return {
      success: true,
      noteId,
      duplicate: false,
      updated: Boolean(existingMeta),
    };
  } catch (error) {
    console.error('Failed to persist structured knowledge note:', error);
    return { success: false, error: String(error) };
  }
}

async function persistKnowledgeEntry(entry: KnowledgeEntryPayload): Promise<{ success: boolean; entryId?: string; duplicate?: boolean; updated?: boolean; error?: string }> {
  const kind = String(entry?.kind || '').trim();
  const source = entry?.source || {};
  const content = entry?.content || {};
  const assets = entry?.assets || {};
  const options = entry?.options || {};
  const sourceLink = String(source?.sourceLink || source?.sourceUrl || '').trim();
  const externalId = String(source?.externalId || '').trim();

  if (kind === 'youtube-video') {
    const videoUrl = String(sourceLink || '').trim();
    const videoId = externalId || (() => {
      try {
        const parsed = new URL(videoUrl);
        if (parsed.hostname === 'youtu.be') {
          return parsed.pathname.split('/').filter(Boolean).pop() || '';
        }
        return parsed.searchParams.get('v') || '';
      } catch {
        return '';
      }
    })();
    const result = await persistYoutubeNote({
      videoId,
      videoUrl,
      title: String(content?.title || '').trim(),
      description: String(content?.description || content?.text || '').trim(),
      thumbnailUrl: String(assets?.thumbnailUrl || assets?.coverUrl || '').trim(),
    });
    return {
      success: result.success,
      entryId: result.noteId,
      duplicate: result.duplicate,
      updated: false,
      error: result.error,
    };
  }

  const rawVideoSource = String(assets?.videoUrl || '').trim();
  const persistedVideoSource = rawVideoSource.startsWith('data:')
    ? rawVideoSource
    : rawVideoSource || '';

  const result = await persistStructuredKnowledgeNote({
    noteId: externalId || `${kind || 'entry'}_${Date.now()}`,
    kind: kind || 'webpage',
    title: String(content?.title || '').trim() || '未命名内容',
    content: String(content?.text || content?.description || '').trim(),
    indexText: String(content?.indexText || content?.text || content?.description || '').trim(),
    sourceUrl: sourceLink,
    siteName: String(content?.siteName || source?.sourceDomain || '').trim(),
    author: String(content?.author || '').trim(),
    authorProfileUrl: String(content?.authorProfileUrl || '').trim(),
    excerpt: String(content?.excerpt || '').trim(),
    tags: Array.isArray(content?.tags) ? content.tags.filter(Boolean) : [],
    publishedAt: String(content?.publishedAt || '').trim(),
    commentsSnapshot: Array.isArray(content?.commentsSnapshot) ? content.commentsSnapshot : [],
    stats: content?.stats,
    coverUrl: String(assets?.coverUrl || assets?.thumbnailUrl || '').trim(),
    imageUrls: Array.isArray(assets?.imageUrls) ? assets.imageUrls.filter(Boolean) : [],
    videoUrl: persistedVideoSource,
    videoSourceUrl: rawVideoSource.startsWith('data:') ? sourceLink : rawVideoSource,
    html: String(content?.html || '').trim(),
    allowUpdate: Boolean(options?.allowUpdate),
    transcribe: Boolean(options?.transcribe),
  });

  return {
    success: result.success,
    entryId: result.noteId,
    duplicate: result.duplicate,
    updated: result.updated,
    error: result.error,
  };
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const fetchWithRetries = async (
  inputUrl: string,
  options?: {
    headers?: Record<string, string>;
    timeoutMs?: number;
  },
): Promise<Response> => {
  const normalizedUrl = normalizeRemoteAssetUrl(inputUrl);
  if (!/^https?:\/\//i.test(normalizedUrl)) {
    throw new Error(`Unsupported download URL: ${normalizedUrl || inputUrl}`);
  }

  let lastError: unknown = null;

  for (const retryDelay of DOWNLOAD_RETRY_DELAYS_MS) {
    if (retryDelay > 0) {
      await delay(retryDelay);
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), options?.timeoutMs ?? 20000);

    try {
      const response = await fetch(normalizedUrl, {
        headers: options?.headers,
        signal: controller.signal,
      });
      clearTimeout(timeout);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status} ${response.statusText}`.trim());
      }
      return response;
    } catch (error) {
      clearTimeout(timeout);
      lastError = error;
    }
  }

  throw lastError instanceof Error ? lastError : new Error(`Download failed: ${normalizedUrl}`);
};

const downloadImageToFile = async (url: string, outputPath: string) => {
  const response = await fetchWithRetries(url, {
    headers: {
      ...XHS_ASSET_REQUEST_HEADERS,
      'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
    },
  });
  const buffer = Buffer.from(await response.arrayBuffer());
  const fs = require('fs/promises');
  await fs.writeFile(outputPath, buffer);
};

const downloadFile = async (url: string, outputPath: string) => {
  const response = await fetchWithRetries(url, {
    headers: {
      ...XHS_ASSET_REQUEST_HEADERS,
      'Accept': '*/*',
    },
    timeoutMs: 45000,
  });

  const contentType = String(response.headers.get('content-type') || '').toLowerCase();
  if (
    contentType &&
    (
      contentType.includes('text/plain')
      || contentType.includes('text/html')
      || contentType.includes('javascript')
      || contentType.includes('json')
      || contentType.includes('xml')
    )
  ) {
    throw new Error(`Downloaded non-media payload: content-type=${contentType}`);
  }
  
  // 尝试使用流式写入以节省内存
  try {
    const { pipeline } = require('node:stream/promises');
    const { Readable } = require('node:stream');
    const fs = require('node:fs');
    
    // @ts-ignore - Readable.fromWeb is available in Node 18+ (Electron usually has it)
    if (response.body && Readable.fromWeb) {
      // @ts-ignore
      const nodeStream = Readable.fromWeb(response.body);
      const fileStream = fs.createWriteStream(outputPath);
      await pipeline(nodeStream, fileStream);
      return;
    }
  } catch (e) {
    console.warn('Stream download failed, falling back to buffer:', e);
  }

  // 回退到 Buffer 模式
  const buffer = Buffer.from(await response.arrayBuffer());
  const fs = require('fs/promises');
  await fs.writeFile(outputPath, buffer);
};

const verifyVideoFileDecodable = async (videoPath: string): Promise<void> => {
  const ffmpegCommand = resolveFfmpegCommand();
  await new Promise<void>((resolve, reject) => {
    const args = ['-v', 'error', '-i', videoPath, '-t', '0.1', '-f', 'null', '-'];
    const child = spawn(ffmpegCommand, args, {
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr?.on('data', (chunk) => {
      if (!chunk) return;
      stderr += String(chunk);
      if (stderr.length > 4000) stderr = stderr.slice(-4000);
    });
    child.once('error', (error) => {
      reject(error);
    });
    child.once('close', (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`ffmpeg probe failed (bin=${ffmpegCommand}, code=${code}): ${stderr || '(no stderr)'}`));
    });
  });
};

const TRANSCRIBE_VIDEO_EXTENSIONS = new Set(['mp4', 'mov', 'm4v', 'webm', 'mkv', 'avi', 'flv', 'wmv', 'mpeg', 'mpg']);
const TRANSCRIBE_REENCODE_SIZE_THRESHOLD = 8 * 1024 * 1024;

const resolveBundledExecutablePath = (rawPath: string): string => {
  const candidate = String(rawPath || '').trim();
  if (!candidate) return '';
  if (candidate.includes('app.asar')) {
    return candidate.replace('app.asar', 'app.asar.unpacked');
  }
  return candidate;
};

const isProbablyFilePath = (value: string): boolean => {
  if (!value) return false;
  if (path.isAbsolute(value)) return true;
  return value.includes('/') || value.includes('\\');
};

const resolveFfmpegCommand = (): string => {
  const envPath = String(process.env.REDCONVERT_FFMPEG_PATH || process.env.FFMPEG_PATH || '').trim();
  const candidates: string[] = [];
  if (envPath) candidates.push(resolveBundledExecutablePath(envPath));

  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const ffmpegStaticPath = require('ffmpeg-static') as string | null;
    if (ffmpegStaticPath) {
      candidates.push(resolveBundledExecutablePath(ffmpegStaticPath));
    }
  } catch {
    // ignore, keep fallback
  }

  if (process.resourcesPath) {
    const exeName = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
    candidates.push(path.join(process.resourcesPath, 'app.asar.unpacked', 'node_modules', 'ffmpeg-static', exeName));
  }

  for (const candidate of candidates) {
    if (!candidate || !isProbablyFilePath(candidate)) continue;
    try {
      if (fsSync.existsSync(candidate)) {
        console.log('[Transcription] ffmpeg binary resolved', {
          path: candidate,
          bundled: candidate.includes('ffmpeg-static') || candidate.includes('app.asar.unpacked'),
        });
        return candidate;
      }
    } catch {
      // ignore check failure
    }
  }

  // Strict mode by default: never fall back to system ffmpeg to avoid environment inconsistency.
  const allowSystemFallback = String(process.env.REDCONVERT_ALLOW_SYSTEM_FFMPEG || '').trim().toLowerCase();
  if (allowSystemFallback === '1' || allowSystemFallback === 'true' || allowSystemFallback === 'yes') {
    console.warn('[Transcription] bundled ffmpeg missing, fallback to system ffmpeg by env override');
    return 'ffmpeg';
  }
  throw new Error('Bundled ffmpeg not found. Please reinstall app/package to restore internal ffmpeg binary.');
};

const guessAudioMimeTypeByExtension = (extension: string): string => {
  const ext = String(extension || '').trim().toLowerCase();
  if (ext === 'mp3') return 'audio/mpeg';
  if (ext === 'wav') return 'audio/wav';
  if (ext === 'm4a') return 'audio/mp4';
  if (ext === 'aac') return 'audio/aac';
  if (ext === 'ogg') return 'audio/ogg';
  if (ext === 'flac') return 'audio/flac';
  return 'application/octet-stream';
};

const extractAudioWithFfmpeg = async (inputPath: string): Promise<{
  outputPath: string;
  cleanup: () => Promise<void>;
}> => {
  const tempDir = await fs.mkdtemp(path.join(app.getPath('temp'), 'redbox-stt-'));
  const outputPath = path.join(tempDir, `${path.parse(path.basename(inputPath)).name || 'audio'}.mp3`);
  const ffmpegCommand = resolveFfmpegCommand();

  await new Promise<void>((resolve, reject) => {
    const args = [
      '-y',
      '-i', inputPath,
      '-vn',
      '-ac', '1',
      '-ar', '16000',
      '-b:a', '64k',
      '-f', 'mp3',
      outputPath,
    ];
    const child = spawn(ffmpegCommand, args, {
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr?.on('data', (chunk) => {
      if (!chunk) return;
      stderr += String(chunk);
      if (stderr.length > 4000) {
        stderr = stderr.slice(-4000);
      }
    });
    child.once('error', (error) => {
      reject(error);
    });
    child.once('close', (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`ffmpeg exited with code ${code} (bin=${ffmpegCommand}): ${stderr || '(no stderr)'}`));
    });
  });

  return {
    outputPath,
    cleanup: async () => {
      try {
        await fs.rm(tempDir, { recursive: true, force: true });
      } catch {
        // ignore cleanup errors
      }
    },
  };
};

const prepareTranscriptionAudio = async (videoPath: string): Promise<{
  audioBuffer: Buffer;
  fileName: string;
  mimeType: string;
  source: 'original' | 'ffmpeg-mp3';
  cleanup?: () => Promise<void>;
}> => {
  const stat = await fs.stat(videoPath);
  const ext = extensionFromPath(videoPath);
  const shouldTryExtract = TRANSCRIBE_VIDEO_EXTENSIONS.has(ext) || stat.size > TRANSCRIBE_REENCODE_SIZE_THRESHOLD;
  if (!shouldTryExtract) {
    const audioBuffer = await fs.readFile(videoPath);
    return {
      audioBuffer,
      fileName: path.basename(videoPath) || 'audio.wav',
      mimeType: guessAudioMimeTypeByExtension(ext),
      source: 'original',
    };
  }

  try {
    const extracted = await extractAudioWithFfmpeg(videoPath);
    const audioBuffer = await fs.readFile(extracted.outputPath);
    return {
      audioBuffer,
      fileName: path.basename(extracted.outputPath) || 'audio.mp3',
      mimeType: 'audio/mpeg',
      source: 'ffmpeg-mp3',
      cleanup: extracted.cleanup,
    };
  } catch (error) {
    // For video sources, uploading original container bytes to /audio/transcriptions
    // is usually invalid and produces misleading upstream errors.
    // Fail fast so users can see the real root cause (audio extraction failed).
    if (TRANSCRIBE_VIDEO_EXTENSIONS.has(ext)) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`ffmpeg 音频抽取失败：${reason}`);
    }
    console.warn('[Transcription] ffmpeg audio extract unavailable, fallback to original media upload:', error);
    const audioBuffer = await fs.readFile(videoPath);
    return {
      audioBuffer,
      fileName: path.basename(videoPath) || 'audio.wav',
      mimeType: guessAudioMimeTypeByExtension(ext),
      source: 'original',
    };
  }
};

const transcribeVideoToText = async (videoPath: string): Promise<{ text: string | null; error?: string }> => {
  const settings = getSettings() as {
    api_endpoint?: string;
    api_key?: string;
    transcription_model?: string;
    transcription_endpoint?: string;
    transcription_key?: string;
  } | undefined;
  const endpointRaw = String(settings?.transcription_endpoint || settings?.api_endpoint || '').trim();
  const endpoint = normalizeApiBaseUrl(endpointRaw);
  let apiKey = String(settings?.transcription_key || settings?.api_key || '').trim();
  if (!endpoint || !apiKey) {
    console.warn('[Transcription] API not configured, skipping transcription');
    return { text: null, error: '未配置转录 API（transcription_endpoint/transcription_key）' };
  }

  const endpointHost = (() => {
    try {
      return new URL(endpoint).hostname.toLowerCase();
    } catch {
      return '';
    }
  })();
  const modelName = String(settings?.transcription_model || 'whisper-1').trim() || 'whisper-1';
  const isOfficialOpenAiTranscriptionModel = /^(whisper-1|gpt-4o-transcribe|gpt-4o-mini-transcribe(?:-\d{4}-\d{2}-\d{2})?|gpt-4o-transcribe-diarize)$/i.test(modelName);
  const isOfficialGeminiEndpoint =
    endpointHost === 'generativelanguage.googleapis.com' || endpointHost.endsWith('.googleapis.com');
  const detectGeminiApiVersionFromEndpoint = (value: string): 'v1' | 'v1beta' => {
    const normalized = String(value || '').toLowerCase();
    if (normalized.includes('/v1/') || normalized.endsWith('/v1')) {
      return 'v1';
    }
    return 'v1beta';
  };
  const isLikelyUnsupportedTranscriptionEndpoint =
    endpointHost.includes('dashscope.aliyuncs.com') ||
    endpointHost.includes('volces.com');
  if (isLikelyUnsupportedTranscriptionEndpoint) {
    const message = `当前转录端点可能不支持 OpenAI /audio/transcriptions：${endpoint}`;
    console.warn(`[Transcription] ${message}`);
    return { text: null, error: `${message}；请在设置中单独配置支持 Whisper 的转录端点。` };
  }

  let isOfficialGatewayEndpoint = false;
  const officialFeatureModule = await loadOfficialFeatureModule();
  if (officialFeatureModule?.prepareOfficialTranscriptionAuth) {
    try {
      const officialAuth = await officialFeatureModule.prepareOfficialTranscriptionAuth({
        endpoint,
        apiKey,
      });
      if (officialAuth?.handled) {
        isOfficialGatewayEndpoint = Boolean(officialAuth.officialGateway);
        if (officialAuth.apiKey) {
          apiKey = officialAuth.apiKey;
        }
        if (officialAuth.error) {
          return {
            text: null,
            error: officialAuth.error,
          };
        }
      }
    } catch (error) {
      const details = error instanceof Error ? error.message : String(error);
      return {
        text: null,
        error: `转录鉴权失败：${details}`,
      };
    }
  }
  console.log('[Transcription] auth prepared', {
    endpoint,
    officialGateway: isOfficialGatewayEndpoint,
    authMode: String(apiKey || '').trim().startsWith('rbx_') ? 'api-key' : 'access-token',
    model: modelName,
  });

  let preparedAudioCleanup: (() => Promise<void>) | undefined;
  try {
    const preparedAudio = await prepareTranscriptionAudio(videoPath);
    preparedAudioCleanup = preparedAudio.cleanup;
    const audioBuffer = preparedAudio.audioBuffer;
    const fileName = preparedAudio.fileName;
    const fileMimeType = preparedAudio.mimeType;
    if (preparedAudio.source === 'original' && TRANSCRIBE_VIDEO_EXTENSIONS.has(extensionFromPath(videoPath))) {
      return { text: null, error: '转录前音频抽取失败：已阻止将原始视频文件直接上传到 ASR。请检查源视频完整性后重试。' };
    }
    const endpointUrl = safeUrlJoin(endpoint, '/audio/transcriptions');
    console.log('[Transcription] payload prepared', {
      endpoint: endpointUrl,
      source: preparedAudio.source,
      bytes: audioBuffer.byteLength,
      fileName,
      fileMimeType,
      });

    if (!isOfficialGatewayEndpoint && isOfficialOpenAiTranscriptionModel) {
      const OpenAI = require('openai').default;
      const { toFile } = require('openai');
      const client = new OpenAI({
        apiKey,
        baseURL: endpoint,
        timeout: 180000,
        maxRetries: 0,
      });
      const file = await toFile(Buffer.from(audioBuffer), fileName || 'audio.wav', {
        type: fileMimeType || 'application/octet-stream',
      });
      const sdkResponse = await client.audio.transcriptions.create({
        model: modelName,
        file,
      });
      const text = typeof sdkResponse === 'string'
        ? sdkResponse
        : String((sdkResponse as { text?: string }).text || '').trim();
      return { text: text || null };
    }

    if (!isOfficialGatewayEndpoint && isOfficialGeminiEndpoint) {
      const { GoogleGenAI } = require('@google/genai');
      const client = new GoogleGenAI({
        apiKey,
        apiVersion: detectGeminiApiVersionFromEndpoint(endpoint),
        httpOptions: {
          timeout: 180000,
          retryOptions: {
            attempts: 1,
          },
          baseUrl: `${new URL(endpoint).protocol}//${new URL(endpoint).host}`,
        },
      });
      const sdkResponse = await client.models.generateContent({
        model: modelName,
        contents: [
          {
            role: 'user',
            parts: [
              {
                text: '请将这段音频完整转写为纯文本。不要总结，不要解释，不要补充格式，只返回转写结果。',
              },
              {
                inlineData: {
                  mimeType: fileMimeType || 'audio/mpeg',
                  data: Buffer.from(audioBuffer).toString('base64'),
                },
              },
            ],
          },
        ],
        config: {
          temperature: 0,
        },
      });
      const text = String(sdkResponse?.text || '').trim();
      return { text: text || null };
    }

    // Align with gateway-api-node OpenAI compat controller:
    // it accepts both multipart file upload and file_base64.
    if (isOfficialGatewayEndpoint) {
      const abortController = new AbortController();
      const timeout = setTimeout(() => abortController.abort(), 180000);
      try {
        const form = new FormData();
        form.set('model', modelName);
        form.set('task', 'transcribe');
        form.set(
          'file',
          new Blob([new Uint8Array(audioBuffer)], { type: fileMimeType || 'application/octet-stream' }),
          fileName || 'audio.wav',
        );
        const response = await fetch(endpointUrl, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${apiKey}`,
          },
          body: form,
          signal: abortController.signal,
        });
        const raw = await response.text().catch(() => '');
        console.log('[Transcription] official response', {
          status: response.status,
          statusText: response.statusText,
          bodyPreview: raw.slice(0, 500),
        });
        if (!response.ok) {
          return {
            text: null,
            error: `转录请求失败：HTTP ${response.status} ${response.statusText} | endpoint=${endpointUrl} | body=${raw || '(empty)'}`,
          };
        }
        const parsed = raw ? (() => {
          try {
            return JSON.parse(raw) as Record<string, unknown>;
          } catch {
            return {} as Record<string, unknown>;
          }
        })() : {};
        const text = String(
          parsed.text
          || (parsed.data && typeof parsed.data === 'object' ? (parsed.data as Record<string, unknown>).text : '')
          || ''
        ).trim();
        return { text: text || null };
      } finally {
        clearTimeout(timeout);
      }
    }

    const abortController = new AbortController();
    const timeout = setTimeout(() => abortController.abort(), 180000);
    try {
      const form = new FormData();
      form.set('model', modelName);
      form.set(
        'file',
        new Blob([new Uint8Array(audioBuffer)], { type: fileMimeType || 'application/octet-stream' }),
        fileName || 'audio.wav',
      );
      const response = await fetch(endpointUrl, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
        },
        body: form,
        signal: abortController.signal,
      });
      const raw = await response.text().catch(() => '');
      console.log('[Transcription] upstream response', {
        status: response.status,
        statusText: response.statusText,
        bodyPreview: raw.slice(0, 500),
      });
      if (!response.ok) {
        return {
          text: null,
          error: `转录请求失败：HTTP ${response.status} ${response.statusText} | endpoint=${endpointUrl} | body=${raw || '(empty)'}`,
        };
      }
      const parsed = raw ? (() => {
        try {
          return JSON.parse(raw) as Record<string, unknown>;
        } catch {
          return {} as Record<string, unknown>;
        }
      })() : {};
      const text = String(
        parsed.text
        || (parsed.data && typeof parsed.data === 'object' ? (parsed.data as Record<string, unknown>).text : '')
        || (parsed.result && typeof parsed.result === 'object' ? (parsed.result as Record<string, unknown>).text : '')
        || ''
      ).trim();
      return { text: text || null };
    } finally {
      clearTimeout(timeout);
    }
  } catch (error) {
    console.error('[Transcription] Failed to transcribe video:', error);
    const err = (error && typeof error === 'object') ? (error as Record<string, unknown>) : {};
    const maybeStatus = Number((err as { statusCode?: number }).statusCode || (err as { status?: number }).status || 0);
    const message = error instanceof Error ? error.message : String(error);
    const detail = Number.isFinite(maybeStatus) && maybeStatus > 0
      ? `${message} (status=${maybeStatus})`
      : message;
    return { text: null, error: `转录请求失败：${detail} | endpoint=${safeUrlJoin(endpoint, '/audio/transcriptions')}` };
  } finally {
    if (preparedAudioCleanup) {
      await preparedAudioCleanup();
    }
  }
};

const sanitizeFilenameSegment = (value: string) => {
  return value.replace(/[^a-zA-Z0-9-_]/g, '_');
};

const getArchiveDir = () => {
  const baseDir = getWorkspacePaths().base;
  return path.join(baseDir, 'archives');
};

const extractTagsFromText = (title = '', content = '') => {
  const tags = new Set<string>();
  const hashtagRegex = /#([^#\s]{1,20})#/g;
  const looseHashtagRegex = /#([^\s#]{1,20})/g;

  [title, content].forEach((text) => {
    let match;
    while ((match = hashtagRegex.exec(text))) {
      tags.add(match[1].trim());
    }
    while ((match = looseHashtagRegex.exec(text))) {
      tags.add(match[1].trim());
    }
  });

  title
    .split(/[\s,，。！？!?.、/|;；:：()\[\]【】]+/)
    .map((chunk) => chunk.trim())
    .filter((chunk) => chunk.length >= 2 && chunk.length <= 12)
    .forEach((chunk) => tags.add(chunk));

  return Array.from(tags).filter(Boolean).slice(0, 6);
};

ipcMain.handle('archives:list', async () => {
  return listArchiveProfiles();
});

ipcMain.handle('archives:create', async (_, data: {
  name: string;
  platform?: string;
  goal?: string;
  domain?: string;
  audience?: string;
  toneTags?: string[];
}) => {
  const id = `archive_${Date.now()}`;
  const created = createArchiveProfile({
    id,
    name: data.name,
    platform: data.platform || '',
    goal: data.goal || '',
    domain: data.domain || '',
    audience: data.audience || '',
    tone_tags: data.toneTags || []
  });
  emitRendererDataChanged('archives', { action: 'create', entityId: id });
  return created;
});

ipcMain.handle('archives:update', async (_, data: {
  id: string;
  name: string;
  platform?: string;
  goal?: string;
  domain?: string;
  audience?: string;
  toneTags?: string[];
}) => {
  const updated = updateArchiveProfile({
    id: data.id,
    name: data.name,
    platform: data.platform || '',
    goal: data.goal || '',
    domain: data.domain || '',
    audience: data.audience || '',
    tone_tags: data.toneTags || []
  });
  emitRendererDataChanged('archives', { action: 'update', entityId: data.id });
  return updated;
});

ipcMain.handle('archives:delete', async (_, profileId: string) => {
  deleteArchiveProfile(profileId);
  emitRendererDataChanged('archives', { action: 'delete', entityId: profileId });
  return { success: true };
});

ipcMain.handle('archives:samples:list', async (_, profileId: string) => {
  return listArchiveSamples(profileId);
});

ipcMain.handle('archives:samples:create', async (_, data: {
  profileId: string;
  title?: string;
  content?: string;
  tags?: string[];
  platform?: string;
  sourceUrl?: string;
  sampleDate?: string;
  isFeatured?: boolean;
}) => {
  const id = `sample_${Date.now()}`;
  const tags = data.tags && data.tags.length > 0
    ? data.tags
    : extractTagsFromText(data.title || '', data.content || '');
  const created = createArchiveSample({
    id,
    profile_id: data.profileId,
    title: data.title || '',
    content: data.content || '',
    excerpt: buildExcerpt(data.content),
    tags,
    images: [],
    platform: data.platform || '',
    source_url: data.sourceUrl || '',
    sample_date: data.sampleDate || new Date().toISOString().slice(0, 10),
    is_featured: data.isFeatured ? 1 : 0
  });
  emitRendererDataChanged('archives', { action: 'sample-create', entityId: id });
  return created;

  // Index the new sample
  // Fetch profile to get platform info
  const profiles = listArchiveProfiles();
  const profile = profiles.find(p => p.id === data.profileId) || { platform: data.platform };

  // Construct sample object for normalization (matching ArchiveSample interface approximately)
  const sampleObj = {
    id,
    profile_id: data.profileId,
    title: data.title,
    content: data.content,
    platform: data.platform,
    source_url: data.sourceUrl,
    sample_date: data.sampleDate,
    images: [], // Images not indexed for now
    created_at: Date.now()
  };

  indexManager.addToQueue(normalizeArchiveSample(sampleObj, profile));
});

ipcMain.handle('archives:samples:update', async (_, data: {
  id: string;
  profileId: string;
  title?: string;
  content?: string;
  tags?: string[];
  platform?: string;
  sourceUrl?: string;
  sampleDate?: string;
  isFeatured?: boolean;
}) => {
  const tags = data.tags && data.tags.length > 0
    ? data.tags
    : extractTagsFromText(data.title || '', data.content || '');
  const existingSamples = listArchiveSamples(data.profileId);
  const existingSample = existingSamples.find(sample => sample.id === data.id);
  const result = updateArchiveSample({
    id: data.id,
    profile_id: data.profileId,
    title: data.title || '',
    content: data.content || '',
    excerpt: buildExcerpt(data.content),
    tags,
    images: existingSample?.images || [],
    platform: data.platform || '',
    source_url: data.sourceUrl || '',
    sample_date: data.sampleDate || new Date().toISOString().slice(0, 10),
    is_featured: data.isFeatured ? 1 : 0
  });

  // Re-index the updated sample
  const profiles = listArchiveProfiles();
  const profile = profiles.find(p => p.id === data.profileId) || { platform: data.platform };

  const sampleObj = {
    id: data.id,
    profile_id: data.profileId,
    title: data.title,
    content: data.content,
    platform: data.platform,
    source_url: data.sourceUrl,
    sample_date: data.sampleDate,
    created_at: Date.now()
  };

  indexManager.addToQueue(normalizeArchiveSample(sampleObj, profile));

  emitRendererDataChanged('archives', { action: 'sample-update', entityId: data.id });
  return result;
});

ipcMain.handle('archives:samples:delete', async (_, sampleId: string) => {
  deleteArchiveSample(sampleId);
  emitRendererDataChanged('archives', { action: 'sample-delete', entityId: sampleId });
  return { success: true };
});

// --------- Vector Indexing Management ---------
// Forward status events to renderer
indexManager.on('status-update', (status) => {
  if (win) {
    win.webContents.send('indexing:status', status);
  }
});

ipcMain.handle('indexing:get-stats', async () => {
  return indexManager.getStatus();
});

ipcMain.handle('indexing:remove-item', async (_, itemId: string) => {
  indexManager.removeItem(itemId);
  return { success: true };
});

ipcMain.handle('indexing:clear-queue', async () => {
  indexManager.clearQueue();
  return { success: true };
});

ipcMain.handle('indexing:rebuild-all', async () => {
  const fs = require('fs/promises');

  // 1. Clear existing
  await indexManager.clearAndRebuild();

  // 2. Scan and re-add all items
  // (1) Knowledge Redbook
  try {
    const redbookDir = getKnowledgeRedbookDir();
    const dirs = await fs.readdir(redbookDir, { withFileTypes: true });
    for (const dir of dirs) {
      if (!dir.isDirectory()) continue;
      try {
        const metaPath = path.join(redbookDir, dir.name, 'meta.json');
        const metaContent = await fs.readFile(metaPath, 'utf-8');
        const meta = JSON.parse(metaContent);

        indexManager.addToQueue(normalizeNote(
          dir.name,
          meta,
          meta.indexText || meta.content || meta.transcript || ''
        ));
      } catch {}
    }
  } catch {}

  // (2) Knowledge YouTube
  try {
    const youtubeDir = getKnowledgeYoutubeDir();
    const dirs = await fs.readdir(youtubeDir, { withFileTypes: true });
    for (const dir of dirs) {
      if (!dir.isDirectory()) continue;
      try {
        const metaPath = path.join(youtubeDir, dir.name, 'meta.json');
        const metaContent = await fs.readFile(metaPath, 'utf-8');
        const meta = JSON.parse(metaContent);

        let content = meta.description || '';
        if (meta.subtitleFile) {
           try {
             const subtitle = await fs.readFile(path.join(youtubeDir, dir.name, meta.subtitleFile), 'utf-8');
             content += `\n\n${subtitle}`;
           } catch {}
        }

        indexManager.addToQueue(normalizeVideo(
          dir.name,
          meta,
          content,
          'user'
        ));
      } catch {}
    }
  } catch {}

  // (3) Archives
  try {
    const archiveDir = getArchiveDir();
    const profiles = listArchiveProfiles();
    for (const profile of profiles) {
      const samples = listArchiveSamples(profile.id);
      for (const sample of samples) {
        indexManager.addToQueue(normalizeArchiveSample(sample, profile));
      }
    }
  } catch {}

  // (4) Advisors Knowledge (Local Files & Videos)
  try {
    const advisorsDir = getWorkspacePaths().advisors;
    const advisors = await fs.readdir(advisorsDir, { withFileTypes: true });

    for (const advisor of advisors) {
      if (!advisor.isDirectory()) continue;
      const advisorId = advisor.name;
      const knowledgeDir = path.join(advisorsDir, advisorId, 'knowledge');
      const configPath = path.join(advisorsDir, advisorId, 'config.json');

      // 1. Local Files
      try {
        const files = await fs.readdir(knowledgeDir);
        for (const file of files) {
          // Skip if it looks like a YouTube video ID (handled below via config)
          // actually, downloadVideo saves as {videoId}.txt, so we can just index all txt/md
          if (file.endsWith('.txt') || file.endsWith('.md')) {
            const content = await fs.readFile(path.join(knowledgeDir, file), 'utf-8');
            const fileId = `${advisorId}_${file}`;
            indexManager.addToQueue(normalizeFile(fileId, file, content, 'advisor', advisorId));
          }
        }
      } catch {}

      // 2. YouTube Videos (via config.json)
      try {
        const configRaw = await fs.readFile(configPath, 'utf-8');
        const config = JSON.parse(configRaw);
        if (config.videos) {
          for (const video of config.videos) {
            if (video.status === 'success' && video.subtitleFile) {
              const subtitlePath = path.join(knowledgeDir, video.subtitleFile);
              try {
                const transcript = await fs.readFile(subtitlePath, 'utf-8');
                // Use normalizeVideo but force scope='advisor'
                indexManager.addToQueue(normalizeVideo(
                  video.id,
                  { ...video, videoId: video.id },
                  transcript,
                  'advisor',
                  advisorId
                ));
              } catch {}
            }
          }
        }
      } catch {}
    }
  } catch {}

  return { success: true };
});

ipcMain.handle('indexing:rebuild-advisor', async (_, advisorId: string) => {
  const fs = require('fs/promises');
  const advisorsDir = getWorkspacePaths().advisors;
  const advisorDir = path.join(advisorsDir, advisorId);
  const knowledgeDir = path.join(advisorDir, 'knowledge');
  const configPath = path.join(advisorDir, 'config.json');

  // 1. Remove existing vectors for this advisor
  // Note: We need a way to delete by advisorId.
  // Current DB deleteVectors takes sourceId.
  // We can iterate and delete, or just rely on overwrite since IDs are deterministic.
  // To be safe and clean, we should ideally support deleteByAdvisorId, but overwrite is fine for "rebuild".

  // 2. Index Local Files
  try {
    const files = await fs.readdir(knowledgeDir);
    for (const file of files) {
      if (file.endsWith('.txt') || file.endsWith('.md')) {
        const content = await fs.readFile(path.join(knowledgeDir, file), 'utf-8');
        const fileId = `${advisorId}_${file}`;
        indexManager.addToQueue(normalizeFile(fileId, file, content, 'advisor', advisorId));
      }
    }
  } catch (e) {
    console.warn(`[IndexAdvisor] No local files for ${advisorId}`);
  }

  // 3. Index YouTube Videos
  try {
    const configRaw = await fs.readFile(configPath, 'utf-8');
    const config = JSON.parse(configRaw);
    if (config.videos) {
      for (const video of config.videos) {
        if (video.status === 'success' && video.subtitleFile) {
          const subtitlePath = path.join(knowledgeDir, video.subtitleFile);
          try {
            const transcript = await fs.readFile(subtitlePath, 'utf-8');
            indexManager.addToQueue(normalizeVideo(
              video.id,
              { ...video, videoId: video.id },
              transcript,
              'advisor',
              advisorId
            ));
          } catch {}
        }
      }
    }
  } catch (e) {
    console.warn(`[IndexAdvisor] No config/videos for ${advisorId}`);
  }

  return { success: true };
});

// --------- Local HTTP Server for Plugin Integration ---------
import http from 'http'

const HTTP_PORT = 23456;
let httpServer: http.Server | null = null;

async function persistXhsNote(note: any): Promise<{ success: boolean; noteId?: string; error?: string }> {
  const fs = require('fs/promises');
  try {
    console.log('[xhs-save] incoming', {
      title: String(note?.title || ''),
      imageCount: Array.isArray(note?.images) ? note.images.length : 0,
      coverUrl: typeof note?.coverUrl === 'string' ? note.coverUrl.slice(0, 80) : '',
      videoUrl: typeof note?.videoUrl === 'string' ? note.videoUrl.slice(0, 120) : '',
      hasVideoDataUrl: typeof note?.videoDataUrl === 'string' && note.videoDataUrl.startsWith('data:'),
    });

    const noteId = note?.noteId || `note_${Date.now()}`;
    const noteDir = path.join(getKnowledgeRedbookDir(), noteId);
    await fs.mkdir(noteDir, { recursive: true });

    const noteContent = note?.content || note?.text || note?.noteText || '';
    const meta: {
      title: string;
      author: string;
      content: string;
      stats: { likes: number; collects?: number };
      images: string[];
      cover?: string;
      video?: string;
      videoUrl?: string;
      transcript?: string;
      transcriptFile?: string;
      transcriptionStatus?: 'processing' | 'completed' | 'failed';
      createdAt: string;
    } = {
      title: note?.title || '无标题',
      author: note?.author || '未知',
      content: noteContent || '',
      stats: note?.stats || { likes: 0, collects: 0 },
      images: [],
      createdAt: new Date().toISOString(),
    };

    if (note?.coverUrl && typeof note.coverUrl === 'string') {
      const imagesDir = path.join(noteDir, 'images');
      await fs.mkdir(imagesDir, { recursive: true });
      const coverPath = path.join(imagesDir, 'cover.jpg');
      try {
        if (note.coverUrl.startsWith('data:image')) {
          const base64Data = note.coverUrl.split(',')[1];
          await fs.writeFile(coverPath, Buffer.from(base64Data, 'base64'));
        } else if (note.coverUrl.startsWith('http')) {
          await downloadImageToFile(note.coverUrl, coverPath);
        }
        meta.cover = 'images/cover.jpg';
        meta.images.push(meta.cover);
      } catch (error) {
        console.error('Failed to download cover:', error);
      }
    }

    if (Array.isArray(note?.images)) {
      const imagesDir = path.join(noteDir, 'images');
      await fs.mkdir(imagesDir, { recursive: true });

      for (let i = 0; i < note.images.length; i++) {
        const imgData = note.images[i];
        if (!imgData || typeof imgData !== 'string') continue;
        const imgPath = path.join(imagesDir, `${i}.jpg`);
        if (imgData.startsWith('data:image')) {
          const base64Data = imgData.split(',')[1];
          await fs.writeFile(imgPath, Buffer.from(base64Data, 'base64'));
          meta.images.push(`images/${i}.jpg`);
        } else if (imgData.startsWith('http')) {
          try {
            await downloadImageToFile(imgData, imgPath);
            meta.images.push(`images/${i}.jpg`);
          } catch (error) {
            console.error('Failed to download image:', error);
            meta.images.push(imgData);
          }
        }
      }
    }

    if (!meta.cover && meta.images.length > 0) {
      meta.cover = meta.images[0];
    }

    if (note?.videoUrl && typeof note.videoUrl === 'string') {
      try {
        const videoName = 'video.mp4';
        const videoPath = path.join(noteDir, videoName);
        if (typeof note.videoDataUrl === 'string' && note.videoDataUrl.startsWith('data:')) {
          const base64Data = note.videoDataUrl.split(',')[1];
          await fs.writeFile(videoPath, Buffer.from(base64Data, 'base64'));
        } else {
          await downloadFile(note.videoUrl, videoPath);
        }
        await verifyVideoFileDecodable(videoPath);
        meta.video = videoName;
        meta.videoUrl = note.videoUrl;
        meta.transcriptionStatus = 'processing';
      } catch (error) {
        console.error('Failed to download video:', error);
        meta.transcriptionStatus = 'failed';
      }
    }

    const metaPath = path.join(noteDir, 'meta.json');
    await fs.writeFile(metaPath, JSON.stringify(meta, null, 2));
    await fs.writeFile(path.join(noteDir, 'content.md'), noteContent || '');

    indexManager.addToQueue(normalizeNote(noteId, meta, noteContent || ''));
    win?.webContents.send('knowledge:new-note', { noteId, title: meta.title });
    win?.webContents.send('knowledge-updated');

    if (meta.video) {
      await queueKnowledgeVideoTranscription({
        noteId,
        noteDir,
        metaPath,
        meta,
      });
    }

    return { success: true, noteId };
  } catch (error) {
    console.error('Failed to save note:', error);
    return { success: false, error: String(error) };
  }
}

function extractJsonObjectFromText(raw: string): Record<string, unknown> | null {
  const text = String(raw || '').trim();
  if (!text) return null;

  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
    if (fenced) {
      try {
        return JSON.parse(fenced) as Record<string, unknown>;
      } catch {}
    }
    const firstBrace = text.indexOf('{');
    const lastBrace = text.lastIndexOf('}');
    if (firstBrace >= 0 && lastBrace > firstBrace) {
      try {
        return JSON.parse(text.slice(firstBrace, lastBrace + 1)) as Record<string, unknown>;
      } catch {}
    }
  }

  return null;
}

async function summarizeYoutubeVideoFromSubtitle(input: {
  originalTitle: string;
  description: string;
  subtitleContent: string;
  videoUrl: string;
}): Promise<{ title: string; summary: string }> {
  const settings = (getSettings() || {}) as Record<string, unknown>;
  const apiKey = String(settings.api_key || '').trim();
  const baseURL = normalizeApiBaseUrl(String(settings.api_endpoint || ''), 'https://api.openai.com/v1');
  const model = String(settings.model_name || '').trim();

  const fallbackTitle = String(input.originalTitle || '未命名视频').trim() || '未命名视频';
  const fallbackSummary = String(input.subtitleContent || '').replace(/\s+/g, ' ').trim().slice(0, 120);

  if (!apiKey || !baseURL || !model) {
    return {
      title: fallbackTitle,
      summary: fallbackSummary,
    };
  }

  const subtitleExcerpt = String(input.subtitleContent || '').trim().slice(0, 12000);
  const systemPrompt = [
    '你是一个 YouTube 视频内容总结助手。',
    '你需要根据字幕内容，为用户生成中文标题和短摘要。',
    '输出要求：',
    '1. 只输出严格 JSON；',
    '2. JSON 顶层必须包含 title 和 summary；',
    '3. title 必须是自然中文标题，准确概括视频主题；',
    '4. summary 必须是 1-2 句中文摘要，便于用户快速理解视频内容；',
    '5. 不要输出 Markdown，不要解释。',
  ].join('\n');
  const userPrompt = [
    `原始标题：${fallbackTitle}`,
    input.description ? `视频描述：${String(input.description).trim().slice(0, 1200)}` : '',
    input.videoUrl ? `视频链接：${String(input.videoUrl).trim()}` : '',
    '',
    '字幕内容：',
    subtitleExcerpt,
  ].filter(Boolean).join('\n');

  const response = await fetch(safeUrlJoin(baseURL, '/chat/completions'), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      temperature: 0.3,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      response_format: { type: 'json_object' },
    }),
  });

  if (!response.ok) {
    const bodyText = await response.text().catch(() => '');
    throw new Error(`YouTube summary request failed (${response.status}): ${bodyText || response.statusText}`);
  }

  const payload = await response.json().catch(() => ({} as any));
  const content = String(payload?.choices?.[0]?.message?.content || '').trim();
  const parsed = extractJsonObjectFromText(content) || {};
  const title = String(parsed.title || '').trim() || fallbackTitle;
  const summary = String(parsed.summary || '').trim() || fallbackSummary;

  return { title, summary };
}

async function regenerateYoutubeSummaryForVideo(videoId: string): Promise<{ success: boolean; title?: string; summary?: string; skipped?: boolean; error?: string }> {
  const videoDir = path.join(getKnowledgeYoutubeDir(), videoId);
  const metaPath = path.join(videoDir, 'meta.json');

  try {
    const metaContent = await fs.readFile(metaPath, 'utf-8');
    const meta = JSON.parse(metaContent);
    if (!meta.subtitleFile) {
      return { success: true, skipped: true };
    }

    const subtitlePath = path.join(videoDir, meta.subtitleFile);
    const subtitleContent = await fs.readFile(subtitlePath, 'utf-8');
    if (!String(subtitleContent || '').trim()) {
      return { success: true, skipped: true };
    }

    meta.originalTitle = String(meta.originalTitle || meta.title || '').trim() || String(meta.title || '').trim();
    const summaryResult = await summarizeYoutubeVideoFromSubtitle({
      originalTitle: String(meta.originalTitle || meta.title || ''),
      description: String(meta.description || ''),
      subtitleContent,
      videoUrl: String(meta.videoUrl || ''),
    });

    meta.title = summaryResult.title;
    meta.summary = summaryResult.summary;
    await fs.writeFile(metaPath, JSON.stringify(meta, null, 2));

    win?.webContents.send('knowledge:youtube-video-updated', {
      noteId: videoId,
      status: String(meta.status || 'completed'),
      hasSubtitle: Boolean(meta.hasSubtitle),
      title: String(meta.title || ''),
      summary: String(meta.summary || ''),
    });

    return {
      success: true,
      title: String(meta.title || ''),
      summary: String(meta.summary || ''),
    };
  } catch (error) {
    return {
      success: false,
      error: String(error),
    };
  }
}

async function persistYoutubeNote(payload: {
  videoId?: string;
  videoUrl?: string;
  title?: string;
  description?: string;
  thumbnailUrl?: string;
}): Promise<{ success: boolean; noteId?: string; duplicate?: boolean; error?: string }> {
  const videoId = String(payload?.videoId || '').trim();
  if (!videoId) {
    return { success: false, error: 'Missing videoId' };
  }

  try {
    const ytdlpReady = await ensureYtdlpReadyForCapture(win);
    if (!ytdlpReady.ok) {
      return { success: false, error: ytdlpReady.error || 'yt-dlp 未就绪' };
    }

    await ensureKnowledgeYoutubeDir();
    const noteId = `youtube_${videoId}`;
    const videoDir = path.join(getKnowledgeYoutubeDir(), noteId);
    const metaPath = path.join(videoDir, 'meta.json');

    try {
      await fs.access(metaPath);
      console.log(`[YouTube] Video ${videoId} already exists, skipping`);
      return { success: true, noteId, duplicate: true };
    } catch {
      // 文件不存在，继续添加
    }

    await fs.mkdir(videoDir, { recursive: true });

    const initialMeta = {
      id: noteId,
      videoId,
      videoUrl: payload.videoUrl || `https://www.youtube.com/watch?v=${videoId}`,
      title: payload.title || 'Untitled Video',
      originalTitle: payload.title || 'Untitled Video',
      description: payload.description || '',
      summary: '',
      thumbnailUrl: payload.thumbnailUrl || '',
      thumbnail: '',
      subtitleFile: '',
      hasSubtitle: false,
      status: 'processing',
      createdAt: new Date().toISOString()
    };

    await fs.writeFile(metaPath, JSON.stringify(initialMeta, null, 2));
    win?.webContents.send('knowledge:new-youtube-video', { noteId, title: initialMeta.title, status: 'processing' });

    (async () => {
      console.log(`[YouTube] Starting background processing for ${videoId}`);
      let localThumbnail = '';
      let subtitleFile = '';
      let hasSubtitle = false;

      if (payload.thumbnailUrl) {
        try {
          const thumbnailPath = path.join(videoDir, 'thumbnail.jpg');
          await downloadImageToFile(payload.thumbnailUrl, thumbnailPath);
          localThumbnail = 'thumbnail.jpg';
          console.log(`[YouTube] Thumbnail downloaded for ${videoId}`);
        } catch (err) {
          console.error('[YouTube] Failed to download thumbnail:', err);
        }
      }

      try {
        const { queueSubtitleDownload } = await import('./core/subtitleQueue');
        console.log(`[YouTube] Downloading subtitle for ${videoId}...`);
        const subtitleResult = await queueSubtitleDownload(videoId, videoDir);
        if (subtitleResult.success && subtitleResult.subtitleFile) {
          subtitleFile = subtitleResult.subtitleFile;
          hasSubtitle = true;
          console.log(`[YouTube] Subtitle downloaded for ${videoId}: ${subtitleFile}`);

          try {
            const subtitleContent = await fs.readFile(path.join(videoDir, subtitleFile), 'utf-8');
            const summaryResult = await summarizeYoutubeVideoFromSubtitle({
              originalTitle: initialMeta.originalTitle,
              description: initialMeta.description,
              subtitleContent,
              videoUrl: initialMeta.videoUrl,
            });
            initialMeta.title = summaryResult.title;
            initialMeta.summary = summaryResult.summary;
          } catch (summaryError) {
            console.warn(`[YouTube] Failed to summarize subtitle for ${videoId}:`, summaryError);
          }
        } else {
          console.log(`[YouTube] No subtitle available for ${videoId}`);
        }
      } catch (err) {
        console.error('[YouTube] Failed to download subtitle:', err);
      }

      const finalMeta = {
        ...initialMeta,
        thumbnail: localThumbnail,
        subtitleFile,
        hasSubtitle,
        status: 'completed'
      };

      await fs.writeFile(metaPath, JSON.stringify(finalMeta, null, 2));
      console.log(`[YouTube] Processing completed for ${videoId}`);

      win?.webContents.send('knowledge:youtube-video-updated', {
        noteId,
        status: 'completed',
        hasSubtitle,
        thumbnail: localThumbnail,
        title: finalMeta.title,
        summary: finalMeta.summary || '',
      });
    })().catch(err => {
      console.error(`[YouTube] Background processing failed for ${videoId}:`, err);
      fs.writeFile(
        metaPath,
        JSON.stringify({ ...initialMeta, status: 'failed', error: String(err) }, null, 2)
      ).catch(() => {});
      win?.webContents.send('knowledge:youtube-video-updated', { noteId, status: 'failed' });
    });

    return { success: true, noteId };
  } catch (error) {
    console.error('Failed to save YouTube video:', error);
    return { success: false, error: String(error) };
  }
}

function startHttpServer() {
  const fs = require('fs/promises');

  httpServer = http.createServer(async (req, res) => {
    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    if (req.method === 'GET' && req.url === '/api/knowledge/health') {
      try {
        await ensureKnowledgeRedbookDir();
        await ensureKnowledgeYoutubeDir();
        const [redbookDirs, youtubeDirs, mediaAssets] = await Promise.all([
          fs.readdir(getKnowledgeRedbookDir(), { withFileTypes: true }).catch(() => []),
          fs.readdir(getKnowledgeYoutubeDir(), { withFileTypes: true }).catch(() => []),
          listMediaAssets(5000).catch(() => []),
        ]);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: true,
          status: 'ok',
          app: 'RedConvert',
          counts: {
            redbook: countTruthyDirectoryEntries(redbookDirs.filter((entry: fsSync.Dirent) => entry.isDirectory())),
            youtube: countTruthyDirectoryEntries(youtubeDirs.filter((entry: fsSync.Dirent) => entry.isDirectory())),
            media: Array.isArray(mediaAssets) ? mediaAssets.length : 0,
          },
        }));
      } catch (error) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: String(error) }));
      }
      return;
    }

    if (req.method === 'POST' && req.url === '/api/knowledge/entries') {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', async () => {
        try {
          const payload = JSON.parse(body || '{}') as KnowledgeEntryPayload;
          const result = await persistKnowledgeEntry(payload);
          if (!result.success) {
            throw new Error(result.error || '保存失败');
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            success: true,
            entryId: result.entryId,
            duplicate: Boolean(result.duplicate),
            updated: Boolean(result.updated),
          }));
        } catch (error) {
          console.error('Failed to persist knowledge entry:', error);
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: String(error) }));
        }
      });
      return;
    }

    if (req.method === 'POST' && req.url === '/api/knowledge/media-assets') {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', async () => {
        try {
          const payload = JSON.parse(body || '{}') as {
            items?: Array<{ title?: string; source?: string }>;
          };
          const items = Array.isArray(payload?.items)
            ? payload.items
                .map((item) => ({
                  title: String(item?.title || '').trim(),
                  source: String(item?.source || '').trim(),
                }))
                .filter((item) => item.source)
            : [];
          if (items.length === 0) {
            throw new Error('items is required');
          }
          const imported = await importMediaSources(items);
          emitRendererDataChanged('media', { action: 'import' });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            success: true,
            imported: imported.length,
            items: imported.map((asset) => ({
              id: asset.id,
              title: asset.title,
              mimeType: asset.mimeType,
              relativePath: asset.relativePath,
            })),
          }));
        } catch (error) {
          console.error('Failed to import media assets:', error);
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: String(error) }));
        }
      });
      return;
    }

    if (req.method === "POST" && req.url === "/api/save-text") {
      let body = "";
      req.on("data", chunk => { body += chunk; });
      req.on("end", async () => {
        try {
          const parsed = JSON.parse(body);
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            throw new Error('Invalid save-text payload: expected object');
          }
          const data = parsed as Record<string, any>;
          const isLinkArticle = String(data.type || '').trim() === 'link-article';
          const noteId = `${isLinkArticle ? 'link' : 'text'}_${Date.now()}`;
          const noteDir = path.join(getKnowledgeRedbookDir(), noteId);
          await fs.mkdir(noteDir, { recursive: true });
          const extractedArticle = isLinkArticle && String(data.captureKind || '').trim() !== 'wechat-article'
            ? extractArticleFromHtmlSnapshot({
                htmlSnapshot: String(data.htmlSnapshot || ''),
                url: String(data.url || ''),
                fallbackTitle: String(data.title || ''),
                fallbackExcerpt: String(data.excerpt || ''),
                fallbackAuthor: String(data.author || ''),
                fallbackSiteName: String(data.siteName || ''),
              })
            : null;

          const meta: {
            id: string;
            type: 'link-article' | 'text';
            captureKind?: string;
            htmlFile?: string;
            title: string;
            content: string;
            sourceUrl: string;
            siteName: string;
            excerpt: string;
            createdAt: string;
            author: string;
            stats: { likes: number; collects: number };
            images: string[];
            cover: string;
            tags?: string[];
          } = {
            id: noteId,
            type: isLinkArticle ? 'link-article' : 'text',
            captureKind: String(data.captureKind || '').trim() || undefined,
            title: extractedArticle?.title || data.title || (isLinkArticle ? 'Link Article' : 'Text Clipping'),
            content: extractedArticle?.markdown || data.text || "",
            sourceUrl: data.url || "",
            siteName: extractedArticle?.siteName || data.siteName || '',
            excerpt: extractedArticle?.excerpt || data.excerpt || '',
            createdAt: new Date().toISOString(),
            author: extractedArticle?.author || data.author || 'User',
            stats: { likes: 0, collects: 0 },
            images: [],
            cover: '',
            tags: Array.isArray(data.tags)
              ? data.tags.map((value: unknown) => String(value || '').trim()).filter(Boolean)
              : [],
          };
          if (isLinkArticle && !meta.tags?.includes('网页文章')) {
            meta.tags = [...(meta.tags || []), '网页文章'];
          }

          const imagesDir = path.join(noteDir, 'images');
          let nextImageIndex = 0;
          const persistedImageBySource = new Map<string, string>();
          const persistImage = async (imageSource: string, preferredName?: string) => {
            if (!imageSource || typeof imageSource !== 'string') return '';
            const normalizedSource = String(imageSource || '').trim();
            if (persistedImageBySource.has(normalizedSource)) {
              return persistedImageBySource.get(normalizedSource) || '';
            }
            await fs.mkdir(imagesDir, { recursive: true });
            const fileName = preferredName || `${nextImageIndex++}.jpg`;
            const outputPath = path.join(imagesDir, fileName);
            if (normalizedSource.startsWith('data:image')) {
              const base64Data = normalizedSource.split(',')[1];
              await fs.writeFile(outputPath, Buffer.from(base64Data, 'base64'));
              const relativePath = `images/${fileName}`;
              persistedImageBySource.set(normalizedSource, relativePath);
              return relativePath;
            }
            if (normalizedSource.startsWith('http')) {
              await downloadImageToFile(normalizedSource, outputPath);
              const relativePath = `images/${fileName}`;
              persistedImageBySource.set(normalizedSource, relativePath);
              return relativePath;
            }
            return '';
          };

          if (typeof data.coverUrl === 'string' && data.coverUrl.trim()) {
            try {
              const coverPath = await persistImage(data.coverUrl.trim(), 'cover.jpg');
              if (coverPath) {
                meta.cover = coverPath;
                meta.images.push(coverPath);
              }
            } catch (error) {
              console.error('Failed to persist link cover:', error);
            }
          }

          if (Array.isArray(data.images)) {
            for (const imageSource of data.images.slice(0, 8)) {
              try {
                const imagePath = await persistImage(String(imageSource || '').trim());
                if (imagePath && !meta.images.includes(imagePath)) {
                  meta.images.push(imagePath);
                }
              } catch (error) {
                console.error('Failed to persist link image:', error);
              }
            }
          }

          if (!meta.cover && meta.images.length > 0) {
            meta.cover = meta.images[0];
          }

          const richHtmlImageTokens = Array.isArray(data.richHtmlImageMap)
            ? data.richHtmlImageMap
                .map((entry: any) => ({
                  token: String(entry?.token || '').trim(),
                  url: String(entry?.url || '').trim(),
                }))
                .filter((entry: { token: string; url: string }) => entry.token && entry.url)
                .slice(0, 80)
            : [];

          if (String(data.captureKind || '').trim() === 'wechat-article' && String(data.richHtmlDocument || '').trim()) {
            const replacements: Array<{ token: string; localPath: string }> = [];
            for (const entry of richHtmlImageTokens) {
              try {
                const localPath = await persistImage(entry.url);
                if (localPath) {
                  if (!meta.images.includes(localPath)) {
                    meta.images.push(localPath);
                  }
                  replacements.push({ token: entry.token, localPath });
                }
              } catch (error) {
                console.error('Failed to persist wechat rich-html image:', error);
              }
            }

            const richHtmlDocument = absolutizeEmbeddedLocalAssetReferences(
              rewriteRichHtmlTokens(String(data.richHtmlDocument || ''), replacements),
              noteDir,
            );
            const htmlFile = 'content.html';
            await fs.writeFile(path.join(noteDir, htmlFile), richHtmlDocument, 'utf-8');
            meta.htmlFile = htmlFile;
            if (!meta.tags?.includes('公众号文章')) {
              meta.tags = [...(meta.tags || []), '公众号文章'];
            }
          } else if (isLinkArticle && extractedArticle?.contentHtml) {
            const htmlFile = 'content.html';
            const articleHtmlBody = await localizeGenericArticleHtml(
              extractedArticle.contentHtml,
              noteDir,
              persistImage,
              (localPath) => {
                if (!meta.images.includes(localPath)) {
                  meta.images.push(localPath);
                }
              },
            );
            if (!meta.cover && meta.images.length > 0) {
              meta.cover = meta.images[0];
            }
            const simpleArticleHtml = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${String(meta.title || 'Article')}</title>
  <style>
    :root { color-scheme: light; }
    * { box-sizing: border-box; }
    body { margin: 0; background: #f5f5f3; color: #1f2937; font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Helvetica Neue", Arial, sans-serif; line-height: 1.85; }
    .rb-article-shell { max-width: 820px; margin: 0 auto; padding: 28px 20px 60px; }
    .rb-article { background: #ffffff; border-radius: 18px; padding: 32px 28px 40px; box-shadow: 0 12px 32px rgba(15, 23, 42, 0.08); border: 1px solid rgba(15, 23, 42, 0.06); }
    .rb-article-title { margin: 0; font-size: 30px; line-height: 1.3; font-weight: 700; color: #111827; }
    .rb-article-meta { margin-top: 12px; font-size: 13px; color: #6b7280; }
    .rb-article-body { margin-top: 24px; font-size: 17px; color: #1f2937; word-break: break-word; }
    .rb-article-body img { max-width: 100%; height: auto; display: block; margin: 18px auto; border-radius: 14px; }
    .rb-article-body a { color: #0369a1; text-decoration: underline; text-underline-offset: 2px; }
    .rb-article-body pre { white-space: pre-wrap; background: #111827; color: #f9fafb; padding: 14px 16px; border-radius: 12px; overflow: auto; }
    .rb-article-body table { width: 100%; border-collapse: collapse; }
    .rb-article-body td, .rb-article-body th { border: 1px solid #d1d5db; padding: 10px 12px; vertical-align: top; }
  </style>
</head>
<body>
  <div class="rb-article-shell">
    <article class="rb-article">
      <h1 class="rb-article-title">${String(meta.title || 'Article')}</h1>
      <div class="rb-article-meta">${[meta.author, meta.siteName].filter(Boolean).join(' · ')}</div>
      <div class="rb-article-body">${articleHtmlBody}</div>
    </article>
  </div>
</body>
</html>`;
            await fs.writeFile(path.join(noteDir, htmlFile), simpleArticleHtml, 'utf-8');
            meta.htmlFile = htmlFile;
          }

          await fs.writeFile(path.join(noteDir, "meta.json"), JSON.stringify(meta, null, 2));
          await fs.writeFile(path.join(noteDir, "content.md"), meta.content || "");

          // Index the text
          indexManager.addToQueue(normalizeNote(noteId, meta, meta.content || ""));

          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ success: true, noteId }));

          // Notify renderer
          if (win) win.webContents.send("knowledge-updated");
        } catch (err) {
          console.error("Failed to save text:", err);
          res.writeHead(500);
          res.end(JSON.stringify({ error: (err as Error).message }));
        }
      });
      return;
    }
    if (req.method === 'POST' && req.url === '/api/notes') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', async () => {
        try {
          const note = JSON.parse(body);
          const result = await persistXhsNote(note);
          if (!result.success || !result.noteId) {
            throw new Error(result.error || '保存失败');
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, noteId: result.noteId }));
        } catch (error) {
          console.error('Failed to save note:', error);
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: String(error) }));
        }
      });
    } else if (req.method === 'GET' && req.url === '/api/archives') {
      const profiles = listArchiveProfiles().map((profile) => ({
        id: profile.id,
        name: profile.name,
        platform: profile.platform || '',
        goal: profile.goal || ''
      }));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, profiles }));
    } else if (req.method === 'POST' && req.url === '/api/archives/samples') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', async () => {
        try {
          const payload = JSON.parse(body);
          const profiles = listArchiveProfiles();
          let profileId = payload.profileId as string | undefined;
          if (!profileId && profiles.length === 1) {
            profileId = profiles[0].id;
          }
          if (!profileId || !profiles.find(profile => profile.id === profileId)) {
            throw new Error('未找到可用的档案，请先在桌面端创建档案');
          }

          const title = payload.title || '未命名笔记';
          const content = payload.content || '';
          const archiveDir = getArchiveDir();
          await fs.mkdir(archiveDir, { recursive: true });
          const sampleId = `sample_${Date.now()}`;
          const sampleDir = path.join(archiveDir, sanitizeFilenameSegment(profileId), sanitizeFilenameSegment(sampleId));
          const sampleImagesDir = path.join(sampleDir, 'images');
          await fs.mkdir(sampleImagesDir, { recursive: true });
          const imagePaths: string[] = [];

          if (payload.images && Array.isArray(payload.images)) {
            for (let i = 0; i < payload.images.length; i++) {
              const imgUrl = payload.images[i];
              if (!imgUrl || typeof imgUrl !== 'string') continue;
              const imgPath = path.join(sampleImagesDir, `${i}.jpg`);
              if (imgUrl.startsWith('data:image')) {
                const base64Data = imgUrl.split(',')[1];
                await fs.writeFile(imgPath, Buffer.from(base64Data, 'base64'));
                imagePaths.push(path.relative(archiveDir, imgPath));
              } else if (imgUrl.startsWith('http')) {
                try {
                  await downloadImageToFile(imgUrl, imgPath);
                  imagePaths.push(path.relative(archiveDir, imgPath));
                } catch (error) {
                  console.error('Failed to download archive image:', error);
                }
              }
            }
          }

          const sample = createArchiveSample({
            id: sampleId,
            profile_id: profileId,
            title,
            content,
            excerpt: buildExcerpt(content),
            tags: extractTagsFromText(title, content),
            images: imagePaths,
            platform: payload.platform || '小红书',
            source_url: payload.source || '',
            sample_date: new Date().toISOString().slice(0, 10),
            is_featured: payload.isFeatured ? 1 : 0
          });

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, sampleId: sample.id }));
          win?.webContents.send('archives:sample-created', { profileId, sampleId: sample.id });

          // Index the new sample
          // Fetch profile to get platform info
          const profile = profiles.find(p => p.id === profileId) || { platform: payload.platform };

          // Construct sample object for normalization (matching ArchiveSample interface approximately)
          const sampleObj = {
            id: sampleId,
            profile_id: profileId,
            title: title,
            content: content,
            platform: payload.platform,
            source_url: payload.source,
            sample_date: payload.sampleDate,
            images: [], // Images not indexed for now
            created_at: Date.now()
          };

          indexManager.addToQueue(normalizeArchiveSample(sampleObj, profile));

        } catch (error) {
          console.error('Failed to save archive sample:', error);
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: String(error) }));
        }
      });
    } else if (req.method === 'GET' && req.url === '/api/status') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', app: 'RedConvert' }));
    } else if (req.method === 'POST' && req.url === '/api/youtube-notes') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', async () => {
        try {
          const data = JSON.parse(body || '{}');
          const result = await persistYoutubeNote(data);
          if (!result.success) {
            throw new Error(result.error || '保存失败');
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(result));
        } catch (error) {
          console.error('Failed to save YouTube video:', error);
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: String(error) }));
        }
      });
    } else {
      res.writeHead(404);
      res.end('Not Found');
    }
  });

  httpServer.listen(HTTP_PORT, '127.0.0.1', () => {
    try {
      console.log(`HTTP Server running at http://127.0.0.1:${HTTP_PORT}`);
    } catch {}
  });

  httpServer.on('error', (err) => {
    try {
      console.error('HTTP Server error:', err);
    } catch {}
  });
}

ipcMain.handle('xhs:save-note', async (_event, note: any) => {
  return persistXhsNote(note);
});

ipcMain.handle('youtube:save-note', async (_event, payload: {
  videoId?: string;
  videoUrl?: string;
  title?: string;
  description?: string;
  thumbnailUrl?: string;
}) => {
  return persistYoutubeNote(payload);
});

app.whenReady().then(() => {
  ensureKnowledgeRedbookDir();
  ensureKnowledgeYoutubeDir();
  startHttpServer();
});
