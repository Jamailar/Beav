import { useEffect, useMemo, useState } from 'react';
import { AlertCircle, ArrowLeft, ArrowRight, Loader2, Sparkles, X } from 'lucide-react';
import { clsx } from 'clsx';
import { Slider } from '../../vendor/freecut/components/ui/slider';
import {
  REDCLAW_ONBOARDING_DEFAULT_ANSWERS,
  REDCLAW_ONBOARDING_MVP_QUESTIONS,
  normalizeOnboardingAnswers,
  onboardingProgressLabel,
  type RedClawOnboardingAnswers,
  type RedClawOnboardingQuestion,
} from './onboardingMvp';

interface RedClawOnboardingFlowProps {
  open: boolean;
  activeSpaceName: string;
  initialStepIndex?: number;
  initialAnswers?: Record<string, unknown> | null;
  onClose: () => void;
  onSaveProgress: (payload: { stepIndex: number; answers: RedClawOnboardingAnswers }) => Promise<void>;
  onComplete: (answers: RedClawOnboardingAnswers) => Promise<void>;
}

const COMPLETION_STAGES = [
  '正在保存问卷结果',
  '正在启动 RedClaw 初始化 agent',
  '正在更新空间长期档案',
  '正在更新空间写作风格技能',
  '正在刷新当前空间上下文',
] as const;

function QuestionProgress({
  currentStepIndex,
  submitting = false,
}: {
  currentStepIndex: number;
  submitting?: boolean;
}) {
  const progress = submitting
    ? 100
    : ((currentStepIndex + 1) / REDCLAW_ONBOARDING_MVP_QUESTIONS.length) * 100;
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between text-[11px] font-semibold uppercase tracking-[0.24em] text-stone-700/70">
        <span>Space Initialization</span>
        <span>{submitting ? 'Finalizing' : onboardingProgressLabel(currentStepIndex)}</span>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-stone-300/60">
        <div
          className="h-full rounded-full bg-gradient-to-r from-amber-500 via-orange-400 to-rose-400 transition-[width] duration-300 ease-out"
          style={{ width: `${progress}%` }}
        />
      </div>
    </div>
  );
}

