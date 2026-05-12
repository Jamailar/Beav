import { ArrowRight, Sparkles } from 'lucide-react';
import { APP_BRAND } from '../../../config/brand';

interface ReadyStepProps {
  onStart: () => void;
}

export function ReadyStep({ onStart }: ReadyStepProps) {
  return (
    <div className="flex max-w-md flex-col items-center gap-8 text-center">
      <div className="flex h-20 w-20 items-center justify-center rounded-full bg-accent-primary/10">
        <Sparkles className="h-10 w-10 text-accent-primary" strokeWidth={1.4} />
      </div>

      <div className="space-y-2">
        <h2 className="text-xl font-semibold text-text-primary">一切就绪</h2>
        <p className="text-sm leading-6 text-text-tertiary">
          你已经了解了 {APP_BRAND.displayName} 的核心能力。
          <br />
          现在去导入第一条知识，或者直接开始 AI 对话吧。
        </p>
      </div>

      <button
        type="button"
        onClick={onStart}
        className="inline-flex items-center gap-2 rounded-xl bg-accent-primary px-6 py-2.5 text-sm font-medium text-primaryText transition-opacity hover:opacity-90"
      >
        开始使用
        <ArrowRight className="h-4 w-4" strokeWidth={1.8} />
      </button>
    </div>
  );
}
