import { lazy, Suspense, useEffect, useMemo, useState } from 'react';
import clsx from 'clsx';
import { AudioLines, MessageSquare, Plus } from 'lucide-react';
import { EditableTrackTimeline } from './EditableTrackTimeline';
import { AudioWaveformPreview } from './AudioWaveformPreview';
import { resolveAssetUrl } from '../../utils/pathManager';

const ChatWorkspace = lazy(async () => ({
  default: (await import('../../pages/Chat')).Chat,
}));

type MediaAssetLike = {
  id: string;
  title?: string;
  relativePath?: string;
  previewUrl?: string;
};

type PackageStateLike = Record<string, unknown>;

type AudioClipLike = {
  clipId?: string;
  assetId?: string;
  name?: string;
  order?: number;
  track?: string;
  durationMs?: number;
  enabled?: boolean;
};

type PreviewTab = 'preview' | 'script';
type DragTarget = 'materials' | 'chat' | 'timeline';

type DragState = {
  target: DragTarget;
  startX: number;
  startY: number;
  materialPaneWidth: number;
  chatPaneWidth: number;
  timelineHeight: number;
};

const AUDIO_EDITING_SHORTCUTS = [
  { label: '去停顿', text: '请检查当前音频工程，给出去停顿和压缩冗余停顿的剪辑方案。' },
  { label: '提取精华', text: '请从当前音频工程中提取最值得保留的高价值片段，并建议重组顺序。' },
  { label: '整理口播', text: '请把当前音频工程整理成更清晰的口播结构，说明章节和过渡如何调整。' },
  { label: '导出方案', text: '请基于当前音频工程，给出最合适的导出版本和交付建议。' },
];

function inferAssetKind(asset: MediaAssetLike): 'image' | 'video' | 'audio' | 'unknown' {
  const source = String(asset.previewUrl || asset.relativePath || '').toLowerCase();
  if (/\.(png|jpe?g|webp|gif|bmp|svg)(\?|$)/.test(source)) return 'image';
  if (/\.(mp4|mov|webm|m4v|mkv|avi)(\?|$)/.test(source)) return 'video';
  if (/\.(mp3|wav|m4a|aac|ogg|flac|opus)(\?|$)/.test(source)) return 'audio';
  return 'unknown';
}

