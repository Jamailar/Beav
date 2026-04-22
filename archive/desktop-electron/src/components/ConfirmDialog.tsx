interface ConfirmDialogProps {
    open: boolean;
    title: string;
    description: string;
    confirmLabel?: string;
    cancelLabel?: string;
    tone?: 'default' | 'danger';
    hideCancel?: boolean;
    onConfirm: () => void;
    onCancel: () => void;
}

export function ConfirmDialog({
    open,
    title,
    description,
    confirmLabel = '确认',
    cancelLabel = '取消',
    tone = 'default',
    hideCancel = false,
    onConfirm,
    onCancel,
}: ConfirmDialogProps) {
    if (!open) return null;

    const confirmClass = tone === 'danger'
        ? 'bg-red-600 hover:bg-red-700 text-white'
        : 'bg-accent-primary hover:bg-accent-primary/90 text-white';

    return (
        <div className="fixed inset-0 z-[120] flex items-center justify-center bg-black/40 backdrop-blur-sm">
            <div className="w-full max-w-sm rounded-2xl border border-border bg-surface-primary shadow-2xl">
                <div className="px-5 py-4 border-b border-border">
                    <div className="text-sm font-semibold text-text-primary">{title}</div>
                    <div className="mt-1 text-xs leading-5 text-text-tertiary whitespace-pre-wrap">
                        {description}
                    </div>
                </div>
                <div className="px-5 py-4 flex items-center justify-end gap-2">
                    {!hideCancel && (
                        <button
                            type="button"
                            onClick={onCancel}
                            className="rounded-xl border border-border px-3 py-2 text-sm text-text-secondary hover:bg-surface-secondary"
                        >
                            {cancelLabel}
                        </button>
                    )}
                    <button
                        type="button"
                        onClick={onConfirm}
                        className={`rounded-xl px-3 py-2 text-sm ${confirmClass}`}
                    >
                        {confirmLabel}
                    </button>
                </div>
            </div>
        </div>
    );
}
