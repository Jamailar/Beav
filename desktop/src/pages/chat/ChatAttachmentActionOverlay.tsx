import { FileText, Image, Video, X } from 'lucide-react';
import { clsx } from 'clsx';
import type { ChatShortcut } from '../Chat';
import type { UploadedFileAttachment } from '../../components/ChatComposer';

export type ChatAttachmentActionKind = 'image' | 'video' | 'file';

interface ChatAttachmentActionOverlayProps {
  attachment: UploadedFileAttachment;
  attachmentCount: number;
  actions: ChatShortcut[];
  darkEmbedded: boolean;
  kind: ChatAttachmentActionKind;
  disabled?: boolean;
  onAction: (action: ChatShortcut) => void;
  onDismiss: () => void;
}

function getActionKindLabel(kind: ChatAttachmentActionKind): string {
  if (kind === 'image') return '图片';
  if (kind === 'video') return '视频';
  return '文件';
}

function renderActionKindIcon(kind: ChatAttachmentActionKind, className: string) {
  if (kind === 'image') return <Image className={className} strokeWidth={1.8} />;
  if (kind === 'video') return <Video className={className} strokeWidth={1.8} />;
  return <FileText className={className} strokeWidth={1.8} />;
}

export function ChatAttachmentActionOverlay({
  attachment,
  attachmentCount,
  actions,
  darkEmbedded,
  kind,
  disabled = false,
  onAction,
  onDismiss,
}: ChatAttachmentActionOverlayProps) {
  if (actions.length === 0) return null;

  const kindLabel = getActionKindLabel(kind);
  const title = attachmentCount > 1 ? `已添加 ${attachmentCount} 个${kindLabel}` : `已添加${kindLabel}`;

  return (
    <div className="pointer-events-none relative z-[130] flex justify-center px-3">
      <div className={clsx(
        'pointer-events-auto w-full max-w-2xl rounded-[24px] border px-3.5 py-3 shadow-[0_22px_70px_rgba(18,15,10,0.18)] backdrop-blur-xl',
        darkEmbedded
          ? 'border-white/10 bg-[#17191d]/94 text-white'
          : 'border-black/[0.07] bg-white/94 text-text-primary'
      )}>
        <div className="flex items-start gap-3">
          <div className={clsx(
            'flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl',
            darkEmbedded ? 'bg-white/[0.08] text-white/72' : 'bg-accent-primary/10 text-accent-primary'
          )}>
            {renderActionKindIcon(kind, 'h-5 w-5')}
          </div>

          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 items-center gap-2">
              <div className="truncate text-sm font-semibold">{title}</div>
              <div className={clsx(
                'min-w-0 truncate text-xs',
                darkEmbedded ? 'text-white/42' : 'text-text-tertiary'
              )}>
                {attachment.name}
              </div>
            </div>
            <div className="mt-3 flex gap-2 overflow-x-auto pb-0.5 no-scrollbar">
              {actions.map((action) => (
                <button
                  key={action.label}
                  type="button"
                  disabled={disabled}
                  onClick={() => onAction(action)}
                  className={clsx(
                    'shrink-0 rounded-full border px-3 py-1.5 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-45',
                    darkEmbedded
                      ? 'border-white/10 bg-white/[0.05] text-white/72 hover:border-white/18 hover:bg-white/[0.08] hover:text-white'
                      : 'border-border bg-surface-secondary text-text-secondary hover:border-accent-primary/24 hover:bg-surface-primary hover:text-accent-primary'
                  )}
                >
                  {action.label}
                </button>
              ))}
            </div>
          </div>

          <button
            type="button"
            onClick={onDismiss}
            className={clsx(
              'flex h-8 w-8 shrink-0 items-center justify-center rounded-full transition-colors',
              darkEmbedded ? 'text-white/42 hover:bg-white/10 hover:text-white/78' : 'text-text-tertiary hover:bg-surface-secondary hover:text-text-primary'
            )}
            aria-label="关闭文件动作"
            title="关闭"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>
    </div>
  );
}
