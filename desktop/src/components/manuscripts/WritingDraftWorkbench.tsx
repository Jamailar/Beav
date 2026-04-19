import { lazy, Suspense, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import clsx from 'clsx';
import {
  Columns,
  Download,
  FileText,
  Image as ImageIcon,
  Loader2,
  MessageSquare,
  Sparkles,
  X,
} from 'lucide-react';
import { toPng } from 'html-to-image';
import { CodeMirrorEditor } from './CodeMirrorEditor';
import { MarkdownItPreview } from './MarkdownItPreview';
import { WritingDiffProposalPanel } from './WritingDiffProposalPanel';
import { resolveAssetUrl } from '../../utils/pathManager';
import { appAlert } from '../../utils/appDialogs';

const ChatWorkspace = lazy(async () => ({
  default: (await import('../../pages/Chat')).Chat,
}));

type WritingDraftType = 'longform' | 'richpost' | 'unknown';
type WritingWorkbenchTab = 'manuscript' | 'layout' | 'wechat' | 'richpost' | 'article-card';

type HtmlPreviewSource = {
  filePath?: string | null;
  fileUrl?: string | null;
  exists?: boolean;
  hasContent?: boolean;
  updatedAt?: number | null;
};

type RichPostPagePreview = {
  id: string;
  label: string;
  template?: string | null;
  title?: string | null;
  summary?: string | null;
  filePath?: string | null;
  fileUrl?: string | null;
  exists?: boolean;
  updatedAt?: number | null;
};

type MediaAssetLike = {
  id: string;
  title?: string;
  relativePath?: string;
  absolutePath?: string;
  previewUrl?: string;
};

type RichpostThemePreset = {
  id?: string;
  label?: string;
  description?: string | null;
  surfaceColor?: string | null;
  textColor?: string | null;
  accentColor?: string | null;
  headingFont?: string | null;
  bodyFont?: string | null;
};

type LongformLayoutPreset = {
  id?: string;
  label?: string;
  description?: string | null;
  surfaceColor?: string | null;
  textColor?: string | null;
  accentColor?: string | null;
};

type AiWorkspaceMode = {
  id: string;
  label: string;
  activeSkills: string[];
};

export interface WritingDraftWorkbenchProps {
  draftType: WritingDraftType;
  title: string;
  filePath: string;
  editorBody: string;
  writeProposal?: {
    id: string;
    createdAt?: string | null;
    baseBody: string;
    proposedBody: string;
    isStale?: boolean;
  } | null;
  editorBodyDirty: boolean;
  isSavingEditorBody: boolean;
  isApplyingWriteProposal?: boolean;
  isRejectingWriteProposal?: boolean;
  editorChatSessionId: string | null;
  isActive?: boolean;
  previewHtml?: string | null;
  layoutPreview?: HtmlPreviewSource | null;
  wechatPreview?: HtmlPreviewSource | null;
  richpostPages?: RichPostPagePreview[];
  richpostThemeId?: string | null;
  richpostFontScale?: number | null;
  richpostLineHeightScale?: number | null;
  richpostThemePresets?: RichpostThemePreset[];
  isApplyingRichpostTheme?: boolean;
  longformLayoutPresetId?: string | null;
  longformLayoutPresets?: LongformLayoutPreset[];
  isApplyingLongformLayoutPreset?: boolean;
  hasGeneratedHtml?: boolean;
  coverAsset?: MediaAssetLike | null;
  imageAssets?: MediaAssetLike[];
  onEditorBodyChange: (value: string) => void;
  onAcceptWriteProposal?: () => void;
  onRejectWriteProposal?: () => void;
  onAiWorkspaceModeChange?: (mode: AiWorkspaceMode) => void;
  onSelectRichpostTheme?: (themeId: string) => void;
  onUpdateRichpostTypography?: (settings: { fontScale: number; lineHeightScale: number }) => void | Promise<void>;
  onSelectLongformLayoutPreset?: (presetId: string, target: 'layout' | 'wechat') => void;
}

const LONGFORM_SHORTCUTS = [
  { label: '润色结构', text: '请先阅读当前长文内容，重新整理段落结构，并给出更清晰的起承转合。' },
  { label: '压缩篇幅', text: '请在保留核心观点的前提下，把当前长文压缩成更利于阅读的版本。' },
  { label: '扩写重点', text: '请找出当前长文最值得展开的部分，并直接补全为更完整的正文。' },
  { label: '公众号风格', text: '请把当前长文改成更适合公众号阅读和排版的表达方式。' },
];

const RICHPOST_SHORTCUTS = [
  { label: '改小红书风格', text: '请把当前图文稿改成更适合小红书发布的语言节奏和段落形式。' },
  { label: '重写标题', text: '请基于当前图文稿，输出一组更抓人的标题和首屏文案。' },
  { label: '压成卡片段落', text: '请把当前图文内容压缩成更适合卡片式阅读的短段落结构。' },
  { label: '图文配合', text: '请根据当前稿件内容，建议每一段适合配什么图，并直接调整文案节奏。' },
];

const RICHPOST_LAYOUT_SKILL_NAME = 'richpost-layout-designer';
const LONGFORM_LAYOUT_SKILL_NAME = 'longform-layout-designer';
const PRESET_PREVIEW_TITLE = 'RedBox';
const PRESET_PREVIEW_BODY = '用 AI 生产高质量内容。';
const RICHPOST_FONT_SCALE_MIN = 0.8;
const RICHPOST_FONT_SCALE_MAX = 1.6;
const RICHPOST_LINE_HEIGHT_SCALE_MIN = 0.8;
const RICHPOST_LINE_HEIGHT_SCALE_MAX = 1.4;

function clampScale(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.min(max, Math.max(min, Number(value.toFixed(2))));
}

function normalizePreviewColor(value: string | null | undefined, fallback: string): string {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function toRgba(value: string | null | undefined, alpha: number, fallback: string): string {
  const normalized = normalizePreviewColor(value, '').replace(/^#/, '');
  if (!normalized) return fallback;
  const expanded = normalized.length === 3
    ? normalized.split('').map((char) => char + char).join('')
    : normalized;
  if (!/^[0-9a-fA-F]{6}$/.test(expanded)) {
    return fallback;
  }
  const red = parseInt(expanded.slice(0, 2), 16);
  const green = parseInt(expanded.slice(2, 4), 16);
  const blue = parseInt(expanded.slice(4, 6), 16);
  return `rgba(${red}, ${green}, ${blue}, ${alpha})`;
}

type PresetPreviewThumbnailProps = {
  surfaceColor?: string | null;
  textColor?: string | null;
  accentColor?: string | null;
  headingFont?: string | null;
  bodyFont?: string | null;
  active?: boolean;
};

function PresetPreviewThumbnail({
  surfaceColor,
  textColor,
  accentColor,
  headingFont,
  bodyFont,
  active = false,
}: PresetPreviewThumbnailProps) {
  const surface = normalizePreviewColor(surfaceColor, '#ffffff');
  const text = normalizePreviewColor(textColor, '#111111');
  const accent = normalizePreviewColor(accentColor, text);
  const shellBorder = toRgba(text, active ? 0.16 : 0.08, 'rgba(17,17,17,0.08)');
  const shellGlow = toRgba(accent, active ? 0.22 : 0.14, 'rgba(17,17,17,0.10)');
  const accentWash = toRgba(accent, 0.12, 'rgba(17,17,17,0.06)');
  const divider = toRgba(accent, 0.82, accent);
  const bodyTone = toRgba(text, 0.78, text);

  const pageStyle: CSSProperties = {
    background: `linear-gradient(180deg, ${accentWash} 0%, ${surface} 38%, ${surface} 100%)`,
    borderColor: shellBorder,
    boxShadow: `0 16px 36px ${shellGlow}`,
    color: text,
  };
  const headingStyle: CSSProperties = {
    color: text,
    fontFamily: normalizePreviewColor(headingFont, bodyFont || ''),
  };
  const bodyStyle: CSSProperties = {
    color: bodyTone,
    fontFamily: normalizePreviewColor(bodyFont, headingFont || ''),
  };

  return (
    <div className="pointer-events-none w-full select-none">
      <div className="aspect-[3/4] border px-4 py-5" style={pageStyle}>
        <div className="flex h-full flex-col">
          <div className="text-[20px] font-semibold leading-[1.1]" style={headingStyle}>
            {PRESET_PREVIEW_TITLE}
          </div>
          <div className="mt-3 h-px w-12" style={{ background: divider }} />
          <div className="mt-4 text-[11px] leading-[1.85]" style={bodyStyle}>
            {PRESET_PREVIEW_BODY}
          </div>
        </div>
      </div>
    </div>
  );
}

function assetUrl(asset?: MediaAssetLike | null): string {
  return resolveAssetUrl(asset?.previewUrl || asset?.relativePath || asset?.absolutePath || '');
}

function buildRichpostExportImagePath(basePath: string, pageIndex: number): string {
  const normalized = String(basePath || '').trim();
  if (!normalized) return '';
  const match = normalized.match(/^(.*?)(\.[^.\\/]+)?$/);
  const stem = (match?.[1] || normalized).split(/[\\/]/).filter(Boolean).pop() || 'richpost-export';
  return `${stem}-${String(pageIndex + 1).padStart(3, '0')}.png`;
}

function buildRichpostExportPageReadPath(packageFilePath: string, pageId: string): string {
  const normalizedPackagePath = String(packageFilePath || '').trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  return `${normalizedPackagePath}/pages/${pageId}.html`;
}

function injectRichpostExportScale(html: string, fontScale: number, lineHeightScale: number): string {
  const normalizedFontScale = clampScale(fontScale, RICHPOST_FONT_SCALE_MIN, RICHPOST_FONT_SCALE_MAX);
  const normalizedLineHeightScale = clampScale(lineHeightScale, RICHPOST_LINE_HEIGHT_SCALE_MIN, RICHPOST_LINE_HEIGHT_SCALE_MAX);
  const scaleScript = `<script>(()=>{const apply=()=>{document.documentElement.style.setProperty('--rb-font-scale','${normalizedFontScale}');document.documentElement.style.setProperty('--rb-line-height-scale','${normalizedLineHeightScale}');const host=document.querySelector('.rb-page-host');if(!host)return;const computed=window.getComputedStyle(host);const rawBase=Number.parseFloat((computed.getPropertyValue('--rb-body-line-height')||'').trim()||'1.9');const base=Number.isFinite(rawBase)?rawBase:1.9;host.style.setProperty('--rb-runtime-body-line-height',String((base*${normalizedLineHeightScale}).toFixed(3)));};if(document.readyState==='loading'){document.addEventListener('DOMContentLoaded',apply,{once:true});}else{apply();}})();</script>`;
  if (/<\/body>/i.test(html)) {
    return html.replace(/<\/body>/i, `${scaleScript}</body>`);
  }
  return `${html}${scaleScript}`;
}

async function waitForIframeContentReady(frame: HTMLIFrameElement): Promise<Document> {
  const doc = await new Promise<Document>((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      cleanup();
      reject(new Error('导出页加载超时'));
    }, 15000);
    const cleanup = () => {
      window.clearTimeout(timeout);
      frame.removeEventListener('load', handleLoad);
      frame.removeEventListener('error', handleError);
    };
    const handleLoad = () => {
      cleanup();
      if (!frame.contentDocument) {
        reject(new Error('导出页加载失败'));
        return;
      }
      resolve(frame.contentDocument);
    };
    const handleError = () => {
      cleanup();
      reject(new Error('导出页加载失败'));
    };
    frame.addEventListener('load', handleLoad, { once: true });
    frame.addEventListener('error', handleError, { once: true });
  });

  const fonts = (doc as Document & { fonts?: { ready?: Promise<unknown> } }).fonts;
  if (fonts?.ready) {
    await fonts.ready.catch(() => undefined);
  }
  await Promise.all(
    Array.from(doc.images).map((image) => (
      image.complete
        ? Promise.resolve()
        : new Promise<void>((resolve) => {
            const done = () => resolve();
            image.addEventListener('load', done, { once: true });
            image.addEventListener('error', done, { once: true });
          })
    ))
  );
  await new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  });
  return doc;
}

