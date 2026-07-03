import { useCallback, useEffect, useRef, useState } from 'react';
import type { ImmersiveMode, ViewType } from './types';

const LAST_VIEW_STORAGE_KEY = 'redbox:app-shell:last-view:v1';
const DEFAULT_VIEW: ViewType = 'redclaw';
const MAX_CACHED_VIEWS = 0;
const APP_VIEWS = [
  'skills',
  'knowledge',
  'settings',
  'archives',
  'wander',
  'redclaw',
  'media-library',
  'cover-studio',
  'generation-studio',
  'subjects',
  'automation',
  'approval',
] satisfies ViewType[];
const RESTORABLE_VIEWS = new Set<ViewType>(APP_VIEWS);
const NON_CACHEABLE_VIEWS = new Set<ViewType>(APP_VIEWS);

function computeMountedViews(history: ViewType[]): Set<ViewType> {
  const next = new Set<ViewType>();
  const recent = history.slice(-MAX_CACHED_VIEWS);
  for (const view of recent) {
    if (!NON_CACHEABLE_VIEWS.has(view)) {
      next.add(view);
    }
  }
  return next;
}

export function shouldRenderView(
  mountedViews: Set<ViewType>,
  currentView: ViewType,
  persistentViews: Set<ViewType>,
  view: ViewType,
): boolean {
  if (currentView === view || persistentViews.has(view)) {
    return true;
  }
  if (NON_CACHEABLE_VIEWS.has(view)) {
    return false;
  }
  return mountedViews.has(view);
}

function normalizeRestoredView(value: unknown): ViewType {
  return typeof value === 'string' && RESTORABLE_VIEWS.has(value as ViewType)
    ? value as ViewType
    : DEFAULT_VIEW;
}

function readInitialView(): ViewType {
  if (typeof window === 'undefined') return DEFAULT_VIEW;
  try {
    return normalizeRestoredView(window.localStorage.getItem(LAST_VIEW_STORAGE_KEY));
  } catch (error) {
    console.warn('Failed to restore app shell view:', error);
    return DEFAULT_VIEW;
  }
}

function persistCurrentView(view: ViewType): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(LAST_VIEW_STORAGE_KEY, view);
  } catch (error) {
    console.warn('Failed to persist app shell view:', error);
  }
}

export function useViewNavigation() {
  const [currentView, setCurrentView] = useState<ViewType>(readInitialView);
  const [immersiveMode, setImmersiveMode] = useState<ImmersiveMode>(false);
  const [activeManuscriptEditorFile, setActiveManuscriptEditorFile] = useState<string | null>(null);
  const [mountedViews, setMountedViews] = useState<Set<ViewType>>(() => computeMountedViews([currentView]));
  const [persistentViews, setPersistentViews] = useState<Set<ViewType>>(() => new Set());
  const viewHistoryRef = useRef<ViewType[]>([currentView]);

  useEffect(() => {
    viewHistoryRef.current = [...viewHistoryRef.current.filter((item) => item !== currentView), currentView];
    const nextMounted = computeMountedViews(viewHistoryRef.current);
    nextMounted.add(currentView);
    setMountedViews(nextMounted);
    persistCurrentView(currentView);
  }, [currentView]);

  const navigateToView = useCallback((view: ViewType) => {
    setActiveManuscriptEditorFile(null);
    setImmersiveMode(false);
    setCurrentView(view);
  }, []);

  const setViewPersistent = useCallback((view: ViewType, persistent: boolean) => {
    setPersistentViews((prev) => {
      const alreadyPersistent = prev.has(view);
      if (alreadyPersistent === persistent) {
        return prev;
      }
      const next = new Set(prev);
      if (persistent) {
        next.add(view);
      } else {
        next.delete(view);
      }
      return next;
    });
  }, []);

  const returnFromSettings = useCallback(() => {
    const previousView = [...viewHistoryRef.current].reverse().find((view) => view !== 'settings') || DEFAULT_VIEW;
    setCurrentView(previousView);
  }, []);

  return {
    currentView,
    setCurrentView,
    immersiveMode,
    setImmersiveMode,
    activeManuscriptEditorFile,
    setActiveManuscriptEditorFile,
    mountedViews,
    persistentViews,
    navigateToView,
    setViewPersistent,
    returnFromSettings,
  };
}