function formatTimelineMillis(input: unknown): string {
  const numeric = typeof input === 'number' ? input : Number(input);
  if (!Number.isFinite(numeric) || numeric <= 0) return '未设置';
  if (numeric < 1000) return `${Math.round(numeric)}ms`;
  const seconds = numeric / 1000;
  if (seconds < 60) return `${seconds.toFixed(seconds >= 10 ? 0 : 1)}s`;
  const minutes = Math.floor(seconds / 60);
  const remainSeconds = Math.round(seconds % 60);
  return `${minutes}m ${remainSeconds}s`;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

export interface AudioDraftWorkbenchProps {
  editorFile: string;
  packageAssets: Array<Record<string, unknown>>;
  packagePreviewAssets: MediaAssetLike[];
  primaryAudioAsset?: MediaAssetLike | null;
  timelineClipCount: number;
  timelineTrackNames: string[];
  timelineClips: AudioClipLike[];
  editorBody: string;
  editorBodyDirty: boolean;
  isSavingEditorBody: boolean;
  editorChatSessionId: string | null;
  onEditorBodyChange: (value: string) => void;
  onOpenBindAssets: () => void;
  onPackageStateChange: (state: PackageStateLike) => void;
}

export function AudioDraftWorkbench({
  editorFile,
  packagePreviewAssets,
  primaryAudioAsset,
  timelineClipCount,
  timelineTrackNames,
  timelineClips,
  editorBody,
  editorBodyDirty,
  isSavingEditorBody,
  editorChatSessionId,
  onEditorBodyChange,
  onOpenBindAssets,
  onPackageStateChange,
}: AudioDraftWorkbenchProps) {
  const [previewTab, setPreviewTab] = useState<PreviewTab>('preview');
  const [materialPaneWidth, setMaterialPaneWidth] = useState(300);
  const [chatPaneWidth, setChatPaneWidth] = useState(380);
  const [timelineHeight, setTimelineHeight] = useState(280);
  const [dragState, setDragState] = useState<DragState | null>(null);
  const [currentPreviewAssetId, setCurrentPreviewAssetId] = useState<string | null>(primaryAudioAsset?.id || null);

  const displayAssets = useMemo(
    () => (packagePreviewAssets.length > 0 ? packagePreviewAssets : ([primaryAudioAsset].filter(Boolean) as MediaAssetLike[])),
    [packagePreviewAssets, primaryAudioAsset]
  );

  useEffect(() => {
    if (!displayAssets.length) {
      setCurrentPreviewAssetId(null);
      return;
    }
    if (currentPreviewAssetId && displayAssets.some((asset) => asset.id === currentPreviewAssetId)) {
      return;
    }
    setCurrentPreviewAssetId(
      primaryAudioAsset && displayAssets.some((asset) => asset.id === primaryAudioAsset.id)
        ? primaryAudioAsset.id
        : displayAssets[0]?.id || null
    );
  }, [currentPreviewAssetId, displayAssets, primaryAudioAsset]);

  const currentPreviewAsset = useMemo(
    () => displayAssets.find((asset) => asset.id === currentPreviewAssetId) || primaryAudioAsset || displayAssets[0] || null,
    [currentPreviewAssetId, displayAssets, primaryAudioAsset]
  );

  useEffect(() => {
    if (!dragState) return;

    const handlePointerMove = (event: PointerEvent) => {
      if (dragState.target === 'materials') {
        const deltaX = event.clientX - dragState.startX;
        setMaterialPaneWidth(clamp(dragState.materialPaneWidth + deltaX, 240, 420));
        return;
      }
      if (dragState.target === 'chat') {
        const deltaX = dragState.startX - event.clientX;
        setChatPaneWidth(clamp(dragState.chatPaneWidth + deltaX, 300, 560));
        return;
      }
      const deltaY = dragState.startY - event.clientY;
      setTimelineHeight(clamp(dragState.timelineHeight + deltaY, 220, 460));
    };

    const handlePointerUp = () => {
      setDragState(null);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };

    document.body.style.cursor = dragState.target === 'timeline' ? 'row-resize' : 'col-resize';
    document.body.style.userSelect = 'none';
    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerUp);

    return () => {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
  }, [dragState]);

  return (
    <div
      className="flex-1 min-h-0 grid bg-[#171717] text-white"
      style={{
        gridTemplateColumns: `minmax(0,1fr) 8px ${chatPaneWidth}px`,
        gridTemplateRows: `minmax(0,1fr) 8px ${timelineHeight}px`,
      }}
    >
      <div
        className="min-h-0 grid"
        style={{
          gridTemplateColumns: `${materialPaneWidth}px 8px minmax(0,1fr)`,
        }}
      >
        <div className="min-h-0 border-r border-b border-white/10 bg-[#1f1f1f]">
          <div className="flex h-full min-h-0 flex-col">
            <div className="border-b border-white/10 px-4 py-3">
              <div className="text-sm font-medium text-emerald-300">素材</div>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
              <button
                type="button"
                onClick={onOpenBindAssets}
                className="flex w-full items-center justify-center gap-2 rounded-2xl border border-dashed border-white/15 bg-white/[0.04] px-4 py-4 text-sm text-white/80 hover:border-emerald-400/40 hover:bg-white/[0.06]"
              >
                <Plus className="h-4 w-4" />
                导入音频
              </button>
              <div className="mt-4 text-xs font-medium uppercase tracking-[0.22em] text-white/35">素材</div>
              <div className="mt-3 grid grid-cols-2 gap-2.5">
                {displayAssets.map((asset, index) => (
                  <button
                    key={asset.id || index}
                    type="button"
                    draggable
                    onDragStart={(event) => {
                      event.dataTransfer.setData('application/x-redbox-asset-id', asset.id);
                      event.dataTransfer.effectAllowed = 'copyMove';
                    }}
                    onClick={() => setCurrentPreviewAssetId(asset.id)}
                    className={clsx(
                      'rounded-2xl border bg-white/[0.04] p-2 text-left transition',
                      currentPreviewAsset?.id === asset.id ? 'border-emerald-400/55 ring-1 ring-emerald-400/35' : 'border-white/10 hover:border-white/20'
                    )}
                  >
                    <div className="rounded-xl border border-white/8 bg-black/20 px-2 py-3">
                      <div className="flex items-center gap-2 text-white/75">
                        <AudioLines className="h-3.5 w-3.5" />
                        <span className="text-xs">音频</span>
                      </div>
                      <div className="mt-3 flex h-8 items-end gap-1">
                        {Array.from({ length: 18 }).map((_, barIndex) => (
                          <div
                            key={barIndex}
                            className="flex-1 rounded-full bg-[linear-gradient(180deg,rgba(255,255,255,0.92),rgba(16,185,129,0.22))]"
                            style={{ height: `${20 + (((barIndex * 29) % 62))}%` }}
                          />
                        ))}
                      </div>
                    </div>
                    <div className="mt-2 flex items-center justify-between gap-2">
                      <div className="min-w-0">
                        <div className="truncate text-xs font-medium text-white">{asset.title || asset.relativePath || asset.id}</div>
                        <div className="mt-0.5 text-[11px] text-white/45">
                          {inferAssetKind(asset) === 'audio' ? '音频' : '素材'}
                        </div>
                      </div>
                      <div className="rounded-full border border-white/10 px-2 py-1 text-[10px] text-white/55">
                        {asset.id === currentPreviewAsset?.id ? '预览' : '拖入'}
                      </div>
                    </div>
                  </button>
                ))}
                {displayAssets.length === 0 && (
                  <div className="col-span-2 rounded-2xl border border-white/10 bg-white/[0.04] px-4 py-5 text-sm text-white/55">
                    还没有关联音频素材。先导入录音、配乐或口播文件。
                  </div>
                )}
              </div>

              <div className="mt-6 text-xs font-medium uppercase tracking-[0.22em] text-white/35">章节</div>
              <div className="mt-3 space-y-2">
                {(timelineClips.length > 0 ? timelineClips : ['开场口播', '主体信息', '结尾收束'].map((name, index) => ({ name, order: index, track: 'A1', enabled: true })))
                  .slice(0, 4)
                  .map((rawItem, index) => {
                    const item = rawItem as AudioClipLike & { assetId?: string; durationMs?: number };
                    return (
                      <div key={`${String(item.clipId || item.assetId || item.name)}-${index}`} className="rounded-2xl border border-white/10 bg-white/[0.04] px-4 py-3">
                        <div className="flex items-center justify-between gap-3">
                          <div className="min-w-0">
                            <div className="truncate text-sm font-medium text-white">{String(item.name || `片段 ${index + 1}`)}</div>
                            <div className="mt-1 text-[11px] text-white/40">{String(item.track || 'A1')} · {formatTimelineMillis(item.durationMs)}</div>
                          </div>
                          <div className="text-[11px] text-white/40">{item.enabled === false ? '禁用' : '启用'}</div>
                        </div>
                      </div>
                    );
                  })}
              </div>
            </div>
          </div>
        </div>

        <div
          className="cursor-col-resize border-b border-r border-white/10 bg-white/[0.03] transition-colors hover:bg-emerald-400/20"
          onPointerDown={(event) => {
            event.preventDefault();
            setDragState({
              target: 'materials',
              startX: event.clientX,
              startY: event.clientY,
              materialPaneWidth,
              chatPaneWidth,
              timelineHeight,
            });
          }}
        />

        <div className="min-h-0 border-r border-b border-white/10 bg-[#111111]">
          <div className="flex h-full min-h-0 flex-col px-5 py-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-5 text-sm">
                <button
                  type="button"
                  onClick={() => setPreviewTab('preview')}
                  className={previewTab === 'preview' ? 'font-medium text-white' : 'font-medium text-white/45'}
                >
                  预览
                </button>
                <button
                  type="button"
                  onClick={() => setPreviewTab('script')}
                  className={previewTab === 'script' ? 'font-medium text-white' : 'font-medium text-white/45'}
                >
                  脚本
                </button>
              </div>
              <div className="text-xs text-white/45">
                {previewTab === 'script'
                  ? (isSavingEditorBody ? '保存中...' : editorBodyDirty ? '待保存' : '已保存')
                  : `${timelineClipCount} 个片段`}
              </div>
            </div>

            <div className="mt-4 flex-1 min-h-0 overflow-hidden rounded-[24px] border border-white/10 bg-[#1b1b1b]">
              {previewTab === 'preview' ? (
                <div className="flex h-full min-h-0 flex-col p-4">
                  <div className="rounded-[20px] border border-white/10 bg-[#121212] p-4">
                    {currentPreviewAsset && inferAssetKind(currentPreviewAsset) === 'audio' ? (
                      <audio src={resolveAssetUrl(currentPreviewAsset.previewUrl || currentPreviewAsset.relativePath || '')} controls className="w-full" />
                    ) : (
                      <div className="flex items-center gap-3 text-white/55">
                        <AudioLines className="h-5 w-5" />
                        <span className="text-sm">还没有可预览的音频素材</span>
                      </div>
                    )}
                  </div>
                  <div className="mt-4 min-h-0 flex-1">
                    <AudioWaveformPreview src={currentPreviewAsset ? resolveAssetUrl(currentPreviewAsset.previewUrl || currentPreviewAsset.relativePath || '') : null} />
                  </div>
                </div>
              ) : (
                <textarea
                  value={editorBody}
                  onChange={(event) => onEditorBodyChange(event.target.value)}
                  placeholder="在这里编辑音频结构、章节摘要、停顿处理和导出备注。"
                  className="h-full w-full resize-none bg-transparent px-5 py-5 text-sm leading-7 text-white outline-none placeholder:text-white/30"
                />
              )}
            </div>
          </div>
        </div>
      </div>

      <div
        className="row-span-3 cursor-col-resize bg-white/[0.03] transition-colors hover:bg-emerald-400/20"
        onPointerDown={(event) => {
          event.preventDefault();
          setDragState({
            target: 'chat',
            startX: event.clientX,
            startY: event.clientY,
            materialPaneWidth,
            chatPaneWidth,
            timelineHeight,
          });
        }}
      />

      <div className="row-span-3 min-h-0 border-l border-white/10 bg-[#131313] text-white">
        <div className="flex h-full min-h-0 flex-col">
          <div className="border-b border-white/10 px-5 py-4">
            <div className="flex items-center gap-2 text-sm font-medium text-white">
              <MessageSquare className="h-4 w-4 text-emerald-400" />
              音频剪辑助手
            </div>
          </div>
          <div className="min-h-0 flex-1 overflow-hidden">
            {editorChatSessionId ? (
              <Suspense fallback={<div className="h-full flex items-center justify-center text-white/45">AI 会话加载中...</div>}>
                <ChatWorkspace
                  fixedSessionId={editorChatSessionId}
                  defaultCollapsed={true}
                  showClearButton={true}
                  fixedSessionBannerText=""
                  showWelcomeShortcuts={false}
                  showComposerShortcuts={true}
                  shortcuts={AUDIO_EDITING_SHORTCUTS}
                  welcomeShortcuts={AUDIO_EDITING_SHORTCUTS}
                  welcomeTitle="音频剪辑助手"
                  welcomeSubtitle="围绕当前音频工程做章节整理、停顿清理和精华提取"
                  contentLayout="default"
                  contentWidthPreset="narrow"
                  allowFileUpload={true}
                  messageWorkflowPlacement="bottom"
                  messageWorkflowVariant="compact"
                  messageWorkflowEmphasis="default"
                />
              </Suspense>
            ) : (
              <div className="h-full flex items-center justify-center px-6 text-center text-sm text-white/45">正在初始化音频剪辑会话...</div>
            )}
          </div>
        </div>
      </div>

      <div
        className="col-span-1 border-r border-white/10 bg-white/[0.03] transition-colors hover:bg-emerald-400/20"
        onPointerDown={(event) => {
          event.preventDefault();
          setDragState({
            target: 'timeline',
            startX: event.clientX,
            startY: event.clientY,
            materialPaneWidth,
            chatPaneWidth,
            timelineHeight,
          });
        }}
      />

      <div className="min-h-0 border-r border-white/10 bg-[#151515] px-5 py-4">
        <EditableTrackTimeline
          filePath={editorFile}
          clips={timelineClips as Array<Record<string, unknown>>}
          fallbackTracks={timelineTrackNames}
          accent="emerald"
          emptyLabel="把音频素材拖入时间轴开始排布"
          onPackageStateChange={onPackageStateChange}
        />
      </div>
    </div>
  );
}
