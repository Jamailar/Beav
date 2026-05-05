type TimelineClipLike = Record<string, unknown>;
type PackageStateLike = {
  manifest?: Record<string, unknown> | null;
  assets?: { items?: Array<Record<string, unknown>> } | null;
  timelineSummary?: {
    trackNames?: string[];
    clips?: TimelineClipLike[];
    clipCount?: number;
  } | null;
  editorProject?: {
    ai?: {
      scriptApproval?: {
        status?: string | null;
      } | null;
    } | null;
  } | null;
  videoProject?: {
    scriptApproval?: {
      status?: string | null;
    } | null;
  } | null;
  contentMapFile?: string | null;
  layoutTokensFile?: string | null;
  longformLayoutPresetId?: string | null;
  longformLayoutPresetLabel?: string | null;
};

export type EditorAiWorkspaceMode = {
  id: string;
  label: string;
  activeSkills: string[];
};

export type EditorSessionBindingRequest = {
  session: {
    scope: 'file' | 'context';
    filePath?: string;
    contextType: string;
    contextId: string;
    title?: string;
    modeLabel?: string;
    targetTypeLabel?: string;
    targetPath?: string;
    initialContext?: string;
  };
  metadata: Record<string, unknown>;
};

type BuildEditorSessionBindingParams = {
  editorFile: string | null;
  draftType?: string | null;
  editorTitle?: string | null;
  fileFallbackTitle?: string | null;
  editorAiWorkspaceMode: EditorAiWorkspaceMode;
  packageState?: PackageStateLike | null;
  editorBodyDirty: boolean;
};

const WRITING_EDITOR_ALLOWED_TOOLS = ['app_cli'];
const WRITING_EDITOR_ALLOWED_APP_CLI_ACTIONS = ['manuscripts.writeCurrent'];

function text(value: unknown): string {
  return String(value || '').trim();
}

function list<T>(value: T[] | null | undefined): T[] {
  return Array.isArray(value) ? value : [];
}

function pickDraftTitle(params: BuildEditorSessionBindingParams): string {
  return text(params.editorTitle) || text(params.fileFallbackTitle) || '未命名';
}

function resolveModeLabel(params: BuildEditorSessionBindingParams): string {
  const workspaceModeLabel = text(params.editorAiWorkspaceMode.label);
  if (workspaceModeLabel) return workspaceModeLabel;
  switch (params.draftType) {
    case 'video':
      return '视频编辑';
    case 'audio':
      return '音频编辑';
    case 'longform':
      return '长文编辑';
    default:
      return '文件编辑';
  }
}

function resolveTargetTypeLabel(params: BuildEditorSessionBindingParams): string {
  switch (params.draftType) {
    case 'video':
      return '视频工程';
    case 'audio':
      return '音频工程';
    case 'longform':
      return '长文稿件';
    default:
      return '文件';
  }
}

function resolveMediaSummaries(params: BuildEditorSessionBindingParams) {
  const packageAssets = list(params.packageState?.assets?.items);
  const timelineClips = list(params.packageState?.timelineSummary?.clips);
  const trackNamesFromSummary = list(params.packageState?.timelineSummary?.trackNames);
  const timelineTrackNames = trackNamesFromSummary.length
    ? trackNamesFromSummary
    : Array.from(new Set(
        timelineClips
          .map((item) => text(item?.track))
          .filter(Boolean),
      ));
  return {
    packageAssets,
    timelineClips,
    timelineTrackNames,
  };
}

function resolveScriptApprovalStatus(params: BuildEditorSessionBindingParams): string {
  if (params.draftType === 'video' || params.draftType === 'audio') {
    return text(params.packageState?.videoProject?.scriptApproval?.status)
      || text(params.packageState?.editorProject?.ai?.scriptApproval?.status)
      || 'pending';
  }
  return params.editorBodyDirty ? 'pending' : 'draft';
}

function isWritingDraftType(draftType: string): boolean {
  return draftType === 'longform';
}

function authoringProjectKindForDraft(draftType: string): string | null {
  if (draftType === 'longform') return 'redarticle';
  return null;
}

function resolveAuthoringContentPath(editorFile: string, packageState?: PackageStateLike | null): string {
  const entry = text(packageState?.manifest?.entry || 'content.md') || 'content.md';
  return `${editorFile.replace(/\/+$/, '')}/${entry.replace(/^\/+/, '')}`;
}

