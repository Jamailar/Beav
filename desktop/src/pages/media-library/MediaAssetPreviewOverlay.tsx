import { X } from 'lucide-react';
import { resolveAssetUrl } from '../../utils/pathManager';
import { formatTimestampDateTime } from '../../utils/time';

type MediaAssetSource = 'generated' | 'planned' | 'imported';

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

const SOURCE_LABEL: Record<MediaAssetSource, string> = {
    generated: '已生成',
    planned: '计划项',
    imported: '导入',
};

function isVideoAsset(asset: Pick<MediaAssetLike, 'mimeType' | 'relativePath'>): boolean {
    const mimeType = String(asset.mimeType || '').toLowerCase();
    if (mimeType.startsWith('video/')) return true;
    return /\.(mp4|webm|mov)$/i.test(String(asset.relativePath || '').trim());
}

export function MediaAssetPreviewOverlay({
    preview,
    onClose,
}: {
    preview: PreviewState | null;
    onClose: () => void;
}) {
    if (!preview) return null;

    const { asset } = preview;
    const src = resolveAssetUrl(preview.src || asset.previewUrl || asset.absolutePath || asset.relativePath || '');
    if (!src) return null;

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
            <div className="flex h-full w-full max-w-[1600px] items-center gap-6">
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
                    className="flex min-w-0 flex-1 items-center justify-center"
                    onClick={(event) => event.stopPropagation()}
                >
                    {isVideoAsset(asset) ? (
                        <video
                            src={src}
                            className="block max-h-[90vh] max-w-[90vw] rounded-xl border border-white/10 bg-black/10 object-contain shadow-2xl"
                            controls
                            autoPlay
                        />
                    ) : (
                        <img
                            src={src}
                            alt={asset.title || asset.id}
                            className="block max-h-[90vh] max-w-[90vw] rounded-xl border border-white/10 bg-black/10 object-contain shadow-2xl"
                        />
                    )}
                </div>
            </div>
        </div>
    );
}
