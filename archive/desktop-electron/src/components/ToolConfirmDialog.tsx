import { AlertTriangle, Terminal, FileEdit, Info, X, Check } from 'lucide-react';
import { clsx } from 'clsx';

interface ToolConfirmDialogProps {
    request: ToolConfirmRequest | null;
    onConfirm: (callId: string) => void;
    onCancel: (callId: string) => void;
}

const TYPE_ICONS = {
    exec: Terminal,
    edit: FileEdit,
    info: Info,
};

const TYPE_COLORS = {
    exec: 'border-yellow-500/50 bg-yellow-500/5',
    edit: 'border-blue-500/50 bg-blue-500/5',
    info: 'border-gray-500/50 bg-gray-500/5',
};

export function ToolConfirmDialog({ request, onConfirm, onCancel }: ToolConfirmDialogProps) {
    if (!request) return null;

    const Icon = TYPE_ICONS[request.details.type] || AlertTriangle;
    const colorClass = TYPE_COLORS[request.details.type] || TYPE_COLORS.info;

    return (
        <div className={clsx(
            'mb-3 w-full rounded-2xl border shadow-sm overflow-hidden',
            colorClass,
        )}>
            <div className="px-4 py-3 bg-surface-primary/90 border-b border-border flex items-start gap-3">
                <div className="mt-0.5 p-2 rounded-lg bg-surface-primary border border-border">
                    <Icon className="w-4 h-4 text-yellow-500" />
                </div>
                <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                        <h3 className="text-sm font-semibold text-text-primary">
                            {request.details.title}
                        </h3>
                        <span className="rounded-full border border-border bg-surface-secondary px-2 py-0.5 text-[11px] text-text-tertiary">
                            {request.name}
                        </span>
                    </div>
                    <p className="mt-1 text-xs text-text-tertiary">
                        检测到高风险或受限操作，执行前需要用户确认。
                    </p>
                </div>
            </div>

            <div className="px-4 py-3 bg-surface-primary">
                <div className="space-y-3">
                    <div className="text-xs text-text-secondary whitespace-pre-wrap font-mono bg-surface-secondary p-3 rounded-xl border border-border max-h-40 overflow-auto">
                        {request.details.description}
                    </div>
                    {request.details.impact && (
                        <div className="flex items-start gap-2 p-3 rounded-xl bg-yellow-500/10 border border-yellow-500/30">
                            <AlertTriangle className="w-4 h-4 text-yellow-500 shrink-0 mt-0.5" />
                            <p className="text-xs text-yellow-700 dark:text-yellow-400">
                                {request.details.impact}
                            </p>
                        </div>
                    )}
                </div>
            </div>

            <div className="px-4 py-3 bg-surface-secondary border-t border-border flex items-center justify-end gap-2">
                    <button
                        onClick={() => onCancel(request.callId)}
                        className="flex items-center gap-2 px-3 py-2 text-sm font-medium text-text-secondary hover:text-text-primary bg-surface-primary border border-border rounded-xl hover:bg-surface-secondary transition-colors"
                    >
                        <X className="w-4 h-4" />
                        取消
                    </button>
                    <button
                        onClick={() => onConfirm(request.callId)}
                        className="flex items-center gap-2 px-3 py-2 text-sm font-medium text-white bg-accent-primary hover:bg-accent-primary/90 rounded-xl transition-colors"
                    >
                        <Check className="w-4 h-4" />
                        确认执行
                    </button>
            </div>
        </div>
    );
}
