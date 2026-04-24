import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Bot, Dices, FileEdit, FolderOpen, Sparkles, Wand2 } from 'lucide-react';
import tippy, { type Instance, type Placement } from 'tippy.js';
import type { ViewType } from '../App';

const TOUR_DONE_KEY = 'redbox:first-run-tour:v2';

interface TourStep {
  id: string;
  selector: string;
  title: string;
  description: string;
  placement: Placement;
  view?: ViewType;
}

interface FirstRunTourProps {
  currentView: ViewType;
  onNavigate: (view: ViewType) => void;
}

interface IntroFeature {
  id: string;
  title: string;
  description: string;
  icon: typeof FolderOpen;
}

const INTRO_FEATURES: IntroFeature[] = [
  {
    id: 'capture',
    title: '采集入口',
    description: '插件、链接和素材先进入知识库，后续所有创作都从这里起步。',
    icon: FolderOpen,
  },
  {
    id: 'wander',
    title: '灵感发散',
    description: '漫步把已有素材重新碰撞，快速长出新选题和表达角度。',
    icon: Dices,
  },
  {
    id: 'drafts',
    title: '稿件主线',
    description: '图文、视频和音频稿都回到稿件工作台统一组织与绑定。',
    icon: FileEdit,
  },
  {
    id: 'generate',
    title: '画面生成',
    description: '创作页负责生图、生视频和参考图驱动，不再只是补充能力。',
    icon: Sparkles,
  },
];

