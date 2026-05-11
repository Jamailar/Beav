import { useState } from 'react';
import { X, ChevronLeft, ChevronRight } from 'lucide-react';
import { APP_BRAND } from '../../config/brand';
import { STEPS, markAppOnboardingSeen } from './constants';
import { WelcomeStep } from './steps/WelcomeStep';
import { HighlightsStep } from './steps/HighlightsStep';
import { SetupStep } from './steps/SetupStep';
import { ReadyStep } from './steps/ReadyStep';

interface AppOnboardingProps {
  open: boolean;
  onClose: () => void;
}

function StepDot({ index, current, label }: { index: number; current: number; label: string }) {
  const active = index === current;
  const done = index < current;
  return (
    <div className="flex items-center gap-1.5">
      <div
        className={`h-2 w-2 rounded-full transition-colors ${
          active ? 'bg-accent-primary' : done ? 'bg-accent-primary/40' : 'bg-border'
        }`}
      />
      <span className={`text-xs ${active ? 'font-medium text-text-primary' : 'text-text-tertiary'}`}>
        {label}
      </span>
    </div>
  );
}

export function AppOnboarding({ open, onClose }: AppOnboardingProps) {
  const [step, setStep] = useState(0);

  if (!open) return null;

  const isFirst = step === 0;
  const isLast = step === STEPS.length - 1;

  const handleClose = () => {
    markAppOnboardingSeen();
    onClose();
  };

  return (
    <div
      className="fixed inset-0 z-[10030] flex min-h-0 flex-col bg-surface-primary text-text-primary"
      role="dialog"
      aria-modal="true"
      aria-label={`${APP_BRAND.displayName} Onboarding`}
    >
      <div className="flex h-14 shrink-0 items-center justify-between border-b border-border px-5">
        <div className="flex items-center gap-4">
          {STEPS.map((label, i) => (
            <StepDot key={i} index={i} current={step} label={label} />
          ))}
        </div>
        <button
          type="button"
          onClick={handleClose}
          className="inline-flex h-8 w-8 items-center justify-center rounded-md text-text-secondary transition-colors hover:bg-surface-secondary hover:text-text-primary"
          aria-label="关闭引导"
          title="关闭"
        >
          <X className="h-4 w-4" strokeWidth={1.8} />
        </button>
      </div>

      <div className="flex min-h-0 flex-1 items-center justify-center px-8">
        {step === 0 && <WelcomeStep />}
        {step === 1 && <HighlightsStep />}
        {step === 2 && <SetupStep />}
        {step === 3 && <ReadyStep onStart={handleClose} />}
      </div>

      <div className="flex h-14 shrink-0 items-center justify-between border-t border-border px-5">
        {!isFirst ? (
          <button
            type="button"
            onClick={() => setStep((s) => s - 1)}
            className="inline-flex items-center gap-1 rounded-lg px-3 py-1.5 text-sm text-text-secondary transition-colors hover:bg-surface-secondary hover:text-text-primary"
          >
            <ChevronLeft className="h-4 w-4" strokeWidth={1.6} />
            上一步
          </button>
        ) : (
          <div />
        )}

        {!isLast ? (
          <button
            type="button"
            onClick={() => setStep((s) => s + 1)}
            className="inline-flex items-center gap-1 rounded-lg bg-accent-primary px-4 py-1.5 text-sm font-medium text-primaryText transition-opacity hover:opacity-90"
          >
            下一步
            <ChevronRight className="h-4 w-4" strokeWidth={1.6} />
          </button>
        ) : null}
      </div>
    </div>
  );
}
