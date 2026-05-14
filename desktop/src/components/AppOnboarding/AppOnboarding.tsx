import { useEffect, useMemo, useState } from 'react';
import {
  type LucideIcon,
  Bot,
  BrainCircuit,
  ChevronLeft,
  Check,
  Cpu,
  Database,
  FolderOpen,
  Image,
  MessageSquareText,
  Palette,
  PenTool,
  Play,
  Rocket,
  Sparkles,
  Users,
  Zap,
} from 'lucide-react';
import { APP_BRAND } from '../../config/brand';
import characterDigitalAvatarCard from '../../assets/onboarding/character-digital-avatar-card.png';
import { STEPS, markAppOnboardingSeen } from './constants';

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
  cards?: VisualCard[];
  image?: {
    src: string;
    alt: string;
  };
}

const STEP_CONTENT: OnboardingStepContent[] = [
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
    eyebrow: '重点能力',
    title: '从分析到发布，核心环节都能接住。',
    desc: '视频分析、套图制作、角色一致性与自动化任务会按你的工作节奏组合起来。',
    cards: [
      {
        icon: Play,
        title: '视频分析',
        desc: '转写、拆解结构、提取要点，再转成小红书笔记方向。',
        meta: '转写 + 摘要',
        tone: 'bg-red-100 text-red-600',
      },
      {
        icon: Palette,
        title: '套图与封面',
        desc: '围绕同一主题批量生成统一风格的图文内容。',
        chips: [
          { icon: Image, color: 'bg-cyan-100 text-cyan-600' },
          { icon: Palette, color: 'bg-fuchsia-100 text-fuchsia-600' },
        ],
        tone: 'bg-fuchsia-100 text-fuchsia-600',
      },
      {
        icon: Users,
        title: '角色创建与使用',
        desc: '维护角色外貌、人设和声音，让多次生成保持同一表达。',
        chips: [
          { icon: Users, color: 'bg-emerald-100 text-emerald-600' },
          { icon: MessageSquareText, color: 'bg-sky-100 text-sky-600' },
          { icon: Sparkles, color: 'bg-amber-100 text-amber-600' },
        ],
        tone: 'bg-emerald-100 text-emerald-600',
      },
    ],
  },
  {
    eyebrow: '角色数字分身',
    title: '创建人物资产，直接创作视频。',
    desc: '把人物形象、声音、人设和内容风格沉淀成可复用资产，后续生成视频时直接调用同一个角色。',
    image: {
      src: characterDigitalAvatarCard,
      alt: '角色数字分身卡片示例',
    },
  },
  {
    eyebrow: '开始前的准备',
    title: '连好模型和工作目录，就可以正式开工。',
    desc: '只需要确认 AI 服务商和本地存储位置，后续素材、稿件和生成结果都会有明确归处。',
    cards: [
      {
        icon: Cpu,
        title: '配置 AI 模型',
        desc: '添加 API 端点和服务商 Key，选择你偏好的模型。',
        meta: '设置 / AI 模型',
        tone: 'bg-indigo-100 text-indigo-600',
      },
      {
        icon: FolderOpen,
        title: '设置工作目录',
        desc: '选择本地文件夹存放知识库、生成素材和稿件。',
        meta: '设置 / 通用',
        tone: 'bg-amber-100 text-amber-600',
      },
      {
        icon: Check,
        title: '保留本地掌控',
        desc: '工作数据留在本机，刷新或重启后继续接着做。',
        chips: [
          { icon: Database, color: 'bg-emerald-100 text-emerald-600' },
          { icon: Check, color: 'bg-sky-100 text-sky-600' },
        ],
        tone: 'bg-emerald-100 text-emerald-600',
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

export function AppOnboarding({ open, onClose }: AppOnboardingProps) {
  const [step, setStep] = useState(0);
  const content = useMemo(() => STEP_CONTENT[step] ?? STEP_CONTENT[0], [step]);

  useEffect(() => {
    if (open) {
      setStep(0);
    }
  }, [open]);

  if (!open) return null;

  const isLast = step === STEPS.length - 1;

  const handleClose = () => {
    markAppOnboardingSeen();
    onClose();
  };

  const handleNext = () => {
    if (isLast) {
      handleClose();
      return;
    }
    setStep((value) => Math.min(value + 1, STEPS.length - 1));
  };

  const handlePrevious = () => {
    setStep((value) => Math.max(value - 1, 0));
  };

  return (
    <div
      className="fixed inset-0 z-[10030] grid h-screen w-screen overflow-hidden bg-white text-zinc-950"
      style={{ display: 'grid', gridTemplateColumns: '49.6% 50.4%' }}
      role="dialog"
      aria-modal="true"
      aria-label={`${APP_BRAND.displayName} Onboarding`}
    >
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
            onClick={handleNext}
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
    </div>
  );
}
