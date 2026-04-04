import { useEffect, useMemo, useRef, useState } from 'react';
import tippy, { type Instance, type Placement } from 'tippy.js';
import type { ViewType } from '../App';

const TOUR_DONE_KEY = 'redbox:first-run-tour:v1';

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

export function FirstRunTour({ currentView, onNavigate }: FirstRunTourProps) {
  const [active, setActive] = useState(false);
  const [stepIndex, setStepIndex] = useState(0);
  const [initialized, setInitialized] = useState(false);
  const instanceRef = useRef<Instance | null>(null);

  const steps = useMemo<TourStep[]>(() => ([
    {
      id: 'plugin-capture',
      selector: '[data-guide-id="nav-knowledge"]',
      title: '1/5 先用插件采集素材',
      description: '安装 Chrome 插件后，可以把小红书笔记、YouTube 视频、网页链接和选中文字直接保存到知识库。',
      placement: 'right',
      view: 'knowledge',
    },
    {
      id: 'youtube-clipboard',
      selector: '[data-guide-id="nav-knowledge"]',
      title: '2/5 YouTube 复制链接采集',
      description: '复制 YouTube 链接到剪贴板（例如 https://www.youtube.com/watch?v=dQw4w9WgXcQ ），应用会自动识别并弹窗确认采集。',
      placement: 'right',
      view: 'knowledge',
    },
    {
      id: 'knowledge',
      selector: '[data-guide-id="nav-knowledge"]',
      title: '3/5 进入知识库处理内容',
      description: '在知识库里查看已采集内容；YouTube 视频采集后会出现在 YouTube 分栏。',
      placement: 'right',
      view: 'knowledge',
    },
    {
      id: 'wander',
      selector: '[data-guide-id="nav-wander"]',
      title: '4/5 用漫步找灵感',
      description: '当选题卡住时，先用漫步随机重组素材，快速获得创作灵感。',
      placement: 'right',
      view: 'wander',
    },
    {
      id: 'redclaw',
      selector: '[data-guide-id="nav-redclaw"]',
      title: '5/5 在 RedClaw 下任务',
      description: '最后和 RedClaw 对话，直接下达创作、配图、复盘等任务。',
      placement: 'right',
      view: 'redclaw',
    },
  ]), []);

  useEffect(() => {
    const done = window.localStorage.getItem(TOUR_DONE_KEY) === '1';
    if (!done) {
      setActive(true);
      setStepIndex(0);
    }
    setInitialized(true);
  }, []);

  const finishTour = () => {
    window.localStorage.setItem(TOUR_DONE_KEY, '1');
    setActive(false);
  };

  useEffect(() => {
    if (!initialized || !active) {
      instanceRef.current?.destroy();
      instanceRef.current = null;
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

      const title = document.createElement('div');
      title.className = 'redbox-tour-title';
      title.textContent = step.title;

      const desc = document.createElement('div');
      desc.className = 'redbox-tour-desc';
      desc.textContent = step.description;

      const actions = document.createElement('div');
      actions.className = 'redbox-tour-actions';

      const skipButton = document.createElement('button');
      skipButton.className = 'redbox-tour-btn redbox-tour-btn-ghost';
      skipButton.textContent = '跳过';
      skipButton.onclick = () => finishTour();

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

      actions.appendChild(skipButton);
      actions.appendChild(nextButton);
      root.appendChild(title);
      root.appendChild(desc);
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

      instanceRef.current?.destroy();
      const created = tippy(target, {
        content: renderContent(),
        trigger: 'manual',
        interactive: true,
        appendTo: () => document.body,
        hideOnClick: false,
        placement: step.placement,
        theme: 'redbox-tour',
        maxWidth: 360,
        offset: [0, 12],
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
    };
  }, [active, currentView, initialized, onNavigate, stepIndex, steps]);

  return null;
}
