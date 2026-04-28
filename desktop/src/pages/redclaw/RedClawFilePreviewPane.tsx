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

interface RedClawFilePreviewPaneProps {
    target: ChatMessageLinkTarget;
    onClose: () => void;
    onOpenExternal: (target: ChatMessageLinkTarget) => void | Promise<void>;
    onRevealInFolder: (target: ChatMessageLinkTarget) => void | Promise<void>;
}

const getKindIcon = (kind: ChatMessageLinkKind) => {
    switch (kind) {
        case 'image':
            return ImageIcon;
        case 'video':
            return Video;
        case 'audio':
            return Music;
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

export function RedClawFilePreviewPane({
    target,
    onClose,
    onOpenExternal,
    onRevealInFolder,
}: RedClawFilePreviewPaneProps) {
    const [loadFailed, setLoadFailed] = useState(false);
    const [copied, setCopied] = useState(false);
    const Icon = getKindIcon(target.kind);
    const sourceLabel = getInspectableSource(target);
    const canInlinePreview = useMemo(() => (
        target.kind === 'image'
        || target.kind === 'video'
        || target.kind === 'audio'
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
        if (!sourceLabel) return;
        try {
            await navigator.clipboard.writeText(sourceLabel);
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1200);
        } catch (error) {
            console.error('Failed to copy RedClaw preview path:', error);
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
                        复制路径
                    </button>
                </div>
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

        if ((target.kind === 'text' || target.kind === 'html') && typeof target.previewText === 'string') {
            return (
                <pre className="h-full w-full overflow-auto bg-surface-secondary/30 p-4 font-mono text-xs leading-5 text-text-secondary whitespace-pre-wrap">
                    {target.previewText}
                </pre>
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

    return (
        <section className="flex h-full min-h-0 w-full flex-col overflow-hidden rounded-2xl border border-border bg-surface-primary">
            <div className="flex min-h-[72px] items-center gap-3 border-b border-border px-4 py-3">
                <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-surface-secondary text-text-tertiary">
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
                        className="inline-flex h-9 w-9 items-center justify-center rounded-lg text-text-tertiary transition hover:bg-surface-secondary hover:text-text-primary"
                        title="复制路径"
                    >
                        {copied ? <Check className="h-4 w-4 text-green-500" /> : <Copy className="h-4 w-4" />}
                    </button>
                    {target.isLocal && (
                        <button
                            type="button"
                            onClick={() => void onRevealInFolder(target)}
                            className="inline-flex h-9 w-9 items-center justify-center rounded-lg text-text-tertiary transition hover:bg-surface-secondary hover:text-text-primary"
                            title="在文件夹中显示"
                        >
                            <FolderOpen className="h-4 w-4" />
                        </button>
                    )}
                    <button
                        type="button"
                        onClick={() => void onOpenExternal(target)}
                        className="inline-flex h-9 w-9 items-center justify-center rounded-lg text-text-tertiary transition hover:bg-surface-secondary hover:text-text-primary"
                        title="打开"
                    >
                        <ExternalLink className="h-4 w-4" />
                    </button>
                    <button
                        type="button"
                        onClick={onClose}
                        className="inline-flex h-9 w-9 items-center justify-center rounded-lg text-text-tertiary transition hover:bg-surface-secondary hover:text-text-primary"
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
