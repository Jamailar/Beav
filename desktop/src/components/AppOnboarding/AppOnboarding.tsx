import { useEffect, useMemo, useRef, useState } from 'react';
import {
  type LucideIcon,
  Bot,
  BrainCircuit,
  ChevronLeft,
  Check,
  Database,
  Download,
  FileText,
  FolderOpen,
  Image,
  MessageSquareText,
  PenTool,
  Play,
  Rocket,
  Sparkles,
  Zap,
} from 'lucide-react';
import { APP_BRAND } from '../../config/brand';
import { setAppAcquisitionSource, STEPS, markAppOnboardingSeen } from './constants';

interface AppOnboardingProps {
  open: boolean;
  onClose: () => void;
}

interface VisualCard {
  icon: LucideIcon;
  title: string;
  desc: string;
  meta?: string;
  chips?: Array<{ icon: LucideIcon; color: string }>;
  tone: string;
}

interface OnboardingStepContent {
  eyebrow: string;
  title: string;
  desc: string;
  acquisitionSurvey?: boolean;
  cards?: VisualCard[];
  image?: {
    src: string;
    alt: string;
  };
  video?: {
    src: string;
    title: string;
    desc: string;
  };
}

const ACQUISITION_SOURCES = [
  { value: 'xiaohongshu', label: '小红书' },
  { value: 'bilibili', label: 'B站' },
  { value: 'wechat_article', label: '公众号/文章' },
  { value: 'search', label: '搜索引擎' },
  { value: 'github', label: 'GitHub' },
  { value: 'friend_referral', label: '朋友推荐' },
  { value: 'ai_recommendation', label: 'AI 工具推荐' },
  { value: 'other', label: '其他' },
];

const STEP_CONTENT: OnboardingStepContent[] = [
  {
    eyebrow: '一个小问题',
    title: `你是从哪里知道 ${APP_BRAND.displayName} 的？`,
    desc: '选择一个最接近的来源，帮助我们判断应该把产品打磨和发布重点放在哪里。',
    acquisitionSurvey: true,
  },
  {
    eyebrow: '本地创作工作台',
    title: `${APP_BRAND.displayName} 帮你把灵感变成内容资产。`,
    desc: '导入笔记、视频和资料，沉淀成可复用知识，再用 AI 串起文案、图片、封面和视频制作。',
    cards: [
      {
        icon: Database,
        title: '收拢素材与知识',
        desc: '把笔记、视频、文档和灵感统一放进本地知识库。',
        meta: '本地优先',
        chips: [
          { icon: FolderOpen, color: 'bg-sky-100 text-sky-600' },
          { icon: Database, color: 'bg-emerald-100 text-emerald-600' },
        ],
        tone: 'bg-sky-100 text-sky-600',
      },
      {
        icon: BrainCircuit,
        title: '理解创作目标',
        desc: '基于你的素材和任务要求，整理选题、角度与执行步骤。',
        chips: [
          { icon: MessageSquareText, color: 'bg-rose-100 text-rose-600' },
          { icon: BrainCircuit, color: 'bg-violet-100 text-violet-600' },
          { icon: PenTool, color: 'bg-amber-100 text-amber-600' },
        ],
        tone: 'bg-violet-100 text-violet-600',
      },
      {
        icon: Sparkles,
        title: '生成可发布内容',
        desc: '文案、套图、封面和短视频工程可以在同一个工作流里推进。',
        chips: [
          { icon: PenTool, color: 'bg-orange-100 text-orange-600' },
          { icon: Image, color: 'bg-cyan-100 text-cyan-600' },
          { icon: Sparkles, color: 'bg-pink-100 text-pink-600' },
        ],
        tone: 'bg-orange-100 text-orange-600',
      },
    ],
  },
  {
    eyebrow: '文件拖动快捷键',
    title: '拖入文件时，按住快捷键切换处理方式。',
    desc: '视频里展示了完整手势；拖动过程中按住快捷键，直接选择文件要交给哪个入口处理。',
    video: {
      src: '/onboarding/file-drag-shortcuts-demo.mp4',
      title: '文件拖动快捷键',
      desc: '拖动文件时按住快捷键，快速切换文件处理入口。',
    },
  },
  {
    eyebrow: '小红书评论洞察',
    title: '下载评论区，把真实需求变成选题。',
    desc: '在小红书页面采集评论，保存到知识库，再让 AI 从追问、反驳和高频痛点里生成内容方向。',
    cards: [
      {
        icon: Download,
        title: '采集评论',
        desc: '在小红书笔记页抓取评论快照，保留原始语境。',
        meta: '浏览器插件',
        tone: 'bg-rose-100 text-rose-600',
      },
      {
        icon: FileText,
        title: '保存数据',
        desc: '笔记和评论分开入库，后续可检索、复用和导出。',
        chips: [
          { icon: Database, color: 'bg-emerald-100 text-emerald-600' },
          { icon: FileText, color: 'bg-sky-100 text-sky-600' },
        ],
        tone: 'bg-sky-100 text-sky-600',
      },
      {
        icon: Sparkles,
        title: '生成洞察',
        desc: '从追问、反驳和高频痛点里提炼内容切口。',
        chips: [
          { icon: MessageSquareText, color: 'bg-violet-100 text-violet-600' },
          { icon: Sparkles, color: 'bg-amber-100 text-amber-600' },
        ],
        tone: 'bg-violet-100 text-violet-600',
      },
    ],
  },
  {
    eyebrow: '准备就绪',
    title: `现在可以开始使用 ${APP_BRAND.displayName}。`,
    desc: '导入第一条知识，或者直接打开对话，把你的创作任务交给 AI 工作台推进。',
    cards: [
      {
        icon: Rocket,
        title: '导入第一份素材',
        desc: '从资料、链接或视频开始，快速建立第一个创作上下文。',
        meta: '知识库',
        tone: 'bg-orange-100 text-orange-600',
      },
      {
        icon: Bot,
        title: '发起一次 AI 对话',
        desc: '告诉 AI 你要做什么，获取可执行的下一步。',
        chips: [
          { icon: MessageSquareText, color: 'bg-sky-100 text-sky-600' },
          { icon: Bot, color: 'bg-violet-100 text-violet-600' },
        ],
        tone: 'bg-violet-100 text-violet-600',
      },
      {
        icon: Zap,
        title: '保存成工作流',
        desc: '常用任务可以沉淀为自动化，让后台持续处理。',
        chips: [
          { icon: Zap, color: 'bg-yellow-100 text-yellow-600' },
          { icon: Check, color: 'bg-emerald-100 text-emerald-600' },
        ],
        tone: 'bg-yellow-100 text-yellow-600',
      },
    ],
  },
];