async function loadRichpostExportPageHtml(
  packageFilePath: string,
  pageId: string,
  fontScale: number,
  lineHeightScale: number
): Promise<string> {
  const readPath = buildRichpostExportPageReadPath(packageFilePath, pageId);
  const result = await window.ipcRenderer.invoke('manuscripts:read', readPath) as { content?: string };
  const html = String(result?.content || '');
  if (!html.trim()) {
    throw new Error(`第 ${pageId} 页 HTML 为空`);
  }
  return injectRichpostExportScale(html, fontScale, lineHeightScale);
}

function TextScaleIcon({ large = false }: { large?: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={clsx(
        'select-none font-semibold leading-none tracking-[-0.04em]',
        large ? 'text-[17px]' : 'text-[13px]'
      )}
    >
      A
    </span>
  );
}

function LineHeightIcon({ expanded = false }: { expanded?: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={clsx(
        'inline-flex flex-col justify-center',
        expanded ? 'gap-[3px]' : 'gap-[1px]'
      )}
    >
      <span className="h-px w-3 bg-current" />
      <span className="h-px w-3 bg-current" />
      <span className="h-px w-3 bg-current" />
    </span>
  );
}

async function renderRichpostHtmlToPng(html: string, pageId: string): Promise<string> {
  void pageId;
  const frame = document.createElement('iframe');
  frame.srcdoc = html;
  frame.sandbox.add('allow-scripts', 'allow-same-origin', 'allow-popups', 'allow-popups-to-escape-sandbox');
  frame.style.position = 'fixed';
  frame.style.left = '-20000px';
  frame.style.top = '0';
  frame.style.width = '1080px';
  frame.style.height = '1440px';
  frame.style.border = '0';
  frame.style.opacity = '0';
  frame.style.pointerEvents = 'none';
  frame.style.background = '#ffffff';
  document.body.appendChild(frame);
  try {
    const doc = await waitForIframeContentReady(frame);
    const target = (doc.querySelector('.page') || doc.body) as HTMLElement | null;
    if (!target) {
      throw new Error('未找到可导出的页面内容');
    }
    const dataUrl = await toPng(target, {
      cacheBust: true,
      pixelRatio: 1,
      width: 1080,
      height: 1440,
      canvasWidth: 1080,
      canvasHeight: 1440,
      backgroundColor: '#ffffff',
    });
    return dataUrl;
  } finally {
    frame.remove();
  }
}