export function FirstRunTour({ currentView, onNavigate }: FirstRunTourProps) {
  const [introVisible, setIntroVisible] = useState(false);
  const [active, setActive] = useState(false);
  const [stepIndex, setStepIndex] = useState(0);
  const [initialized, setInitialized] = useState(false);
  const instanceRef = useRef<Instance | null>(null);
  const highlightedElementRef = useRef<HTMLElement | null>(null);

  const steps = useMemo<TourStep[]>(() => ([
    {
      id: 'knowledge',
      selector: '[data-guide-id="nav-knowledge"]',
      title: '1/5 先把素材收进知识库',
      description: '插件采集、链接入库和外部内容导入都先落在这里，后续的漫步、写稿和自动化都会复用这些内容。',
      placement: 'right',
      view: 'knowledge',
    },
    {
      id: 'wander',
      selector: '[data-guide-id="nav-wander"]',
      title: '2/5 漫步负责把内容撞出新选题',
      description: '当知识库里已经有素材时，优先来漫步做灵感碰撞，再把结果继续送到稿件或任务执行链路。',
      placement: 'right',
      view: 'wander',
    },
    {
      id: 'manuscripts',
      selector: '[data-guide-id="nav-manuscripts"]',
      title: '3/5 稿件是现在的主工作台',
      description: '图文稿、视频稿、音频稿和素材绑定都在稿件页完成，启动后默认进入这里是为了更快回到正在生产的内容。',
      placement: 'right',
      view: 'manuscripts',
    },
    {
      id: 'generation-studio',
      selector: '[data-guide-id="nav-generation-studio"]',
      title: '4/5 创作页负责画面与视频生成',
      description: '需要生图、生视频、参考图视频或首尾帧视频时，直接进入创作页处理，再把产物回流到稿件或媒体库。',
      placement: 'right',
      view: 'generation-studio',
    },
    {
      id: 'redclaw',
      selector: '[data-guide-id="nav-redclaw"]',
      title: '5/5 RedClaw 接管持续执行',
      description: '当任务已经明确，需要自动创作、工具串联或持续值守时，再把工作交给 RedClaw 来跑完整执行链。',
      placement: 'right',
      view: 'redclaw',
    },
  ]), []);

  useEffect(() => {
    let done = false;
    try {
      done = window.localStorage.getItem(TOUR_DONE_KEY) === '1';
    } catch {
      done = false;
    }

    if (!done) {
      setIntroVisible(true);
      setStepIndex(0);
    }
    setInitialized(true);
  }, []);

  const markDone = useCallback(() => {
    try {
      window.localStorage.setItem(TOUR_DONE_KEY, '1');
    } catch {
      // Ignore storage failures so onboarding never blocks the app.
    }
  }, []);

  const finishTour = useCallback(() => {
    markDone();
    setIntroVisible(false);
    setActive(false);
  }, [markDone]);

  const startTour = useCallback(() => {
    setIntroVisible(false);
    setActive(true);
    setStepIndex(0);
  }, []);

  useEffect(() => {
    if (!initialized) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        finishTour();
      }
    };

    if (introVisible || active) {
      window.addEventListener('keydown', handleKeyDown);
      return () => {
        window.removeEventListener('keydown', handleKeyDown);
      };
    }

    return;
  }, [active, finishTour, initialized, introVisible]);

  useEffect(() => {
    if (!initialized || !active) {
      instanceRef.current?.destroy();
      instanceRef.current = null;
      highlightedElementRef.current?.removeAttribute('data-redbox-tour-target');
      highlightedElementRef.current = null;
      return;
    }

    let cancelled = false;
    let timer: number | null = null;
    const step = steps[stepIndex];

    if (step.view && currentView !== step.view) {
      onNavigate(step.view);
    }

    const renderContent = () => {
      const root = document.createElement('div');
      root.className = 'redbox-tour-content';

      const eyebrow = document.createElement('div');
      eyebrow.className = 'redbox-tour-kicker';
      eyebrow.textContent = '推荐工作流';

      const title = document.createElement('div');
      title.className = 'redbox-tour-title';
      title.textContent = step.title;

      const desc = document.createElement('div');
      desc.className = 'redbox-tour-desc';
      desc.textContent = step.description;

      const dots = document.createElement('div');
      dots.className = 'redbox-tour-dots';
      steps.forEach((_item, index) => {
        const dot = document.createElement('span');
        dot.className = index === stepIndex ? 'redbox-tour-dot redbox-tour-dot--active' : 'redbox-tour-dot';
        dots.appendChild(dot);
      });

      const actions = document.createElement('div');
      actions.className = 'redbox-tour-actions';

      const skipButton = document.createElement('button');
      skipButton.className = 'redbox-tour-btn redbox-tour-btn-ghost';
      skipButton.textContent = '跳过';
      skipButton.onclick = () => finishTour();

      const nextGroup = document.createElement('div');
      nextGroup.className = 'redbox-tour-actions-group';

      if (stepIndex > 0) {
        const prevButton = document.createElement('button');
        prevButton.className = 'redbox-tour-btn redbox-tour-btn-secondary';
        prevButton.textContent = '上一步';
        prevButton.onclick = () => {
          setStepIndex((value) => Math.max(value - 1, 0));
        };
        nextGroup.appendChild(prevButton);
      }

      const nextButton = document.createElement('button');
      nextButton.className = 'redbox-tour-btn redbox-tour-btn-primary';
      nextButton.textContent = stepIndex >= steps.length - 1 ? '完成' : '下一步';
      nextButton.onclick = () => {
        if (stepIndex >= steps.length - 1) {
          finishTour();
          return;
        }
        setStepIndex((value) => Math.min(value + 1, steps.length - 1));
      };
      nextGroup.appendChild(nextButton);

      actions.appendChild(skipButton);
      actions.appendChild(nextGroup);
      root.appendChild(eyebrow);
      root.appendChild(title);
      root.appendChild(desc);
      root.appendChild(dots);
      root.appendChild(actions);

      return root;
    };

    const showStep = (attempt: number) => {
      if (cancelled) return;

      const target = document.querySelector(step.selector) as HTMLElement | null;
      if (!target) {
        if (attempt < 40) {
          timer = window.setTimeout(() => showStep(attempt + 1), 120);
        }
        return;
      }

      highlightedElementRef.current?.removeAttribute('data-redbox-tour-target');
      highlightedElementRef.current = target;
      target.setAttribute('data-redbox-tour-target', 'active');

      instanceRef.current?.destroy();
      const created = tippy(target, {
        content: renderContent(),
        trigger: 'manual',
        interactive: true,
        appendTo: () => document.body,
        hideOnClick: false,
        placement: step.placement,
        theme: 'redbox-tour',
        maxWidth: 380,
        offset: [0, 14],
      });

      instanceRef.current = Array.isArray(created) ? created[0] : created;
      instanceRef.current?.show();
    };

    showStep(0);

    return () => {
      cancelled = true;
      if (timer) {
        window.clearTimeout(timer);
      }
      instanceRef.current?.destroy();
      instanceRef.current = null;
      highlightedElementRef.current?.removeAttribute('data-redbox-tour-target');
      highlightedElementRef.current = null;
    };
  }, [active, currentView, initialized, onNavigate, stepIndex, steps]);

  if (!initialized || !introVisible) {
    return null;
  }

  return (
    <div className="redbox-tour-overlay" role="dialog" aria-modal="true" aria-label="RedBox 启动引导">
      <div className="redbox-tour-backdrop" onClick={finishTour} />
      <div className="redbox-tour-panel">
        <div className="redbox-tour-hero" aria-hidden="true">
          <div className="redbox-tour-hero-orbit redbox-tour-hero-orbit--one" />
          <div className="redbox-tour-hero-orbit redbox-tour-hero-orbit--two" />
          <div className="redbox-tour-hero-grid">
            <div className="redbox-tour-hero-card redbox-tour-hero-card--knowledge">
              <FolderOpen className="h-4 w-4" strokeWidth={1.75} />
              <span>知识入库</span>
            </div>
            <div className="redbox-tour-hero-card redbox-tour-hero-card--wander">
              <Dices className="h-4 w-4" strokeWidth={1.75} />
              <span>漫步发散</span>
            </div>
            <div className="redbox-tour-hero-card redbox-tour-hero-card--draft">
              <FileEdit className="h-4 w-4" strokeWidth={1.75} />
              <span>稿件组织</span>
            </div>
            <div className="redbox-tour-hero-card redbox-tour-hero-card--generate">
              <Sparkles className="h-4 w-4" strokeWidth={1.75} />
              <span>画面生成</span>
            </div>
            <div className="redbox-tour-hero-card redbox-tour-hero-card--automation">
              <Bot className="h-4 w-4" strokeWidth={1.75} />
              <span>持续执行</span>
            </div>
          </div>
        </div>

        <div className="redbox-tour-panel-body">
          <div className="redbox-tour-panel-kicker">
            <Wand2 className="h-4 w-4" strokeWidth={1.8} />
            <span>新版启动引导</span>
          </div>

          <h2 className="redbox-tour-panel-title">RedBox 现在的主流程已经切到“生产优先”</h2>
          <p className="redbox-tour-panel-desc">
            启动后默认回到稿件工作台，知识采集、灵感发散、画面生成和自动执行围绕同一条内容生产链协同工作。
            这轮引导会先给你一个总览，再用 5 个定位步骤带你过一遍现在的入口顺序。
          </p>

          <div className="redbox-tour-feature-grid">
            {INTRO_FEATURES.map(({ id, title, description, icon: Icon }) => (
              <div key={id} className="redbox-tour-feature-card">
                <div className="redbox-tour-feature-icon">
                  <Icon className="h-4 w-4" strokeWidth={1.8} />
                </div>
                <div>
                  <div className="redbox-tour-feature-title">{title}</div>
                  <div className="redbox-tour-feature-desc">{description}</div>
                </div>
              </div>
            ))}
          </div>

          <div className="redbox-tour-path">
            <span className="redbox-tour-path-label">推荐起手路径</span>
            <strong>知识库</strong>
            <span>→</span>
            <strong>漫步</strong>
            <span>→</span>
            <strong>稿件</strong>
            <span>→</span>
            <strong>创作</strong>
            <span>→</span>
            <strong>RedClaw</strong>
          </div>

          <div className="redbox-tour-panel-actions">
            <button
              type="button"
              onClick={finishTour}
              className="redbox-tour-panel-btn redbox-tour-panel-btn-ghost"
            >
              暂不显示
            </button>
            <button
              type="button"
              onClick={startTour}
              className="redbox-tour-panel-btn redbox-tour-panel-btn-primary"
            >
              开始查看
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