function CompletionView({
  activeSpaceName,
  stageIndex,
}: {
  activeSpaceName: string;
  stageIndex: number;
}) {
  return (
    <div className="flex h-full min-h-[420px] items-center justify-center">
      <div className="w-full max-w-3xl rounded-[32px] border border-stone-300/80 bg-[linear-gradient(180deg,rgba(255,252,247,0.96),rgba(246,238,228,0.94))] px-8 py-10 text-center shadow-[0_32px_90px_rgba(120,88,38,0.14)] backdrop-blur-xl">
        <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full border border-amber-300/70 bg-amber-50">
          <Loader2 className="h-7 w-7 animate-spin text-amber-700" />
        </div>
        <div className="mt-6 text-[11px] font-semibold uppercase tracking-[0.24em] text-stone-600/70">
          RedClaw · {activeSpaceName || '当前空间'}
        </div>
        <h2 className="mt-3 text-3xl font-semibold leading-tight text-stone-950 sm:text-[38px]">
          正在完成这个空间的风格初始化
        </h2>
        <p className="mx-auto mt-4 max-w-2xl text-sm leading-7 text-stone-700/80 sm:text-[15px]">
          我正在把这份问卷结果交给 RedClaw 初始化 agent，顺序更新空间档案和写作风格技能。这个页面会一直停留到初始化全部完成。
        </p>

        <div className="mt-8 space-y-3 text-left">
          {COMPLETION_STAGES.map((label, index) => {
            const active = index <= stageIndex;
            return (
              <div
                key={label}
                className={clsx(
                  'flex items-center gap-3 rounded-2xl border px-4 py-3 transition-all duration-200',
                  active
                    ? 'border-amber-300/70 bg-amber-50/90 text-stone-900'
                    : 'border-stone-200/90 bg-white/70 text-stone-500'
                )}
              >
                <div
                  className={clsx(
                    'flex h-6 w-6 items-center justify-center rounded-full border',
                    active ? 'border-amber-300 bg-amber-100' : 'border-stone-300 bg-stone-100/80'
                  )}
                >
                  {index === stageIndex ? <Loader2 className="h-3.5 w-3.5 animate-spin text-amber-700" /> : <span className="text-[11px] font-semibold">{index + 1}</span>}
                </div>
                <div className="text-sm font-medium">{label}</div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function SliderQuestionView({
  question,
  value,
  onChange,
}: {
  question: Extract<RedClawOnboardingQuestion, { type: 'slider' }>;
  value: number;
  onChange: (next: number) => void;
}) {
  const leftValue = Math.max(0, 100 - value);
  const rightValue = Math.max(0, value);

  return (
    <div className="space-y-8">
      <div className="space-y-4">
        <div className="inline-flex items-center gap-2 rounded-full border border-amber-300/70 bg-white/82 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-stone-700">
          <Sparkles className="h-3.5 w-3.5 text-amber-600" />
          Continuous Scale
        </div>
        <div className="space-y-3">
          <h2 className="max-w-3xl text-3xl font-semibold leading-tight text-stone-950 sm:text-[38px]">
            {question.title}
          </h2>
          <p className="max-w-2xl text-sm leading-7 text-stone-700/80 sm:text-[15px]">
            {question.description}
          </p>
        </div>
      </div>

      <div className="rounded-[28px] border border-stone-300/85 bg-[linear-gradient(180deg,rgba(255,255,255,0.92),rgba(248,242,233,0.9))] p-6 shadow-[0_24px_70px_rgba(120,88,38,0.1)] backdrop-blur-xl sm:p-8">
        <div className="mb-2 flex items-end justify-between gap-6">
          <div className="min-w-0">
            <div className="text-sm font-semibold text-stone-700">{question.minLabel}</div>
            <div className="mt-1 text-[34px] font-black leading-none tracking-[-0.03em] text-stone-950">{leftValue}%</div>
          </div>
          <div className="min-w-0 text-right">
            <div className="text-sm font-semibold text-stone-700">{question.maxLabel}</div>
            <div className="mt-1 text-[34px] font-black leading-none tracking-[-0.03em] text-stone-950">{rightValue}%</div>
          </div>
        </div>
        <div className="mt-1">
          <div className="relative px-16 py-6">
            <div className="absolute inset-x-16 top-1/2 h-12 -translate-y-1/2 overflow-hidden rounded-full bg-rose-200 shadow-[inset_0_2px_5px_rgba(120,53,15,0.12)]">
              <div
                className="h-full rounded-full bg-gradient-to-r from-amber-500 via-orange-400 to-orange-300"
                style={{ width: `${value}%` }}
              />
            </div>

            <Slider
              value={[value]}
              min={0}
              max={100}
              step={1}
              onValueChange={(values) => onChange(values[0] ?? value)}
              className="relative z-20 w-full cursor-grab py-6 active:cursor-grabbing [&>span:first-child]:h-12 [&>span:first-child]:bg-transparent [&>span:first-child>span]:bg-transparent [&>span:last-child]:h-16 [&>span:last-child]:w-16 [&>span:last-child]:rounded-none [&>span:last-child]:border-0 [&>span:last-child]:bg-[url('/Box.png')] [&>span:last-child]:bg-contain [&>span:last-child]:bg-center [&>span:last-child]:bg-no-repeat [&>span:last-child]:bg-transparent [&>span:last-child]:shadow-none [&>span:last-child]:outline-none [&>span:last-child]:ring-0 [&>span:last-child]:focus:outline-none [&>span:last-child]:focus-visible:outline-none [&>span:last-child]:focus-visible:ring-0"
            />
          </div>

          <div className="mt-6 rounded-2xl border border-amber-200/80 bg-amber-50/90 px-4 py-3 text-sm leading-6 text-stone-700">
            {question.helper(value)}
          </div>
        </div>
      </div>
    </div>
  );
}

function ChoiceQuestionView({
  question,
  value,
  onChange,
}: {
  question: Extract<RedClawOnboardingQuestion, { type: 'choice' }>;
  value: string;
  onChange: (next: string) => void;
}) {
  return (
    <div className="space-y-8">
      <div className="space-y-3">
        <h2 className="max-w-3xl text-3xl font-semibold leading-tight text-stone-950 sm:text-[38px]">
          {question.title}
        </h2>
        <p className="max-w-2xl text-sm leading-7 text-stone-700/80 sm:text-[15px]">
          {question.description}
        </p>
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        {question.options.map((option) => {
          const active = option.value === value;
          return (
            <button
              key={option.value}
              type="button"
              onClick={() => onChange(option.value)}
              className={clsx(
                'group rounded-[28px] border px-5 py-5 text-left transition-all duration-200',
                active
                  ? 'border-amber-300 bg-[linear-gradient(180deg,rgba(255,255,255,0.96),rgba(255,245,230,0.94))] shadow-[0_24px_70px_rgba(120,88,38,0.14)]'
                  : 'border-stone-200 bg-white/78 hover:border-stone-300 hover:bg-white'
              )}
            >
              <div className="flex items-start justify-between gap-4">
                <div className="space-y-2">
                  <div className="text-lg font-semibold text-stone-950">{option.label}</div>
                  <div className="text-sm leading-6 text-stone-700/80">{option.description}</div>
                </div>
                <div
                  className={clsx(
                    'mt-1 h-5 w-5 rounded-full border transition-colors',
                    active
                      ? 'border-amber-400 bg-amber-400 shadow-[0_0_0_4px_rgba(251,191,36,0.18)]'
                      : 'border-stone-300 bg-stone-50'
                  )}
                />
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function AbQuestionView({
  question,
  value,
  onChange,
}: {
  question: Extract<RedClawOnboardingQuestion, { type: 'ab' }>;
  value: string;
  onChange: (next: string) => void;
}) {
  return (
    <div className="space-y-8">
      <div className="space-y-3">
        <h2 className="max-w-3xl text-3xl font-semibold leading-tight text-stone-950 sm:text-[38px]">
          {question.title}
        </h2>
        <p className="max-w-2xl text-sm leading-7 text-stone-700/80 sm:text-[15px]">
          {question.description}
        </p>
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        {question.options.map((option) => {
          const active = option.value === value;
          return (
            <button
              key={option.value}
              type="button"
              onClick={() => onChange(option.value)}
              className={clsx(
                'rounded-[30px] border px-6 py-6 text-left transition-all duration-200',
                active
                  ? 'border-amber-300 bg-[linear-gradient(180deg,rgba(255,255,255,0.97),rgba(255,244,227,0.94))] shadow-[0_24px_70px_rgba(120,88,38,0.14)]'
                  : 'border-stone-200 bg-white/80 hover:border-stone-300 hover:bg-white'
              )}
            >
              <div className="mb-5 flex items-center justify-between">
                <div className="text-[11px] font-semibold uppercase tracking-[0.24em] text-stone-500">
                  选项 {option.label}
                </div>
                <div
                  className={clsx(
                    'h-5 w-5 rounded-full border transition-colors',
                    active
                      ? 'border-amber-400 bg-amber-400 shadow-[0_0_0_4px_rgba(251,191,36,0.18)]'
                      : 'border-stone-300 bg-stone-50'
                  )}
                />
              </div>
              <div className="space-y-3 rounded-[22px] border border-stone-200/90 bg-stone-50/85 px-5 py-5">
                {option.body.map((line) => (
                  <p key={line} className="text-base leading-7 text-stone-900">
                    {line}
                  </p>
                ))}
              </div>
              <p className="mt-4 text-sm leading-6 text-stone-700/75">{option.caption}</p>
            </button>
          );
        })}
      </div>
    </div>
  );
}

export function RedClawOnboardingFlow({
  open,
  activeSpaceName,
  initialStepIndex = 0,
  initialAnswers,
  onClose,
  onSaveProgress,
  onComplete,
}: RedClawOnboardingFlowProps) {
  const [answers, setAnswers] = useState<RedClawOnboardingAnswers>(REDCLAW_ONBOARDING_DEFAULT_ANSWERS);
  const [currentStepIndex, setCurrentStepIndex] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [submissionStageIndex, setSubmissionStageIndex] = useState(0);
  const [submissionError, setSubmissionError] = useState('');
  const [hasDefaultModelConfigured, setHasDefaultModelConfigured] = useState(true);
  const [modelConfigMessage, setModelConfigMessage] = useState('');

  useEffect(() => {
    if (!open) return;
    setAnswers(normalizeOnboardingAnswers(initialAnswers));
    setCurrentStepIndex(Math.max(0, Math.min(REDCLAW_ONBOARDING_MVP_QUESTIONS.length - 1, initialStepIndex)));
    setSubmitting(false);
    setSubmissionStageIndex(0);
    setSubmissionError('');
    setModelConfigMessage('');
  }, [initialAnswers, initialStepIndex, open]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const loadModelConfig = async () => {
      try {
        const settings = await window.ipcRenderer.getSettings();
        if (cancelled) return;
        const defaultModelName = String(settings?.model_name || '').trim();
        const configured = defaultModelName.length > 0;
        setHasDefaultModelConfigured(configured);
        setModelConfigMessage(
          configured
            ? ''
            : '请先在“设置 -> AI 模型”里设置默认模型，再继续风格初始化。没有默认模型，RedClaw 无法完成后续档案和技能生成。'
        );
      } catch (error) {
        if (cancelled) return;
        console.error('Failed to load settings for RedClaw onboarding:', error);
        setHasDefaultModelConfigured(false);
        setModelConfigMessage('当前无法读取模型配置，请先在“设置 -> AI 模型”确认默认模型已设置，再重新打开风格初始化。');
      }
    };
    void loadModelConfig();
    return () => {
      cancelled = true;
    };
  }, [open]);

  useEffect(() => {
    if (!submitting) return;
    const timer = window.setInterval(() => {
      setSubmissionStageIndex((prev) => Math.min(COMPLETION_STAGES.length - 1, prev + 1));
    }, 900);
    return () => {
      window.clearInterval(timer);
    };
  }, [submitting]);

  const currentQuestion = REDCLAW_ONBOARDING_MVP_QUESTIONS[currentStepIndex];
  const isLastStep = currentStepIndex >= REDCLAW_ONBOARDING_MVP_QUESTIONS.length - 1;
  const blockProgression = !hasDefaultModelConfigured;
  const updateAnswer = (
    key: keyof RedClawOnboardingAnswers,
    nextValue: number | string,
  ) => {
    setAnswers((prev) => ({ ...prev, [key]: nextValue } as RedClawOnboardingAnswers));
  };

  const currentValue = useMemo(() => {
    return answers[currentQuestion.id];
  }, [answers, currentQuestion.id]);

  const commitProgress = async (nextStepIndex: number) => {
    await onSaveProgress({
      stepIndex: Math.max(0, Math.min(REDCLAW_ONBOARDING_MVP_QUESTIONS.length - 1, nextStepIndex)),
      answers,
    });
  };

  const handlePrevious = async () => {
    if (submitting || currentStepIndex <= 0) return;
    const nextStepIndex = currentStepIndex - 1;
    setCurrentStepIndex(nextStepIndex);
    await commitProgress(nextStepIndex);
  };

  const handleNext = async () => {
    if (submitting || blockProgression) return;
    if (isLastStep) {
      setSubmitting(true);
      setSubmissionStageIndex(0);
      setSubmissionError('');
      try {
        await onComplete(answers);
      } catch (error) {
        console.error('Failed to complete RedClaw onboarding:', error);
        setSubmissionError('风格初始化失败，请重试。');
      } finally {
        setSubmitting(false);
      }
      return;
    }
    const nextStepIndex = currentStepIndex + 1;
    setCurrentStepIndex(nextStepIndex);
    await commitProgress(nextStepIndex);
  };

  const handleClose = async () => {
    if (submitting) return;
    setSubmitting(true);
    try {
      await commitProgress(currentStepIndex);
      onClose();
    } finally {
      setSubmitting(false);
    }
  };

  if (!open) return null;

  return (
    <div className="absolute inset-0 z-40 overflow-hidden bg-[radial-gradient(circle_at_top_left,rgba(245,158,11,0.2),transparent_34%),radial-gradient(circle_at_top_right,rgba(244,114,182,0.12),transparent_26%),linear-gradient(180deg,#f8f2e8_0%,#f3ebdf_54%,#ede2d2_100%)]">
      <div className="absolute inset-0 bg-[linear-gradient(120deg,rgba(255,255,255,0.24),transparent_34%,transparent_72%,rgba(180,83,9,0.05))]" />
      <div className="relative flex h-full min-h-0 flex-col">
        <div className="mx-auto flex w-full max-w-6xl items-center justify-between px-6 pb-4 pt-6 sm:px-8">
          <div className="space-y-1">
            <div className="text-[11px] font-semibold uppercase tracking-[0.24em] text-stone-600/75">
              RedClaw · {activeSpaceName || '当前空间'}
            </div>
            <div className="text-lg font-semibold text-stone-950">定义这个空间的经营方向和写作风格</div>
          </div>
          <button
            type="button"
            onClick={() => void handleClose()}
            disabled={submitting}
            className="inline-flex h-10 w-10 items-center justify-center rounded-full border border-stone-300/85 bg-white/80 text-stone-700 transition hover:bg-white disabled:cursor-not-allowed disabled:opacity-35"
            aria-label="关闭"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="mx-auto w-full max-w-6xl px-6 pb-4 sm:px-8">
          <QuestionProgress currentStepIndex={currentStepIndex} submitting={submitting} />
        </div>

        <div className="mx-auto flex w-full max-w-6xl min-h-0 flex-1 flex-col px-6 pb-6 sm:px-8">
          <div className="flex-1 overflow-y-auto rounded-[32px] border border-stone-300/80 bg-[linear-gradient(180deg,rgba(255,252,247,0.78),rgba(246,238,228,0.72))] px-6 py-6 shadow-[0_36px_100px_rgba(120,88,38,0.12)] backdrop-blur-xl sm:px-8 sm:py-8">
            {submitting ? (
              <CompletionView activeSpaceName={activeSpaceName} stageIndex={submissionStageIndex} />
            ) : (
              <div className="space-y-6">
                {blockProgression ? (
                  <div className="flex items-start gap-3 rounded-2xl border border-amber-300/70 bg-amber-50/90 px-4 py-3 text-sm leading-6 text-amber-900">
                    <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-amber-700" />
                    <div>
                      {modelConfigMessage || '请先在“设置 -> AI 模型”里设置默认模型，再继续风格初始化。'}
                    </div>
                  </div>
                ) : null}
                {currentQuestion.type === 'slider' ? (
                  <SliderQuestionView
                    question={currentQuestion}
                    value={Number(currentValue)}
                    onChange={(next) => updateAnswer(currentQuestion.id, next)}
                  />
                ) : currentQuestion.type === 'choice' ? (
                  <ChoiceQuestionView
                    question={currentQuestion}
                    value={String(currentValue)}
                    onChange={(next) => updateAnswer(currentQuestion.id, next)}
                  />
                ) : (
                  <AbQuestionView
                    question={currentQuestion}
                    value={String(currentValue)}
                    onChange={(next) => updateAnswer(currentQuestion.id, next)}
                  />
                )}
              </div>
            )}
          </div>

          {submissionError ? (
            <div className="mt-4 rounded-2xl border border-rose-400/24 bg-rose-500/10 px-4 py-3 text-sm text-rose-100">
              {submissionError}
            </div>
          ) : null}

          {!submitting ? (
            <div className="mt-5 flex items-center justify-between gap-4">
              <button
                type="button"
                onClick={() => void handlePrevious()}
                disabled={submitting || currentStepIndex <= 0}
                className="inline-flex items-center gap-2 rounded-full border border-stone-300/85 bg-white/78 px-4 py-2.5 text-sm font-medium text-stone-700 transition hover:bg-white disabled:cursor-not-allowed disabled:opacity-35"
              >
                <ArrowLeft className="h-4 w-4" />
                上一题
              </button>
              <button
                type="button"
                onClick={() => void handleNext()}
                disabled={submitting || blockProgression}
                className="inline-flex items-center gap-2 rounded-full bg-stone-950 px-5 py-2.5 text-sm font-semibold text-amber-50 transition hover:scale-[0.99] hover:bg-stone-900 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {isLastStep ? '完成并应用' : '下一题'}
                <ArrowRight className="h-4 w-4" />
              </button>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
