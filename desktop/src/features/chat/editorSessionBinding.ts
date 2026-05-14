type TimelineClipLike = Record<string, unknown>;
type PackageStateLike = {
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
};

export type EditorAiWorkspaceMode = {
  id: string;
  label: string;
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

const WRITING_EDITOR_ALLOWED_TOOLS = ['workflow'];
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
  const isMediaDraft = draftType === 'video' || draftType === 'audio';

  const metadata: Record<string, unknown> = {
    editorBindingVersion: 1,
    editorBindingKind: 'file',
    contextType: 'file',
    contextId: editorFile,
    isContextBound: true,
    intent: 'manuscript_editing',
    allowedTools: WRITING_EDITOR_ALLOWED_TOOLS,
    allowedAppCliActions: WRITING_EDITOR_ALLOWED_APP_CLI_ACTIONS,
    writeTarget: 'manuscripts://current',
    allowedWriteTargets: ['manuscripts://current'],
    associatedFilePath,
    agentProfile: draftType === 'video'
      ? 'video-editor'
      : draftType === 'audio'
        ? 'audio-editor'
        : draftType === 'longform'
          ? 'manuscript-editor'
          : 'default',
    sourceManuscriptPath: editorFile,
    sourceManuscriptTitle: currentTitle,
    sourceManuscriptDraftType: draftType,
    currentAuthoringProjectPath: editorFile,
    currentAuthoringContentPath: editorFile,
    currentAuthoringEntryPath: editorFile,
    currentAuthoringTitle: currentTitle,
    editorWorkspaceMode: text(params.editorAiWorkspaceMode.id),
    editorWorkspaceModeLabel: text(params.editorAiWorkspaceMode.label),
    mediaAssetCount: packageAssets.length,
    mediaClipCount: isMediaDraft ? Number(params.packageState?.timelineSummary?.clipCount || timelineClips.length || 0) : 0,
    editorApprovalStatus: resolveScriptApprovalStatus(params),
    mediaTrackNames: isMediaDraft ? timelineTrackNames : [],
    mediaClips: isMediaDraft
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

  if (isMediaDraft) {
    metadata.associatedPackageFilePath = editorFile;
    metadata.associatedPackageKind = draftType;
    metadata.associatedPackageTitle = currentTitle;
    metadata.associatedPackageWorkspaceMode = text(params.editorAiWorkspaceMode.id);
    metadata.associatedPackageWorkspaceModeLabel = text(params.editorAiWorkspaceMode.label);
    metadata.associatedPackageClipCount = metadata.mediaClipCount;
    metadata.associatedPackageScriptApprovalStatus = metadata.editorApprovalStatus;
    metadata.associatedPackageTrackNames = metadata.mediaTrackNames;
    metadata.associatedPackageClips = metadata.mediaClips;
  }

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
