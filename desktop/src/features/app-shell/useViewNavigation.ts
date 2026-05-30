import { useCallback, useEffect, useRef, useState } from 'react';
import type { ImmersiveMode, ViewType } from './types';

const MAX_CACHED_VIEWS = 0;
const NON_CACHEABLE_VIEWS = new Set<ViewType>([
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
]);

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

export function useViewNavigation() {
  const [currentView, setCurrentView] = useState<ViewType>('generation-studio');
  const [immersiveMode, setImmersiveMode] = useState<ImmersiveMode>(false);
  const [activeManuscriptEditorFile, setActiveManuscriptEditorFile] = useState<string | null>(null);
  const [mountedViews, setMountedViews] = useState<Set<ViewType>>(() => computeMountedViews(['generation-studio']));
  const [persistentViews, setPersistentViews] = useState<Set<ViewType>>(() => new Set());
  const viewHistoryRef = useRef<ViewType[]>(['generation-studio']);

  useEffect(() => {
    viewHistoryRef.current = [...viewHistoryRef.current.filter((item) => item !== currentView), currentView];
    const nextMounted = computeMountedViews(viewHistoryRef.current);
    nextMounted.add(currentView);
    setMountedViews(nextMounted);
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
    const previousView = [...viewHistoryRef.current].reverse().find((view) => view !== 'settings') || 'generation-studio';
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
