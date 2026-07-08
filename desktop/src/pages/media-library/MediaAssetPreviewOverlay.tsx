import { useEffect, useState } from 'react';
import { Download, X } from 'lucide-react';
import { getLiquidGlassMenuItemClassName, LiquidGlassMenuPanel } from '@/components/ui/liquid-glass-menu';
import { resolveAssetUrl } from '../../utils/pathManager';
import { formatTimestampDateTime } from '../../utils/time';
import { appAlert } from '../../utils/appDialogs';

type MediaAssetSource = 'generated' | 'planned' | 'imported' | 'external';

interface MediaAssetLike {
    id: string;
    source: MediaAssetSource;
    title?: string;
    projectId?: string;
    aspectRatio?: string;
    size?: string;
    mimeType?: string;
    relativePath?: string;
    absolutePath?: string;
    previewUrl?: string;
    createdAt: string;
}

interface PreviewState {
    asset: MediaAssetLike;
    src: string;
}

interface ImageContextMenuState {
    visible: boolean;
    x: number;
    y: number;
}

const SOURCE_LABEL: Record<MediaAssetSource, string> = {
    generated: '已生成',
    planned: '计划项',
    imported: '导入',
    external: '外部素材',
};

function isVideoAsset(asset: Pick<MediaAssetLike, 'mimeType' | 'relativePath' | 'absolutePath' | 'previewUrl'>): boolean {
    const mimeType = String(asset.mimeType || '').toLowerCase();
    if (mimeType.startsWith('audio/')) return false;
    if (mimeType.startsWith('video/')) return true;
    const source = String(asset.relativePath || asset.absolutePath || asset.previewUrl || '').trim();
    return /\.(mp4|webm|mov)(?:[?#].*)?$/i.test(source);
}

function isAudioAsset(asset: Pick<MediaAssetLike, 'mimeType' | 'relativePath' | 'absolutePath' | 'previewUrl'>): boolean {
    const mimeType = String(asset.mimeType || '').toLowerCase();
    if (mimeType.startsWith('audio/')) return true;
    const source = String(asset.relativePath || asset.absolutePath || asset.previewUrl || '').trim();
    return /\.(mp3|wav|m4a|aac|flac|ogg|opus|webm)(?:[?#].*)?$/i.test(source);
}

function stripQueryAndHash(value: string): string {
    const hashIndex = value.indexOf('#');
    const queryIndex = value.indexOf('?');
    const indexes = [hashIndex, queryIndex].filter((index) => index >= 0);
    if (indexes.length === 0) return value;
    return value.slice(0, Math.min(...indexes));
}

function safeDecodeLabel(value: string): string {
    try {
        return decodeURIComponent(value);
    } catch {
        return value;
    }
}

function getSourceFilename(value: string): string {
    const source = String(value || '').trim();
    if (!source) return '';
    try {
        const parsed = new URL(source);
        return getSourceFilename(parsed.pathname) || parsed.hostname;
    } catch {
        const clean = stripQueryAndHash(source).replace(/\\/g, '/').replace(/\/+$/, '');
        const segment = clean.split('/').filter(Boolean).pop() || clean;
        return safeDecodeLabel(segment);
    }
}

function getImageActionSource(asset: MediaAssetLike, fallbackSrc: string): string {
    return asset.absolutePath || asset.relativePath || asset.previewUrl || fallbackSrc;
}

function getImageDefaultName(asset: MediaAssetLike, actionSource: string, fallbackSrc: string): string {
    return getSourceFilename(actionSource)
        || getSourceFilename(fallbackSrc)
        || asset.title
        || asset.id
        || `media-image-${Date.now()}`;
}

export function MediaAssetPreviewOverlay({
    preview,
    onClose,
}: {
    preview: PreviewState | null;
    onClose: () => void;
}) {
    const [imageMenu, setImageMenu] = useState<ImageContextMenuState>({
        visible: false,
        x: 0,
        y: 0,
    });

    useEffect(() => {
        setImageMenu((prev) => (prev.visible ? { visible: false, x: 0, y: 0 } : prev));
    }, [preview]);

    useEffect(() => {
        if (!imageMenu.visible) return;
        const close = () => setImageMenu({ visible: false, x: 0, y: 0 });
        window.addEventListener('click', close);
        window.addEventListener('scroll', close, true);
        window.addEventListener('resize', close);
        return () => {
            window.removeEventListener('click', close);
            window.removeEventListener('scroll', close, true);
            window.removeEventListener('resize', close);
        };
    }, [imageMenu.visible]);

    if (!preview) return null;

    const { asset } = preview;
    const src = resolveAssetUrl(preview.src || asset.previewUrl || asset.absolutePath || asset.relativePath || '');
    if (!src) return null;
    const isImage = !isVideoAsset(asset) && !isAudioAsset(asset);
    const imageActionSource = getImageActionSource(asset, preview.src || src);
    const imageDefaultName = getImageDefaultName(asset, imageActionSource, preview.src || src);

    const saveImageAs = async () => {
        if (!imageActionSource) return;
        try {
            const result = await window.ipcRenderer.files.saveAs({
                source: imageActionSource,
                defaultName: imageDefaultName,
            }) as { success?: boolean; error?: string; canceled?: boolean };
            if (!result?.success && !result?.canceled) {
                throw new Error(result?.error || '保存失败');
            }
        } catch (error) {
            console.error('Failed to save media asset image:', error);
            void appAlert(error instanceof Error ? error.message : '保存失败');
        } finally {
            setImageMenu({ visible: false, x: 0, y: 0 });
        }
    };

    const downloadImage = async () => {
        if (!imageActionSource) return;
        try {
            const result = await window.ipcRenderer.files.downloadToDownloads({
                source: imageActionSource,
                defaultName: imageDefaultName,
            });
            if (!result?.success) {
                throw new Error(result?.error || '下载失败');
            }
        } catch (error) {
            console.error('Failed to download media asset image:', error);
            void appAlert(error instanceof Error ? error.message : '下载失败');
        }
    };

    return (
        <div
            className="fixed inset-0 z-[9998] flex items-center justify-center bg-black/70 p-6"
            onClick={onClose}
        >
            <button
                type="button"
                onClick={(event) => {
                    event.stopPropagation();
                    onClose();
                }}
                className="absolute right-5 top-5 z-[9999] inline-flex h-10 w-10 items-center justify-center rounded-full border border-white/14 bg-black/38 text-white/88 backdrop-blur hover:bg-black/56"
                aria-label="关闭预览"
            >
                <X className="h-5 w-5" />
            </button>
            <div className="flex h-full min-h-0 w-full max-w-[1600px] items-center gap-6">
                <div
                    className="hidden h-full w-[280px] shrink-0 md:flex md:items-end"
                    onClick={(event) => event.stopPropagation()}
                >
                    <div className="w-full bg-gradient-to-t from-black/72 via-black/28 to-transparent px-4 pb-6 pt-20">
                        <div className="space-y-1.5 text-white/90">
                            <div className="text-[11px] uppercase tracking-[0.12em] text-white/58">
                                {SOURCE_LABEL[asset.source] || '素材'}
                            </div>
                            <div className="text-sm leading-6 text-white/96 break-words">
                                {asset.title || asset.id}
                            </div>
                            <div className="text-[12px] leading-5 text-white/78">
                                {asset.projectId || '未设置项目ID'} · {asset.aspectRatio || asset.size || '原始比例'}
                            </div>
                            <div className="text-[12px] leading-5 text-white/72">
                                {formatTimestampDateTime(asset.createdAt)}
                            </div>
                            {asset.relativePath && (
                                <div className="text-[11px] leading-5 text-white/52 break-all">
                                    {asset.relativePath}
                                </div>
                            )}
                        </div>
                    </div>
                </div>
                <div
                    className="flex h-full min-h-0 min-w-0 flex-1 items-center justify-center overflow-hidden"
                    onClick={(event) => event.stopPropagation()}
                >
                    {isVideoAsset(asset) ? (
                        <video
                            src={src}
                            className="block max-h-full max-w-full rounded-xl border border-white/10 bg-black/10 object-contain shadow-2xl"
                            controls
                            autoPlay
                        />
                    ) : isAudioAsset(asset) ? (
                        <div className="w-full max-w-2xl rounded-xl border border-white/10 bg-black/38 p-5 shadow-2xl">
                            <div className="mb-3 text-sm text-white/78">{asset.title || asset.id}</div>
                            <audio src={src} className="w-full" controls autoPlay />
                        </div>
                    ) : (
                        <div className="relative max-h-full max-w-full">
                            <img
                                src={src}
                                alt={asset.title || asset.id}
                                className="block max-h-full max-w-full rounded-xl border border-white/10 bg-black/10 object-contain shadow-2xl"
                                onContextMenu={(event) => {
                                    event.preventDefault();
                                    event.stopPropagation();
                                    setImageMenu({
                                        visible: true,
                                        x: event.clientX,
                                        y: event.clientY,
                                    });
                                }}
                            />
                            <button
                                type="button"
                                onClick={(event) => {
                                    event.stopPropagation();
                                    void downloadImage();
                                }}
                                className="absolute right-3 top-3 z-[1] inline-flex h-9 w-9 items-center justify-center rounded-full border border-white/14 bg-black/42 text-white/90 backdrop-blur hover:bg-black/60"
                                aria-label="下载图片"
                                title="下载图片"
                            >
                                <Download className="h-4 w-4" />
                            </button>
                        </div>
                    )}
                </div>
            </div>
            {isImage && imageMenu.visible && (
                <LiquidGlassMenuPanel
                    className="fixed z-[10000] min-w-[148px]"
                    style={{ left: imageMenu.x, top: imageMenu.y }}
                    onClick={(event) => event.stopPropagation()}
                >
                    <button
                        type="button"
                        className={getLiquidGlassMenuItemClassName()}
                        onClick={() => void saveImageAs()}
                    >
                        <Download className="h-3.5 w-3.5" />
                        另存为
                    </button>
                </LiquidGlassMenuPanel>
            )}
        </div>
    );
}
