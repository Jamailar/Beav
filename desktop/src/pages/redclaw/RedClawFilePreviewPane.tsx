import { useEffect, useMemo, useState } from 'react';
import { clsx } from 'clsx';
import {
    AlertCircle,
    Archive,
    Check,
    Copy,
    ExternalLink,
    File,
    FileText,
    FolderOpen,
    Globe,
    Image as ImageIcon,
    Music,
    Video,
    X,
} from 'lucide-react';
import type { ChatMessageLinkKind, ChatMessageLinkTarget } from '../../components/MessageItem';
import { MarkdownItPreview } from '../../components/manuscripts/MarkdownItPreview';

interface RedClawFilePreviewPaneProps {
    target: ChatMessageLinkTarget;
    onClose: () => void;
    onOpenExternal: (target: ChatMessageLinkTarget) => void | Promise<void>;
    onRevealInFolder: (target: ChatMessageLinkTarget) => void | Promise<void>;
    variant?: 'card' | 'sidebar';
}

const getKindIcon = (kind: ChatMessageLinkKind) => {
    switch (kind) {
        case 'image':
            return ImageIcon;
        case 'video':
            return Video;
        case 'audio':
            return Music;
        case 'manuscript':
        case 'document':
            return FileText;
        case 'web':
        case 'html':
            return Globe;
        case 'archive':
            return Archive;
        case 'pdf':
        case 'text':
            return FileText;
        default:
            return File;
    }
};

const getKindLabel = (target: ChatMessageLinkTarget): string => {
    const base = (() => {
        switch (target.kind) {
            case 'image':
                return '图片';
            case 'video':
                return '视频';
            case 'audio':
                return '音频';
            case 'manuscript':
                return '稿件';
            case 'document':
                return '文档';
            case 'web':
            case 'html':
                return '网页';
            case 'archive':
                return '压缩包';
            case 'pdf':
            case 'text':
                return '文档';
            default:
                return '文件';
        }
    })();
    return target.extension ? `${base} · ${target.extension.toUpperCase()}` : base;
};

const getInspectableSource = (target: ChatMessageLinkTarget): string => (
    target.localPathCandidate || target.href
);

const canCopyPreviewText = (target: ChatMessageLinkTarget): boolean => (
    (target.kind === 'text' || target.kind === 'html' || target.kind === 'manuscript')
    && typeof target.previewText === 'string'
);

const isReadableManuscriptPreview = (target: ChatMessageLinkTarget): boolean => (
    target.kind === 'manuscript'
    || String(target.extension || '').toLowerCase() === 'md'
    || String(target.extension || '').toLowerCase() === 'markdown'
);

