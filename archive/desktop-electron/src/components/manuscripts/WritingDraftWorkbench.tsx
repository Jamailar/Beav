import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import clsx from 'clsx';
import {
  ArrowLeft,
  Columns,
  Download,
  ExternalLink,
  Image as ImageIcon,
  Loader2,
  MessageSquare,
  Plus,
  Sparkles,
  X,
} from 'lucide-react';
import { CodeMirrorEditor } from './CodeMirrorEditor';
import { MarkdownItPreview } from './MarkdownItPreview';
import { WritingDiffProposalPanel } from './WritingDiffProposalPanel';
import {
  loadRichpostPreviewHtml,
  RICHPOST_RENDER_VIEWPORT_HEIGHT,
  RICHPOST_RENDER_VIEWPORT_WIDTH,
  renderRichpostHtmlToPng,
} from './richpostPreviewImage';
import { resolveAssetUrl } from '../../utils/pathManager';
import { appAlert, appConfirm } from '../../utils/appDialogs';

const ChatWorkspace = lazy(async () => ({
  default: (await import('../../pages/Chat')).Chat,
}));

type WritingDraftType = 'longform' | 'richpost' | 'unknown';
type WritingWorkbenchTab = 'manuscript' | 'layout' | 'wechat' | 'richpost';

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
  source?: string | null;
  shellBg?: string | null;
  pageBg?: string | null;
  surfaceColor?: string | null;
  surfaceBg?: string | null;
  surfaceBorder?: string | null;
  surfaceShadow?: string | null;
  surfaceRadius?: string | null;
  imageRadius?: string | null;
  previewCardBg?: string | null;
  previewCardBorder?: string | null;
  previewCardShadow?: string | null;
  headingColor?: string | null;
  bodyColor?: string | null;
  textColor?: string | null;
  mutedColor?: string | null;
  accentColor?: string | null;
  headingFont?: string | null;
  bodyFont?: string | null;
  coverFrame?: RichpostZoneFrame | null;
  bodyFrame?: RichpostZoneFrame | null;
  endingFrame?: RichpostZoneFrame | null;
  coverBackgroundPath?: string | null;
  bodyBackgroundPath?: string | null;
  endingBackgroundPath?: string | null;
};

type RichpostZoneFrame = {
  x: number;
  y: number;
  w: number;
  h: number;
};

type RichpostThemeDraft = {
  id?: string | null;
  label: string;
  description: string;
  shellBg: string;
  pageBg: string;
  surfaceBg: string;
  surfaceBorder: string;
  surfaceShadow: string;
  surfaceRadius: string;
  imageRadius: string;
  previewCardBg: string;
  previewCardBorder: string;
  previewCardShadow: string;
  headingColor: string;
  bodyColor: string;
  textColor: string;
  mutedColor: string;
  accentColor: string;
  headingFont: string;
  bodyFont: string;
  coverFrame: RichpostZoneFrame;
  bodyFrame: RichpostZoneFrame;
  endingFrame: RichpostZoneFrame;
  coverBackgroundPath: string;
  bodyBackgroundPath: string;
  endingBackgroundPath: string;
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
  themeEditingId?: string | null;
  themeEditingLabel?: string | null;
  themeEditingRoot?: string | null;
  themeEditingFile?: string | null;
  themeEditingTemplateFile?: string | null;
};

