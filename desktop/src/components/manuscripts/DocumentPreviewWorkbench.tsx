import { useEffect, useState } from 'react';
import { AlertCircle, FileText, Loader2 } from 'lucide-react';
import { resolveAssetUrl } from '../../utils/pathManager';

type DocumentPreviewResolveResult = {
    success?: boolean;
    error?: string;
    resolvedUrl?: string | null;
    title?: string | null;
};

interface DocumentPreviewWorkbenchProps {
    filePath: string;
    title: string;
}

export function DocumentPreviewWorkbench({ filePath, title }: DocumentPreviewWorkbenchProps) {
    const [loading, setLoading] = useState(true);
    const [previewUrl, setPreviewUrl] = useState('');
    const [error, setError] = useState('');

    useEffect(() => {
        let cancelled = false;
        const source = `manuscripts://${filePath}`;
        setLoading(true);
        setPreviewUrl('');
        setError('');
        void (async () => {
            try {
                const result = await window.ipcRenderer.files.resolvePreview({ source }) as DocumentPreviewResolveResult;
                if (cancelled) return;
                if (!result?.success) {
                    setError(result?.error || '无法预览');
                    return;
                }
                const resolvedUrl = resolveAssetUrl(String(result.resolvedUrl || '').trim());
                setPreviewUrl(resolvedUrl);
                if (!resolvedUrl) {
                    setError('无法预览');
                }
            } catch (previewError) {
                if (!cancelled) {
                    setError(previewError instanceof Error ? previewError.message : '无法预览');
                }
            } finally {
                if (!cancelled) {
                    setLoading(false);
                }
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [filePath]);

    if (loading) {
        return (
            <div className="flex h-full min-h-0 flex-1 items-center justify-center bg-surface-secondary/20 text-text-tertiary">
                <Loader2 className="h-5 w-5 animate-spin" />
            </div>
        );
    }

    if (previewUrl) {
        return (
            <iframe
                src={previewUrl}
                title={title}
                className="h-full min-h-0 w-full flex-1 border-0 bg-white"
            />
        );
    }

    return (
        <div className="flex h-full min-h-0 flex-1 items-center justify-center bg-surface-secondary/20 p-6">
            <div className="flex flex-col items-center gap-3 text-center">
                <div className="flex h-14 w-14 items-center justify-center rounded-2xl border border-border bg-surface-primary text-text-tertiary">
                    {error ? <AlertCircle className="h-6 w-6" /> : <FileText className="h-6 w-6" />}
                </div>
                <div className="max-w-[360px] truncate text-sm font-semibold text-text-primary">
                    {title}
                </div>
                {error ? <div className="text-xs text-text-tertiary">{error}</div> : null}
            </div>
        </div>
    );
}
