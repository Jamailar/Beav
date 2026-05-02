import { useEffect, useRef, useState } from 'react';
import { Check, ChevronDown } from 'lucide-react';
import { clsx } from 'clsx';

export interface SelectMenuOption {
  value: string;
  label: string;
  description?: string;
}

interface SelectMenuProps {
  value: string;
  onChange: (value: string) => void;
  options: SelectMenuOption[];
  disabled?: boolean;
  placeholder?: string;
  className?: string;
  menuClassName?: string;
}

export function SelectMenu({
  value,
  onChange,
  options,
  disabled = false,
  placeholder = '请选择',
  className,
  menuClassName,
}: SelectMenuProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const selected = options.find((option) => option.value === value);

  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (event: MouseEvent) => {
      if (!(event.target instanceof Node)) return;
      if (rootRef.current?.contains(event.target)) return;
      setOpen(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [open]);

  return (
    <div ref={rootRef} className={clsx('relative min-w-0', className)}>
      <button
        type="button"
        onClick={() => {
          if (disabled || options.length === 0) return;
          setOpen((value) => !value);
        }}
        disabled={disabled || options.length === 0}
        className={clsx(
          'flex h-9 w-full min-w-0 items-center justify-between gap-2 rounded-lg border px-3 text-left text-sm transition',
          open
            ? 'border-accent-primary/45 bg-surface-primary ring-2 ring-accent-primary/15'
            : 'border-border bg-surface-secondary/40 hover:bg-surface-secondary',
          (disabled || options.length === 0) && 'cursor-not-allowed opacity-55',
        )}
      >
        <span className={clsx('truncate font-medium', selected ? 'text-text-primary' : 'text-text-tertiary')}>
          {selected?.label || placeholder}
        </span>
        <ChevronDown className={clsx('h-4 w-4 shrink-0 text-text-tertiary transition-transform', open && 'rotate-180')} />
      </button>

      {open && (
        <div
          className={clsx(
            'absolute left-0 right-0 top-full z-[150] mt-1.5 overflow-hidden rounded-xl border border-border bg-surface-primary shadow-[0_18px_50px_rgba(15,23,42,0.16)]',
            menuClassName,
          )}
        >
          <div className="max-h-64 overflow-y-auto p-1">
            {options.map((option) => {
              const active = option.value === value;
              return (
                <button
                  key={option.value}
                  type="button"
                  onClick={() => {
                    onChange(option.value);
                    setOpen(false);
                  }}
                  className={clsx(
                    'flex min-h-9 w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm transition',
                    active ? 'bg-accent-primary/10 text-accent-primary' : 'text-text-secondary hover:bg-surface-secondary',
                  )}
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">{option.label}</span>
                    {option.description && (
                      <span className="mt-0.5 block truncate text-[11px] text-text-tertiary">{option.description}</span>
                    )}
                  </span>
                  {active && <Check className="h-4 w-4 shrink-0" />}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
