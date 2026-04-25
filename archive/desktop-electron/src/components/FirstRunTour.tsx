import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Bot, FileEdit, FolderOpen, Sparkles } from 'lucide-react';
import tippy, { type Instance } from 'tippy.js';
import type { ViewType } from '../App';
import {
  getStartupAnnouncementByVersion,
  getStartupAnnouncementSeenKey,
  type StartupAnnouncement,
  type StartupAnnouncementFeature,
  type StartupAnnouncementStep,
} from '../config/startupAnnouncements';

interface FirstRunTourProps {
  currentView: ViewType;
  onNavigate: (view: ViewType) => void;
}

const HERO_ICON_MAP: Record<StartupAnnouncementFeature['icon'], typeof FolderOpen> = {
  knowledge: FolderOpen,
  wander: Sparkles,
  draft: FileEdit,
  generate: Sparkles,
  automation: Bot,
};

function readSeenFlag(announcementId: string): boolean {
  try {
    return window.localStorage.getItem(getStartupAnnouncementSeenKey(announcementId)) === '1';
  } catch {
    return false;
  }
}

export function FirstRunTour({ currentView, onNavigate }: FirstRunTourProps) {
  const [announcement, setAnnouncement] = useState<StartupAnnouncement | null>(null);
  const [introVisible, setIntroVisible] = useState(false);
  const [active, setActive] = useState(false);
  const [stepIndex, setStepIndex] = useState(0);
  const [initialized, setInitialized] = useState(false);
  const instanceRef = useRef<Instance | null>(null);
  const highlightedElementRef = useRef<HTMLElement | null>(null);

  const steps = useMemo<StartupAnnouncementStep[]>(
    () => announcement?.steps || [],
    [announcement],
  );

  useEffect(() => {
    let disposed = false;

    const loadAnnouncement = async () => {
      try {
        const version = await window.ipcRenderer.getAppVersion();
        if (disposed) return;
        const next = getStartupAnnouncementByVersion(typeof version === 'string' ? version.trim() : String(version || '').trim());
        if (!next) {
          setInitialized(true);
          return;
        }
        setAnnouncement(next);
        if (!readSeenFlag(next.id)) {
          setIntroVisible(true);
          setStepIndex(0);
        }
      } catch {
        // Do not block the app if version resolution fails.
      } finally {
        if (!disposed) {
          setInitialized(true);
        }
      }
    };

    void loadAnnouncement();
    return () => {
      disposed = true;
    };
  }, []);

  const markDone = useCallback((announcementId: string | null) => {
    if (!announcementId) return;
    try {
      window.localStorage.setItem(getStartupAnnouncementSeenKey(announcementId), '1');
    } catch {
      // Ignore storage failures so onboarding never blocks the app.
    }
  }, []);

  const finishTour = useCallback(() => {
    markDone(announcement?.id || null);
    setIntroVisible(false);
    setActive(false);
  }, [announcement?.id, markDone]);

  const startTour = useCallback(() => {
    if (!steps.length) {
      finishTour();
      return;
    }
    setIntroVisible(false);
    setActive(true);
    setStepIndex(0);
  }, [finishTour, steps.length]);

  const handleShortcutNavigate = useCallback((view: ViewType) => {
    finishTour();
    onNavigate(view);
  }, [finishTour, onNavigate]);

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
    if (!initialized || !active || !announcement || steps.length === 0) {
      instanceRef.current?.destroy();
      instanceRef.current = null;
      highlightedElementRef.current?.removeAttribute('data-redbox-tour-target');
      highlightedElementRef.current = null;
      return;
    }

    let cancelled = false;
    let timer: number | null = null;
    const step = steps[stepIndex];

    if (step?.view && currentView !== step.view) {
      onNavigate(step.view);
    }

    const renderContent = () => {
      const root = document.createElement('div');
      root.className = 'redbox-tour-content';

      const eyebrow = document.createElement('div');
      eyebrow.className = 'redbox-tour-kicker';
      eyebrow.textContent = announcement.badge;

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
      if (cancelled || !step) return;

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
        maxWidth: 360,
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
  }, [active, announcement, currentView, finishTour, initialized, onNavigate, stepIndex, steps]);

  if (!initialized || !introVisible || !announcement) {
    return null;
  }

  return (
    <div className="redbox-tour-overlay" role="dialog" aria-modal="true" aria-label="RedBox 更新提示">
      <div className="redbox-tour-backdrop" onClick={finishTour} />
      <div className="redbox-tour-panel">
        <div className="redbox-tour-hero" aria-hidden="true">
          <div className="redbox-tour-hero-orbit redbox-tour-hero-orbit--one" />
          <div className="redbox-tour-hero-orbit redbox-tour-hero-orbit--two" />
          <div className="redbox-tour-hero-grid redbox-tour-hero-grid--compact">
            {announcement.hero.map((feature) => {
              const Icon = HERO_ICON_MAP[feature.icon];
              return (
                <div key={feature.id} className="redbox-tour-hero-card redbox-tour-hero-card--compact">
                  <Icon className="h-4 w-4" strokeWidth={1.75} />
                  <span>{feature.label}</span>
                </div>
              );
            })}
          </div>
        </div>

        <div className="redbox-tour-panel-body">
          <div className="redbox-tour-panel-kicker">{announcement.badge}</div>
          <h2 className="redbox-tour-panel-title">{announcement.title}</h2>
          <p className="redbox-tour-panel-desc">{announcement.summary}</p>

          <ul className="redbox-tour-highlight-list">
            {announcement.highlights.map((item) => (
              <li key={item} className="redbox-tour-highlight-item">{item}</li>
            ))}
          </ul>

          {announcement.shortcuts && announcement.shortcuts.length > 0 && (
            <div className="redbox-tour-shortcuts">
              {announcement.shortcuts.map((shortcut) => (
                <button
                  key={shortcut.id}
                  type="button"
                  onClick={() => handleShortcutNavigate(shortcut.view)}
                  className="redbox-tour-shortcut-btn"
                >
                  {shortcut.label}
                </button>
              ))}
            </div>
          )}

          <div className="redbox-tour-panel-actions">
            <button
              type="button"
              onClick={finishTour}
              className="redbox-tour-panel-btn redbox-tour-panel-btn-ghost"
            >
              知道了
            </button>
            {steps.length > 0 && (
              <button
                type="button"
                onClick={startTour}
                className="redbox-tour-panel-btn redbox-tour-panel-btn-primary"
              >
                查看引导
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
