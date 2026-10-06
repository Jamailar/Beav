import { AlertTriangle, Check, Globe, ShieldAlert, X } from 'lucide-react';
import { clsx } from 'clsx';

export type CliEscalationScope = 'once' | 'session' | 'always';

export interface CliEscalationRequestModel {
  escalationId: string;
  executionId?: string;
  title: string;
  description: string;
  reason?: string;
  commandPreview?: string;
  permissionSummary: string[];
  scopeOptions: CliEscalationScope[];
}

interface CliEscalationDialogProps {
  request: CliEscalationRequestModel | null;
  onApprove: (escalationId: string, scope: CliEscalationScope) => void;
  onDeny: (escalationId: string) => void;
}

const SCOPE_LABELS: Record<CliEscalationScope, { title: string; description: string; icon: typeof Globe }> = {
  once: {
    title: '仅这一次',
    description: '只为当前命令扩权',
    icon: Globe,
  },
  session: {
    title: '当前会话',
    description: '本次会话内复用授权',
    icon: ShieldAlert,
  },
  always: {
    title: '始终允许',
    description: '持久化同类授权策略',
    icon: Check,
  },
};

export function CliEscalationDialog({ request, onApprove, onDeny }: CliEscalationDialogProps) {
  if (!request) return null;

  return (
    <div className="mb-3 w-full overflow-hidden rounded-2xl border border-yellow-500/40 bg-yellow-500/5 shadow-sm">
      <div className="flex items-start gap-3 border-b border-yellow-500/20 bg-surface-primary/90 px-4 py-3">
        <div className="mt-0.5 rounded-lg border border-border bg-surface-primary p-2">
          <AlertTriangle className="h-4 w-4 text-yellow-500" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <h3 className="text-sm font-semibold text-text-primary">
              {request.title || 'CLI 需要额外权限'}
            </h3>
            {request.executionId ? (
              <span className="rounded-full border border-border bg-surface-secondary px-2 py-0.5 text-[11px] text-text-tertiary">
                exec {request.executionId}
              </span>
            ) : null}
          </div>
          <p className="mt-1 text-xs text-text-tertiary">
            {request.description || '该操作需要额外权限后才能继续执行。'}
          </p>
        </div>
      </div>

      <div className="space-y-3 bg-surface-primary px-4 py-3">
        {request.commandPreview ? (
          <div>
            <div className="mb-1 text-[11px] font-medium text-text-tertiary">命令预览</div>
            <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-all rounded-xl border border-border bg-surface-secondary/60 px-3 py-2 text-xs text-text-secondary">
              {request.commandPreview}
            </pre>
          </div>
        ) : null}

        {request.reason ? (
          <div className="text-xs text-text-secondary">
            <span className="font-medium text-text-primary">原因：</span>
            {request.reason}
          </div>
        ) : null}

        {request.permissionSummary.length > 0 ? (
          <div className="rounded-xl border border-yellow-500/25 bg-yellow-500/10 px-3 py-3">
            <div className="mb-2 text-[11px] font-medium text-yellow-700">申请的额外权限</div>
            <div className="space-y-1 text-xs text-yellow-800">
              {request.permissionSummary.map((item, index) => (
                <div key={`${request.escalationId}:${index}`}>{item}</div>
              ))}
            </div>
          </div>
        ) : null}
      </div>

      <div className="border-t border-border bg-surface-secondary px-4 py-3">
        <div className="grid gap-2 sm:grid-cols-3">
          {request.scopeOptions.map((scope) => {
            const meta = SCOPE_LABELS[scope];
            const Icon = meta.icon;
            return (
              <button
                key={scope}
                type="button"
                onClick={() => onApprove(request.escalationId, scope)}
                className={clsx(
                  'rounded-xl border border-border bg-surface-primary px-3 py-2 text-left transition-colors hover:border-accent-primary hover:bg-accent-primary/5',
                  scope === 'always' && 'border-yellow-500/30',
                )}
              >
                <div className="flex items-center gap-2 text-sm font-medium text-text-primary">
                  <Icon className="h-4 w-4 text-yellow-600" />
                  {meta.title}
                </div>
                <div className="mt-1 text-[11px] text-text-tertiary">{meta.description}</div>
              </button>
            );
          })}
        </div>
        <div className="mt-2 flex justify-end">
          <button
            type="button"
            onClick={() => onDeny(request.escalationId)}
            className="inline-flex items-center gap-2 rounded-xl border border-border bg-surface-primary px-3 py-2 text-sm font-medium text-text-secondary transition-colors hover:bg-surface-secondary hover:text-text-primary"
          >
            <X className="h-4 w-4" />
            拒绝
          </button>
        </div>
      </div>
    </div>
  );
}
