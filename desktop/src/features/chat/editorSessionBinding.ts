type TimelineClipLike = Record<string, unknown>;
type MasterRecordLike = Record<string, unknown>;

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
  richpostThemeId?: string | null;
  richpostThemeLabel?: string | null;
  richpostThemesFile?: string | null;
  richpostThemeRoot?: string | null;
  richpostThemeConfigFile?: string | null;
  richpostThemeTemplateFile?: string | null;
  richpostThemeAssetsDir?: string | null;
  richpostThemeTokensFile?: string | null;
  richpostThemeMastersDir?: string | null;
  richpostThemeMasters?: MasterRecordLike[] | null;
  richpostThemePagePlanFile?: string | null;
  richpostPagesDir?: string | null;
  contentMapFile?: string | null;
  layoutTokensFile?: string | null;
  richpostMastersDir?: string | null;
  richpostMasters?: MasterRecordLike[] | null;
  richpostPagePlanFile?: string | null;
  longformLayoutPresetId?: string | null;
  longformLayoutPresetLabel?: string | null;
};

export type EditorAiWorkspaceMode = {
  id: string;
  label: string;
  activeSkills: string[];
  themeEditingId?: string | null;
  themeEditingLabel?: string | null;
  themeEditingRoot?: string | null;
  themeEditingFile?: string | null;
  themeEditingTemplateFile?: string | null;
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

function text(value: unknown): string {
  return String(value || '').trim();
}

function stringOrNull(value: unknown): string | null {
  const normalized = text(value);
  return normalized ? normalized : null;
}

function list<T>(value: T[] | null | undefined): T[] {
  return Array.isArray(value) ? value : [];
}

function pickDraftTitle(params: BuildEditorSessionBindingParams): string {
  return text(params.editorTitle) || text(params.fileFallbackTitle) || '未命名';
}

function isThemeEditingMode(params: BuildEditorSessionBindingParams): boolean {
  return params.draftType === 'richpost' && params.editorAiWorkspaceMode.id === 'richpost-theme-editing';
}

function resolveThemeEditingRoot(themeEditingFile: string | null, explicitRoot: string | null): string | null {
  if (explicitRoot) return explicitRoot;
  if (!themeEditingFile) return null;
  const normalized = themeEditingFile.replace(/\\/g, '/');
  const lastSlashIndex = normalized.lastIndexOf('/');
  if (lastSlashIndex <= 0) return null;
  return normalized.slice(0, lastSlashIndex);
}

function resolveModeLabel(params: BuildEditorSessionBindingParams, themeEditing: boolean): string {
  const workspaceModeLabel = text(params.editorAiWorkspaceMode.label);
  if (workspaceModeLabel) return workspaceModeLabel;
  if (themeEditing) return '主题编辑';
  switch (params.draftType) {
    case 'video':
      return '视频编辑';
    case 'audio':
      return '音频编辑';
    case 'longform':
      return '长文编辑';
    case 'richpost':
      return '图文编辑';
    default:
      return '文件编辑';
  }
}

function resolveTargetTypeLabel(params: BuildEditorSessionBindingParams, themeEditing: boolean): string {
  if (themeEditing) return '主题文件';
  switch (params.draftType) {
    case 'video':
      return '视频工程';
    case 'audio':
      return '音频工程';
    case 'longform':
      return '长文稿件';
    case 'richpost':
      return '图文稿件';
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

function currentThemeMasterIds(packageState?: PackageStateLike | null): string[] {
  return list(packageState?.richpostThemeMasters)
    .map((item) => text(item?.id))
    .filter(Boolean);
}

function findMasterFile(items: MasterRecordLike[] | null | undefined, masterId: string, fallback: string): string {
  const exact = list(items).find((item) => text(item?.id) === masterId);
  return text(exact?.file) || fallback;
}

export function buildEditorSessionBinding(
  params: BuildEditorSessionBindingParams,
): EditorSessionBindingRequest | null {
  const editorFile = text(params.editorFile);
  if (!editorFile) return null;

  const draftType = text(params.draftType) || 'unknown';
  const themeEditing = isThemeEditingMode(params);
  const themeSessionId = text(params.editorAiWorkspaceMode.themeEditingId)
    || text(params.editorAiWorkspaceMode.themeEditingLabel)
    || 'draft';
  const themeSessionTitle = text(params.editorAiWorkspaceMode.themeEditingLabel) || '当前主题';
  const themeEditingFile = themeEditing
    ? stringOrNull(params.editorAiWorkspaceMode.themeEditingFile) || stringOrNull(params.packageState?.richpostThemeConfigFile)
    : null;
  const themeEditingRoot = themeEditing
    ? resolveThemeEditingRoot(
        themeEditingFile,
        stringOrNull(params.editorAiWorkspaceMode.themeEditingRoot) || stringOrNull(params.packageState?.richpostThemeRoot),
      )
    : null;
  const themeEditingTokensFile = themeEditing && themeEditingRoot ? `${themeEditingRoot}/layout.tokens.json` : null;
  const themeEditingPagePlanFile = themeEditing && themeEditingRoot ? `${themeEditingRoot}/page-plan.json` : null;
  const themeEditingAssetsDir = themeEditing && themeEditingRoot ? `${themeEditingRoot}/assets` : null;
  const themeEditingMasterFiles = themeEditing && themeEditingRoot
    ? [
        `${themeEditingRoot}/masters/cover.master.html`,
        `${themeEditingRoot}/masters/body.master.html`,
        `${themeEditingRoot}/masters/ending.master.html`,
      ]
    : [];
  const themeEditingTemplateFile = themeEditing
    ? stringOrNull(params.packageState?.richpostThemeTemplateFile) || stringOrNull(params.editorAiWorkspaceMode.themeEditingTemplateFile)
    : null;
  const { packageAssets, timelineClips, timelineTrackNames } = resolveMediaSummaries(params);
  const modeLabel = resolveModeLabel(params, themeEditing);
  const targetTypeLabel = resolveTargetTypeLabel(params, themeEditing);
  const associatedFilePath = themeEditing
    ? text(themeEditingRoot || themeEditingFile || editorFile)
    : editorFile;
  const currentTitle = pickDraftTitle(params);
  const activeSkills = Array.from(new Set(list(params.editorAiWorkspaceMode.activeSkills).map((item) => text(item)).filter(Boolean)));
  const isMediaDraft = draftType === 'video' || draftType === 'audio';
  const currentMasters = currentThemeMasterIds(params.packageState);

  const metadata: Record<string, unknown> = {
    editorBindingVersion: 1,
    editorBindingKind: themeEditing ? 'theme' : 'file',
    contextType: themeEditing ? 'richpost-theme-editing' : 'file',
    contextId: themeEditing ? `richpost-theme:${themeSessionId}` : editorFile,
    isContextBound: true,
    allowedTools: themeEditing ? ['app_cli', 'redbox_fs'] : undefined,
    associatedFilePath,
    associatedPackageFilePath: editorFile,
    associatedPackageKind: draftType,
    agentProfile: draftType === 'video' ? 'video-editor' : draftType === 'audio' ? 'audio-editor' : 'default',
    associatedPackageTitle: currentTitle,
    associatedPackageWorkspaceMode: text(params.editorAiWorkspaceMode.id),
    associatedPackageWorkspaceModeLabel: text(params.editorAiWorkspaceMode.label),
    associatedPackagePromptProfile:
      draftType === 'richpost' && text(params.editorAiWorkspaceMode.id) === 'richpost-theme-editing'
        ? 'richpost-theme-editor'
        : text(params.editorAiWorkspaceMode.id),
    associatedPackageRequiredSkills: activeSkills,
    activeSkills,
    associatedPackageThemeId:
      draftType === 'richpost'
        ? themeEditing
          ? stringOrNull(params.editorAiWorkspaceMode.themeEditingId)
          : stringOrNull(params.packageState?.richpostThemeId)
        : draftType === 'longform'
          ? stringOrNull(params.packageState?.longformLayoutPresetId)
          : null,
    associatedPackageThemeLabel:
      draftType === 'richpost'
        ? themeEditing
          ? stringOrNull(params.editorAiWorkspaceMode.themeEditingLabel)
          : stringOrNull(params.packageState?.richpostThemeLabel)
        : draftType === 'longform'
          ? stringOrNull(params.packageState?.longformLayoutPresetLabel)
          : null,
    associatedPackageAppliedThemeId:
      draftType === 'richpost'
        ? stringOrNull(params.packageState?.richpostThemeId)
        : draftType === 'longform'
          ? stringOrNull(params.packageState?.longformLayoutPresetId)
          : null,
    associatedPackageAppliedThemeLabel:
      draftType === 'richpost'
        ? stringOrNull(params.packageState?.richpostThemeLabel)
        : draftType === 'longform'
          ? stringOrNull(params.packageState?.longformLayoutPresetLabel)
          : null,
    associatedPackageThemeEditingId: draftType === 'richpost' && themeEditing ? stringOrNull(params.editorAiWorkspaceMode.themeEditingId) : null,
    associatedPackageThemeEditingLabel: draftType === 'richpost' && themeEditing ? stringOrNull(params.editorAiWorkspaceMode.themeEditingLabel) : null,
    associatedPackageThemeEditingRoot: draftType === 'richpost' && themeEditing ? themeEditingRoot : null,
    associatedPackageThemeEditingFile: draftType === 'richpost' && themeEditing ? themeEditingFile : null,
    associatedPackageThemeEditingTemplateFile: draftType === 'richpost' && themeEditing ? themeEditingTemplateFile : null,
    associatedPackageThemeEditingTargetFiles:
      draftType === 'richpost' && themeEditing
        ? {
            themeRoot: themeEditingRoot,
            themeIndexFile: stringOrNull(params.packageState?.richpostThemesFile),
            themeFile: themeEditingFile,
            templateGuideFile: themeEditingTemplateFile,
            layoutTokensFile: themeEditingTokensFile,
            pagePlanFile: themeEditingPagePlanFile,
            assetsDir: themeEditingAssetsDir,
            masterFiles: themeEditingMasterFiles,
          }
        : null,
    associatedPackageThemeRoot: draftType === 'richpost' && themeEditing ? themeEditingRoot : null,
    associatedPackageContentSource:
      draftType === 'richpost' || draftType === 'longform'
        ? text(params.packageState?.manifest?.entry || 'content.md')
        : editorFile,
    associatedPackageStyleTargets:
      draftType === 'richpost'
        ? themeEditing
          ? [
              String(themeEditingRoot || params.packageState?.richpostThemeRoot || '<workspace>/themes/<theme-id>/'),
              String(themeEditingFile || params.packageState?.richpostThemeConfigFile || params.packageState?.richpostThemesFile || '<workspace>/themes/<theme-id>/<theme-id>.json'),
              String(themeEditingTemplateFile || '<workspace>/themes/richpost-theme-template.md'),
              String(themeEditingTokensFile || '<workspace>/themes/<theme-id>/layout.tokens.json'),
              ...(themeEditingMasterFiles.length ? themeEditingMasterFiles : [
                '<workspace>/themes/<theme-id>/masters/cover.master.html',
                '<workspace>/themes/<theme-id>/masters/body.master.html',
                '<workspace>/themes/<theme-id>/masters/ending.master.html',
              ]),
              String(themeEditingPagePlanFile || '<workspace>/themes/<theme-id>/page-plan.json'),
              String(themeEditingAssetsDir || '<workspace>/themes/<theme-id>/assets'),
            ]
          : [
              'manifest.richpostThemeId',
              'layout.tokens.json',
              'masters/*.master.html',
              'richpost-page-plan.json',
              'pages/page-xxx.html',
              'layout.html',
            ]
        : draftType === 'longform'
          ? ['manifest.longformLayoutPresetId', 'layout.html', 'wechat.html']
          : [],
    associatedPackageStyleEditRule:
      draftType === 'richpost'
        ? themeEditing
          ? '当前处于图文主题编辑模式。先阅读 richpost-theme-template.md 里的规则，再修改当前工作区主题 root 里的 <theme-id>.json。优先修改 <workspace>/themes/<theme-id>/<theme-id>.json、layout.tokens.json 与首页、内容页、尾页母版；只有在母版、tokens 和 frame 不足以达成目标时，才调整 page-plan.json。不要改正文，也不要手写渲染产物。'
          : '修改图文主题或排版时，只能改 richpostThemeId、layout.tokens.json、masters、richpost-page-plan.json 或生成后的图文页面 HTML，不能改 content.md 的正文内容。'
        : draftType === 'longform'
          ? '修改长文排版时，优先改 longformLayoutPresetId；需要细调时只改 layout/wechat HTML 资产，不能改正文 Markdown 内容。'
          : null,
    associatedPackageStructure:
      draftType === 'richpost'
        ? themeEditing
          ? {
              themeCatalogFile: text(params.packageState?.richpostThemesFile || '<workspace>/themes/index.json'),
              themeTemplateGuideFile: text(themeEditingTemplateFile || '<workspace>/themes/richpost-theme-template.md'),
              themeRoot: text(themeEditingRoot || params.packageState?.richpostThemeRoot || '<workspace>/themes/<theme-id>/'),
              themeConfig: text(themeEditingFile || params.packageState?.richpostThemeConfigFile || params.packageState?.richpostThemesFile || '<workspace>/themes/<theme-id>/<theme-id>.json'),
              themeAssetsDir: text(themeEditingAssetsDir || '<workspace>/themes/<theme-id>/assets'),
              layoutTokens: text(themeEditingTokensFile || '<workspace>/themes/<theme-id>/layout.tokens.json'),
              mastersDir: text(themeEditingRoot ? `${themeEditingRoot}/masters/*.master.html` : '<workspace>/themes/<theme-id>/masters/*.master.html'),
              coverMaster: text(themeEditingRoot ? `${themeEditingRoot}/masters/cover.master.html` : '<workspace>/themes/<theme-id>/masters/cover.master.html'),
              bodyMaster: text(themeEditingRoot ? `${themeEditingRoot}/masters/body.master.html` : '<workspace>/themes/<theme-id>/masters/body.master.html'),
              endingMaster: text(themeEditingRoot ? `${themeEditingRoot}/masters/ending.master.html` : '<workspace>/themes/<theme-id>/masters/ending.master.html'),
              pagePlan: text(themeEditingPagePlanFile || '<workspace>/themes/<theme-id>/page-plan.json'),
              themeEditableFrames: ['coverFrame', 'bodyFrame', 'endingFrame'],
              templateEditingFocus: ['cover', 'body', 'ending'],
              currentMasters,
            }
          : {
              contentSource: text(params.packageState?.manifest?.entry || 'content.md'),
              contentMap: text(params.packageState?.contentMapFile || 'content-map.json'),
              themeCatalogFile: text(params.packageState?.richpostThemesFile || '<workspace>/themes/index.json'),
              themeTemplateGuideFile: text(params.packageState?.richpostThemeTemplateFile || params.editorAiWorkspaceMode.themeEditingTemplateFile || '<workspace>/themes/richpost-theme-template.md'),
              themeRoot: text(themeEditingRoot || params.packageState?.richpostThemeRoot || '<workspace>/themes/<theme-id>/'),
              themeConfig: text(themeEditingFile || params.packageState?.richpostThemeConfigFile || params.packageState?.richpostThemesFile || '<workspace>/themes/<theme-id>/<theme-id>.json'),
              themeAssetsDir: text(params.packageState?.richpostThemeAssetsDir || '<workspace>/themes/<theme-id>/assets'),
              layoutTokens: text(params.packageState?.richpostThemeTokensFile || params.packageState?.layoutTokensFile || '<workspace>/themes/<theme-id>/layout.tokens.json'),
              mastersDir: text(params.packageState?.richpostThemeMastersDir || params.packageState?.richpostMastersDir || '<workspace>/themes/<theme-id>/masters/*.master.html'),
              coverMaster: findMasterFile(params.packageState?.richpostThemeMasters, 'cover',
                findMasterFile(params.packageState?.richpostMasters, 'cover', '<workspace>/themes/<theme-id>/masters/cover.master.html')),
              bodyMaster: findMasterFile(params.packageState?.richpostThemeMasters, 'body',
                findMasterFile(params.packageState?.richpostMasters, 'body', '<workspace>/themes/<theme-id>/masters/body.master.html')),
              endingMaster: findMasterFile(params.packageState?.richpostThemeMasters, 'ending',
                findMasterFile(params.packageState?.richpostMasters, 'ending', '<workspace>/themes/<theme-id>/masters/ending.master.html')),
              pagePlan: text(params.packageState?.richpostThemePagePlanFile || params.packageState?.richpostPagePlanFile || '<workspace>/themes/<theme-id>/page-plan.json'),
              previewShell: 'layout.html',
              pagesDir: text(params.packageState?.richpostPagesDir || 'pages/page-xxx.html'),
              themeSource: 'manifest.richpostThemeId',
              themeEditableFrames: ['coverFrame', 'bodyFrame', 'endingFrame'],
              templateEditingFocus: [],
              currentMasters,
            }
        : draftType === 'longform'
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
      scope: themeEditing ? 'context' : 'file',
      filePath: themeEditing ? undefined : editorFile,
      contextType: themeEditing ? 'richpost-theme-editing' : 'file',
      contextId: themeEditing ? `richpost-theme:${themeSessionId}` : editorFile,
      title: themeEditing ? `主题编辑 · ${themeSessionTitle}` : currentTitle,
      modeLabel,
      targetTypeLabel,
      targetPath: associatedFilePath,
    },
    metadata,
  };
}
