import { useState, type FormEvent } from 'react';
import { ArrowRight } from 'lucide-react';
import { clsx } from 'clsx';

interface ChatInlineTextInputProps {
  placeholder?: string;
  defaultValue?: string;
  submitLabel?: string;
  disabled?: boolean;
  autoFocus?: boolean;
  className?: string;
  inputMode?: 'text' | 'url' | 'email' | 'search' | 'tel';
  onSubmit: (value: string) => void;
}

export function ChatInlineTextInput({
  placeholder = '输入内容...',
  defaultValue = '',
  submitLabel = '提交',
  disabled = false,
  autoFocus = false,
  className,
  inputMode = 'text',
  onSubmit,
}: ChatInlineTextInputProps) {
  const [value, setValue] = useState(defaultValue);
  const trimmedValue = value.trim();

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (disabled || !trimmedValue) return;
    onSubmit(trimmedValue);
  };

  return (
    <form
      onSubmit={handleSubmit}
      className={clsx(
        'flex w-full max-w-[680px] items-center gap-2 rounded-xl border border-border bg-surface-primary/80 px-3 py-2.5 shadow-sm transition-colors focus-within:border-accent-primary/35 focus-within:bg-surface-primary',
        disabled && 'opacity-50',
        className,
      )}
    >
      <input
        value={value}
        onChange={(event) => setValue(event.target.value)}
        disabled={disabled}
        autoFocus={autoFocus}
        inputMode={inputMode}
        className="min-w-0 flex-1 bg-transparent px-1 text-sm font-medium text-text-primary outline-none placeholder:text-text-tertiary disabled:cursor-not-allowed"
        placeholder={placeholder}
      />
      <button
        type="submit"
        disabled={disabled || !trimmedValue}
        className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-lg bg-accent-primary px-3 text-xs font-semibold text-white shadow-sm transition-colors hover:bg-accent-primary/90 disabled:cursor-not-allowed disabled:bg-surface-tertiary disabled:text-text-tertiary disabled:shadow-none"
        aria-label={submitLabel}
      >
        <span>{submitLabel}</span>
        <ArrowRight className="h-3.5 w-3.5" />
      </button>
    </form>
  );
}