export function RedClawFilePreviewPane({
    target,
    onClose,
    onOpenExternal,
    onRevealInFolder,
    variant = 'card',
}: RedClawFilePreviewPaneProps) {
    const [loadFailed, setLoadFailed] = useState(false);
    const [copied, setCopied] = useState(false);
    const Icon = getKindIcon(target.kind);
    const sourceLabel = getInspectableSource(target);
    const copyLabel = canCopyPreviewText(target) ? '复制全文' : '复制路径';
    const canInlinePreview = useMemo(() => (
        target.kind === 'image'
        || target.kind === 'video'
        || target.kind === 'audio'
        || target.kind === 'manuscript'
        || target.kind === 'pdf'
        || target.kind === 'html'
        || target.kind === 'text'
        || target.kind === 'web'
    ), [target.kind]);

    useEffect(() => {
        setLoadFailed(false);
        setCopied(false);
    }, [target.href]);

    const copySource = async () => {
        const copyText = canCopyPreviewText(target) ? target.previewText || '' : sourceLabel;
        if (!copyText) return;
        try {
            await navigator.clipboard.writeText(copyText);
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1200);
        } catch (error) {
            console.error('Failed to copy AI preview content:', error);
        }
    };

    const renderPreview = () => {
        if (target.error) {
            return (
                <div className="flex h-full min-h-[280px] flex-col items-center justify-center gap-4 px-8 text-center">
                    <div className="flex h-14 w-14 items-center justify-center rounded-2xl border border-border bg-surface-secondary text-text-tertiary">
                        <AlertCircle className="h-6 w-6" />
                    </div>
                    <div className="space-y-1">
                        <div className="text-sm font-semibold text-text-primary">{target.label}</div>
                        <div className="text-xs text-red-500">{target.error}</div>
                    </div>
                    <button
                        type="button"
                        onClick={() => void copySource()}
                        className="inline-flex items-center gap-2 rounded-xl border border-border bg-surface-primary px-3 py-2 text-sm font-semibold text-text-secondary transition hover:bg-surface-secondary"
                    >
                        <Copy className="h-4 w-4" />
                        {copyLabel}
                    </button>
                </div>
            );
        }

        if (
            (
                target.kind === 'text'
                || target.kind === 'manuscript'
                || (target.kind === 'html' && !target.resolvedUrl)
            )
            && typeof target.previewText === 'string'
        ) {
            if (isReadableManuscriptPreview(target)) {
                return (
                    <div className="h-full w-full overflow-auto bg-surface-secondary/30 px-6 py-5">
                        <MarkdownItPreview
                            content={target.previewText}
                            density="compact"
                            emptyText="暂无内容"
                            className="text-text-secondary"
                        />
                    </div>
                );
            }

            return (
                <pre className="h-full w-full overflow-auto bg-surface-secondary/30 p-4 font-mono text-xs leading-5 text-text-secondary whitespace-pre-wrap">
                    {target.previewText}
                </pre>
            );
        }

        if (loadFailed || !target.resolvedUrl || !canInlinePreview) {
            return (
                <div className="flex h-full min-h-[280px] flex-col items-center justify-center gap-4 px-8 text-center">
                    <div className="flex h-14 w-14 items-center justify-center rounded-2xl border border-border bg-surface-secondary text-text-tertiary">
                        {loadFailed ? <AlertCircle className="h-6 w-6" /> : <Icon className="h-6 w-6" />}
                    </div>
                    <div className="space-y-1">
                        <div className="text-sm font-semibold text-text-primary">{target.label}</div>
                        <div className="text-xs text-text-tertiary">{getKindLabel(target)}</div>
                    </div>
                    <button
                        type="button"
                        onClick={() => void onOpenExternal(target)}
                        className="inline-flex items-center gap-2 rounded-xl bg-text-primary px-3 py-2 text-sm font-semibold text-surface-primary transition hover:opacity-90"
                    >
                        <ExternalLink className="h-4 w-4" />
                        打开
                    </button>
                </div>
            );
        }

        if (target.kind === 'image') {
            return (
                <div className="flex h-full items-center justify-center bg-surface-secondary/40 p-4">
                    <img
                        src={target.resolvedUrl}
                        alt={target.label}
                        className="max-h-full max-w-full rounded-xl border border-border bg-surface-primary object-contain shadow-sm"
                        onError={() => setLoadFailed(true)}
                    />
                </div>
            );
        }

        if (target.kind === 'video') {
            return (
                <div className="flex h-full items-center justify-center bg-black/90 p-4">
                    <video
                        src={target.resolvedUrl}
                        controls
                        preload="metadata"
                        className="max-h-full max-w-full rounded-xl"
                        onError={() => setLoadFailed(true)}
                    />
                </div>
            );
        }

        if (target.kind === 'audio') {
            return (
                <div className="flex h-full flex-col items-center justify-center gap-5 bg-surface-secondary/40 p-6">
                    <div className="flex h-16 w-16 items-center justify-center rounded-2xl border border-border bg-surface-primary text-text-tertiary">
                        <Music className="h-7 w-7" />
                    </div>
                    <audio
                        src={target.resolvedUrl}
                        controls
                        className="w-full"
                        onError={() => setLoadFailed(true)}
                    />
                </div>
            );
        }

        return (
            <iframe
                src={target.resolvedUrl}
                title={target.label}
                className="h-full w-full border-0 bg-white"
                onError={() => setLoadFailed(true)}
            />
        );
    };
    const sidebarVariant = variant === 'sidebar';

    return (
        <section className={clsx(
            'flex h-full min-h-0 w-full flex-col overflow-hidden bg-surface-primary',
            sidebarVariant ? 'rounded-none border-0' : 'rounded-2xl border border-border'
        )}>
            <div className={clsx(
                'flex items-center gap-3 border-b border-border',
                sidebarVariant ? 'min-h-[56px] px-4 py-2' : 'min-h-[72px] px-4 py-3'
            )}>
                <div className={clsx(
                    'flex shrink-0 items-center justify-center bg-surface-secondary text-text-tertiary',
                    sidebarVariant ? 'h-9 w-9 rounded-lg' : 'h-11 w-11 rounded-xl'
                )}>
                    <Icon className="h-5 w-5" />
                </div>
                <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-semibold text-text-primary" title={target.label}>
                        {target.label}
                    </div>
                    <div className="mt-1 truncate text-xs text-text-tertiary" title={sourceLabel}>
                        {getKindLabel(target)}
                    </div>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                    <button
                        type="button"
                        onClick={() => void copySource()}
                        className={clsx(
                            'inline-flex items-center justify-center rounded-lg text-text-tertiary transition hover:bg-surface-secondary hover:text-text-primary',
                            sidebarVariant ? 'h-8 w-8' : 'h-9 w-9'
                        )}
                        title={copyLabel}
                    >
                        {copied ? <Check className="h-4 w-4 text-green-500" /> : <Copy className="h-4 w-4" />}
                    </button>
                    {target.isLocal && (
                        <button
                            type="button"
                            onClick={() => void onRevealInFolder(target)}
                            className={clsx(
                                'inline-flex items-center justify-center rounded-lg text-text-tertiary transition hover:bg-surface-secondary hover:text-text-primary',
                                sidebarVariant ? 'h-8 w-8' : 'h-9 w-9'
                            )}
                            title="在文件夹中显示"
                        >
                            <FolderOpen className="h-4 w-4" />
                        </button>
                    )}
                    <button
                        type="button"
                        onClick={() => void onOpenExternal(target)}
                        className={clsx(
                            'inline-flex items-center justify-center rounded-lg text-text-tertiary transition hover:bg-surface-secondary hover:text-text-primary',
                            sidebarVariant ? 'h-8 w-8' : 'h-9 w-9'
                        )}
                        title="打开"
                    >
                        <ExternalLink className="h-4 w-4" />
                    </button>
                    <button
                        type="button"
                        onClick={onClose}
                        className={clsx(
                            'inline-flex items-center justify-center rounded-lg text-text-tertiary transition hover:bg-surface-secondary hover:text-text-primary',
                            sidebarVariant ? 'h-8 w-8' : 'h-9 w-9'
                        )}
                        title="关闭预览"
                    >
                        <X className="h-4 w-4" />
                    </button>
                </div>
            </div>
            <div className={clsx('min-h-0 flex-1 overflow-hidden', loadFailed && 'bg-surface-secondary/30')}>
                {renderPreview()}
            </div>
        </section>
    );
}