type PackageStateLike = Record<string, unknown>;
type RichpostThemeContextMenuState = {
  visible: boolean;
  x: number;
  y: number;
  theme: RichpostThemePreset | null;
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
  editorChatReady?: boolean;
  isActive?: boolean;
  previewHtml?: string | null;
  layoutPreview?: HtmlPreviewSource | null;
  wechatPreview?: HtmlPreviewSource | null;
  richpostPages?: RichPostPagePreview[];
  richpostThemeId?: string | null;
  richpostFontScale?: number | null;
  richpostLineHeightScale?: number | null;
  richpostThemePresets?: RichpostThemePreset[];
  richpostThemesDir?: string | null;
  richpostThemeTemplateFile?: string | null;
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
  onPackageStateChange?: (state: PackageStateLike) => void;
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
const RICHPOST_THEME_EDITOR_SKILL_NAME = 'richpost-theme-editor';
const LONGFORM_LAYOUT_SKILL_NAME = 'longform-layout-designer';
const SHOW_RICHPOST_THEME_EDITOR_CHAT = false;
const PRESET_PREVIEW_TITLE = 'RedBox';
const RICHPOST_FONT_SCALE_MIN = 0.8;
const RICHPOST_FONT_SCALE_MAX = 1.6;
const RICHPOST_LINE_HEIGHT_SCALE_MIN = 0.8;
const RICHPOST_LINE_HEIGHT_SCALE_MAX = 1.4;
const RICHPOST_FRAME_MIN_SIZE = 0.08;
const RICHPOST_PREVIEW_PAGE_WIDTH = 420;
const RICHPOST_PREVIEW_PAGE_WIDTH_COMPACT = 320;

function clampScale(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.min(max, Math.max(min, Number(value.toFixed(2))));
}

type RichpostThemePreviewRecord = {
  id: string;
  label?: string;
  html: string;
};

type RichpostZoneFrameRole = 'cover' | 'body' | 'ending';

function RichpostThemePreviewFrame({
  html,
  active = false,
  bare = false,
  capturePointer = false,
}: {
  html?: string | null;
  active?: boolean;
  bare?: boolean;
  capturePointer?: boolean;
}) {
  const frameHostRef = useRef<HTMLDivElement | null>(null);
  const [frameWidth, setFrameWidth] = useState(0);

  useEffect(() => {
    const node = frameHostRef.current;
    if (!node) return;
    const update = () => setFrameWidth(node.getBoundingClientRect().width || 0);
    update();
    const observer = new ResizeObserver(() => update());
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const previewScale = frameWidth > 0 ? frameWidth / RICHPOST_RENDER_VIEWPORT_WIDTH : 1;
  const previewHeight = RICHPOST_RENDER_VIEWPORT_HEIGHT * previewScale;

  return (
    <div
      className={clsx(
        'relative w-full overflow-hidden transition',
        bare ? 'bg-transparent' : 'rounded-[14px] bg-surface-secondary/55',
        active ? 'ring-1 ring-accent-primary/35' : ''
      )}
    >
      <div
        ref={frameHostRef}
        className="pointer-events-none relative w-full overflow-hidden bg-surface-elevated"
        style={{ height: previewHeight || undefined, aspectRatio: '3 / 4' }}
      >
        {html ? (
          <iframe
            title={PRESET_PREVIEW_TITLE}
            srcDoc={html}
            sandbox={RICHPOST_PREVIEW_SANDBOX}
            className="pointer-events-none absolute left-0 top-0 border-0 bg-surface-elevated"
            style={{
              width: `${RICHPOST_RENDER_VIEWPORT_WIDTH}px`,
              height: `${RICHPOST_RENDER_VIEWPORT_HEIGHT}px`,
              transform: `scale(${previewScale || 1})`,
              transformOrigin: 'top left',
            }}
            tabIndex={-1}
          />
        ) : (
          <div className="pointer-events-none flex h-full items-center justify-center text-[11px] text-text-tertiary">
            预览加载中
          </div>
        )}
      </div>
      {capturePointer ? <div className="absolute inset-0 z-[2]" aria-hidden="true" /> : null}
    </div>
  );
}

const DEFAULT_RICHPOST_THEME_DRAFT: RichpostThemeDraft = {
  id: null,
  label: '新主题',
  description: '',
  shellBg: 'linear-gradient(180deg,#fff8ef 0%,#f5ede1 100%)',
  pageBg: '#ffffff',
  surfaceBg: '#ffffff',
  surfaceBorder: 'rgba(34,24,18,.08)',
  surfaceShadow: '0 14px 34px rgba(17,17,17,.06)',
  surfaceRadius: '0px',
  imageRadius: '0px',
  previewCardBg: 'rgba(255,255,255,.82)',
  previewCardBorder: 'rgba(34,24,18,.08)',
  previewCardShadow: '0 18px 48px rgba(88,59,36,.08)',
  headingColor: '#111111',
  bodyColor: '#111111',
  textColor: '#111111',
  mutedColor: '#6b625a',
  accentColor: '#111111',
  headingFont: '"PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif',
  bodyFont: '"PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif',
  coverFrame: { x: 0.12, y: 0.18, w: 0.76, h: 0.58 },
  bodyFrame: { x: 0.08, y: 0.10, w: 0.84, h: 0.78 },
  endingFrame: { x: 0.12, y: 0.24, w: 0.76, h: 0.48 },
  coverBackgroundPath: '',
  bodyBackgroundPath: '',
  endingBackgroundPath: '',
};

function clampRichpostZoneFrame(frame?: Partial<RichpostZoneFrame> | null, fallback?: RichpostZoneFrame): RichpostZoneFrame {
  const base = fallback || DEFAULT_RICHPOST_THEME_DRAFT.bodyFrame;
  let x = Number.isFinite(frame?.x) ? Number(frame?.x) : base.x;
  let y = Number.isFinite(frame?.y) ? Number(frame?.y) : base.y;
  let w = Number.isFinite(frame?.w) ? Number(frame?.w) : base.w;
  let h = Number.isFinite(frame?.h) ? Number(frame?.h) : base.h;
  x = Math.max(0, Math.min(0.92, x));
  y = Math.max(0, Math.min(0.92, y));
  w = Math.max(RICHPOST_FRAME_MIN_SIZE, Math.min(1, w));
  h = Math.max(RICHPOST_FRAME_MIN_SIZE, Math.min(1, h));
  if (x + w > 1) x = Math.max(0, 1 - w);
  if (y + h > 1) y = Math.max(0, 1 - h);
  return {
    x: Number(x.toFixed(3)),
    y: Number(y.toFixed(3)),
    w: Number(w.toFixed(3)),
    h: Number(h.toFixed(3)),
  };
}

function normalizeRichpostThemeDraft(theme?: RichpostThemePreset | null): RichpostThemeDraft {
  return {
    id: typeof theme?.id === 'string' ? theme.id : null,
    label: typeof theme?.label === 'string' && theme.label.trim() ? theme.label : DEFAULT_RICHPOST_THEME_DRAFT.label,
    description: typeof theme?.description === 'string' ? theme.description : '',
    shellBg: typeof theme?.shellBg === 'string' && theme.shellBg.trim() ? theme.shellBg : DEFAULT_RICHPOST_THEME_DRAFT.shellBg,
    pageBg: typeof theme?.pageBg === 'string' && theme.pageBg.trim() ? theme.pageBg : DEFAULT_RICHPOST_THEME_DRAFT.pageBg,
    surfaceBg: typeof (theme?.surfaceBg || theme?.surfaceColor) === 'string' && String(theme?.surfaceBg || theme?.surfaceColor).trim()
      ? String(theme?.surfaceBg || theme?.surfaceColor)
      : DEFAULT_RICHPOST_THEME_DRAFT.surfaceBg,
    surfaceBorder: typeof theme?.surfaceBorder === 'string' && theme.surfaceBorder.trim() ? theme.surfaceBorder : DEFAULT_RICHPOST_THEME_DRAFT.surfaceBorder,
    surfaceShadow: typeof theme?.surfaceShadow === 'string' && theme.surfaceShadow.trim() ? theme.surfaceShadow : DEFAULT_RICHPOST_THEME_DRAFT.surfaceShadow,
    surfaceRadius: typeof theme?.surfaceRadius === 'string' && theme.surfaceRadius.trim() ? theme.surfaceRadius : DEFAULT_RICHPOST_THEME_DRAFT.surfaceRadius,
    imageRadius: typeof theme?.imageRadius === 'string' && theme.imageRadius.trim() ? theme.imageRadius : DEFAULT_RICHPOST_THEME_DRAFT.imageRadius,
    previewCardBg: typeof theme?.previewCardBg === 'string' && theme.previewCardBg.trim() ? theme.previewCardBg : DEFAULT_RICHPOST_THEME_DRAFT.previewCardBg,
    previewCardBorder: typeof theme?.previewCardBorder === 'string' && theme.previewCardBorder.trim() ? theme.previewCardBorder : DEFAULT_RICHPOST_THEME_DRAFT.previewCardBorder,
    previewCardShadow: typeof theme?.previewCardShadow === 'string' && theme.previewCardShadow.trim() ? theme.previewCardShadow : DEFAULT_RICHPOST_THEME_DRAFT.previewCardShadow,
    headingColor: typeof theme?.headingColor === 'string' && theme.headingColor.trim()
      ? theme.headingColor
      : (typeof theme?.textColor === 'string' && theme.textColor.trim() ? theme.textColor : DEFAULT_RICHPOST_THEME_DRAFT.headingColor),
    bodyColor: typeof theme?.bodyColor === 'string' && theme.bodyColor.trim()
      ? theme.bodyColor
      : (typeof theme?.textColor === 'string' && theme.textColor.trim() ? theme.textColor : DEFAULT_RICHPOST_THEME_DRAFT.bodyColor),
    textColor: typeof theme?.textColor === 'string' && theme.textColor.trim() ? theme.textColor : DEFAULT_RICHPOST_THEME_DRAFT.textColor,
    mutedColor: typeof theme?.mutedColor === 'string' && theme.mutedColor.trim() ? theme.mutedColor : DEFAULT_RICHPOST_THEME_DRAFT.mutedColor,
    accentColor: typeof theme?.accentColor === 'string' && theme.accentColor.trim() ? theme.accentColor : DEFAULT_RICHPOST_THEME_DRAFT.accentColor,
    headingFont: typeof theme?.headingFont === 'string' && theme.headingFont.trim() ? theme.headingFont : DEFAULT_RICHPOST_THEME_DRAFT.headingFont,
    bodyFont: typeof theme?.bodyFont === 'string' && theme.bodyFont.trim() ? theme.bodyFont : DEFAULT_RICHPOST_THEME_DRAFT.bodyFont,
    coverFrame: clampRichpostZoneFrame(theme?.coverFrame, DEFAULT_RICHPOST_THEME_DRAFT.coverFrame),
    bodyFrame: clampRichpostZoneFrame(theme?.bodyFrame, DEFAULT_RICHPOST_THEME_DRAFT.bodyFrame),
    endingFrame: clampRichpostZoneFrame(theme?.endingFrame, DEFAULT_RICHPOST_THEME_DRAFT.endingFrame),
    coverBackgroundPath: typeof theme?.coverBackgroundPath === 'string' ? theme.coverBackgroundPath : '',
    bodyBackgroundPath: typeof theme?.bodyBackgroundPath === 'string' ? theme.bodyBackgroundPath : '',
    endingBackgroundPath: typeof theme?.endingBackgroundPath === 'string' ? theme.endingBackgroundPath : '',
  };
}

function richpostFrameForRole(draft: RichpostThemeDraft, role: RichpostZoneFrameRole): RichpostZoneFrame {
  if (role === 'cover') return draft.coverFrame;
  if (role === 'ending') return draft.endingFrame;
  return draft.bodyFrame;
}

function richpostBackgroundPathForRole(draft: RichpostThemeDraft, role: RichpostZoneFrameRole): string {
  if (role === 'cover') return draft.coverBackgroundPath;
  if (role === 'ending') return draft.endingBackgroundPath;
  return draft.bodyBackgroundPath;
}

function updateRichpostThemeDraftFrame(
  draft: RichpostThemeDraft,
  role: RichpostZoneFrameRole,
  frame: RichpostZoneFrame
): RichpostThemeDraft {
  if (role === 'cover') {
    return { ...draft, coverFrame: frame };
  }
  if (role === 'ending') {
    return { ...draft, endingFrame: frame };
  }
  return { ...draft, bodyFrame: frame };
}

function richpostThemeDraftSignature(draft: RichpostThemeDraft): string {
  return JSON.stringify(draft);
}

function normalizeRichpostThemeLabelInput(value: string, fallback: string): string {
  const normalized = value
    .replace(/[\r\n]+/g, ' ')
    .trim()
    .split(/\s+/)
    .join(' ')
    .slice(0, 32);
  return normalized || fallback;
}

type RichpostZoneFrameHandle = 'move' | 'nw' | 'ne' | 'sw' | 'se';
type RichpostTypographyPreviewTarget =
  | 'heading-primary'
  | 'heading-accent'
  | 'heading-muted'
  | 'body-primary'
  | 'body-accent';

type TypographyPreviewEditorState = {
  id: RichpostTypographyPreviewTarget;
  label: string;
  fontFamily: string;
  color: string;
};

const FALLBACK_SYSTEM_FONT_OPTIONS = [
  '"PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif',
  '"Songti SC","STSong","Source Han Serif SC",serif',
  '"Kaiti SC","STKaiti","KaiTi","Songti SC",serif',
  '"STFangsong","FangSong","Songti SC",serif',
  '"Helvetica Neue","Arial",sans-serif',
  '"Times New Roman","Georgia",serif',
  '"Avenir Next","Helvetica Neue",sans-serif',
  '"SF Pro Display","PingFang SC",sans-serif',
];

function fontFamilyLabel(value: string): string {
  const first = value.split(',')[0]?.trim() || value;
  return first.replace(/^["']+|["']+$/g, '');
}

function richpostTypographyPreviewEditorState(
  draft: RichpostThemeDraft,
  target: RichpostTypographyPreviewTarget,
): TypographyPreviewEditorState {
  switch (target) {
    case 'heading-accent':
      return {
        id: target,
        label: '标题强调',
        fontFamily: draft.headingFont || DEFAULT_RICHPOST_THEME_DRAFT.headingFont,
        color: draft.accentColor || draft.textColor || DEFAULT_RICHPOST_THEME_DRAFT.accentColor,
      };
    case 'heading-muted':
      return {
        id: target,
        label: '标题弱化',
        fontFamily: draft.headingFont || DEFAULT_RICHPOST_THEME_DRAFT.headingFont,
        color: draft.mutedColor || draft.textColor || DEFAULT_RICHPOST_THEME_DRAFT.mutedColor,
      };
    case 'body-primary':
      return {
        id: target,
        label: '正文',
        fontFamily: draft.bodyFont || DEFAULT_RICHPOST_THEME_DRAFT.bodyFont,
        color: draft.bodyColor || draft.textColor || DEFAULT_RICHPOST_THEME_DRAFT.bodyColor,
      };
    case 'body-accent':
      return {
        id: target,
        label: '正文强调',
        fontFamily: draft.bodyFont || DEFAULT_RICHPOST_THEME_DRAFT.bodyFont,
        color: draft.accentColor || draft.textColor || DEFAULT_RICHPOST_THEME_DRAFT.accentColor,
      };
    case 'heading-primary':
    default:
      return {
        id: 'heading-primary',
        label: '标题',
        fontFamily: draft.headingFont || DEFAULT_RICHPOST_THEME_DRAFT.headingFont,
        color: draft.headingColor || draft.textColor || DEFAULT_RICHPOST_THEME_DRAFT.headingColor,
      };
  }
}

function updateRichpostThemeDraftTypographyTarget(
  draft: RichpostThemeDraft,
  target: RichpostTypographyPreviewTarget,
  patch: { fontFamily?: string; color?: string },
): RichpostThemeDraft {
  const next = { ...draft };
  if (patch.fontFamily) {
    if (target.startsWith('heading')) {
      next.headingFont = patch.fontFamily;
    } else {
      next.bodyFont = patch.fontFamily;
    }
  }
  if (patch.color) {
    if (target === 'heading-accent' || target === 'body-accent') {
      next.accentColor = patch.color;
    } else if (target === 'heading-muted') {
      next.mutedColor = patch.color;
    } else if (target === 'heading-primary') {
      next.headingColor = patch.color;
      next.textColor = next.bodyColor || next.textColor;
    } else if (target === 'body-primary') {
      next.bodyColor = patch.color;
      next.textColor = patch.color;
    } else {
      next.textColor = patch.color;
    }
  }
  return next;
}

function RichpostZoneFrameOverlay({
  frame,
  onChange,
}: {
  frame: RichpostZoneFrame;
  onChange: (frame: RichpostZoneFrame) => void;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const dragStateRef = useRef<{
    handle: RichpostZoneFrameHandle;
    startX: number;
    startY: number;
    startFrame: RichpostZoneFrame;
    width: number;
    height: number;
  } | null>(null);

  useEffect(() => {
    return () => {
      dragStateRef.current = null;
    };
  }, []);

  const beginDrag = (handle: RichpostZoneFrameHandle, event: ReactPointerEvent<HTMLDivElement>) => {
    const host = hostRef.current;
    if (!host) return;
    const rect = host.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    event.preventDefault();
    event.stopPropagation();
    dragStateRef.current = {
      handle,
      startX: event.clientX,
      startY: event.clientY,
      startFrame: frame,
      width: rect.width,
      height: rect.height,
    };
    const handleMove = (moveEvent: PointerEvent) => {
      const state = dragStateRef.current;
      if (!state) return;
      const dx = (moveEvent.clientX - state.startX) / state.width;
      const dy = (moveEvent.clientY - state.startY) / state.height;
      let next = state.startFrame;
      switch (state.handle) {
        case 'move':
          next = {
            ...state.startFrame,
            x: state.startFrame.x + dx,
            y: state.startFrame.y + dy,
          };
          break;
        case 'nw':
          next = {
            x: state.startFrame.x + dx,
            y: state.startFrame.y + dy,
            w: state.startFrame.w - dx,
            h: state.startFrame.h - dy,
          };
          break;
        case 'ne':
          next = {
            x: state.startFrame.x,
            y: state.startFrame.y + dy,
            w: state.startFrame.w + dx,
            h: state.startFrame.h - dy,
          };
          break;
        case 'sw':
          next = {
            x: state.startFrame.x + dx,
            y: state.startFrame.y,
            w: state.startFrame.w - dx,
            h: state.startFrame.h + dy,
          };
          break;
        case 'se':
          next = {
            x: state.startFrame.x,
            y: state.startFrame.y,
            w: state.startFrame.w + dx,
            h: state.startFrame.h + dy,
          };
          break;
      }
      onChange(clampRichpostZoneFrame(next, state.startFrame));
    };
    const handleUp = () => {
      dragStateRef.current = null;
      window.removeEventListener('pointermove', handleMove);
      window.removeEventListener('pointerup', handleUp);
    };
    window.addEventListener('pointermove', handleMove);
    window.addEventListener('pointerup', handleUp, { once: true });
  };

  return (
    <div ref={hostRef} className="absolute inset-0 z-[3]">
      <div
        className="absolute border-2 border-accent-primary/60 bg-accent-primary/12 shadow-[0_14px_36px_rgba(15,23,42,0.12)] backdrop-blur-[1px]"
        style={{
          left: `${frame.x * 100}%`,
          top: `${frame.y * 100}%`,
          width: `${frame.w * 100}%`,
          height: `${frame.h * 100}%`,
        }}
      >
        <div
          className="flex h-full w-full cursor-move items-center justify-center px-3 text-center"
          onPointerDown={(event) => beginDrag('move', event)}
        >
          <div className="text-[22px] font-black tracking-[0.22em] text-text-secondary/70">文字区域</div>
        </div>
        {([
          ['nw', 'cursor-nwse-resize', '-left-2 -top-2'],
          ['ne', 'cursor-nesw-resize', '-right-2 -top-2'],
          ['sw', 'cursor-nesw-resize', '-bottom-2 -left-2'],
          ['se', 'cursor-nwse-resize', '-bottom-2 -right-2'],
        ] as Array<[RichpostZoneFrameHandle, string, string]>).map(([handle, cursorClass, positionClass]) => (
          <div
            key={handle}
            className={clsx(
              'absolute h-4 w-4 rounded-full border border-white bg-accent-primary shadow-sm',
              cursorClass,
              positionClass,
            )}
            onPointerDown={(event) => beginDrag(handle, event)}
          />
        ))}
      </div>
    </div>
  );
}

function RichpostThemeEditorOverlay({
  previews,
  themeDraft,
  isPreviewLoading,
  isSaving,
  canSave,
  uploadingBackgroundRole,
  editorChatSessionId,
  editorChatReady,
  isActive,
  shortcuts,
  onThemeDraftChange,
  onSave,
  onUploadBackground,
  onClose,
}: {
  previews: RichpostThemePreviewRecord[];
  themeDraft: RichpostThemeDraft;
  isPreviewLoading: boolean;
  isSaving: boolean;
  canSave: boolean;
  uploadingBackgroundRole: RichpostZoneFrameRole | null;
  editorChatSessionId: string | null;
  editorChatReady: boolean;
  isActive: boolean;
  shortcuts: Array<{ label: string; text: string }>;
  onThemeDraftChange: (draft: RichpostThemeDraft) => void;
  onSave: () => void;
  onUploadBackground: (role: RichpostZoneFrameRole) => void;
  onClose: () => void;
}) {
  const [isEditingThemeLabel, setIsEditingThemeLabel] = useState(false);
  const [themeLabelInput, setThemeLabelInput] = useState(themeDraft.label || DEFAULT_RICHPOST_THEME_DRAFT.label);
  const [selectedTypographyTarget, setSelectedTypographyTarget] = useState<RichpostTypographyPreviewTarget>('heading-primary');
  const [systemFontOptions, setSystemFontOptions] = useState<string[]>(FALLBACK_SYSTEM_FONT_OPTIONS);

  useEffect(() => {
    if (!isEditingThemeLabel) {
      setThemeLabelInput(themeDraft.label || DEFAULT_RICHPOST_THEME_DRAFT.label);
    }
  }, [isEditingThemeLabel, themeDraft.label]);

  useEffect(() => {
    let cancelled = false;
    const queryLocalFonts = (window as Window & {
      queryLocalFonts?: () => Promise<Array<{ family: string }>>;
    }).queryLocalFonts;
    if (!queryLocalFonts) return;
    void queryLocalFonts()
      .then((fonts) => {
        if (cancelled || !Array.isArray(fonts) || fonts.length === 0) return;
        const next = Array.from(new Set(
          fonts
            .map((font) => (typeof font?.family === 'string' ? font.family.trim() : ''))
            .filter((value) => value.length > 0)
            .map((value) => `"${value}",sans-serif`)
        ));
        if (next.length > 0) {
          setSystemFontOptions((prev) => Array.from(new Set([...next, ...prev])));
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  const commitThemeLabel = () => {
    const nextLabel = normalizeRichpostThemeLabelInput(
      themeLabelInput,
      themeDraft.label || DEFAULT_RICHPOST_THEME_DRAFT.label
    );
    setThemeLabelInput(nextLabel);
    setIsEditingThemeLabel(false);
    if (nextLabel !== themeDraft.label) {
      onThemeDraftChange({
        ...themeDraft,
        label: nextLabel,
      });
    }
  };

  const typographyEditor = richpostTypographyPreviewEditorState(themeDraft, selectedTypographyTarget);
  const handleOpenThemeGuide = async () => {
    try {
      const result = await window.ipcRenderer.openRichpostThemeGuide();
      if (!result?.success) {
        void appAlert(`打开主题编辑指南失败：${result?.error || '未知错误'}`);
      }
    } catch (error) {
      console.error('Failed to open richpost theme guide', error);
      void appAlert(`打开主题编辑指南失败：${String(error)}`);
    }
  };

  return (
    <div className="fixed inset-0 z-[120] isolate overflow-hidden bg-background text-text-primary">
      <div
        className="absolute inset-0"
        style={{
          background:
            'radial-gradient(circle at top left, rgb(var(--color-accent-primary) / 0.14) 0%, transparent 36%), linear-gradient(180deg, rgb(var(--color-background) / 1) 0%, rgb(var(--color-surface-secondary) / 0.78) 100%)',
        }}
      />
      <div className="relative flex h-full min-h-0 flex-col">
        <header className="flex items-center justify-between border-b border-border/70 bg-surface-primary/90 px-6 py-4 backdrop-blur-xl">
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={onClose}
              className="inline-flex h-10 w-10 items-center justify-center rounded-full border border-border bg-surface-elevated text-text-secondary transition hover:bg-surface-secondary hover:text-text-primary"
              aria-label="返回主题抽屉"
              title="返回"
            >
              <ArrowLeft className="h-4 w-4" />
            </button>
            <div>
              <div className="text-[11px] font-semibold uppercase tracking-[0.22em] text-text-tertiary">图文主题编辑</div>
              {isEditingThemeLabel ? (
                <input
                  value={themeLabelInput}
                  onChange={(event) => setThemeLabelInput(event.target.value)}
                  onBlur={commitThemeLabel}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault();
                      commitThemeLabel();
                    } else if (event.key === 'Escape') {
                      event.preventDefault();
                      setThemeLabelInput(themeDraft.label || DEFAULT_RICHPOST_THEME_DRAFT.label);
                      setIsEditingThemeLabel(false);
                    }
                  }}
                  autoFocus
                  maxLength={32}
                  className="mt-1 h-9 min-w-[240px] rounded-xl border border-border bg-surface-elevated px-3 text-[20px] font-semibold text-text-primary shadow-sm outline-none ring-0 placeholder:text-text-tertiary focus:border-accent-primary/35"
                  placeholder="输入主题名称"
                />
              ) : (
                <button
                  type="button"
                  onClick={() => setIsEditingThemeLabel(true)}
                  className="mt-1 -ml-2 inline-flex items-center rounded-xl px-2 py-1 text-left text-[20px] font-semibold text-text-primary transition hover:bg-surface-secondary/70"
                  title="点击重命名主题"
                >
                  {themeDraft.label || DEFAULT_RICHPOST_THEME_DRAFT.label}
                </button>
              )}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => {
                void handleOpenThemeGuide();
              }}
              className="inline-flex items-center gap-1 rounded-full px-2 py-1 text-[12px] font-medium text-text-secondary transition hover:bg-surface-secondary hover:text-text-primary"
            >
              <span>主题编辑指南</span>
              <ExternalLink className="h-3.5 w-3.5" />
            </button>
            <div className="rounded-full border border-border bg-surface-elevated px-3 py-1.5 text-[12px] font-medium text-text-secondary">编辑首页、内容页和尾页风格</div>
            <button
              type="button"
              onClick={onSave}
              disabled={isSaving || !canSave}
              className="inline-flex items-center gap-2 rounded-full border border-transparent bg-accent-primary px-4 py-2 text-[12px] font-semibold text-white transition hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-45"
            >
              {isSaving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
              {isSaving ? '保存中' : '保存主题'}
            </button>
          </div>
        </header>

        <div
          className={clsx(
            'grid min-h-0 flex-1',
            SHOW_RICHPOST_THEME_EDITOR_CHAT ? 'grid-cols-[minmax(0,1fr)_420px]' : 'grid-cols-1'
          )}
        >
          <section
            className={clsx(
              'min-h-0 overflow-y-auto px-6 py-6',
              SHOW_RICHPOST_THEME_EDITOR_CHAT && 'border-r border-border/70'
            )}
          >
            <div className="mx-auto max-w-[1100px]">
              <div
                className="mb-5 max-w-[720px] rounded-[22px] border border-border/70 px-5 py-5 shadow-[var(--ui-shadow-1)]"
                style={{
                  background: themeDraft.pageBg || 'rgb(var(--color-surface-elevated) / 1)',
                  color: themeDraft.bodyColor || themeDraft.textColor || '#111111',
                }}
              >
                <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_220px] lg:items-start">
                  <div className="space-y-3">
                  <div
                    role="button"
                    tabIndex={0}
                    onClick={() => setSelectedTypographyTarget('heading-primary')}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault();
                        setSelectedTypographyTarget('heading-primary');
                      }
                    }}
                    className={clsx(
                      'cursor-pointer rounded-xl px-2 py-1 text-[28px] font-black leading-[1.08] outline-none transition',
                      selectedTypographyTarget === 'heading-primary' ? 'bg-surface-secondary/80 ring-1 ring-accent-primary/25' : 'hover:bg-surface-secondary/55'
                    )}
                    style={{
                      fontFamily: themeDraft.headingFont || 'inherit',
                      color: themeDraft.headingColor || themeDraft.textColor || '#111111',
                    }}
                  >
                    这是标题
                  </div>
                  <div
                    role="button"
                    tabIndex={0}
                    onClick={() => setSelectedTypographyTarget('heading-accent')}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault();
                        setSelectedTypographyTarget('heading-accent');
                      }
                    }}
                    className={clsx(
                      'cursor-pointer rounded-xl px-2 py-1 text-[21px] font-bold leading-[1.16] outline-none transition',
                      selectedTypographyTarget === 'heading-accent' ? 'bg-surface-secondary/80 ring-1 ring-accent-primary/25' : 'hover:bg-surface-secondary/55'
                    )}
                    style={{
                      fontFamily: themeDraft.headingFont || 'inherit',
                      color: themeDraft.accentColor || themeDraft.textColor || '#111111',
                    }}
                  >
                    这是标题
                  </div>
                  <div
                    role="button"
                    tabIndex={0}
                    onClick={() => setSelectedTypographyTarget('heading-muted')}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault();
                        setSelectedTypographyTarget('heading-muted');
                      }
                    }}
                    className={clsx(
                      'cursor-pointer rounded-xl px-2 py-1 text-[16px] font-semibold leading-[1.22] outline-none transition',
                      selectedTypographyTarget === 'heading-muted' ? 'bg-surface-secondary/80 ring-1 ring-accent-primary/25' : 'hover:bg-surface-secondary/55'
                    )}
                    style={{
                      fontFamily: themeDraft.headingFont || 'inherit',
                      color: themeDraft.mutedColor || themeDraft.textColor || '#111111',
                    }}
                  >
                    这是标题
                  </div>
                  <div
                    role="button"
                    tabIndex={0}
                    onClick={() => setSelectedTypographyTarget('body-primary')}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault();
                        setSelectedTypographyTarget('body-primary');
                      }
                    }}
                    className={clsx(
                      'space-y-2 rounded-xl px-2 py-2 text-[15px] leading-[1.85] outline-none transition',
                      selectedTypographyTarget === 'body-primary' ? 'bg-surface-secondary/80 ring-1 ring-accent-primary/25' : 'cursor-pointer hover:bg-surface-secondary/55'
                    )}
                    style={{
                      fontFamily: themeDraft.bodyFont || 'inherit',
                      color: themeDraft.bodyColor || themeDraft.textColor || '#111111',
                    }}
                  >
                    <p className="m-0">这是正文，展示当前主题下正文的字体、颜色和行距。</p>
                    <p className="m-0">
                      这是正文，
                      <strong
                        role="button"
                        tabIndex={0}
                        onClick={(event) => {
                          event.stopPropagation();
                          setSelectedTypographyTarget('body-accent');
                        }}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter' || event.key === ' ') {
                            event.preventDefault();
                            event.stopPropagation();
                            setSelectedTypographyTarget('body-accent');
                          }
                        }}
                        className={clsx(
                          'rounded px-1 outline-none transition',
                          selectedTypographyTarget === 'body-accent' ? 'bg-surface-tertiary/80 ring-1 ring-accent-primary/25' : 'hover:bg-surface-secondary/70'
                        )}
                        style={{
                          color: themeDraft.accentColor || themeDraft.textColor || '#111111',
                          fontWeight: 800,
                        }}
                      >
                        这是加粗
                      </strong>
                      ，用于确认强调内容会如何出现。
                    </p>
                  </div>
                  </div>
                  <div className="w-full rounded-[18px] border border-border bg-surface-elevated/95 p-3 shadow-[var(--ui-shadow-1)] backdrop-blur-xl lg:sticky lg:top-0">
                    <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-text-tertiary">文字样式</div>
                    <div className="mt-1 text-[13px] font-semibold text-text-primary">{typographyEditor.label}</div>
                    <label className="mt-3 block">
                      <div className="mb-1 text-[10px] font-medium uppercase tracking-[0.14em] text-text-tertiary">颜色</div>
                      <div className="flex items-center gap-2">
                        <input
                          type="color"
                          value={typographyEditor.color}
                          onChange={(event) => {
                            onThemeDraftChange(updateRichpostThemeDraftTypographyTarget(
                              themeDraft,
                              selectedTypographyTarget,
                              { color: event.target.value }
                            ));
                          }}
                          className="h-9 w-10 cursor-pointer rounded border border-border bg-transparent p-0"
                        />
                        <div className="rounded-lg border border-border bg-surface-secondary/80 px-2.5 py-1.5 text-[11px] font-medium text-text-secondary">
                          {typographyEditor.color}
                        </div>
                      </div>
                    </label>
                    <label className="mt-3 block">
                      <div className="mb-1 text-[10px] font-medium uppercase tracking-[0.14em] text-text-tertiary">字体</div>
                      <select
                        value={typographyEditor.fontFamily}
                        onChange={(event) => {
                          onThemeDraftChange(updateRichpostThemeDraftTypographyTarget(
                            themeDraft,
                            selectedTypographyTarget,
                            { fontFamily: event.target.value }
                          ));
                        }}
                        className="h-9 w-full rounded-xl border border-border bg-surface-primary px-3 text-[12px] text-text-primary outline-none focus:border-accent-primary/35"
                      >
                        {systemFontOptions.map((font) => (
                          <option key={font} value={font}>
                            {fontFamilyLabel(font)}
                          </option>
                        ))}
                      </select>
                    </label>
                  </div>
                </div>
              </div>
              <div className="grid gap-5 xl:grid-cols-3">
                {(previews.length ? previews : [
                  { id: 'cover', label: '首页', html: '' },
                  { id: 'body', label: '内容页', html: '' },
                  { id: 'ending', label: '尾页', html: '' },
                ]).map((preview) => (
                  <div key={preview.id} className="space-y-3">
                    <div className="flex items-center justify-between px-1">
                      <div className="text-[12px] font-semibold tracking-[0.08em] text-text-secondary">{preview.label || preview.id}</div>
                      <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-text-tertiary">3:4</div>
                    </div>
                    <div className="relative">
                      <RichpostThemePreviewFrame html={preview.html} bare />
                      <RichpostZoneFrameOverlay
                        frame={richpostFrameForRole(
                          themeDraft,
                          preview.id === 'cover' ? 'cover' : preview.id === 'ending' ? 'ending' : 'body',
                        )}
                        onChange={(frame) => {
                          const role = preview.id === 'cover' ? 'cover' : preview.id === 'ending' ? 'ending' : 'body';
                          onThemeDraftChange(updateRichpostThemeDraftFrame(themeDraft, role, frame));
                        }}
                      />
                      {isPreviewLoading ? (
                        <div className="absolute inset-0 flex items-center justify-center rounded-[14px] bg-background/55 backdrop-blur-[2px]">
                          <div className="inline-flex items-center gap-2 rounded-full border border-border bg-surface-elevated/92 px-3 py-1.5 text-[12px] text-text-secondary shadow-sm">
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            更新中
                          </div>
                        </div>
                      ) : null}
                    </div>
                    <div className="flex items-center justify-between gap-3 px-1">
                      <div className="truncate text-[11px] text-text-tertiary">
                        {richpostBackgroundPathForRole(
                          themeDraft,
                          preview.id === 'cover' ? 'cover' : preview.id === 'ending' ? 'ending' : 'body',
                        )
                          ? '已设置背景图'
                          : '未设置背景图'}
                      </div>
                      <button
                        type="button"
                        onClick={() => onUploadBackground(preview.id === 'cover' ? 'cover' : preview.id === 'ending' ? 'ending' : 'body')}
                        className="inline-flex items-center gap-2 rounded-full border border-border bg-surface-elevated px-3 py-1.5 text-[12px] font-medium text-text-primary transition hover:bg-surface-secondary"
                      >
                        {uploadingBackgroundRole === (preview.id === 'cover' ? 'cover' : preview.id === 'ending' ? 'ending' : 'body') ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <ImageIcon className="h-3.5 w-3.5" />
                        )}
                        上传背景图
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </section>

          {SHOW_RICHPOST_THEME_EDITOR_CHAT ? (
            <aside className="min-h-0 border-l border-border/70 bg-surface-primary/90 backdrop-blur-xl">
              <div className="flex h-full min-h-0 flex-col">
                <div className="border-b border-border/70 px-5 py-4">
                  <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-text-tertiary">对话修改</div>
                  <div className="mt-2 text-[18px] font-semibold text-text-primary">直接描述你想要的主题风格</div>
                </div>
                <div className="min-h-0 flex-1 overflow-hidden">
                  {editorChatSessionId && editorChatReady ? (
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
                        embeddedTheme="auto"
                        welcomeTitle="图文排版"
                        welcomeSubtitle="描述你希望的首页、内容页和尾页风格，让 AI 来改主题。"
                        shortcuts={shortcuts}
                        welcomeShortcuts={shortcuts}
                        fixedSessionBannerText={`图文主题编辑 · ${themeDraft.label || '当前主题'}`}
                      />
                    </Suspense>
                  ) : (
                    <div className="flex h-full items-center justify-center px-6 text-center">
                      <div>
                        <Loader2 className="mx-auto h-5 w-5 animate-spin text-accent-primary/70" />
                        <div className="mt-3 text-sm text-text-secondary">
                          {editorChatSessionId ? '正在同步当前主题上下文...' : '正在初始化 AI 会话...'}
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </aside>
          ) : null}
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
  const normalizedPackagePath = String(packageFilePath || '').trim().replace(/\\/g, '/').replace(/\/+$/g, '');
  return `${normalizedPackagePath}/pages/${pageId}.html`;
}

async function loadRichpostExportPageHtml(
  packageFilePath: string,
  pageId: string,
  fontScale: number,
  lineHeightScale: number
): Promise<string> {
  const readPath = buildRichpostExportPageReadPath(packageFilePath, pageId);
  return loadRichpostPreviewHtml(readPath, {
    fontScale,
    lineHeightScale,
    errorLabel: `第 ${pageId} 页 HTML 为空`,
  });
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
  const previewWidth = compact ? RICHPOST_PREVIEW_PAGE_WIDTH_COMPACT : RICHPOST_PREVIEW_PAGE_WIDTH;
  const previewHeight = Math.round(previewWidth * 4 / 3);
  const previewScale = previewWidth / RICHPOST_RENDER_VIEWPORT_WIDTH;
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
      <div className="mx-auto w-fit space-y-5">
        {hasRenderedPages ? (
          <div className="space-y-4">
            {pages.map((page) => {
              const frameUrl = buildPreviewFrameUrl(page.fileUrl || page.filePath, page.updatedAt, {
                fontScale,
                lineHeightScale,
              });
              return (
                <section
                  key={page.id}
                  className="border border-border bg-surface-primary p-4 shadow-sm"
                  style={{ width: previewWidth + 32 }}
                >
                  {frameUrl ? (
                    <div
                      className="relative overflow-hidden border border-border bg-surface-elevated"
                      style={{ width: previewWidth, height: previewHeight }}
                    >
                      <iframe
                        title={page.title || page.label}
                        src={frameUrl}
                        sandbox={RICHPOST_PREVIEW_SANDBOX}
                        className="absolute left-0 top-0 border-0 bg-surface-elevated"
                        style={{
                          width: `${RICHPOST_RENDER_VIEWPORT_WIDTH}px`,
                          height: `${RICHPOST_RENDER_VIEWPORT_HEIGHT}px`,
                          transform: `scale(${previewScale})`,
                          transformOrigin: 'top left',
                        }}
                      />
                    </div>
                  ) : (
                    <div
                      className="flex items-center justify-center border border-dashed border-border bg-surface-elevated text-sm text-text-tertiary"
                      style={{ width: previewWidth, height: previewHeight }}
                    >
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
              保存正文或调整图文样式后，这里会自动刷新多页预览。
            </div>
          </div>
        ) : !hasRenderedPages && previewFrameUrl ? (
          <div
            className="relative overflow-hidden border border-border bg-surface-elevated"
            style={{ width: previewWidth, height: previewHeight }}
          >
            <iframe
              title="图文预览"
              src={previewFrameUrl}
              sandbox={RICHPOST_PREVIEW_SANDBOX}
              className="absolute left-0 top-0 border-0 bg-surface-elevated"
              style={{
                width: `${RICHPOST_RENDER_VIEWPORT_WIDTH}px`,
                height: `${RICHPOST_RENDER_VIEWPORT_HEIGHT}px`,
                transform: `scale(${previewScale})`,
                transformOrigin: 'top left',
              }}
            />
          </div>
        ) : !hasRenderedPages && previewHtml?.trim() ? (
          <div
            className="relative overflow-hidden border border-border bg-surface-elevated"
            style={{ width: previewWidth, height: previewHeight }}
          >
            <iframe
              title="图文预览"
              srcDoc={previewHtml}
              sandbox={RICHPOST_PREVIEW_SANDBOX}
              className="absolute left-0 top-0 border-0 bg-surface-elevated"
              style={{
                width: `${RICHPOST_RENDER_VIEWPORT_WIDTH}px`,
                height: `${RICHPOST_RENDER_VIEWPORT_HEIGHT}px`,
                transform: `scale(${previewScale})`,
                transformOrigin: 'top left',
              }}
            />
          </div>
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
            className="w-full rounded-2xl border border-border bg-surface-elevated"
            style={{ height: iframeHeight }}
          />
        ) : previewHtml?.trim() ? (
          <iframe
            title={`${previewLabel || '长文'}预览`}
            srcDoc={previewHtml}
            sandbox="allow-popups allow-popups-to-escape-sandbox"
            className="w-full rounded-2xl border border-border bg-surface-elevated"
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
          className="manuscript-editor-shell h-full min-h-0 bg-transparent"
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
  editorChatReady = true,
  isActive = false,
  previewHtml,
  layoutPreview = null,
  wechatPreview = null,
  richpostPages = [],
  richpostThemeId = null,
  richpostFontScale: richpostFontScaleProp = 1,
  richpostLineHeightScale: richpostLineHeightScaleProp = 1,
  richpostThemePresets = [],
  richpostThemesDir = null,
  richpostThemeTemplateFile = null,
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
  onPackageStateChange,
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
  const [isRichpostThemeEditorOpen, setIsRichpostThemeEditorOpen] = useState(false);
  const [isCreatingRichpostThemeEditor, setIsCreatingRichpostThemeEditor] = useState(false);
  const [richpostThemePreviewHtmlMap, setRichpostThemePreviewHtmlMap] = useState<Record<string, string>>({});
  const [isLoadingRichpostThemePreviews, setIsLoadingRichpostThemePreviews] = useState(false);
  const [richpostThemeContextMenu, setRichpostThemeContextMenu] = useState<RichpostThemeContextMenuState>({
    visible: false,
    x: 0,
    y: 0,
    theme: null,
  });
  const [richpostThemeRenameOpen, setRichpostThemeRenameOpen] = useState(false);
  const [richpostThemeRenameValue, setRichpostThemeRenameValue] = useState('');
  const [richpostThemeRenameTarget, setRichpostThemeRenameTarget] = useState<RichpostThemePreset | null>(null);
  const [isUpdatingRichpostTheme, setIsUpdatingRichpostTheme] = useState(false);
  const [uploadingThemeBackgroundRole, setUploadingThemeBackgroundRole] = useState<RichpostZoneFrameRole | null>(null);
  const [richpostThemeEditorDraft, setRichpostThemeEditorDraft] = useState<RichpostThemeDraft>(DEFAULT_RICHPOST_THEME_DRAFT);
  const [richpostThemeEditorBaseThemeId, setRichpostThemeEditorBaseThemeId] = useState<string | null>(null);
  const [richpostThemeEditorThemeId, setRichpostThemeEditorThemeId] = useState<string | null>(null);
  const [richpostThemeEditorThemeLabel, setRichpostThemeEditorThemeLabel] = useState<string | null>(null);
  const [richpostThemeEditorThemeRoot, setRichpostThemeEditorThemeRoot] = useState<string | null>(null);
  const [richpostThemeEditorThemeFile, setRichpostThemeEditorThemeFile] = useState<string | null>(null);
  const [richpostThemeEditorThemeTemplateFile, setRichpostThemeEditorThemeTemplateFile] = useState<string | null>(null);
  const [richpostThemeEditorPreviewPages, setRichpostThemeEditorPreviewPages] = useState<RichpostThemePreviewRecord[]>([]);
  const [isLoadingRichpostThemeEditorPreview, setIsLoadingRichpostThemeEditorPreview] = useState(false);
  const committedRichpostTypographyRef = useRef({
    fontScale: normalizedRichpostFontScaleProp,
    lineHeightScale: normalizedRichpostLineHeightScaleProp,
  });
  const pendingRichpostTypographyRef = useRef<{ fontScale: number; lineHeightScale: number } | null>(null);
  const richpostThemePreviewRequestIdRef = useRef(0);
  const richpostThemeEditorPreviewRequestIdRef = useRef(0);
  const richpostThemeEditorSaveRequestIdRef = useRef(0);
  const richpostThemeContextMenuRef = useRef<HTMLDivElement | null>(null);
  const richpostThemeEditorLastSavedSignatureRef = useRef(
    richpostThemeDraftSignature(DEFAULT_RICHPOST_THEME_DRAFT)
  );

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
    setIsRichpostThemeEditorOpen(false);
    setIsCreatingRichpostThemeEditor(false);
    setIsUpdatingRichpostTheme(false);
    setUploadingThemeBackgroundRole(null);
    setRichpostThemeContextMenu({ visible: false, x: 0, y: 0, theme: null });
    setRichpostThemeRenameOpen(false);
    setRichpostThemeRenameValue('');
    setRichpostThemeRenameTarget(null);
    setRichpostThemeEditorThemeId(null);
    setRichpostThemeEditorThemeLabel(null);
    setRichpostThemeEditorThemeRoot(null);
    setRichpostThemeEditorThemeFile(null);
    setRichpostThemeEditorThemeTemplateFile(null);
    setRichpostThemeEditorPreviewPages([]);
    richpostThemeEditorLastSavedSignatureRef.current = richpostThemeDraftSignature(DEFAULT_RICHPOST_THEME_DRAFT);
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
        { id: 'richpost' as const, label: '卡片' },
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
      return [{ id: 'richpost' as const, label: '卡片排版' }];
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
    if (isRichPost && isRichpostThemeEditorOpen) {
      return {
        id: 'richpost-theme-editing',
        label: '图文主题编辑',
        activeSkills: [RICHPOST_LAYOUT_SKILL_NAME, RICHPOST_THEME_EDITOR_SKILL_NAME],
        themeEditingId: richpostThemeEditorThemeId,
        themeEditingLabel: richpostThemeEditorThemeLabel,
        themeEditingRoot: richpostThemeEditorThemeRoot,
        themeEditingFile: richpostThemeEditorThemeFile,
        themeEditingTemplateFile: richpostThemeEditorThemeTemplateFile,
      };
    }
    const isRichpostLayoutMode = isRichPost
      && (
        activeTab === 'richpost'
        || (activeTab === 'manuscript' && isSplitCompareEnabled && splitPreviewTab === 'richpost')
      );
    if (isRichpostLayoutMode) {
      return {
        id: 'richpost-layout',
        label: '卡片排版',
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
    if (activeTab === 'layout' || activeTab === 'wechat' || (activeTab === 'manuscript' && isSplitCompareEnabled)) {
      return { id: 'article-layout', label: '长文排版', activeSkills: [] };
    }
    return { id: 'manuscript-editing', label: '稿件编辑', activeSkills: [] };
  }, [
    activeTab,
    isLongform,
    isRichPost,
    isRichpostThemeEditorOpen,
    isSplitCompareEnabled,
    richpostThemeEditorThemeRoot,
    richpostThemeEditorThemeFile,
    richpostThemeEditorThemeTemplateFile,
    richpostThemeEditorThemeId,
    richpostThemeEditorThemeLabel,
    splitPreviewTab,
  ]);

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
  const isRichpostThemeEditorDirty = useMemo(
    () => richpostThemeDraftSignature(richpostThemeEditorDraft) !== richpostThemeEditorLastSavedSignatureRef.current,
    [richpostThemeEditorDraft]
  );
  const activeRichpostThemePreset = useMemo(
    () => normalizedThemePresets.find((theme) => String(theme.id || '') === String(richpostThemeId || '')) || normalizedThemePresets[0] || null,
    [normalizedThemePresets, richpostThemeId]
  );
  const closeRichpostThemeEditor = useCallback(() => {
    setIsRichpostThemeEditorOpen(false);
    setRichpostThemeEditorThemeId(null);
    setRichpostThemeEditorThemeLabel(null);
    setRichpostThemeEditorThemeRoot(null);
    setRichpostThemeEditorThemeFile(null);
    setRichpostThemeEditorPreviewPages([]);
  }, []);

  const persistRichpostThemeEditorDraft = useCallback(async (options?: {
    silent?: boolean;
    closeAfterSave?: boolean;
  }) => {
    const silent = options?.silent ?? false;
    const closeAfterSave = options?.closeAfterSave ?? false;
    if (!isRichPost || !filePath || !richpostThemeEditorThemeId) {
      if (closeAfterSave) {
        closeRichpostThemeEditor();
      }
      return true;
    }
    const nextSignature = richpostThemeDraftSignature(richpostThemeEditorDraft);
    if (nextSignature === richpostThemeEditorLastSavedSignatureRef.current) {
      if (closeAfterSave) {
        closeRichpostThemeEditor();
      }
      return true;
    }
    setIsUpdatingRichpostTheme(true);
    try {
      const result = await window.ipcRenderer.invoke('manuscripts:save-richpost-custom-theme', {
        filePath,
        baseThemeId: richpostThemeEditorBaseThemeId,
        existingThemeId: richpostThemeEditorThemeId,
        theme: richpostThemeEditorDraft,
        apply: true,
      }) as {
        success?: boolean;
        error?: string;
        state?: PackageStateLike;
        theme?: RichpostThemePreset | null;
        themeId?: string | null;
        themeRoot?: string | null;
        themeFile?: string | null;
      };
      if (!result?.success || !result.theme) {
        throw new Error(result?.error || '保存主题失败');
      }
      const normalizedDraft = normalizeRichpostThemeDraft(result.theme);
      const normalizedSignature = richpostThemeDraftSignature(normalizedDraft);
      richpostThemeEditorLastSavedSignatureRef.current = normalizedSignature;
      if (normalizedSignature !== nextSignature) {
        setRichpostThemeEditorDraft(normalizedDraft);
      }
      if (typeof result.themeId === 'string' && result.themeId.trim()) {
        setRichpostThemeEditorThemeId(result.themeId);
      }
      if (typeof result.themeRoot === 'string' && result.themeRoot.trim()) {
        setRichpostThemeEditorThemeRoot(result.themeRoot);
      }
      if (typeof result.themeFile === 'string' && result.themeFile.trim()) {
        setRichpostThemeEditorThemeFile(result.themeFile);
      }
      if (typeof result.theme?.label === 'string' && result.theme.label.trim()) {
        setRichpostThemeEditorThemeLabel(result.theme.label);
      }
      if (result.state) {
        onPackageStateChange?.(result.state);
      }
      if (closeAfterSave) {
        closeRichpostThemeEditor();
      }
      return true;
    } catch (error) {
      console.error('Failed to save richpost custom theme:', error);
      if (!silent) {
        void appAlert(error instanceof Error ? error.message : '保存主题失败');
      }
      return false;
    } finally {
      setIsUpdatingRichpostTheme(false);
    }
  }, [
    closeRichpostThemeEditor,
    filePath,
    isRichPost,
    onPackageStateChange,
    richpostThemeEditorBaseThemeId,
    richpostThemeEditorDraft,
    richpostThemeEditorThemeId,
  ]);

  const openRichpostThemeEditor = (targetTheme?: RichpostThemePreset | null) => {
    if (!filePath || isCreatingRichpostThemeEditor || isUpdatingRichpostTheme) return;
    const baseTheme = targetTheme || activeRichpostThemePreset || normalizedThemePresets[0] || null;
    const creatingBlankTheme = !targetTheme;
    const baseThemeId = creatingBlankTheme
      ? null
      : typeof baseTheme?.id === 'string'
        ? baseTheme.id
        : null;
    if (targetTheme?.source === 'custom' && baseThemeId) {
      const normalizedThemesDir = typeof richpostThemesDir === 'string' && richpostThemesDir.trim()
        ? richpostThemesDir.replace(/\\/g, '/').replace(/\/+$/, '')
        : null;
      const normalizedThemeTemplateFile = typeof richpostThemeTemplateFile === 'string' && richpostThemeTemplateFile.trim()
        ? richpostThemeTemplateFile.replace(/\\/g, '/')
        : null;
      const normalizedDraft = normalizeRichpostThemeDraft(baseTheme);
      setRichpostThemeEditorDraft(normalizedDraft);
      richpostThemeEditorLastSavedSignatureRef.current = richpostThemeDraftSignature(normalizedDraft);
      setRichpostThemeEditorBaseThemeId(baseThemeId);
      setRichpostThemeEditorThemeId(baseThemeId);
      setRichpostThemeEditorThemeLabel(typeof baseTheme.label === 'string' ? baseTheme.label : normalizedDraft.label);
      setRichpostThemeEditorThemeRoot(normalizedThemesDir ? `${normalizedThemesDir}/${baseThemeId}` : null);
      setRichpostThemeEditorThemeFile(normalizedThemesDir ? `${normalizedThemesDir}/${baseThemeId}/${baseThemeId}.json` : null);
      setRichpostThemeEditorThemeTemplateFile(normalizedThemeTemplateFile);
      setRichpostThemeEditorPreviewPages([]);
      setRichpostThemeContextMenu({ visible: false, x: 0, y: 0, theme: null });
      setIsRichpostThemeDrawerOpen(false);
      setIsRichpostThemeEditorOpen(true);
      return;
    }
    setIsCreatingRichpostThemeEditor(true);
    void window.ipcRenderer.invoke('manuscripts:create-richpost-custom-theme', {
      filePath,
      baseThemeId,
      createFromBlank: creatingBlankTheme,
      theme: creatingBlankTheme
        ? {
          ...DEFAULT_RICHPOST_THEME_DRAFT,
          id: null,
          label: DEFAULT_RICHPOST_THEME_DRAFT.label,
          description: '',
          coverBackgroundPath: '',
          bodyBackgroundPath: '',
          endingBackgroundPath: '',
        }
        : baseTheme
        ? (() => {
          const draft = normalizeRichpostThemeDraft(baseTheme);
          return {
            ...draft,
            id: null,
            label: typeof baseTheme.label === 'string' && baseTheme.label.trim()
              ? `${baseTheme.label} 副本`
              : DEFAULT_RICHPOST_THEME_DRAFT.label,
          };
        })()
        : undefined,
    }).then((result) => {
      const payload = result as {
        success?: boolean;
        error?: string;
        theme?: RichpostThemePreset | null;
        state?: PackageStateLike;
        themeRoot?: string | null;
        themeFile?: string | null;
        themeIndexFile?: string | null;
        themeTemplateFile?: string | null;
      } | null;
      if (!payload?.success || !payload.theme) {
        throw new Error(payload?.error || '创建主题失败');
      }
      const normalizedDraft = normalizeRichpostThemeDraft(payload.theme);
      setRichpostThemeEditorDraft(normalizedDraft);
      richpostThemeEditorLastSavedSignatureRef.current = richpostThemeDraftSignature(normalizedDraft);
      setRichpostThemeEditorBaseThemeId(baseThemeId || (typeof payload.theme.id === 'string' ? payload.theme.id : null));
      setRichpostThemeEditorThemeId(typeof payload.theme.id === 'string' ? payload.theme.id : null);
      setRichpostThemeEditorThemeLabel(typeof payload.theme.label === 'string' ? payload.theme.label : normalizedDraft.label);
      setRichpostThemeEditorThemeRoot(typeof payload.themeRoot === 'string' ? payload.themeRoot : null);
      setRichpostThemeEditorThemeFile(typeof payload.themeFile === 'string' ? payload.themeFile : null);
      setRichpostThemeEditorThemeTemplateFile(typeof payload.themeTemplateFile === 'string' ? payload.themeTemplateFile : null);
      setRichpostThemeEditorPreviewPages([]);
      if (payload.state) {
        onPackageStateChange?.(payload.state);
      }
      setIsRichpostThemeDrawerOpen(false);
      setRichpostThemeContextMenu({ visible: false, x: 0, y: 0, theme: null });
      setIsRichpostThemeEditorOpen(true);
    }).catch((error) => {
      console.error('Failed to create richpost custom theme:', error);
      void appAlert(error instanceof Error ? error.message : '创建主题失败');
    }).finally(() => {
      setIsCreatingRichpostThemeEditor(false);
    });
  };

  const richpostThemePreviewKey = useMemo(
    () => normalizedThemePresets.map((theme) => String(theme.id || '')).join('|'),
    [normalizedThemePresets]
  );

  const normalizedLongformLayoutPresets = useMemo(
    () => longformLayoutPresets.filter((preset) => typeof preset?.id === 'string' && preset.id.trim()),
    [longformLayoutPresets]
  );

  const activeSplitPreviewLabel = useMemo(
    () => splitPreviewOptions.find((item) => item.id === splitPreviewTab)?.label || '排版',
    [splitPreviewOptions, splitPreviewTab]
  );

  useEffect(() => {
    setRichpostThemePreviewHtmlMap({});
  }, [filePath]);

  useEffect(() => {
    if (!isRichPost || !isRichpostThemeEditorOpen || !filePath) {
      return;
    }
    const requestId = ++richpostThemeEditorPreviewRequestIdRef.current;
    setIsLoadingRichpostThemeEditorPreview(true);
    const timeoutId = window.setTimeout(() => {
      void window.ipcRenderer.invoke('manuscripts:preview-richpost-theme-draft', {
        filePath,
        baseThemeId: richpostThemeEditorBaseThemeId,
        existingThemeId: richpostThemeEditorThemeId,
        theme: richpostThemeEditorDraft,
      }).then((result) => {
        if (richpostThemeEditorPreviewRequestIdRef.current !== requestId) {
          return;
        }
        const previews = Array.isArray((result as { previews?: RichpostThemePreviewRecord[] } | null | undefined)?.previews)
          ? ((result as { previews?: RichpostThemePreviewRecord[] }).previews || []).map((item) => ({
            id: String(item?.id || ''),
            label: typeof item?.label === 'string' ? item.label : '',
            html: typeof item?.html === 'string' ? item.html : '',
          })).filter((item) => item.id)
          : [];
        setRichpostThemeEditorPreviewPages(previews);
      }).catch((error) => {
        if (richpostThemeEditorPreviewRequestIdRef.current !== requestId) {
          return;
        }
        console.error('Failed to preview custom richpost theme draft:', error);
      }).finally(() => {
        if (richpostThemeEditorPreviewRequestIdRef.current === requestId) {
          setIsLoadingRichpostThemeEditorPreview(false);
        }
      });
    }, 140);
    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [
    filePath,
    isRichPost,
    isRichpostThemeEditorOpen,
    richpostThemeEditorBaseThemeId,
    richpostThemeEditorDraft,
    richpostThemeEditorThemeId,
  ]);

  useEffect(() => {
    if (!isRichPost || !isRichpostThemeEditorOpen || !filePath || !richpostThemeEditorThemeId) {
      return;
    }
    if (richpostThemeDraftSignature(richpostThemeEditorDraft) === richpostThemeEditorLastSavedSignatureRef.current) {
      return;
    }
    const requestId = ++richpostThemeEditorSaveRequestIdRef.current;
    const timeoutId = window.setTimeout(() => {
      void persistRichpostThemeEditorDraft({ silent: true }).catch((error) => {
        if (richpostThemeEditorSaveRequestIdRef.current !== requestId) {
          return;
        }
        console.error('Failed to save richpost custom theme:', error);
      });
    }, 220);
    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [
    filePath,
    isRichPost,
    isRichpostThemeEditorOpen,
    richpostThemeEditorDraft,
    richpostThemeEditorThemeId,
    persistRichpostThemeEditorDraft,
  ]);

  useEffect(() => {
    if (!isRichPost || !isRichpostThemeDrawerOpen || !filePath || !richpostThemePreviewKey) {
      return;
    }
    const requestId = ++richpostThemePreviewRequestIdRef.current;
    setIsLoadingRichpostThemePreviews(true);
    void window.ipcRenderer.invoke('manuscripts:get-richpost-theme-previews', {
      filePath,
      themeIds: normalizedThemePresets.map((theme) => String(theme.id || '')).filter(Boolean),
    }).then((result) => {
      if (richpostThemePreviewRequestIdRef.current !== requestId) {
        return;
      }
      const nextMap = Array.isArray((result as { previews?: RichpostThemePreviewRecord[] } | null | undefined)?.previews)
        ? ((result as { previews?: RichpostThemePreviewRecord[] }).previews || []).reduce<Record<string, string>>((accumulator, item) => {
          const themeId = String(item?.id || '').trim();
          const html = typeof item?.html === 'string' ? item.html : '';
          if (themeId && html.trim()) {
            accumulator[themeId] = html;
          }
          return accumulator;
        }, {})
        : {};
      setRichpostThemePreviewHtmlMap(nextMap);
    }).catch((error) => {
      if (richpostThemePreviewRequestIdRef.current !== requestId) {
        return;
      }
      console.error('Failed to load richpost theme previews:', error);
    }).finally(() => {
      if (richpostThemePreviewRequestIdRef.current === requestId) {
        setIsLoadingRichpostThemePreviews(false);
      }
    });
  }, [
    filePath,
    isRichPost,
    isRichpostThemeDrawerOpen,
    layoutPreview?.updatedAt,
    normalizedThemePresets,
    richpostThemePreviewKey,
  ]);

  useEffect(() => {
    if (!richpostThemeContextMenu.visible) return;
    const handlePointerDown = (event: MouseEvent) => {
      if (!richpostThemeContextMenuRef.current?.contains(event.target as Node)) {
        setRichpostThemeContextMenu({ visible: false, x: 0, y: 0, theme: null });
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setRichpostThemeContextMenu({ visible: false, x: 0, y: 0, theme: null });
      }
    };
    document.addEventListener('mousedown', handlePointerDown);
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [richpostThemeContextMenu.visible]);

  const handleOpenRichpostThemeContextMenu = (
    event: React.MouseEvent<HTMLElement>,
    theme: RichpostThemePreset
  ) => {
    event.preventDefault();
    event.stopPropagation();
    setRichpostThemeContextMenu({
      visible: true,
      x: event.clientX,
      y: event.clientY,
      theme,
    });
  };

  const handleStartRenameRichpostTheme = () => {
    const targetTheme = richpostThemeContextMenu.theme;
    if (!targetTheme || targetTheme.source !== 'custom') return;
    setRichpostThemeRenameTarget(targetTheme);
    setRichpostThemeRenameValue(typeof targetTheme.label === 'string' ? targetTheme.label : '');
    setRichpostThemeContextMenu({ visible: false, x: 0, y: 0, theme: null });
    setRichpostThemeRenameOpen(true);
  };

  const handleConfirmRenameRichpostTheme = async () => {
    const targetTheme = richpostThemeRenameTarget;
    const themeId = String(targetTheme?.id || '').trim();
    if (!filePath || !themeId || !targetTheme || targetTheme.source !== 'custom') return;
    const nextLabel = richpostThemeRenameValue.trim();
    if (!nextLabel) return;
    setIsUpdatingRichpostTheme(true);
    try {
      const result = await window.ipcRenderer.invoke('manuscripts:save-richpost-custom-theme', {
        filePath,
        baseThemeId: themeId,
        existingThemeId: themeId,
        theme: {
          ...targetTheme,
          label: nextLabel,
        },
        apply: false,
      }) as {
        success?: boolean;
        error?: string;
        state?: PackageStateLike;
        theme?: RichpostThemePreset | null;
      };
      if (!result?.success || !result.theme) {
        throw new Error(result?.error || '重命名主题失败');
      }
      if (result.state) {
        onPackageStateChange?.(result.state);
      }
      if (themeId === richpostThemeEditorThemeId) {
        setRichpostThemeEditorDraft((current) => ({ ...current, label: nextLabel }));
        setRichpostThemeEditorThemeLabel(nextLabel);
      }
      setRichpostThemeRenameOpen(false);
      setRichpostThemeRenameTarget(null);
      setRichpostThemeRenameValue('');
    } catch (error) {
      void appAlert(error instanceof Error ? error.message : '重命名主题失败');
    } finally {
      setIsUpdatingRichpostTheme(false);
    }
  };

  const handleDeleteRichpostTheme = async () => {
    const targetTheme = richpostThemeContextMenu.theme;
    const themeId = String(targetTheme?.id || '').trim();
    if (!filePath || !themeId || !targetTheme || targetTheme.source !== 'custom') return;
    const confirmed = await appConfirm(`确认删除主题“${targetTheme.label || themeId}”吗？`, {
      title: '删除主题',
      confirmLabel: '删除',
      cancelLabel: '取消',
      tone: 'danger',
    });
    if (!confirmed) return;
    setRichpostThemeContextMenu({ visible: false, x: 0, y: 0, theme: null });
    setIsUpdatingRichpostTheme(true);
    try {
      const result = await window.ipcRenderer.invoke('manuscripts:delete-richpost-custom-theme', {
        filePath,
        themeId,
      }) as {
        success?: boolean;
        error?: string;
        state?: PackageStateLike;
      };
      if (!result?.success) {
        throw new Error(result?.error || '删除主题失败');
      }
      if (themeId === richpostThemeEditorThemeId) {
        setIsRichpostThemeEditorOpen(false);
        setRichpostThemeEditorThemeId(null);
        setRichpostThemeEditorThemeLabel(null);
        setRichpostThemeEditorThemeFile(null);
        setRichpostThemeEditorPreviewPages([]);
      }
      if (result.state) {
        onPackageStateChange?.(result.state);
      }
    } catch (error) {
      void appAlert(error instanceof Error ? error.message : '删除主题失败');
    } finally {
      setIsUpdatingRichpostTheme(false);
    }
  };

  const handleUploadRichpostThemeBackground = async (role: RichpostZoneFrameRole) => {
    if (!filePath || !richpostThemeEditorThemeId || uploadingThemeBackgroundRole) return;
    setUploadingThemeBackgroundRole(role);
    try {
      const result = await window.ipcRenderer.invoke('manuscripts:upload-richpost-theme-background', {
        filePath,
        themeId: richpostThemeEditorThemeId,
        role,
      }) as {
        success?: boolean;
        canceled?: boolean;
        error?: string;
        state?: PackageStateLike;
        theme?: RichpostThemePreset | null;
      };
      if (result?.canceled) {
        return;
      }
      if (!result?.success || !result.theme) {
        throw new Error(result?.error || '上传背景图失败');
      }
      const normalizedDraft = normalizeRichpostThemeDraft(result.theme);
      setRichpostThemeEditorDraft(normalizedDraft);
      richpostThemeEditorLastSavedSignatureRef.current = richpostThemeDraftSignature(normalizedDraft);
      if (result.state) {
        onPackageStateChange?.(result.state);
      }
    } catch (error) {
      void appAlert(error instanceof Error ? error.message : '上传背景图失败');
    } finally {
      setUploadingThemeBackgroundRole(null);
    }
  };

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
                  ? 'absolute right-2 top-2 z-20 inline-flex items-center rounded-full border border-border bg-surface-primary/92 px-3 py-1.5 text-[12px] font-medium text-text-secondary shadow-sm backdrop-blur transition hover:text-text-primary'
                  : 'absolute right-3 top-3 z-20 inline-flex items-center rounded-full border border-border bg-surface-primary/92 px-3.5 py-1.5 text-[13px] font-medium text-text-secondary shadow-sm backdrop-blur transition hover:text-text-primary',
                isRichpostThemeDrawerOpen && 'pointer-events-none opacity-0'
              )}
              aria-label="打开图文主题抽屉"
              title="图文主题"
            >
              主题
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
                  className="inline-flex h-10 w-10 items-center justify-center rounded-full border border-border bg-surface-primary text-text-tertiary transition hover:bg-surface-secondary/50 hover:text-text-primary"
                  aria-label="关闭图文主题抽屉"
                  title="关闭"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
              <div className="min-h-0 flex-1 overflow-auto px-3 py-3">
                {isLoadingRichpostThemePreviews && Object.keys(richpostThemePreviewHtmlMap).length === 0 ? (
                  <div className="pb-3 text-[11px] text-text-tertiary">主题预览加载中</div>
                ) : null}
                <div className="grid grid-cols-2 gap-x-3 gap-y-4">
                  {normalizedThemePresets.map((theme) => {
                    const themeId = String(theme.id || '');
                    const active = themeId === richpostThemeId;
                    const previewHtml = richpostThemePreviewHtmlMap[themeId] || '';
                    return (
                      <div
                        key={themeId}
                        role="button"
                        tabIndex={0}
                        onClick={() => {
                          onSelectRichpostTheme?.(themeId);
                          setIsRichpostThemeDrawerOpen(false);
                        }}
                        onContextMenu={(event) => handleOpenRichpostThemeContextMenu(event, theme)}
                        onKeyDown={(event) => {
                          if (isApplyingRichpostTheme) return;
                          if (event.key === 'Enter' || event.key === ' ') {
                            event.preventDefault();
                            onSelectRichpostTheme?.(themeId);
                            setIsRichpostThemeDrawerOpen(false);
                          }
                        }}
                        aria-disabled={isApplyingRichpostTheme}
                        className={clsx(
                          'w-full cursor-pointer text-left transition duration-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-primary/40',
                          active ? 'opacity-100' : 'hover:-translate-y-0.5',
                          isApplyingRichpostTheme && 'pointer-events-none opacity-70'
                        )}
                      >
                        <div className={clsx('truncate text-[11px] font-medium', active ? 'text-accent-primary' : 'text-text-secondary')}>
                          {theme.label || themeId}
                        </div>
                        <div className="mt-2">
                          <RichpostThemePreviewFrame
                            html={previewHtml}
                            active={active}
                            capturePointer
                          />
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
              <div className="border-t border-border px-3 py-3">
                <button
                  type="button"
                  onClick={() => openRichpostThemeEditor()}
                  disabled={isCreatingRichpostThemeEditor || isUpdatingRichpostTheme}
                  className="inline-flex w-full items-center justify-center gap-2 rounded-2xl border border-dashed border-accent-primary/28 bg-accent-primary/6 px-4 py-3 text-[13px] font-semibold text-accent-primary transition hover:bg-accent-primary/10"
                >
                  {isCreatingRichpostThemeEditor ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
                  {isCreatingRichpostThemeEditor ? '创建中' : '添加主题'}
                </button>
              </div>
            </aside>
            {richpostThemeContextMenu.visible && richpostThemeContextMenu.theme ? (
              <div
                ref={richpostThemeContextMenuRef}
                className="fixed z-[120] min-w-[172px] overflow-hidden rounded-2xl border border-border bg-surface-elevated/96 p-1.5 shadow-[0_20px_48px_rgba(15,23,42,0.18)] backdrop-blur-xl"
                style={{
                  left: Math.min(richpostThemeContextMenu.x, window.innerWidth - 188),
                  top: Math.min(richpostThemeContextMenu.y, window.innerHeight - 160),
                }}
              >
                <button
                  type="button"
                  onClick={() => {
                    const theme = richpostThemeContextMenu.theme;
                    setRichpostThemeContextMenu({ visible: false, x: 0, y: 0, theme: null });
                    openRichpostThemeEditor(theme);
                  }}
                  className="flex w-full items-center rounded-xl px-3 py-2 text-left text-sm text-text-primary hover:bg-surface-secondary"
                >
                  编辑
                </button>
                <button
                  type="button"
                  onClick={handleStartRenameRichpostTheme}
                  disabled={richpostThemeContextMenu.theme.source !== 'custom'}
                  className="flex w-full items-center rounded-xl px-3 py-2 text-left text-sm text-text-primary hover:bg-surface-secondary disabled:cursor-not-allowed disabled:text-text-tertiary/50 disabled:hover:bg-transparent"
                >
                  重命名
                </button>
                <button
                  type="button"
                  onClick={() => void handleDeleteRichpostTheme()}
                  disabled={richpostThemeContextMenu.theme.source !== 'custom'}
                  className="flex w-full items-center rounded-xl px-3 py-2 text-left text-sm text-red-600 hover:bg-red-50 disabled:cursor-not-allowed disabled:text-text-tertiary/50 disabled:hover:bg-transparent"
                >
                  删除
                </button>
              </div>
            ) : null}
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
                          <span className="h-6 w-6 rounded-full border border-border/70" style={{ background: preset.surfaceColor || '#ffffff' }} />
                          <span className="h-6 w-6 rounded-full border border-border/70" style={{ background: preset.accentColor || '#111111' }} />
                          <span className="h-6 w-6 rounded-full border border-border/70" style={{ background: preset.textColor || '#111111' }} />
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
    <>
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
            {editorChatSessionId && editorChatReady ? (
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
                  embeddedTheme="auto"
                  welcomeTitle={aiWorkspaceMode.label}
                  welcomeSubtitle={isRichPost ? '围绕当前图文稿继续改标题、压缩段落、强化发布感。' : '围绕当前长文继续改结构、润色正文、生成发布版本。'}
                  shortcuts={shortcuts}
                  welcomeShortcuts={shortcuts}
                  fixedSessionBannerText={
                    aiWorkspaceMode.id === 'richpost-theme-editing'
                      ? `图文主题编辑 · ${aiWorkspaceMode.themeEditingLabel || '当前主题'}`
                      : aiWorkspaceMode.label
                  }
                />
              </Suspense>
            ) : (
              <div className="flex h-full items-center justify-center px-6 text-center">
                <div>
                  <Loader2 className="mx-auto h-5 w-5 animate-spin text-accent-primary/70" />
                  <div className="mt-3 text-sm text-text-secondary">
                    {editorChatSessionId ? '正在同步当前页面上下文...' : '正在初始化 AI 会话...'}
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      </aside>
    </div>
    {isRichPost && isRichpostThemeEditorOpen ? (
      <RichpostThemeEditorOverlay
        previews={richpostThemeEditorPreviewPages}
        themeDraft={richpostThemeEditorDraft}
        isPreviewLoading={isLoadingRichpostThemeEditorPreview}
        isSaving={isUpdatingRichpostTheme}
        canSave={isRichpostThemeEditorDirty}
        uploadingBackgroundRole={uploadingThemeBackgroundRole}
        editorChatSessionId={editorChatSessionId}
        editorChatReady={editorChatReady}
        isActive={isActive}
        shortcuts={shortcuts}
        onThemeDraftChange={setRichpostThemeEditorDraft}
        onSave={() => {
          void persistRichpostThemeEditorDraft();
        }}
        onUploadBackground={handleUploadRichpostThemeBackground}
        onClose={() => {
          void persistRichpostThemeEditorDraft({ closeAfterSave: true });
        }}
      />
    ) : null}
    {richpostThemeRenameOpen ? (
      <div
        className="fixed inset-0 z-[130] flex items-center justify-center bg-black/35 p-4 backdrop-blur-[1px]"
        onMouseDown={() => !isUpdatingRichpostTheme && setRichpostThemeRenameOpen(false)}
      >
        <div
          className="w-full max-w-md rounded-3xl border border-border bg-background shadow-2xl"
          onMouseDown={(event) => event.stopPropagation()}
        >
          <div className="flex items-center justify-between border-b border-border/70 px-6 py-5">
            <div>
              <h2 className="text-lg font-semibold text-text-primary">重命名主题</h2>
              <p className="mt-1 text-sm text-text-secondary">输入新的主题名称。</p>
            </div>
            <button
              type="button"
              onClick={() => !isUpdatingRichpostTheme && setRichpostThemeRenameOpen(false)}
              className="rounded-xl p-2 text-text-tertiary transition-colors hover:bg-surface-secondary hover:text-text-primary"
            >
              <X className="h-5 w-5" />
            </button>
          </div>
          <div className="space-y-3 px-6 py-6">
            <label className="text-sm font-medium text-text-primary">名称</label>
            <input
              autoFocus
              value={richpostThemeRenameValue}
              onChange={(event) => setRichpostThemeRenameValue(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !isUpdatingRichpostTheme) {
                  event.preventDefault();
                  void handleConfirmRenameRichpostTheme();
                }
              }}
              placeholder="输入新的主题名称"
              className="w-full rounded-2xl border border-border bg-surface-secondary/30 px-4 py-3 text-sm focus:border-accent-primary focus:outline-none"
            />
          </div>
          <div className="flex items-center justify-end gap-3 rounded-b-3xl border-t border-border/70 bg-surface-secondary/10 px-6 py-5">
            <button
              type="button"
              onClick={() => setRichpostThemeRenameOpen(false)}
              disabled={isUpdatingRichpostTheme}
              className="rounded-xl border border-border px-4 py-2 text-sm text-text-secondary transition-colors hover:bg-surface-secondary hover:text-text-primary disabled:opacity-50"
            >
              取消
            </button>
            <button
              type="button"
              onClick={() => void handleConfirmRenameRichpostTheme()}
              disabled={isUpdatingRichpostTheme || !richpostThemeRenameValue.trim()}
              className="rounded-xl bg-accent-primary px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-accent-hover disabled:opacity-50"
            >
              {isUpdatingRichpostTheme ? '处理中...' : '重命名'}
            </button>
          </div>
        </div>
      </div>
    ) : null}
    </>
  );
}
