import type { AuthoringTaskHints } from '../../utils/redclawAuthoring';

export type ViewType =
  | 'skills'
  | 'knowledge'
  | 'settings'
  | 'archives'
  | 'wander'
  | 'redclaw'
  | 'media-library'
  | 'cover-studio'
  | 'generation-studio'
  | 'subjects'
  | 'automation'
  | 'approval';

export type AppShellViewType = ViewType;
export type ImmersiveMode = false | 'theme' | 'dark';
export type TeamSection = 'team-workbench' | 'members';

export type SettingsNavigationTarget = {
  tab?: 'general' | 'ai' | 'team' | 'platforms' | 'skills' | 'tools' | 'profile' | 'memory' | 'remote' | 'mcp' | 'experimental';
  aiModelSubTab?: 'custom' | 'login';
  nonce: number;
};

export type RedClawNavigationAction = {
  action: 'new' | 'open-team' | 'open-session';
  sessionId?: string;
  nonce: number;
};

export interface GenerationIntent {
  mode: 'image' | 'video' | 'cover';
  source: 'standalone' | 'generation_studio' | 'media-library' | 'manuscripts' | 'cover-studio' | 'cover_studio' | 'tool' | 'redclaw';
  sourceTitle?: string;
  bindTarget?: {
    manuscriptPath?: string;
    projectId?: string;
  };
  preset?: {
    aspectRatio?: string;
    resolution?: '720p' | '1080p';
    durationSeconds?: number;
  };
}

export interface PendingChatMessage {
  content: string;
  displayContent?: string;
  sessionRouting?: 'current' | 'new';
  deliveryMode?: 'send' | 'draft';
  taskHints?: AuthoringTaskHints;
  knowledgeReferences?: Array<{
    id: string;
    title: string;
    sourceKind?: string;
    summary?: string;
    cover?: string;
    sourceUrl?: string;
    folderPath?: string;
    rootPath?: string;
    tags?: string[];
    updatedAt?: string;
    fileCount?: number;
    hasTranscript?: boolean;
  }>;
  attachment?: {
    type: 'youtube-video';
    title: string;
    thumbnailUrl?: string;
    videoId?: string;
  } | {
    type: 'wander-references';
    title?: string;
    items: Array<{
      title: string;
      itemType: 'note' | 'video';
      tag?: string;
      folderPath?: string;
      summary?: string;
      cover?: string;
    }>;
  } | {
    type: 'uploaded-file';
    attachmentId?: string;
    name: string;
    ext?: string;
    size?: number;
    thumbnailDataUrl?: string;
    inlineDataUrl?: string;
    workspaceRelativePath?: string;
    toolPath?: string;
    absolutePath?: string;
    originalAbsolutePath?: string;
    localUrl?: string;
    kind?: 'text' | 'image' | 'audio' | 'video' | 'document' | 'binary' | string;
    mimeType?: string;
    storageMode?: 'staged' | string;
    directUploadEligible?: boolean;
    processingStrategy?: string;
    deliveryMode?: 'direct-input' | 'tool-read';
    intakeStatus?: 'ready' | 'unsupported' | 'failed' | string;
    capabilities?: Record<string, boolean | undefined>;
    deliveryPlan?: {
      mode?: string;
      toolPath?: string;
      toolName?: string;
      requiresTool?: boolean;
      reason?: string;
    };
    summary?: string;
    requiresMultimodal?: boolean;
  };
  attachments?: Array<{
    type: 'uploaded-file';
    name: string;
    attachmentId?: string;
    workspaceRelativePath?: string;
    toolPath?: string;
    absolutePath?: string;
    originalAbsolutePath?: string;
    localUrl?: string;
    inlineDataUrl?: string;
    thumbnailDataUrl?: string;
    kind?: string;
    mimeType?: string;
    size?: number;
    ext?: string;
    storageMode?: string;
    directUploadEligible?: boolean;
    processingStrategy?: string;
    deliveryMode?: string;
    intakeStatus?: string;
    capabilities?: Record<string, boolean | undefined>;
    deliveryPlan?: Record<string, unknown>;
    summary?: string;
    requiresMultimodal?: boolean;
    attachmentLifecycle?: string;
  }>;
}

export type StartupMigrationState = {
  status?: string;
  needsDbImport?: boolean;
  needsProjectUpgrade?: boolean;
  shouldShowModal?: boolean;
  legacyDbPath?: string | null;
  legacyWorkspacePath?: string | null;
  workspacePath?: string | null;
  currentStep?: string | null;
  message?: string | null;
  error?: string | null;
  progress?: number;
  legacyMarkdownCount?: number | null;
  importedCounts?: Record<string, number> | null;
  projectUpgradeCounts?: Record<string, number> | null;
};

export type AppIntent =
  | {
      type: 'settings.open';
      tab?: SettingsNavigationTarget['tab'];
      aiModelSubTab?: SettingsNavigationTarget['aiModelSubTab'];
    }
  | {
      type: 'redclaw.open';
      action?: RedClawNavigationAction['action'];
      sessionId?: string;
    }
  | {
      type: 'approval.open';
      requestId?: string;
      docketId?: string;
      escalationId?: string;
    }
  | {
      type: 'view.open';
      view: ViewType;
      skillsAction?: 'open-market';
    }
  | {
      type: 'generation.open';
      intent: GenerationIntent;
    }
  | {
      type: 'manuscript.open';
      manuscriptPath: string;
    };

export type LegacyNavigateEventDetail = {
  view?: ViewType;
  settingsTab?: SettingsNavigationTarget['tab'];
  aiModelSubTab?: SettingsNavigationTarget['aiModelSubTab'];
  skillsAction?: 'open-market';
  redclawAction?: RedClawNavigationAction['action'];
  action?: RedClawNavigationAction['action'] | 'open-market';
  teamSessionId?: string;
  sessionId?: string;
  requestId?: string;
  docketId?: string;
  escalationId?: string;
  intent?: GenerationIntent;
  manuscriptPath?: string;
};

export type AppNavigateEventDetail = AppIntent | LegacyNavigateEventDetail;