function buildPreviewFrameUrl(
  source?: string | null,
  updatedAt?: number | null,
  extraParams?: Record<string, string | number | null | undefined>
): string {
  const resolved = resolveAssetUrl(source || '');
  if (!resolved) return '';
  const params = new URLSearchParams();
  if (updatedAt) {
    params.set('v', String(updatedAt));
  }
  if (extraParams) {
    Object.entries(extraParams).forEach(([key, value]) => {
      if (value === null || value === undefined || value === '') return;
      params.set(key, String(value));
    });
  }
  const query = params.toString();
  if (!query) return resolved;
  return `${resolved}${resolved.includes('?') ? '&' : '?'}${query}`;
}

function MarkdownPreview({ content }: { content: string }) {
  return (
    <div className="mx-auto w-full max-w-[880px]">
      <MarkdownItPreview content={content} />
    </div>
  );
}

const RICHPOST_PREVIEW_SANDBOX = 'allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox';

function RichPostPreview({
  title,
  editorBody,
  previewHtml,
  previewSource,
  pagePreviews,
  coverAsset,
  imageAssets,
  hasGeneratedHtml,
  fontScale = 1,
  lineHeightScale = 1,
  compact = false,
}: {
  title: string;
  editorBody: string;
  previewHtml?: string | null;
  previewSource?: HtmlPreviewSource | null;
  pagePreviews?: RichPostPagePreview[];
  coverAsset?: MediaAssetLike | null;
  imageAssets: MediaAssetLike[];
  hasGeneratedHtml?: boolean;
  fontScale?: number;
  lineHeightScale?: number;
  compact?: boolean;
}) {
  const galleryAssets = imageAssets.slice(0, 4);
  const coverSrc = assetUrl(coverAsset);
  const iframeHeight = compact
    ? 'min(840px, calc(100vh - 220px))'
    : 'min(960px, calc(100vh - 144px))';
  const previewFrameUrl = buildPreviewFrameUrl(
    previewSource?.fileUrl || previewSource?.filePath,
    previewSource?.updatedAt,
    { fontScale, lineHeightScale }
  );
  const hasHtmlFile = Boolean(previewSource?.exists);
  const hasPreviewContent = Boolean(previewSource?.hasContent || previewHtml?.trim());
  const pages = pagePreviews || [];
  const hasRenderedPages = pages.some((page) => page.exists && (page.fileUrl || page.filePath));

  return (
    <div className={clsx('h-full overflow-auto', compact ? 'px-4 py-4' : 'px-8 py-8')}>
      <div className={clsx('mx-auto w-full space-y-5', compact ? 'max-w-[520px]' : 'max-w-[560px]')}>
        {hasRenderedPages ? (
          <div className="space-y-4">
            {pages.map((page) => {
              const frameUrl = buildPreviewFrameUrl(page.fileUrl || page.filePath, page.updatedAt, {
                fontScale,
                lineHeightScale,
              });
              return (
                <section key={page.id} className="border border-border bg-surface-primary p-4 shadow-sm">
                  {frameUrl ? (
                    <iframe
                      title={page.title || page.label}
                      src={frameUrl}
                      sandbox={RICHPOST_PREVIEW_SANDBOX}
                      className="w-full border border-border bg-white"
                      style={{ aspectRatio: '3 / 4', height: 'auto' }}
                    />
                  ) : (
                    <div className="flex aspect-[3/4] items-center justify-center border border-dashed border-border bg-white text-sm text-text-tertiary">
                      页面尚未渲染
                    </div>
                  )}
                </section>
              );
            })}
          </div>
        ) : null}
        {hasHtmlFile && !hasPreviewContent ? (
          <div className="rounded-2xl border border-dashed border-border bg-surface-primary px-6 py-10 text-center">
            <div className="text-sm font-medium text-text-primary">图文预览尚未渲染</div>
            <div className="mt-2 text-sm leading-6 text-text-tertiary">
              生成分页方案后会在这里渲染多页预览。
            </div>
          </div>
        ) : !hasRenderedPages && previewFrameUrl ? (
          <iframe
            title="图文预览"
            src={previewFrameUrl}
            sandbox={RICHPOST_PREVIEW_SANDBOX}
            className="w-full border border-border bg-white"
            style={{ height: iframeHeight }}
          />
        ) : !hasRenderedPages && previewHtml?.trim() ? (
          <iframe
            title="图文预览"
            srcDoc={previewHtml}
            sandbox={RICHPOST_PREVIEW_SANDBOX}
            className="w-full border border-border bg-white"
            style={{ height: iframeHeight }}
          />
        ) : !hasRenderedPages ? (
          <div className="space-y-5 border border-border bg-surface-primary p-6">
            {coverSrc ? (
              <img src={coverSrc} alt={title} className="h-64 w-full object-cover" />
            ) : null}
            <h1 className="text-[28px] font-semibold leading-tight tracking-tight text-text-primary">{title}</h1>
            <MarkdownPreview content={editorBody} />
            {galleryAssets.length > 0 ? (
              <div className="grid grid-cols-2 gap-3">
                {galleryAssets.map((asset) => (
                  <img
                    key={asset.id}
                    src={assetUrl(asset)}
                    alt={asset.title || asset.id}
                    className="h-36 w-full border border-border object-cover"
                  />
                ))}
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function LongformPreview({
  title,
  editorBody,
  previewHtml,
  previewSource,
  coverAsset,
  hasGeneratedHtml,
  previewLabel,
  compact = false,
}: {
  title: string;
  editorBody: string;
  previewHtml?: string | null;
  previewSource?: HtmlPreviewSource | null;
  coverAsset?: MediaAssetLike | null;
  hasGeneratedHtml?: boolean;
  previewLabel?: string;
  compact?: boolean;
}) {
  const coverSrc = assetUrl(coverAsset);
  const iframeHeight = compact
    ? 'min(860px, calc(100vh - 220px))'
    : 'min(980px, calc(100vh - 144px))';
  const previewFrameUrl = buildPreviewFrameUrl(previewSource?.fileUrl || previewSource?.filePath, previewSource?.updatedAt);
  const previewFileName = String(previewSource?.filePath || '').trim().split(/[\\/]/).filter(Boolean).pop() || '';
  const hasHtmlFile = Boolean(previewSource?.exists);
  const hasPreviewContent = Boolean(previewSource?.hasContent || previewHtml?.trim());

  return (
    <div className={clsx('h-full overflow-auto', compact ? 'px-4 py-4' : 'px-8 py-8')}>
      <div className={clsx('mx-auto w-full', compact ? 'max-w-full' : 'max-w-[1040px]')}>
        {hasHtmlFile && !hasPreviewContent ? (
          <div className="mx-auto max-w-[860px] rounded-2xl border border-dashed border-border bg-surface-primary px-8 py-12 text-center">
            <div className="text-sm font-medium text-text-primary">{previewLabel || 'HTML 预览'}尚未渲染</div>
            <div className="mt-2 text-sm leading-6 text-text-tertiary">
              {previewFileName || 'HTML 文件'} 已就位，生成后会直接刷新这里的预览。
            </div>
          </div>
        ) : previewFrameUrl ? (
          <iframe
            title={`${previewLabel || '长文'}预览`}
            src={previewFrameUrl}
            sandbox="allow-popups allow-popups-to-escape-sandbox"
            className="w-full rounded-2xl border border-border bg-white"
            style={{ height: iframeHeight }}
          />
        ) : previewHtml?.trim() ? (
          <iframe
            title={`${previewLabel || '长文'}预览`}
            srcDoc={previewHtml}
            sandbox="allow-popups allow-popups-to-escape-sandbox"
            className="w-full rounded-2xl border border-border bg-white"
            style={{ height: iframeHeight }}
          />
        ) : (
          <article className="mx-auto max-w-[860px] space-y-8 rounded-2xl border border-border bg-surface-primary px-10 py-10">
            <h1 className="text-[2.75rem] font-semibold leading-[1.08] tracking-tight text-text-primary">{title}</h1>
            {coverSrc ? (
              <img src={coverSrc} alt={title} className="h-72 w-full rounded-xl object-cover" />
            ) : null}
            <MarkdownPreview content={editorBody} />
          </article>
        )}
      </div>
    </div>
  );
}

function ManuscriptEditor({
  editorBody,
  writeProposal,
  isApplyingWriteProposal = false,
  isRejectingWriteProposal = false,
  onEditorBodyChange,
  onAcceptWriteProposal,
  onRejectWriteProposal,
  compact = false,
}: {
  editorBody: string;
  writeProposal?: WritingDraftWorkbenchProps['writeProposal'];
  isApplyingWriteProposal?: boolean;
  isRejectingWriteProposal?: boolean;
  onEditorBodyChange: (value: string) => void;
  onAcceptWriteProposal?: () => void;
  onRejectWriteProposal?: () => void;
  compact?: boolean;
}) {
  if (writeProposal) {
    return (
      <WritingDiffProposalPanel
        createdAt={writeProposal.createdAt}
        baseBody={writeProposal.baseBody}
        proposedBody={writeProposal.proposedBody}
        isStale={writeProposal.isStale}
        isApplying={isApplyingWriteProposal}
        isRejecting={isRejectingWriteProposal}
        onAccept={() => onAcceptWriteProposal?.()}
        onReject={() => onRejectWriteProposal?.()}
      />
    );
  }

  return (
    <div className={clsx('h-full min-h-0 overflow-hidden', compact ? 'px-4 py-4' : 'px-8 py-8')}>
      <div className="h-full min-h-0 overflow-hidden rounded-2xl border border-border bg-surface-primary">
        <CodeMirrorEditor
          value={editorBody}
          onChange={onEditorBodyChange}
          className="h-full min-h-0 bg-transparent"
        />
      </div>
    </div>
  );
}

export function WritingDraftWorkbench({
  draftType,
  title,
  filePath,
  editorBody,
  writeProposal = null,
  editorBodyDirty,
  isSavingEditorBody,
  isApplyingWriteProposal = false,
  isRejectingWriteProposal = false,
  editorChatSessionId,
  isActive = false,
  previewHtml,
  layoutPreview = null,
  wechatPreview = null,
  richpostPages = [],
  richpostThemeId = null,
  richpostFontScale: richpostFontScaleProp = 1,
  richpostLineHeightScale: richpostLineHeightScaleProp = 1,
  richpostThemePresets = [],
  isApplyingRichpostTheme = false,
  longformLayoutPresetId = null,
  longformLayoutPresets = [],
  isApplyingLongformLayoutPreset = false,
  hasGeneratedHtml = false,
  coverAsset = null,
  imageAssets = [],
  onEditorBodyChange,
  onAcceptWriteProposal,
  onRejectWriteProposal,
  onAiWorkspaceModeChange,
  onSelectRichpostTheme,
  onUpdateRichpostTypography,
  onSelectLongformLayoutPreset,
}: WritingDraftWorkbenchProps) {
  const normalizedRichpostFontScaleProp = clampScale(
    richpostFontScaleProp ?? 1,
    RICHPOST_FONT_SCALE_MIN,
    RICHPOST_FONT_SCALE_MAX
  );
  const normalizedRichpostLineHeightScaleProp = clampScale(
    richpostLineHeightScaleProp ?? 1,
    RICHPOST_LINE_HEIGHT_SCALE_MIN,
    RICHPOST_LINE_HEIGHT_SCALE_MAX
  );
  const [activeTab, setActiveTab] = useState<WritingWorkbenchTab>('manuscript');
  const [isSplitCompareEnabled, setIsSplitCompareEnabled] = useState(false);
  const [splitPreviewTab, setSplitPreviewTab] = useState<WritingWorkbenchTab>('layout');
  const [richpostFontScale, setRichpostFontScale] = useState(normalizedRichpostFontScaleProp);
  const [richpostLineHeightScale, setRichpostLineHeightScale] = useState(normalizedRichpostLineHeightScaleProp);
  const [isExportingRichpostImages, setIsExportingRichpostImages] = useState(false);
  const [isRichpostThemeDrawerOpen, setIsRichpostThemeDrawerOpen] = useState(false);
  const [isLongformLayoutDrawerOpen, setIsLongformLayoutDrawerOpen] = useState(false);
  const committedRichpostTypographyRef = useRef({
    fontScale: normalizedRichpostFontScaleProp,
    lineHeightScale: normalizedRichpostLineHeightScaleProp,
  });
  const pendingRichpostTypographyRef = useRef<{ fontScale: number; lineHeightScale: number } | null>(null);

  useEffect(() => {
    setActiveTab('manuscript');
    setIsSplitCompareEnabled(false);
  }, [draftType, filePath]);

  useEffect(() => {
    const nextTypography = {
      fontScale: normalizedRichpostFontScaleProp,
      lineHeightScale: normalizedRichpostLineHeightScaleProp,
    };
    committedRichpostTypographyRef.current = nextTypography;
    pendingRichpostTypographyRef.current = null;
    setRichpostFontScale(nextTypography.fontScale);
    setRichpostLineHeightScale(nextTypography.lineHeightScale);
  }, [draftType, filePath, normalizedRichpostFontScaleProp, normalizedRichpostLineHeightScaleProp]);

  useEffect(() => {
    setIsRichpostThemeDrawerOpen(false);
    setIsLongformLayoutDrawerOpen(false);
  }, [activeTab, filePath, draftType, isSplitCompareEnabled, splitPreviewTab]);

  const isRichPost = draftType === 'richpost';
  const isLongform = draftType === 'longform';
  const canSplitCompare = isRichPost || draftType === 'longform';
  const shortcuts = useMemo(
    () => (isRichPost ? RICHPOST_SHORTCUTS : LONGFORM_SHORTCUTS),
    [isRichPost]
  );
  const tabs = useMemo(() => {
    if (isRichPost) {
      return [
        { id: 'manuscript' as const, label: '稿件' },
        { id: 'richpost' as const, label: '图文' },
        { id: 'article-card' as const, label: '长文卡片' },
      ];
    }

    const nextTabs: Array<{ id: WritingWorkbenchTab; label: string }> = [
      { id: 'manuscript', label: '稿件' },
      { id: 'layout', label: '排版' },
    ];

    if (wechatPreview?.exists || wechatPreview?.hasContent || wechatPreview?.fileUrl) {
      nextTabs.push({ id: 'wechat', label: '公众号' });
    }

    return nextTabs;
  }, [isRichPost, wechatPreview?.exists, wechatPreview?.fileUrl, wechatPreview?.hasContent]);

  useEffect(() => {
    if (tabs.some((tab) => tab.id === activeTab)) return;
    setActiveTab('manuscript');
  }, [activeTab, tabs]);

  const splitPreviewOptions = useMemo(() => {
    if (isRichPost) {
      return [
        { id: 'richpost' as const, label: '图文排版' },
        { id: 'article-card' as const, label: '长文排版' },
      ];
    }

    return [{ id: 'layout' as const, label: '长文排版' }];
  }, [isRichPost]);

  useEffect(() => {
    const defaultTab = splitPreviewOptions[0]?.id ?? 'layout';
    if (!splitPreviewOptions.some((item) => item.id === splitPreviewTab)) {
      setSplitPreviewTab(defaultTab);
    }
  }, [splitPreviewOptions, splitPreviewTab]);

  const aiWorkspaceMode = useMemo<AiWorkspaceMode>(() => {
    const isRichpostLayoutMode = isRichPost
      && (
        activeTab === 'richpost'
        || (activeTab === 'manuscript' && isSplitCompareEnabled && splitPreviewTab === 'richpost')
      );
    if (isRichpostLayoutMode) {
      return {
        id: 'richpost-layout',
        label: '图文排版',
        activeSkills: [RICHPOST_LAYOUT_SKILL_NAME],
      };
    }
    const isLongformLayoutMode = isLongform
      && (
        activeTab === 'layout'
        || activeTab === 'wechat'
        || (activeTab === 'manuscript' && isSplitCompareEnabled)
      );
    if (isLongformLayoutMode) {
      return {
        id: 'article-layout',
        label: '长文排版',
        activeSkills: [LONGFORM_LAYOUT_SKILL_NAME],
      };
    }
    if (activeTab === 'layout' || activeTab === 'wechat' || activeTab === 'article-card' || (activeTab === 'manuscript' && isSplitCompareEnabled)) {
      return { id: 'article-layout', label: '长文排版', activeSkills: [] };
    }
    return { id: 'manuscript-editing', label: '稿件编辑', activeSkills: [] };
  }, [activeTab, isLongform, isRichPost, isSplitCompareEnabled, splitPreviewTab]);

  useEffect(() => {
    onAiWorkspaceModeChange?.(aiWorkspaceMode);
  }, [aiWorkspaceMode, onAiWorkspaceModeChange]);

  useEffect(() => {
    if (!isRichPost || !onUpdateRichpostTypography) return;
    const nextTypography = {
      fontScale: clampScale(richpostFontScale, RICHPOST_FONT_SCALE_MIN, RICHPOST_FONT_SCALE_MAX),
      lineHeightScale: clampScale(
        richpostLineHeightScale,
        RICHPOST_LINE_HEIGHT_SCALE_MIN,
        RICHPOST_LINE_HEIGHT_SCALE_MAX
      ),
    };
    const committed = committedRichpostTypographyRef.current;
    const pending = pendingRichpostTypographyRef.current;
    const matchesCommitted = (
      nextTypography.fontScale === committed.fontScale
      && nextTypography.lineHeightScale === committed.lineHeightScale
    );
    const matchesPending = pending
      && nextTypography.fontScale === pending.fontScale
      && nextTypography.lineHeightScale === pending.lineHeightScale;
    if (matchesCommitted || matchesPending) {
      return;
    }
    const timeoutId = window.setTimeout(() => {
      pendingRichpostTypographyRef.current = nextTypography;
      void Promise.resolve(onUpdateRichpostTypography(nextTypography)).catch((error) => {
        console.error('Failed to update richpost typography:', error);
      });
    }, 160);
    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [
    isRichPost,
    onUpdateRichpostTypography,
    richpostFontScale,
    richpostLineHeightScale,
  ]);

  const normalizedThemePresets = useMemo(
    () => richpostThemePresets.filter((theme) => typeof theme?.id === 'string' && theme.id.trim()),
    [richpostThemePresets]
  );

  const normalizedLongformLayoutPresets = useMemo(
    () => longformLayoutPresets.filter((preset) => typeof preset?.id === 'string' && preset.id.trim()),
    [longformLayoutPresets]
  );

  const activeSplitPreviewLabel = useMemo(
    () => splitPreviewOptions.find((item) => item.id === splitPreviewTab)?.label || '排版',
    [splitPreviewOptions, splitPreviewTab]
  );

  const renderPreviewContent = (tab: WritingWorkbenchTab, compact = false) => {
    if (tab === 'layout') {
      return (
        <LongformPreview
          title={title}
          editorBody={editorBody}
          previewHtml={previewHtml}
          previewSource={layoutPreview}
          coverAsset={coverAsset}
          hasGeneratedHtml={hasGeneratedHtml}
          previewLabel="排版"
          compact={compact}
        />
      );
    }

    if (tab === 'wechat') {
      return (
        <LongformPreview
          title={title}
          editorBody={editorBody}
          previewSource={wechatPreview}
          coverAsset={coverAsset}
          hasGeneratedHtml={hasGeneratedHtml}
          previewLabel="公众号"
          compact={compact}
        />
      );
    }

    if (tab === 'richpost') {
      return (
        <RichPostPreview
          title={title}
          editorBody={editorBody}
          previewHtml={previewHtml}
          previewSource={layoutPreview}
          pagePreviews={richpostPages}
          coverAsset={coverAsset}
          imageAssets={imageAssets}
          hasGeneratedHtml={hasGeneratedHtml}
          fontScale={richpostFontScale}
          lineHeightScale={richpostLineHeightScale}
          compact={compact}
        />
      );
    }

    return (
      <LongformPreview
        title={title}
        editorBody={editorBody}
        previewHtml={undefined}
        coverAsset={coverAsset}
        hasGeneratedHtml={false}
        compact={compact}
      />
    );
  };

  const renderPreviewSurface = (tab: WritingWorkbenchTab, compact = false) => {
    const shouldShowThemeDrawer = isRichPost && tab === 'richpost';
    const longformPresetTarget = tab === 'wechat' ? 'wechat' : 'layout';
    const shouldShowLongformLayoutDrawer = isLongform && (tab === 'layout' || tab === 'wechat');

    return (
      <div className="relative h-full min-h-0">
        {renderPreviewContent(tab, compact)}
        {shouldShowThemeDrawer ? (
          <>
            <button
              type="button"
              onClick={() => setIsRichpostThemeDrawerOpen((current) => !current)}
              className={clsx(
                compact
                  ? 'absolute right-2 top-2 z-20 rounded-full border border-border bg-surface-primary/92 p-2 text-text-tertiary shadow-sm backdrop-blur transition hover:text-text-primary'
                  : 'absolute right-3 top-1/2 z-20 -translate-y-1/2 rounded-full border border-border bg-surface-primary/92 p-2 text-text-tertiary shadow-sm backdrop-blur transition hover:text-text-primary',
                isRichpostThemeDrawerOpen && 'pointer-events-none opacity-0'
              )}
              aria-label="打开图文主题抽屉"
              title="图文主题"
            >
              <Sparkles className="h-4 w-4" />
            </button>
            <div
              className={clsx(
                'absolute inset-0 z-20 bg-black/10 transition-opacity',
                isRichpostThemeDrawerOpen ? 'opacity-100' : 'pointer-events-none opacity-0'
              )}
              onClick={() => setIsRichpostThemeDrawerOpen(false)}
            />
            <aside
              className={clsx(
                'absolute inset-y-0 right-0 z-30 flex w-[360px] max-w-[82vw] flex-col border-l border-border bg-surface-primary shadow-2xl transition-transform duration-200',
                isRichpostThemeDrawerOpen ? 'translate-x-0' : 'translate-x-full'
              )}
            >
              <div className="flex items-center justify-between border-b border-border px-4 py-2.5">
                <div className="text-[12px] font-medium tracking-[0.08em] text-text-secondary">图文主题</div>
                <button
                  type="button"
                  onClick={() => setIsRichpostThemeDrawerOpen(false)}
                  className="rounded-full border border-border p-1.5 text-text-tertiary transition hover:bg-surface-secondary/50 hover:text-text-primary"
                  aria-label="关闭图文主题抽屉"
                  title="关闭"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
              <div className="min-h-0 flex-1 overflow-auto px-3 py-3">
                <div className="grid grid-cols-2 gap-x-3 gap-y-4">
                  {normalizedThemePresets.map((theme) => {
                    const themeId = String(theme.id || '');
                    const active = themeId === richpostThemeId;
                    return (
                      <button
                        key={themeId}
                        type="button"
                        onClick={() => {
                          onSelectRichpostTheme?.(themeId);
                          setIsRichpostThemeDrawerOpen(false);
                        }}
                        disabled={isApplyingRichpostTheme}
                        className={clsx(
                          'w-full text-left transition duration-200',
                          active ? 'opacity-100' : 'hover:-translate-y-0.5',
                          isApplyingRichpostTheme && 'opacity-70'
                        )}
                      >
                        <div className={clsx('truncate text-[11px] font-medium', active ? 'text-accent-primary' : 'text-text-secondary')}>
                          {theme.label || themeId}
                        </div>
                        <div className="mt-2">
                          <PresetPreviewThumbnail
                            surfaceColor={theme.surfaceColor}
                            textColor={theme.textColor}
                            accentColor={theme.accentColor}
                            headingFont={theme.headingFont}
                            bodyFont={theme.bodyFont}
                            active={active}
                          />
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>
            </aside>
          </>
        ) : null}
        {shouldShowLongformLayoutDrawer ? (
          <>
            <button
              type="button"
              onClick={() => setIsLongformLayoutDrawerOpen((current) => !current)}
              className={clsx(
                compact
                  ? 'absolute right-2 top-2 z-20 rounded-full border border-border bg-surface-primary/92 p-2 text-text-tertiary shadow-sm backdrop-blur transition hover:text-text-primary'
                  : 'absolute right-3 top-1/2 z-20 -translate-y-1/2 rounded-full border border-border bg-surface-primary/92 p-2 text-text-tertiary shadow-sm backdrop-blur transition hover:text-text-primary',
                isLongformLayoutDrawerOpen && 'pointer-events-none opacity-0'
              )}
              aria-label="打开长文母版抽屉"
              title="长文母版"
            >
              <Sparkles className="h-4 w-4" />
            </button>
            <div
              className={clsx(
                'absolute inset-0 z-20 bg-black/10 transition-opacity',
                isLongformLayoutDrawerOpen ? 'opacity-100' : 'pointer-events-none opacity-0'
              )}
              onClick={() => setIsLongformLayoutDrawerOpen(false)}
            />
            <aside
              className={clsx(
                'absolute inset-y-0 right-0 z-30 flex w-[320px] max-w-[78vw] flex-col border-l border-border bg-surface-primary shadow-2xl transition-transform duration-200',
                isLongformLayoutDrawerOpen ? 'translate-x-0' : 'translate-x-full'
              )}
            >
              <div className="flex items-center justify-between border-b border-border px-4 py-3">
                <div>
                  <div className="text-sm font-semibold text-text-primary">长文母版</div>
                  <div className="mt-1 text-xs text-text-tertiary">只改母版和 HTML 样式，不改正文内容。</div>
                </div>
                <button
                  type="button"
                  onClick={() => setIsLongformLayoutDrawerOpen(false)}
                  className="rounded-full border border-border p-1.5 text-text-tertiary transition hover:bg-surface-secondary/50 hover:text-text-primary"
                  aria-label="关闭长文母版抽屉"
                  title="关闭"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
              <div className="border-b border-border px-4 py-2 text-[11px] text-text-tertiary">
                当前目标：{longformPresetTarget === 'wechat' ? '公众号' : '长文排版'}
              </div>
              <div className="min-h-0 flex-1 overflow-auto px-3 py-3">
                <div className="space-y-3">
                  {normalizedLongformLayoutPresets.map((preset) => {
                    const presetId = String(preset.id || '');
                    const active = presetId === longformLayoutPresetId;
                    return (
                      <button
                        key={presetId}
                        type="button"
                        onClick={() => {
                          onSelectLongformLayoutPreset?.(presetId, longformPresetTarget);
                          setIsLongformLayoutDrawerOpen(false);
                        }}
                        disabled={isApplyingLongformLayoutPreset}
                        className={clsx(
                          'w-full rounded-2xl border px-4 py-4 text-left transition',
                          active
                            ? 'border-accent-primary/40 bg-accent-primary/10'
                            : 'border-border bg-surface-secondary/45 hover:border-accent-primary/20 hover:bg-surface-secondary/70',
                          isApplyingLongformLayoutPreset && 'opacity-70'
                        )}
                      >
                        <div className="flex items-center justify-between gap-3">
                          <div className="truncate text-sm font-semibold text-text-primary">{preset.label || presetId}</div>
                          <div className={clsx('text-[11px] font-medium', active ? 'text-accent-primary' : 'text-text-tertiary')}>
                            {active ? '当前' : '应用'}
                          </div>
                        </div>
                        {preset.description ? (
                          <div className="mt-1.5 text-xs leading-5 text-text-tertiary">{preset.description}</div>
                        ) : null}
                        <div className="mt-3 flex items-center gap-2">
                          <span className="h-6 w-6 rounded-full border border-black/5" style={{ background: preset.surfaceColor || '#ffffff' }} />
                          <span className="h-6 w-6 rounded-full border border-black/5" style={{ background: preset.accentColor || '#111111' }} />
                          <span className="h-6 w-6 rounded-full border border-black/5" style={{ background: preset.textColor || '#111111' }} />
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>
            </aside>
          </>
        ) : null}
      </div>
    );
  };

  const handleExportRichpostImages = async () => {
    if (!isRichPost || isExportingRichpostImages) return;
    const exportablePages = richpostPages.filter((page) => page.exists && (page.fileUrl || page.filePath));
    if (exportablePages.length === 0) {
      void appAlert('当前还没有可导出的图文页面。');
      return;
    }
    setIsExportingRichpostImages(true);
    try {
      const picked = await window.ipcRenderer.invoke('manuscripts:pick-richpost-export-path', {
        filePath,
      }) as { success?: boolean; canceled?: boolean; path?: string; error?: string };
      if (!picked?.success) {
        throw new Error(picked?.error || '选择导出位置失败');
      }
      if (picked.canceled || !picked.path) {
        return;
      }
      const archiveEntries: Array<{ name: string; dataBase64: string }> = [];
      for (let index = 0; index < exportablePages.length; index += 1) {
        const page = exportablePages[index];
        const entryName = buildRichpostExportImagePath(picked.path, index);
        const html = await loadRichpostExportPageHtml(
          filePath,
          page.id,
          richpostFontScale,
          richpostLineHeightScale
        );
        const dataUrl = await renderRichpostHtmlToPng(html, page.id);
        const dataBase64 = dataUrl.replace(/^data:image\/png;base64,/, '');
        archiveEntries.push({ name: entryName, dataBase64 });
      }
      const saved = await window.ipcRenderer.invoke('manuscripts:save-richpost-export-archive', {
        outputPath: picked.path,
        entries: archiveEntries,
      }) as { success?: boolean; error?: string; path?: string; entryCount?: number };
      if (!saved?.success) {
        throw new Error(saved?.error || '导出压缩包失败');
      }
      void appAlert(`已导出 ${exportablePages.length} 张图文图片压缩包。`);
    } catch (error) {
      void appAlert(error instanceof Error ? error.message : '导出图文图片失败');
    } finally {
      setIsExportingRichpostImages(false);
    }
  };

  const adjustRichpostFontScale = (delta: number) => {
    setRichpostFontScale((current) => clampScale(current + delta, RICHPOST_FONT_SCALE_MIN, RICHPOST_FONT_SCALE_MAX));
  };

  const adjustRichpostLineHeightScale = (delta: number) => {
    setRichpostLineHeightScale((current) => clampScale(current + delta, RICHPOST_LINE_HEIGHT_SCALE_MIN, RICHPOST_LINE_HEIGHT_SCALE_MAX));
  };

  return (
    <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_420px] bg-surface-primary text-text-primary">
      <section className="relative min-h-0 border-r border-border bg-background">
        <div className="flex h-full min-h-0 flex-col">
          <div className="flex items-center gap-2 border-b border-border px-6 py-4">
            {tabs.map((tab) => (
              <button
                key={tab.id}
                type="button"
                onClick={() => setActiveTab(tab.id)}
                className={clsx(
                  'rounded-full border px-4 py-1.5 text-sm transition',
                  activeTab === tab.id
                    ? 'border-accent-primary/35 bg-accent-primary/10 text-text-primary'
                    : 'border-transparent bg-transparent text-text-tertiary hover:border-border hover:bg-surface-secondary/50 hover:text-text-primary'
                )}
              >
                {tab.label}
              </button>
            ))}
            {activeTab === 'manuscript' && canSplitCompare ? (
              <button
                type="button"
                onClick={() => setIsSplitCompareEnabled((current) => !current)}
                className={clsx(
                  'ml-auto inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-sm transition',
                  isSplitCompareEnabled
                    ? 'border-accent-primary/35 bg-accent-primary/10 text-text-primary'
                    : 'border-border bg-transparent text-text-tertiary hover:bg-surface-secondary/50 hover:text-text-primary'
                )}
                aria-label={isSplitCompareEnabled ? '关闭分栏对比' : '打开分栏对比'}
                title={isSplitCompareEnabled ? '关闭分栏对比' : '打开分栏对比'}
              >
                <Columns className="h-4 w-4" />
                <span>分栏</span>
              </button>
            ) : null}
            {isRichPost && activeTab === 'richpost' ? (
              <div className="ml-auto flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => adjustRichpostFontScale(-0.1)}
                  disabled={richpostFontScale <= RICHPOST_FONT_SCALE_MIN}
                  className="inline-flex h-9 w-9 items-center justify-center rounded-full text-text-tertiary transition hover:bg-surface-secondary/50 hover:text-text-primary disabled:opacity-35"
                  aria-label="缩小文字"
                  title="缩小文字"
                >
                  <TextScaleIcon />
                </button>
                <button
                  type="button"
                  onClick={() => adjustRichpostFontScale(0.1)}
                  disabled={richpostFontScale >= RICHPOST_FONT_SCALE_MAX}
                  className="inline-flex h-9 w-9 items-center justify-center rounded-full text-text-tertiary transition hover:bg-surface-secondary/50 hover:text-text-primary disabled:opacity-35"
                  aria-label="放大文字"
                  title="放大文字"
                >
                  <TextScaleIcon large />
                </button>
                <button
                  type="button"
                  onClick={() => adjustRichpostLineHeightScale(-0.08)}
                  disabled={richpostLineHeightScale <= RICHPOST_LINE_HEIGHT_SCALE_MIN}
                  className="inline-flex h-9 w-9 items-center justify-center rounded-full text-text-tertiary transition hover:bg-surface-secondary/50 hover:text-text-primary disabled:opacity-35"
                  aria-label="缩小行间距"
                  title="缩小行间距"
                >
                  <LineHeightIcon />
                </button>
                <button
                  type="button"
                  onClick={() => adjustRichpostLineHeightScale(0.08)}
                  disabled={richpostLineHeightScale >= RICHPOST_LINE_HEIGHT_SCALE_MAX}
                  className="inline-flex h-9 w-9 items-center justify-center rounded-full text-text-tertiary transition hover:bg-surface-secondary/50 hover:text-text-primary disabled:opacity-35"
                  aria-label="放大行间距"
                  title="放大行间距"
                >
                  <LineHeightIcon expanded />
                </button>
                <button
                  type="button"
                  onClick={() => void handleExportRichpostImages()}
                  disabled={isExportingRichpostImages}
                  className="ml-1 inline-flex items-center gap-2 rounded-full px-3 py-1.5 text-sm text-text-tertiary transition hover:bg-surface-secondary/50 hover:text-text-primary disabled:opacity-40"
                  aria-label="导出图文图片"
                  title="导出图文图片"
                >
                  {isExportingRichpostImages ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
                  <span>{isExportingRichpostImages ? '导出中' : '导出'}</span>
                </button>
              </div>
            ) : null}
          </div>

          <div className="min-h-0 flex-1 overflow-hidden">
            {activeTab === 'manuscript' && isSplitCompareEnabled ? (
              <div className="grid h-full min-h-0 grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
                <section className="flex min-h-0 min-w-0 flex-col border-r border-border">
                  <div className="flex items-center justify-between border-b border-border px-5 py-3">
                    <div className="text-sm font-semibold text-text-primary">原稿</div>
                    {editorBodyDirty || isSavingEditorBody ? (
                      <div className="text-xs text-text-tertiary">
                        {isSavingEditorBody ? '保存中' : '未保存'}
                      </div>
                    ) : null}
                  </div>
                  <div className="min-h-0 flex-1 overflow-hidden">
                    <ManuscriptEditor
                      editorBody={editorBody}
                      writeProposal={writeProposal}
                      isApplyingWriteProposal={isApplyingWriteProposal}
                      isRejectingWriteProposal={isRejectingWriteProposal}
                      onEditorBodyChange={onEditorBodyChange}
                      onAcceptWriteProposal={onAcceptWriteProposal}
                      onRejectWriteProposal={onRejectWriteProposal}
                      compact
                    />
                  </div>
                </section>
                <section className="flex min-h-0 min-w-0 flex-col">
                  <div className="flex items-center justify-between border-b border-border px-5 py-3">
                    <div className="text-sm font-semibold text-text-primary">排版</div>
                    <div className="flex items-center gap-2">
                      {splitPreviewOptions.map((option) => (
                        <button
                          key={option.id}
                          type="button"
                          onClick={() => setSplitPreviewTab(option.id)}
                          className={clsx(
                            'rounded-full border px-3 py-1 text-xs transition',
                            splitPreviewTab === option.id
                              ? 'border-accent-primary/35 bg-accent-primary/10 text-text-primary'
                              : 'border-transparent bg-transparent text-text-tertiary hover:border-border hover:bg-surface-secondary/50 hover:text-text-primary'
                          )}
                        >
                          {option.label}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div className="min-h-0 flex-1 overflow-hidden">
                    {renderPreviewSurface(splitPreviewTab, true)}
                  </div>
                </section>
              </div>
            ) : (
              activeTab === 'manuscript' ? (
                <ManuscriptEditor
                  editorBody={editorBody}
                  writeProposal={writeProposal}
                  isApplyingWriteProposal={isApplyingWriteProposal}
                  isRejectingWriteProposal={isRejectingWriteProposal}
                  onEditorBodyChange={onEditorBodyChange}
                  onAcceptWriteProposal={onAcceptWriteProposal}
                  onRejectWriteProposal={onRejectWriteProposal}
                />
              ) : (
                renderPreviewSurface(activeTab)
              )
            )}
          </div>
        </div>
      </section>

      <aside className="min-h-0 bg-surface-secondary/55">
        <div className="flex h-full min-h-0 flex-col">
          <div className="border-b border-border px-5 py-3">
            <div className="text-[11px] font-medium tracking-wide text-text-tertiary">当前页面</div>
            <div className="mt-1 flex items-center gap-2 text-sm font-semibold text-text-primary">
              <MessageSquare className="h-4 w-4 text-accent-primary" />
              {aiWorkspaceMode.label}
            </div>
          </div>
          <div className="min-h-0 flex-1 overflow-hidden">
            {editorChatSessionId ? (
              <Suspense fallback={<div className="flex h-full items-center justify-center text-text-tertiary">AI 会话加载中...</div>}>
                <ChatWorkspace
                  isActive={isActive}
                  fixedSessionId={editorChatSessionId}
                  showClearButton={false}
                  showWelcomeShortcuts={false}
                  showComposerShortcuts
                  fixedSessionContextIndicatorMode="corner-ring"
                  contentLayout="wide"
                  contentWidthPreset="default"
                  allowFileUpload
                  messageWorkflowPlacement="bottom"
                  messageWorkflowVariant="compact"
                  messageWorkflowEmphasis="default"
                  welcomeTitle={aiWorkspaceMode.label}
                  welcomeSubtitle={isRichPost ? '围绕当前图文稿继续改标题、压缩段落、强化发布感。' : '围绕当前长文继续改结构、润色正文、生成发布版本。'}
                  shortcuts={shortcuts}
                  welcomeShortcuts={shortcuts}
                  fixedSessionBannerText={aiWorkspaceMode.label}
                />
              </Suspense>
            ) : (
              <div className="flex h-full items-center justify-center px-6 text-center">
                <div>
                  <Loader2 className="mx-auto h-5 w-5 animate-spin text-accent-primary/70" />
                  <div className="mt-3 text-sm text-text-secondary">正在初始化 AI 会话...</div>
                </div>
              </div>
            )}
          </div>
          <div className="border-t border-border px-5 py-4">
            <div className="grid grid-cols-3 gap-2 text-left text-[11px] text-text-tertiary">
              <div className="rounded-2xl border border-border bg-surface-primary/85 px-3 py-2">
                <div className="flex items-center gap-2 text-text-secondary">
                  {isRichPost ? <ImageIcon className="h-3.5 w-3.5 text-amber-500" /> : <FileText className="h-3.5 w-3.5 text-accent-primary" />}
                  当前类型
                </div>
                <div className="mt-2 text-xs font-medium text-text-primary">{isRichPost ? '图文稿' : '长文稿'}</div>
              </div>
              <div className="rounded-2xl border border-border bg-surface-primary/85 px-3 py-2">
                <div className="flex items-center gap-2 text-text-secondary">
                  <Sparkles className="h-3.5 w-3.5 text-fuchsia-500" />
                  预览模式
                </div>
                <div className="mt-2 text-xs font-medium text-text-primary">
                  {activeTab === 'manuscript' && isSplitCompareEnabled
                    ? `分栏 / ${activeSplitPreviewLabel}`
                    : tabs.find((tab) => tab.id === activeTab)?.label || '稿件'}
                </div>
              </div>
              <div className="rounded-2xl border border-border bg-surface-primary/85 px-3 py-2">
                <div className="flex items-center gap-2 text-text-secondary">
                  <MessageSquare className="h-3.5 w-3.5 text-emerald-500" />
                  会话状态
                </div>
                <div className="mt-2 text-xs font-medium text-text-primary">{editorChatSessionId ? '已绑定文件' : '初始化中'}</div>
              </div>
            </div>
          </div>
        </div>
      </aside>
    </div>
  );
}
