import clsx from 'clsx';
import type { MutableRefObject } from 'react';
import { Clapperboard, Image as ImageIcon, Type } from 'lucide-react';
import { RemotionTransportBar } from './remotion/RemotionTransportBar';
import { resolveAssetUrl } from '../../utils/pathManager';
import type { RemotionScene } from './remotion/types';

type PreviewAssetLike = {
    id: string;
    title?: string;
    relativePath?: string;
    absolutePath?: string;
    previewUrl?: string;
    mimeType?: string;
};

type PreviewStageProps = {
    asset: PreviewAssetLike | null;
    assetKind: 'image' | 'video' | 'audio' | 'unknown';
    title: string;
    statusLabel: string;
    currentFrame: number;
    durationInFrames: number;
    fps: number;
    isPlaying: boolean;
    selectedScene: RemotionScene | null;
    selectedSceneItemId: string | null;
    selectedSceneItemKind: 'asset' | 'overlay' | 'title' | null;
    guidesVisible: boolean;
    safeAreaVisible: boolean;
    previewVideoRef: MutableRefObject<HTMLVideoElement | null>;
    onTogglePlayback: () => void;
    onSeekFrame: (frame: number) => void;
    onStepFrame: (deltaFrames: number) => void;
    onSelectSceneItem: (kind: 'asset' | 'overlay' | 'title', id: string) => void;
};

function buildOverlayText(scene: RemotionScene | null): string {
    if (!scene) return '';
    const explicitText = String(scene.overlays?.[0]?.text || '').trim();
    if (explicitText) return explicitText;
    return String(scene.overlayBody || '').trim();
}