function StepDot({ index, current }: { index: number; current: number }) {
  const active = index === current;
  const done = index < current;

  return (
    <div
      className={`h-2.5 w-2.5 rounded-full transition-colors ${
        active ? 'bg-zinc-950' : done ? 'bg-zinc-300' : 'bg-zinc-200'
      }`}
    />
  );
}

function VisualCard({ card }: { card: VisualCard }) {
  const Icon = card.icon;

  return (
    <div className="flex min-h-[clamp(150px,20vh,248px)] w-full items-start gap-[clamp(18px,2vw,34px)] rounded-[22px] bg-white px-[clamp(26px,3vw,58px)] py-[clamp(24px,3.2vh,42px)] shadow-[0_18px_55px_rgba(120,75,45,0.08)]">
      <div className={`mt-1 flex h-11 w-11 shrink-0 items-center justify-center rounded-full ${card.tone}`}>
        <Icon className="h-5 w-5" strokeWidth={1.9} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-[clamp(24px,1.85vw,36px)] font-semibold leading-tight text-zinc-950">{card.title}</div>
        <div className="mt-2 max-w-[760px] text-[clamp(18px,1.45vw,28px)] leading-[1.45] text-zinc-500">{card.desc}</div>
        {card.meta ? (
          <div className="mt-4 inline-flex items-center gap-2 text-sm text-zinc-400">
            <span className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-zinc-100 text-zinc-400">
              <MessageSquareText className="h-3.5 w-3.5" strokeWidth={1.8} />
            </span>
            {card.meta}
          </div>
        ) : null}
        {card.chips && card.chips.length > 0 ? (
          <div className="mt-5 flex items-center">
            {card.chips.map((chip, index) => {
              const ChipIcon = chip.icon;
              return (
                <div
                  key={index}
                  className={`flex h-7 w-7 items-center justify-center rounded-full border-2 border-white ${chip.color} ${
                    index > 0 ? '-ml-1.5' : ''
                  }`}
                >
                  <ChipIcon className="h-3.5 w-3.5" strokeWidth={2} />
                </div>
              );
            })}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function VideoShortcutPreview({ video }: { video: { src: string; title: string; desc: string } }) {
  return (
    <div className="relative z-10 flex w-full flex-1 flex-col items-center justify-center px-[6vw] pb-[4vh] pt-[2vh]">
      <div className="flex w-full max-w-[980px] justify-center overflow-hidden rounded-[28px] bg-zinc-950 shadow-[0_30px_90px_rgba(120,75,45,0.2)]">
        <video
          src={video.src}
          className="block h-auto max-h-[54vh] w-full bg-zinc-950 object-contain"
          controls
          autoPlay
          muted
          loop
          playsInline
          aria-label={video.title}
        />
      </div>
      <div className="mt-[3vh] max-w-[860px] text-center">
        <div className="text-[clamp(28px,2.6vw,48px)] font-semibold leading-tight text-zinc-950">{video.title}</div>
        <p className="mt-3 text-[clamp(18px,1.45vw,26px)] font-medium leading-[1.5] text-zinc-500">{video.desc}</p>
      </div>
    </div>
  );
}

function CharacterAssetPreview({ image }: { image: { src: string; alt: string } }) {
  return (
    <div className="relative z-10 flex w-full justify-center">
      <div className="w-full overflow-hidden rounded-[32px] bg-white shadow-[0_24px_70px_rgba(120,75,45,0.16)]">
        <img
          src={image.src}
          alt={image.alt}
          className="block h-auto w-full object-contain"
          draggable={false}
        />
      </div>
    </div>
  );
}

function onboardingStepKind(content: OnboardingStepContent) {
  if (content.acquisitionSurvey) return 'acquisition_survey';
  if (content.video) return 'video';
  if (content.image) return 'image';
  if (content.cards) return 'cards';
  return 'content';
}

function AcquisitionSurvey({
  selected,
  onSelect,
  invalid,
}: {
  selected: string;
  onSelect: (source: string) => void;
  invalid: boolean;
}) {
  return (
    <div className="w-full max-w-[980px]">
      <div className={`app-onboarding-acquisition-options grid grid-cols-4 gap-3 ${invalid ? 'app-onboarding-acquisition-options-invalid' : ''}`}>
        {ACQUISITION_SOURCES.map((source) => {
          const active = selected === source.value;
          return (
            <button
              key={source.value}
              type="button"
              onClick={() => onSelect(source.value)}
              className={`flex h-[clamp(66px,7vh,86px)] items-center justify-between rounded-2xl border px-5 text-left text-[clamp(16px,1.12vw,22px)] font-semibold shadow-[0_14px_40px_rgba(120,75,45,0.05)] transition-all active:scale-[0.99] ${
                active
                  ? 'border-accent-primary bg-white text-accent-primary shadow-[0_18px_45px_rgba(167,116,73,0.14)]'
                  : 'border-zinc-200/80 bg-white/80 text-zinc-700 hover:border-accent-primary/35 hover:bg-white hover:shadow-[0_18px_45px_rgba(120,75,45,0.1)]'
              }`}
            >
              <span>{source.label}</span>
              {active ? <Check className="h-4 w-4" strokeWidth={2.2} /> : null}
            </button>
          );
        })}
      </div>
    </div>
  );
}

export function AppOnboarding({ open, onClose }: AppOnboardingProps) {
  const [step, setStep] = useState(0);
  const [acquisitionSource, setAcquisitionSource] = useState('');
  const [acquisitionInvalid, setAcquisitionInvalid] = useState(false);
  const acquisitionShownRef = useRef(false);
  const acquisitionInvalidTimerRef = useRef<number | null>(null);
  const acquisitionInvalidFrameRef = useRef<number | null>(null);
  const onboardingStartedAtRef = useRef<number>(0);
  const stepStartedAtRef = useRef<number>(0);
  const trackedStepRef = useRef<number | null>(null);
  const content = useMemo(() => STEP_CONTENT[step] ?? STEP_CONTENT[0], [step]);

  useEffect(() => {
    if (open) {
      setStep(0);
      setAcquisitionSource('');
      setAcquisitionInvalid(false);
      acquisitionShownRef.current = false;
      onboardingStartedAtRef.current = Date.now();
      stepStartedAtRef.current = Date.now();
      trackedStepRef.current = null;
    }
  }, [open]);

  useEffect(() => {
    if (!open || trackedStepRef.current === step) return;
    trackedStepRef.current = step;
    stepStartedAtRef.current = Date.now();
    void window.ipcRenderer.analytics.track('onboarding_step_viewed', {
      surface: 'app-onboarding',
      origin: 'renderer',
      properties: {
        stepIndex: step,
        step: STEPS[step] || `step_${step + 1}`,
        stepKind: onboardingStepKind(content),
      },
    });
  }, [content, open, step]);

  useEffect(() => {
    if (!open || !content.acquisitionSurvey || acquisitionShownRef.current) return;
    acquisitionShownRef.current = true;
    void window.ipcRenderer.analytics.track('acquisition_survey_shown', {
      surface: 'app-onboarding',
      origin: 'renderer',
    });
  }, [content.acquisitionSurvey, open]);

  useEffect(() => {
    return () => {
      if (acquisitionInvalidTimerRef.current !== null) {
        window.clearTimeout(acquisitionInvalidTimerRef.current);
      }
      if (acquisitionInvalidFrameRef.current !== null) {
        window.cancelAnimationFrame(acquisitionInvalidFrameRef.current);
      }
    };
  }, []);

  if (!open) return null;

  const isLast = step === STEPS.length - 1;
  const isVideoStep = Boolean(content.video);
  const isAcquisitionStep = Boolean(content.acquisitionSurvey);

  const handleClose = () => {
    markAppOnboardingSeen();
    onClose();
  };

  const trackStepCompleted = (action: 'next' | 'skip' | 'finish') => {
    const now = Date.now();
    const durationMs = stepStartedAtRef.current > 0 ? now - stepStartedAtRef.current : 0;
    void window.ipcRenderer.analytics.track('onboarding_step_completed', {
      surface: 'app-onboarding',
      origin: 'renderer',
      properties: {
        stepIndex: step,
        step: STEPS[step] || `step_${step + 1}`,
        stepKind: onboardingStepKind(content),
        action,
        durationMs,
      },
    });
    if (action === 'finish') {
      const totalDurationMs =
        onboardingStartedAtRef.current > 0 ? now - onboardingStartedAtRef.current : durationMs;
      void window.ipcRenderer.analytics.track('onboarding_completed', {
        surface: 'app-onboarding',
        origin: 'renderer',
        properties: {
          totalSteps: STEPS.length,
          totalDurationMs,
        },
      });
    }
  };

  const triggerAcquisitionRequiredPrompt = () => {
    if (acquisitionInvalidTimerRef.current !== null) {
      window.clearTimeout(acquisitionInvalidTimerRef.current);
    }
    if (acquisitionInvalidFrameRef.current !== null) {
      window.cancelAnimationFrame(acquisitionInvalidFrameRef.current);
    }
    setAcquisitionInvalid(false);
    acquisitionInvalidFrameRef.current = window.requestAnimationFrame(() => {
      setAcquisitionInvalid(true);
      acquisitionInvalidTimerRef.current = window.setTimeout(() => {
        setAcquisitionInvalid(false);
      }, 620);
    });
  };

  const handleNext = (options?: { suppressAcquisitionSkip?: boolean }) => {
    if (isAcquisitionStep && !acquisitionSource && !options?.suppressAcquisitionSkip) {
      triggerAcquisitionRequiredPrompt();
      return;
    }
    trackStepCompleted(isLast ? 'finish' : options?.suppressAcquisitionSkip ? 'skip' : 'next');
    if (isLast) {
      handleClose();
      return;
    }
    setStep((value) => Math.min(value + 1, STEPS.length - 1));
  };

  const handlePrevious = () => {
    setStep((value) => Math.max(value - 1, 0));
  };

  const handleAcquisitionSelect = (source: string) => {
    setAcquisitionInvalid(false);
    setAcquisitionSource(source);
    setAppAcquisitionSource(source);
    void window.ipcRenderer.analytics.track('acquisition_survey_answered', {
      surface: 'app-onboarding',
      origin: 'renderer',
      properties: {
        source,
      },
    });
  };

  const handleAcquisitionSkip = () => {
    void window.ipcRenderer.analytics.track('acquisition_survey_skipped', {
      surface: 'app-onboarding',
      origin: 'renderer',
      properties: {
        action: 'skip_button',
      },
    });
    handleNext({ suppressAcquisitionSkip: true });
  };

  return (
    <div
      className={`app-onboarding fixed inset-0 z-[10030] h-screen w-screen overflow-hidden bg-white text-zinc-950 ${
        isVideoStep || isAcquisitionStep ? 'flex flex-col' : 'grid'
      }`}
      style={isVideoStep || isAcquisitionStep ? undefined : { display: 'grid', gridTemplateColumns: '49.6% 50.4%' }}
      role="dialog"
      aria-modal="true"
      aria-label={`${APP_BRAND.displayName} Onboarding`}
    >
      {isAcquisitionStep ? (
        <section className="relative flex h-screen min-w-0 flex-col overflow-hidden bg-white px-[5vw] py-[7vh]">
          <div className="relative z-10 flex flex-1 flex-col items-center justify-center text-center">
            <div className="text-[clamp(18px,1.25vw,26px)] font-semibold text-accent-primary">{content.eyebrow}</div>
            <h1 className="mt-5 max-w-[940px] text-[clamp(46px,5vw,88px)] font-bold leading-[1.08] tracking-normal text-zinc-950">
              {content.title}
            </h1>
            <p className="mt-6 max-w-[760px] text-[clamp(18px,1.45vw,28px)] font-medium leading-[1.55] tracking-normal text-zinc-500">
              {content.desc}
            </p>
            <div className="mt-[7vh] flex w-full justify-center">
              <AcquisitionSurvey
                selected={acquisitionSource}
                onSelect={handleAcquisitionSelect}
                invalid={acquisitionInvalid}
              />
            </div>
          </div>
          <div className="relative z-10 flex items-center justify-between gap-6">
            <div className="flex items-center gap-5">
              {step > 0 ? (
                <button
                  type="button"
                  onClick={handlePrevious}
                  className="inline-flex h-10 items-center gap-1.5 rounded-lg px-2 text-sm font-medium text-zinc-500 transition-colors hover:bg-white/60 hover:text-zinc-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-primary/40"
                >
                  <ChevronLeft className="h-4 w-4" strokeWidth={1.8} />
                  上一步
                </button>
              ) : null}
              <div className="flex items-center gap-3" aria-label={`第 ${step + 1} 步，共 ${STEPS.length} 步`}>
                {STEPS.map((_, index) => (
                  <StepDot key={index} index={index} current={step} />
                ))}
              </div>
            </div>
            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={handleAcquisitionSkip}
                className="inline-flex h-[clamp(48px,5vh,58px)] items-center justify-center rounded-xl px-5 text-[clamp(16px,1.05vw,20px)] font-semibold text-zinc-400 transition-colors hover:bg-white/60 hover:text-zinc-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-primary/40"
              >
                跳过
              </button>
              <button
                type="button"
                onClick={() => handleNext()}
                className="inline-flex h-[clamp(58px,6vh,76px)] min-w-[clamp(124px,8vw,160px)] items-center justify-center rounded-xl bg-white/75 px-7 text-[clamp(20px,1.5vw,30px)] font-semibold text-zinc-600 transition-colors hover:bg-white hover:text-zinc-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-primary/40"
              >
                Next
              </button>
            </div>
          </div>
        </section>
      ) : isVideoStep && content.video ? (
        <section className="relative flex h-screen min-w-0 flex-col overflow-hidden bg-[#ffe7d8] px-[4vw] py-[6vh]">
          <div
            className="absolute inset-0 opacity-70"
            aria-hidden="true"
            style={{
              backgroundImage:
                'linear-gradient(0deg, rgba(255,145,83,0.14) 1px, transparent 1px), linear-gradient(90deg, rgba(255,145,83,0.12) 1px, transparent 1px)',
              backgroundSize: '100% 190px, 320px 100%',
            }}
          />
          <div
            className="absolute left-1/2 top-1/2 h-[980px] w-[980px] -translate-x-1/2 -translate-y-1/2 rounded-full border border-[#ffb88d]/25"
            aria-hidden="true"
          />
          <VideoShortcutPreview video={content.video} />
          <div className="relative z-10 flex items-center justify-between gap-6">
            <div className="flex items-center gap-5">
              {step > 0 ? (
                <button
                  type="button"
                  onClick={handlePrevious}
                  className="inline-flex h-10 items-center gap-1.5 rounded-lg px-2 text-sm font-medium text-zinc-500 transition-colors hover:bg-white/60 hover:text-zinc-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-primary/40"
                >
                  <ChevronLeft className="h-4 w-4" strokeWidth={1.8} />
                  上一步
                </button>
              ) : null}
              <div className="flex items-center gap-3" aria-label={`第 ${step + 1} 步，共 ${STEPS.length} 步`}>
                {STEPS.map((_, index) => (
                  <StepDot key={index} index={index} current={step} />
                ))}
              </div>
            </div>
            <button
              type="button"
              onClick={() => handleNext()}
              className="inline-flex h-[clamp(58px,6vh,76px)] min-w-[clamp(124px,8vw,160px)] items-center justify-center rounded-xl bg-white/70 px-7 text-[clamp(20px,1.5vw,30px)] font-semibold text-zinc-500 transition-colors hover:bg-white hover:text-zinc-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-primary/40"
            >
              {isLast ? '开始' : 'Next'}
            </button>
          </div>
        </section>
      ) : (
        <>
          <section className="relative flex h-screen min-w-0 flex-col px-[4vw] pb-[9vh] pt-[12vh]">
            <div className="flex flex-1 items-center">
              <div className="max-w-[760px]">
                <div className="text-[clamp(18px,1.55vw,30px)] font-medium leading-none text-accent-primary">{content.eyebrow}</div>
                <h1 className="mt-[4vh] text-[clamp(42px,4.1vw,82px)] font-bold leading-[1.12] tracking-normal text-zinc-950">
                  {content.title}
                </h1>
                <p className="mt-[4vh] max-w-[720px] text-[clamp(22px,1.75vw,36px)] font-medium leading-[1.55] tracking-normal text-zinc-500">
                  {content.desc}
                </p>
              </div>
            </div>

            <div className="flex items-center justify-between gap-6">
              <div className="flex items-center gap-5">
                {step > 0 ? (
                  <button
                    type="button"
                    onClick={handlePrevious}
                    className="inline-flex h-10 items-center gap-1.5 rounded-lg px-2 text-sm font-medium text-zinc-500 transition-colors hover:bg-zinc-100 hover:text-zinc-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-primary/40"
                  >
                    <ChevronLeft className="h-4 w-4" strokeWidth={1.8} />
                    上一步
                  </button>
                ) : null}
                <div className="flex items-center gap-3" aria-label={`第 ${step + 1} 步，共 ${STEPS.length} 步`}>
                  {STEPS.map((_, index) => (
                    <StepDot key={index} index={index} current={step} />
                  ))}
                </div>
              </div>
              <button
                type="button"
                onClick={() => handleNext()}
                className="inline-flex h-[clamp(58px,6vh,76px)] min-w-[clamp(124px,8vw,160px)] items-center justify-center rounded-xl bg-zinc-100 px-7 text-[clamp(20px,1.5vw,30px)] font-semibold text-zinc-500 transition-colors hover:bg-zinc-200 hover:text-zinc-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-primary/40"
              >
                {isLast ? '开始' : 'Next'}
              </button>
            </div>
          </section>

          <section className="relative flex h-screen min-w-0 items-center overflow-hidden bg-[#ffe7d8] px-[3.2vw] py-[8vh]">
            <div
              className="absolute inset-0 opacity-70"
              aria-hidden="true"
              style={{
                backgroundImage:
                  'linear-gradient(0deg, rgba(255,145,83,0.14) 1px, transparent 1px), linear-gradient(90deg, rgba(255,145,83,0.12) 1px, transparent 1px)',
                backgroundSize: '100% 190px, 320px 100%',
              }}
            />
            <div
              className="absolute -left-28 top-1/2 h-[680px] w-[680px] -translate-y-1/2 rounded-full border border-[#ffb88d]/35"
              aria-hidden="true"
            />
            <div
              className="absolute left-1/4 top-1/2 h-[980px] w-[980px] -translate-y-1/2 rounded-full border border-[#ffb88d]/25"
              aria-hidden="true"
            />
            {content.image ? (
              <CharacterAssetPreview image={content.image} />
            ) : (
              <div className="relative z-10 flex w-full flex-col gap-[4vh]">
                {(content.cards || []).map((card) => (
                  <VisualCard key={card.title} card={card} />
                ))}
              </div>
            )}
          </section>
        </>
      )}
    </div>
  );
}