export function buildEditorSessionBinding(
  params: BuildEditorSessionBindingParams,
): EditorSessionBindingRequest | null {
  const editorFile = text(params.editorFile);
  if (!editorFile) return null;

  const draftType = text(params.draftType) || 'unknown';
  const { packageAssets, timelineClips, timelineTrackNames } = resolveMediaSummaries(params);
  const modeLabel = resolveModeLabel(params);
  const targetTypeLabel = resolveTargetTypeLabel(params);
  const associatedFilePath = editorFile;
  const currentTitle = pickDraftTitle(params);
  const activeSkills = Array.from(new Set(list(params.editorAiWorkspaceMode.activeSkills).map((item) => text(item)).filter(Boolean)));
  const isMediaDraft = draftType === 'video' || draftType === 'audio';
  const isWritingDraft = isWritingDraftType(draftType);
  const authoringProjectKind = isWritingDraft ? authoringProjectKindForDraft(draftType) : null;
  const authoringContentPath = isWritingDraft ? resolveAuthoringContentPath(editorFile, params.packageState) : null;

  const metadata: Record<string, unknown> = {
    editorBindingVersion: 1,
    editorBindingKind: 'file',
    contextType: 'file',
    contextId: editorFile,
    isContextBound: true,
    allowedTools: WRITING_EDITOR_ALLOWED_TOOLS,
    allowedAppCliActions: WRITING_EDITOR_ALLOWED_APP_CLI_ACTIONS,
    associatedFilePath,
    associatedPackageFilePath: editorFile,
    associatedPackageKind: draftType,
    agentProfile: draftType === 'video'
      ? 'video-editor'
      : draftType === 'audio'
        ? 'audio-editor'
        : isWritingDraft
          ? 'manuscript-editor'
          : 'default',
    associatedPackageTitle: currentTitle,
    currentAuthoringProjectPath: isWritingDraft ? editorFile : null,
    currentAuthoringContentPath: authoringContentPath,
    currentAuthoringEntryPath: authoringContentPath,
    currentAuthoringProjectKind: authoringProjectKind,
    currentAuthoringTitle: isWritingDraft ? currentTitle : null,
    associatedPackageWorkspaceMode: text(params.editorAiWorkspaceMode.id),
    associatedPackageWorkspaceModeLabel: text(params.editorAiWorkspaceMode.label),
    associatedPackagePromptProfile: text(params.editorAiWorkspaceMode.id),
    associatedPackageRequiredSkills: activeSkills,
    activeSkills,
    associatedPackageLayoutPresetId: draftType === 'longform' ? text(params.packageState?.longformLayoutPresetId) || null : null,
    associatedPackageLayoutPresetLabel: draftType === 'longform' ? text(params.packageState?.longformLayoutPresetLabel) || null : null,
    associatedPackageContentSource:
      draftType === 'longform'
        ? text(params.packageState?.manifest?.entry || 'content.md')
        : editorFile,
    associatedPackageStyleTargets:
      draftType === 'longform'
          ? ['manifest.longformLayoutPresetId', 'layout.html', 'wechat.html']
          : [],
    associatedPackageStyleEditRule:
      draftType === 'longform'
          ? '修改长文排版时，优先改 longformLayoutPresetId；需要细调时只改 layout/wechat HTML 资产，不能改正文 Markdown 内容。'
          : null,
    associatedPackageStructure:
      draftType === 'longform'
          ? {
              contentSource: text(params.packageState?.manifest?.entry || 'content.md'),
              masterSource: 'manifest.longformLayoutPresetId',
              layoutTarget: 'layout.html',
              wechatTarget: 'wechat.html',
            }
          : null,
    associatedPackageAssetCount: packageAssets.length,
    associatedPackageClipCount: isMediaDraft ? Number(params.packageState?.timelineSummary?.clipCount || timelineClips.length || 0) : 0,
    associatedPackageScriptApprovalStatus: resolveScriptApprovalStatus(params),
    associatedPackageTrackNames: isMediaDraft ? timelineTrackNames : [],
    associatedPackageClips: isMediaDraft
      ? timelineClips.slice(0, 12).map((item) => ({
          assetId: item?.assetId,
          name: item?.name,
          track: item?.track,
          order: item?.order,
          durationMs: item?.durationMs,
          trimInMs: item?.trimInMs,
          trimOutMs: item?.trimOutMs,
          enabled: item?.enabled,
        }))
      : [],
  };

  return {
    session: {
      scope: 'file',
      filePath: editorFile,
      contextType: 'file',
      contextId: editorFile,
      title: currentTitle,
      modeLabel,
      targetTypeLabel,
      targetPath: associatedFilePath,
    },
    metadata,
  };
}