export function VideoEditorPreviewStage({
    asset,
    assetKind,
    title,
    statusLabel,
    currentFrame,
    durationInFrames,
    fps,
    isPlaying,
    selectedScene,
    selectedSceneItemId,
    selectedSceneItemKind,
    guidesVisible,
    safeAreaVisible,
    previewVideoRef,
    onTogglePlayback,
    onSeekFrame,
    onStepFrame,
    onSelectSceneItem,
}: PreviewStageProps) {
    const overlayText = buildOverlayText(selectedScene);
    const overlayId = selectedScene ? `${selectedScene.id}:overlay` : null;
    const titleId = selectedScene ? `${selectedScene.id}:title` : null;
    const assetUrl = resolveAssetUrl(asset?.previewUrl || asset?.absolutePath || asset?.relativePath || '');

    return (
        <div className="flex h-full min-h-0 flex-col">
            <div className="flex items-center justify-between gap-3 border-b border-white/10 px-4 py-3 text-xs text-white/55">
                <div className="truncate">
                    {asset?.title || asset?.relativePath || asset?.id || title}
                </div>
                <div className="shrink-0 rounded-full border border-white/10 bg-white/[0.04] px-2.5 py-1 text-[10px] text-white/60">
                    {statusLabel}
                </div>
            </div>
            <div className="border-b border-white/10 px-4 py-3">
                <RemotionTransportBar
                    fps={fps}
                    durationInFrames={durationInFrames}
                    currentFrame={currentFrame}
                    playing={isPlaying}
                    onTogglePlayback={onTogglePlayback}
                    onSeekFrame={onSeekFrame}
                    onStepFrame={onStepFrame}
                    disabled={!asset}
                />
            </div>
            <div className="min-h-0 flex-1 bg-[radial-gradient(circle_at_top,rgba(67,67,75,0.25),transparent_55%)] p-6">
                <div className="relative flex h-full items-center justify-center overflow-hidden rounded-[28px] border border-white/10 bg-[#060606] shadow-[0_20px_60px_rgba(0,0,0,0.45)]">
                    <div className="absolute left-4 top-4 z-20 rounded-full border border-white/10 bg-black/45 px-3 py-1 text-[10px] uppercase tracking-[0.18em] text-white/55">
                        Scene Editor
                    </div>
                    {guidesVisible ? (
                        <>
                            <div className="pointer-events-none absolute inset-y-0 left-1/2 z-10 w-px -translate-x-1/2 bg-white/10" />
                            <div className="pointer-events-none absolute inset-x-0 top-1/2 z-10 h-px -translate-y-1/2 bg-white/10" />
                        </>
                    ) : null}
                    {safeAreaVisible ? (
                        <div className="pointer-events-none absolute inset-6 z-10 rounded-[26px] border border-dashed border-cyan-300/25" />
                    ) : null}

                    {asset ? (
                        <button
                            type="button"
                            onClick={() => onSelectSceneItem('asset', asset.id)}
                            className={clsx(
                                'group relative z-20 max-h-full max-w-full rounded-[26px] border bg-black/25 p-2 transition',
                                selectedSceneItemKind === 'asset' && selectedSceneItemId === asset.id
                                    ? 'border-cyan-300/70 shadow-[0_0_0_1px_rgba(103,232,249,0.35)]'
                                    : 'border-transparent hover:border-white/20'
                            )}
                        >
                            {assetKind === 'video' ? (
                                <video
                                    ref={previewVideoRef}
                                    src={assetUrl}
                                    className="max-h-[72vh] max-w-full rounded-[22px] object-contain"
                                    controls={false}
                                    playsInline
                                />
                            ) : assetKind === 'image' ? (
                                <img
                                    src={assetUrl}
                                    alt={asset.title || asset.id}
                                    className="max-h-[72vh] max-w-full rounded-[22px] object-contain"
                                />
                            ) : assetKind === 'audio' ? (
                                <div className="flex h-[360px] w-[360px] items-center justify-center rounded-[24px] border border-white/10 bg-[radial-gradient(circle_at_top,rgba(217,70,239,0.2),transparent_55%)] text-white/75">
                                    <AudioBadge />
                                </div>
                            ) : (
                                <div className="flex h-[320px] w-[320px] items-center justify-center rounded-[24px] border border-white/10 bg-white/[0.04] text-white/55">
                                    <Clapperboard className="h-12 w-12" />
                                </div>
                            )}
                        </button>
                    ) : (
                        <div className="z-20 text-center text-white/55">
                            <Clapperboard className="mx-auto h-10 w-10 text-white/35" />
                            <div className="mt-3 text-sm">还没有可预览素材</div>
                        </div>
                    )}

                    {selectedScene?.overlayTitle ? (
                        <button
                            type="button"
                            onClick={() => titleId && onSelectSceneItem('title', titleId)}
                            className={clsx(
                                'absolute left-8 top-8 z-30 max-w-[55%] rounded-2xl border px-4 py-3 text-left transition',
                                selectedSceneItemKind === 'title' && selectedSceneItemId === titleId
                                    ? 'border-fuchsia-300/70 bg-fuchsia-400/18'
                                    : 'border-white/10 bg-black/35 hover:border-white/20'
                            )}
                        >
                            <div className="mb-1 flex items-center gap-2 text-[10px] uppercase tracking-[0.18em] text-white/45">
                                <Type className="h-3.5 w-3.5" />
                                Title Layer
                            </div>
                            <div className="text-lg font-semibold text-white">{selectedScene.overlayTitle}</div>
                        </button>
                    ) : null}

                    {overlayText ? (
                        <button
                            type="button"
                            onClick={() => overlayId && onSelectSceneItem('overlay', overlayId)}
                            className={clsx(
                                'absolute bottom-8 left-1/2 z-30 w-[min(76%,560px)] -translate-x-1/2 rounded-[24px] border px-5 py-4 text-center transition',
                                selectedSceneItemKind === 'overlay' && selectedSceneItemId === overlayId
                                    ? 'border-amber-300/70 bg-amber-300/16'
                                    : 'border-white/10 bg-black/45 hover:border-white/20'
                            )}
                        >
                            <div className="mb-1 flex items-center justify-center gap-2 text-[10px] uppercase tracking-[0.18em] text-white/45">
                                <ImageIcon className="h-3.5 w-3.5" />
                                Overlay Layer
                            </div>
                            <div className="text-sm leading-6 text-white/90">{overlayText}</div>
                        </button>
                    ) : null}
                </div>
            </div>
        </div>
    );
}

function AudioBadge() {
    return (
        <div className="flex flex-col items-center gap-3">
            <div className="rounded-full border border-white/10 bg-black/30 p-5">
                <Clapperboard className="hidden h-0 w-0" />
                <Type className="hidden h-0 w-0" />
                <ImageIcon className="hidden h-0 w-0" />
                <div className="flex items-center justify-center rounded-full bg-pink-400/15 p-5 text-pink-100">
                    <svg width="28" height="28" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                        <path d="M12 18a1 1 0 0 1-1-1V5.83l-1.59 1.06a1 1 0 1 1-1.11-1.66l3-2A1 1 0 0 1 13 4v13a1 1 0 0 1-1 1Zm4.5-5.5a1 1 0 0 1-.55-1.83l2-1.33a1 1 0 0 1 1.1 1.66l-2 1.33a1 1 0 0 1-.55.17Z" fill="currentColor"/>
                        <path d="M6 20a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z" fill="currentColor"/>
                        <path d="M16 18a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z" fill="currentColor"/>
                    </svg>
                </div>
            </div>
            <div className="text-xs uppercase tracking-[0.18em] text-white/45">Audio Preview</div>
        </div>
    );
}
