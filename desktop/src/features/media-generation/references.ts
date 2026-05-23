import type { UploadedFileAttachment } from '../../components/ChatComposer';
import { resolveAssetUrl } from '../../utils/pathManager';
import type { ReferenceItem } from './feedModel';

const readBlobAsDataUrl = (blob: Blob): Promise<string> => new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(reader.error || new Error('读取文件失败'));
    reader.readAsDataURL(blob);
});

export function dataUrlMimeType(dataUrl: string): string {
    const match = String(dataUrl || '').match(/^data:([^;,]+)[;,]/i);
    return String(match?.[1] || '').trim().toLowerCase();
}

export function referenceItemIsImage(item: ReferenceItem | null | undefined): boolean {
    return dataUrlMimeType(String(item?.dataUrl || '')).startsWith('image/');
}

export function attachmentVisualKind(
    attachment: UploadedFileAttachment | null | undefined,
): 'image' | 'video' | 'audio' | 'text' | 'file' {
    const kind = String(attachment?.kind || '').trim().toLowerCase();
    const mimeType = String(attachment?.mimeType || '').trim().toLowerCase();
    const name = String(attachment?.name || '').trim().toLowerCase();
    if (kind === 'image' || mimeType.startsWith('image/') || /\.(png|jpe?g|webp|gif|bmp|svg|avif)$/i.test(name)) return 'image';
    if (kind === 'video' || mimeType.startsWith('video/') || /\.(mp4|mov|webm|m4v|avi|mkv)$/i.test(name)) return 'video';
    if (kind === 'audio' || mimeType.startsWith('audio/') || /\.(mp3|wav|m4a|aac|flac|ogg|opus|webm)$/i.test(name)) return 'audio';
    if (kind === 'text' || mimeType.startsWith('text/') || /\.(txt|md|markdown|json|csv|tsv|doc|docx|pdf|rtf|xml|yaml|yml)$/i.test(name)) return 'text';
    return 'file';
}

export function attachmentPreviewSrc(attachment: UploadedFileAttachment | null | undefined): string {
    const preferred = String(
        attachment?.thumbnailDataUrl
        || attachment?.inlineDataUrl
        || attachment?.localUrl
        || attachment?.absolutePath
        || attachment?.originalAbsolutePath
        || '',
    ).trim();
    if (!preferred) return '';
    return preferred.startsWith('data:') ? preferred : resolveAssetUrl(preferred);
}

export function formatAttachmentSize(size?: number): string {
    if (typeof size !== 'number' || !Number.isFinite(size) || size <= 0) return '';
    if (size >= 1024 * 1024) return `${(size / (1024 * 1024)).toFixed(size >= 10 * 1024 * 1024 ? 0 : 1)} MB`;
    if (size >= 1024) return `${Math.round(size / 1024)} KB`;
    return `${Math.round(size)} B`;
}

export function attachmentKindLabel(kind: ReturnType<typeof attachmentVisualKind>): string {
    switch (kind) {
        case 'image':
            return '图片';
        case 'video':
            return '视频';
        case 'audio':
            return '音频';
        case 'text':
            return '文档';
        default:
            return '文件';
    }
}

export async function loadImageElement(source: string): Promise<HTMLImageElement> {
    return new Promise((resolve, reject) => {
        const image = new window.Image();
        image.onload = () => resolve(image);
        image.onerror = () => reject(new Error('参考图读取失败'));
        image.src = source;
    });
}

export async function buildReferenceContactSheet(
    items: ReferenceItem[],
): Promise<{ fileName: string; dataUrl: string; note: string }> {
    const imageItems = items.filter(referenceItemIsImage).slice(0, 4);
    if (imageItems.length === 0) {
        throw new Error('没有可用于拼版的图片参考图');
    }
    if (imageItems.length === 1) {
        return {
            fileName: imageItems[0].name || 'reference-image.png',
            dataUrl: imageItems[0].dataUrl,
            note: `参考图共 1 张：${imageItems[0].name || 'reference-image'}`,
        };
    }

    const loaded = await Promise.all(imageItems.map(async (item) => ({
        item,
        image: await loadImageElement(item.dataUrl),
    })));
    const columns = imageItems.length <= 2 ? imageItems.length : 2;
    const rows = Math.ceil(imageItems.length / columns);
    const cellWidth = 640;
    const cellHeight = 640;
    const labelHeight = 76;
    const gap = 18;
    const padding = 24;
    const canvas = document.createElement('canvas');
    canvas.width = padding * 2 + columns * cellWidth + (columns - 1) * gap;
    canvas.height = padding * 2 + rows * (cellHeight + labelHeight) + (rows - 1) * gap;
    const context = canvas.getContext('2d');
    if (!context) {
        throw new Error('参考图拼版失败');
    }

    context.fillStyle = '#0f1115';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.textBaseline = 'middle';
    context.font = '500 28px sans-serif';

    loaded.forEach(({ item, image }, index) => {
        const column = index % columns;
        const row = Math.floor(index / columns);
        const x = padding + column * (cellWidth + gap);
        const y = padding + row * (cellHeight + labelHeight + gap);
        const imageRatio = image.width / Math.max(image.height, 1);
        const targetRatio = cellWidth / cellHeight;
        let drawWidth = cellWidth;
        let drawHeight = cellHeight;
        let drawX = x;
        let drawY = y;
        if (imageRatio > targetRatio) {
            drawHeight = cellHeight;
            drawWidth = drawHeight * imageRatio;
            drawX = x - (drawWidth - cellWidth) / 2;
        } else {
            drawWidth = cellWidth;
            drawHeight = drawWidth / Math.max(imageRatio, 0.001);
            drawY = y - (drawHeight - cellHeight) / 2;
        }

        context.save();
        context.beginPath();
        context.roundRect(x, y, cellWidth, cellHeight, 22);
        context.clip();
        context.drawImage(image, drawX, drawY, drawWidth, drawHeight);
        context.restore();

        context.fillStyle = 'rgba(255,255,255,0.12)';
        context.fillRect(x, y + cellHeight + 10, cellWidth, labelHeight - 10);
        context.fillStyle = '#f5f7fb';
        context.fillText(`${index + 1}. ${item.name || `参考图 ${index + 1}`}`, x + 20, y + cellHeight + labelHeight / 2 + 4);
    });

    return {
        fileName: `suite-references-${Date.now()}.png`,
        dataUrl: canvas.toDataURL('image/png'),
        note: `参考图共 ${imageItems.length} 张，附件为拼版图，按从左到右、从上到下查看：${imageItems.map((item, index) => `${index + 1}.${item.name || `参考图${index + 1}`}`).join('，')}`,
    };
}

export async function attachmentToReferenceItem(
    attachment: UploadedFileAttachment,
): Promise<ReferenceItem | null> {
    if (attachmentVisualKind(attachment) !== 'image') return null;
    const source = attachmentPreviewSrc(attachment);
    if (!source) return null;
    const response = await fetch(source);
    if (!response.ok) {
        throw new Error(`读取附件失败 (${response.status})`);
    }
    const blob = await response.blob();
    return {
        name: attachment.name || `reference-${Date.now()}.png`,
        dataUrl: await readBlobAsDataUrl(blob),
    };
}
