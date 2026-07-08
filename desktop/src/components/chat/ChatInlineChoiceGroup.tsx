import type { ReactNode } from 'react';
import { ArrowRight } from 'lucide-react';
import { clsx } from 'clsx';

export interface ChatInlineChoice {
  id: string;
  label: string;
  description?: string;
  icon?: ReactNode;
  disabled?: boolean;
}

interface ChatInlineChoiceGroupProps {
  choices: ChatInlineChoice[];
  onSelect: (choice: ChatInlineChoice) => void;
  className?: string;
  columns?: 1 | 2;
  disabled?: boolean;
}

export function ChatInlineChoiceGroup({
  choices,
  onSelect,
  className,
  columns = 2,
  disabled = false,
}: ChatInlineChoiceGroupProps) {
  if (choices.length === 0) return null;

  return (
    <div className={clsx(
      'grid w-full max-w-[680px] gap-2',
      columns === 2 ? 'grid-cols-1 sm:grid-cols-2' : 'grid-cols-1',
      className,
    )}>
      {choices.map((choice) => {
        const choiceDisabled = disabled || Boolean(choice.disabled);
        return (
          <button
            key={choice.id}
            type="button"
            disabled={choiceDisabled}
            onClick={() => onSelect(choice)}
            className={clsx(
              'group relative flex items-center gap-3 overflow-hidden rounded-[22px] border px-5 text-left transition-all duration-300',
              choice.description ? 'min-h-[62px] py-3' : 'min-h-[58px] py-3',
              'border-accent-primary/25 bg-surface-primary/85 shadow-[0_14px_40px_rgb(68_51_36/0.10)]',
              'hover:-translate-y-0.5 hover:border-accent-primary/50 hover:bg-surface-primary hover:shadow-[0_22px_58px_rgb(var(--color-accent-primary)/0.18)]',
              'focus:outline-none focus-visible:-translate-y-0.5 focus-visible:border-accent-primary/60 focus-visible:ring-2 focus-visible:ring-accent-primary/25',
              choiceDisabled && 'cursor-not-allowed opacity-50 hover:translate-y-0 hover:border-border hover:bg-surface-primary/80 hover:shadow-none',
            )}
          >
            <span className="pointer-events-none absolute -inset-8 rounded-[30px] bg-[radial-gradient(circle_at_88%_50%,rgb(var(--color-accent-primary)/0.24),transparent_42%),radial-gradient(circle_at_12%_50%,rgb(var(--color-status-success)/0.13),transparent_36%)] opacity-0 blur-2xl transition-opacity duration-500 group-hover:animate-pulse group-hover:opacity-100 group-focus-visible:animate-pulse group-focus-visible:opacity-100" />
            {choice.icon ? (
              <span className="relative flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-accent-primary/20 bg-accent-primary/10 text-accent-primary shadow-sm">
                {choice.icon}
              </span>
            ) : null}
            <span className="relative min-w-0 flex-1">
              <span className="block truncate text-[15px] font-bold text-text-primary">
                {choice.label}
              </span>
              {choice.description ? (
                <span className="mt-0.5 block truncate text-xs text-text-tertiary">
                  {choice.description}
                </span>
              ) : null}
            </span>
            <span className="relative flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-accent-primary/10 text-accent-primary transition-all duration-200 group-hover:translate-x-0.5 group-hover:bg-accent-primary group-hover:text-white group-hover:shadow-[0_10px_24px_rgb(var(--color-accent-primary)/0.28)]">
              <ArrowRight className="h-4 w-4" />
            </span>
          </button>
        );
      })}
    </div>
  );
}
