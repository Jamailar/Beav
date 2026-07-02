import { ArrowRight, X } from 'lucide-react';
import { clsx } from 'clsx';
import type { ChatShortcut } from '../Chat';
import type { UploadedFileAttachment } from '../../components/ChatComposer';
import {
  getActionDescription,
  getActionKindLabel,
  getActionTone,
  getAttachmentPreviewSource,
  renderActionIcon,
  renderActionKindIcon,
} from './attachment-actions/actionVisuals';
import type { ChatAttachmentActionKind } from './attachment-actions/types';

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
  const title = attachmentCount > 1 ? `${attachmentCount} 个${kindLabel}已就绪` : `${kindLabel}已就绪`;
  const subtitle = attachmentCount > 1 ? '选择接下来要执行的工作流' : attachment.name;
  const previewSource = getAttachmentPreviewSource(attachment);
  const customActionLabel = '自定义';

  const renderActionButton = (
    key: string,
    label: string,
    onClick: () => void,
  ) => {
    const tone = getActionTone(label, darkEmbedded);
    return (
      <button
        key={key}
        type="button"
        disabled={disabled}
        onClick={onClick}
        className={clsx(
          'group relative flex aspect-square min-h-[148px] flex-col items-start overflow-hidden rounded-[28px] border p-5 pb-4 text-left shadow-[0_18px_50px_rgba(28,24,18,0.06)] transition-all duration-300 disabled:cursor-not-allowed disabled:opacity-45',
          darkEmbedded ? 'text-white' : 'text-text-primary',
          tone.card,
        )}
      >
        <span className={clsx('pointer-events-none absolute -bottom-12 -left-12 h-32 w-32 rounded-full blur-2xl', tone.wash)} />
        <span className={clsx('pointer-events-none absolute -right-4 -top-4 h-24 w-24 rounded-full blur-xl', tone.wash)} />
        <span
          className={clsx(
            'pointer-events-none absolute right-5 top-4 h-16 w-16 opacity-80',
            '[background-image:radial-gradient(currentColor_1.4px,transparent_1.4px)] [background-size:9px_9px]',
            tone.dots,
          )}
        />
        <span className={clsx(
          'relative z-10 flex h-12 w-12 items-center justify-center rounded-[17px] shadow-[0_12px_24px_rgba(18,15,10,0.08)] ring-1 ring-white/65 backdrop-blur',
          tone.icon,
        )}>
          {renderActionIcon(label, 'h-6 w-6')}
        </span>
        <span className="relative z-10 mt-5 min-w-0 pr-4">
          <span className="block text-[22px] font-semibold leading-tight tracking-tight">{label}</span>
          <span className={clsx('mt-2 block text-[12px] leading-[1.55]', darkEmbedded ? 'text-white/48' : 'text-text-secondary')}>
            {getActionDescription(label)}
          </span>
        </span>
        <span className={clsx(
          'absolute bottom-4 right-4 z-10 flex h-9 w-9 shrink-0 items-center justify-center rounded-full shadow-[0_10px_20px_rgba(18,15,10,0.12)] transition-transform group-hover:translate-x-0.5',
          tone.arrow,
        )}>
          <ArrowRight className="h-4.5 w-4.5" />
        </span>
      </button>
    );
  };

  return (
    <div className={clsx(
      'absolute inset-0 z-[140] flex items-center justify-center px-10 py-10',
      darkEmbedded ? 'bg-[#15181d] text-white' : 'bg-surface-primary text-text-primary'
    )}>
      <div className="relative flex h-full w-full max-w-5xl flex-col justify-center">
        <button
          type="button"
          onClick={onDismiss}
          className={clsx(
            'absolute right-5 top-5 flex h-10 w-10 items-center justify-center rounded-full transition-colors',
            darkEmbedded ? 'text-white/45 hover:bg-white/10 hover:text-white/82' : 'text-text-tertiary hover:bg-surface-secondary hover:text-text-primary'
          )}
          aria-label="关闭文件动作"
          title="关闭"
        >
          <X className="h-5 w-5" />
        </button>

        <div className="flex flex-col items-center gap-5 text-center">
          <div className={clsx(
            'flex max-h-[180px] min-h-[112px] max-w-[320px] items-center justify-center overflow-hidden rounded-[14px]',
            previewSource
              ? ''
              : darkEmbedded
                ? 'h-28 w-28 border border-white/10 bg-white/[0.09] text-white/76 shadow-[0_18px_48px_rgba(18,15,10,0.14)]'
                : 'h-28 w-28 border border-[#ebe7dc] bg-[#fcfbf7] text-accent-primary shadow-[0_18px_48px_rgba(18,15,10,0.14)]'
          )}>
            {previewSource ? (
              <img
                src={previewSource}
                alt={attachment.name}
                className="max-h-[180px] max-w-[320px] rounded-[14px] object-contain shadow-[0_18px_48px_rgba(18,15,10,0.14)]"
              />
            ) : (
              renderActionKindIcon(kind, 'h-11 w-11')
            )}
          </div>

          <div className="space-y-3">
            <div className="text-3xl font-semibold tracking-tight">{title}</div>
            <div className={clsx('mx-auto max-w-xl truncate text-base leading-7', darkEmbedded ? 'text-white/58' : 'text-text-secondary')}>
              {subtitle}
            </div>
          </div>
        </div>

        <div className="mx-auto mt-10 grid w-full max-w-4xl grid-cols-2 gap-5 md:grid-cols-4">
          {actions.map((action) => renderActionButton(action.label, action.label, () => onAction(action)))}
          {renderActionButton('__custom_prompt__', customActionLabel, onDismiss)}
        </div>
      </div>
    </div>
  );
}
