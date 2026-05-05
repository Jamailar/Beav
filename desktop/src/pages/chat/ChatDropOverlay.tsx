import { FileUp } from 'lucide-react';
import { clsx } from 'clsx';

interface ChatDropOverlayProps {
  darkEmbedded: boolean;
}

export function ChatDropOverlay({ darkEmbedded }: ChatDropOverlayProps) {
  return (
    <div className="pointer-events-none absolute inset-0 z-[140] flex items-center justify-center bg-surface-primary/90 px-10 backdrop-blur-xl">
      <div className={clsx(
        'flex min-h-[360px] w-full max-w-3xl flex-col items-center justify-center gap-7 rounded-[34px] border border-dashed px-12 py-14 text-center shadow-2xl',
        darkEmbedded
          ? 'border-white/24 bg-white/[0.06] text-white'
          : 'border-accent-primary/35 bg-white/80 text-text-primary'
      )}>
        <div className={clsx(
          'flex h-20 w-20 items-center justify-center rounded-[28px]',
          darkEmbedded ? 'bg-white/10 text-white' : 'bg-accent-primary/10 text-accent-primary'
        )}>
          <FileUp className="h-9 w-9" strokeWidth={1.8} />
        </div>
        <div className="space-y-3">
          <div className="text-3xl font-semibold tracking-tight">拖入素材，导出精彩</div>
          <div className={clsx('text-base leading-7', darkEmbedded ? 'text-white/62' : 'text-text-secondary')}>
            松开后文件会添加到输入框，可继续补充问题再发送。
          </div>
        </div>
      </div>
    </div>
  );
}
