import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';

const SIDEBAR_COLLAPSED_STORAGE_KEY = 'redbox:layout-sidebar-collapsed:v1';
const SIDEBAR_WIDTH_STORAGE_KEY = 'redbox:layout-sidebar-width:v1';
const SIDEBAR_DEFAULT_WIDTH = 320;
const SIDEBAR_MIN_WIDTH = 240;
const SIDEBAR_MAX_WIDTH = 460;
const SIDEBAR_CONTENT_ANIMATION_MS = 280;

function readInitialSidebarCollapsed(): boolean {
  if (typeof window === 'undefined') return false;
  return window.localStorage.getItem(SIDEBAR_COLLAPSED_STORAGE_KEY) === 'true';
}

function clampSidebarWidth(width: number): number {
  return Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, Math.round(width)));
}

function readInitialSidebarWidth(): number {
  if (typeof window === 'undefined') return SIDEBAR_DEFAULT_WIDTH;
  const storedWidth = Number(window.localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY));
  return Number.isFinite(storedWidth) ? clampSidebarWidth(storedWidth) : SIDEBAR_DEFAULT_WIDTH;
}

export function useLayoutSidebar(onBeforeToggle?: () => void) {
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(readInitialSidebarCollapsed);
  const [sidebarWidth, setSidebarWidth] = useState(readInitialSidebarWidth);
  const [isSidebarAnimating, setIsSidebarAnimating] = useState(false);
  const [sidebarAnimationDirection, setSidebarAnimationDirection] = useState<'collapsing' | 'expanding' | null>(null);
  const sidebarAnimationTimerRef = useRef<number | null>(null);
  const sidebarResizeStateRef = useRef<{ startX: number; startWidth: number } | null>(null);
  const sidebarResizeFrameRef = useRef<number | null>(null);
  const pendingSidebarWidthRef = useRef(sidebarWidth);
  const sidebarWidthPersistTimerRef = useRef<number | null>(null);
  const sidebarVisualCollapsed = isSidebarCollapsed || sidebarAnimationDirection === 'collapsing';

  useEffect(() => {
    window.localStorage.setItem(SIDEBAR_COLLAPSED_STORAGE_KEY, String(isSidebarCollapsed));
  }, [isSidebarCollapsed]);

  useEffect(() => {
    if (sidebarWidthPersistTimerRef.current !== null) {
      window.clearTimeout(sidebarWidthPersistTimerRef.current);
    }
    sidebarWidthPersistTimerRef.current = window.setTimeout(() => {
      sidebarWidthPersistTimerRef.current = null;
      window.localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, String(sidebarWidth));
    }, 160);
  }, [sidebarWidth]);

  useEffect(() => () => {
    if (sidebarAnimationTimerRef.current !== null) {
      window.clearTimeout(sidebarAnimationTimerRef.current);
    }
    if (sidebarResizeFrameRef.current !== null) {
      window.cancelAnimationFrame(sidebarResizeFrameRef.current);
    }
    if (sidebarWidthPersistTimerRef.current !== null) {
      window.clearTimeout(sidebarWidthPersistTimerRef.current);
    }
  }, []);

  const toggleSidebarCollapsed = useCallback(() => {
    onBeforeToggle?.();
    if (isSidebarAnimating) return;

    if (sidebarAnimationTimerRef.current !== null) {
      window.clearTimeout(sidebarAnimationTimerRef.current);
      sidebarAnimationTimerRef.current = null;
    }

    setIsSidebarAnimating(true);

    if (isSidebarCollapsed) {
      setSidebarAnimationDirection('expanding');
      setIsSidebarCollapsed(false);
      sidebarAnimationTimerRef.current = window.setTimeout(() => {
        setIsSidebarAnimating(false);
        setSidebarAnimationDirection(null);
        sidebarAnimationTimerRef.current = null;
      }, SIDEBAR_CONTENT_ANIMATION_MS);
      return;
    }

    setSidebarAnimationDirection('collapsing');
    sidebarAnimationTimerRef.current = window.setTimeout(() => {
      setIsSidebarCollapsed(true);
      setIsSidebarAnimating(false);
      setSidebarAnimationDirection(null);
      sidebarAnimationTimerRef.current = null;
    }, SIDEBAR_CONTENT_ANIMATION_MS);
  }, [isSidebarAnimating, isSidebarCollapsed, onBeforeToggle]);

  const startSidebarResize = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (sidebarVisualCollapsed || isSidebarAnimating) return;
    event.preventDefault();
    event.stopPropagation();
    sidebarResizeStateRef.current = {
      startX: event.clientX,
      startWidth: sidebarWidth,
    };
    pendingSidebarWidthRef.current = sidebarWidth;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';

    const handlePointerMove = (moveEvent: PointerEvent) => {
      const resizeState = sidebarResizeStateRef.current;
      if (!resizeState) return;
      const nextWidth = clampSidebarWidth(resizeState.startWidth + moveEvent.clientX - resizeState.startX);
      if (pendingSidebarWidthRef.current === nextWidth) return;
      pendingSidebarWidthRef.current = nextWidth;
      if (sidebarResizeFrameRef.current !== null) return;
      sidebarResizeFrameRef.current = window.requestAnimationFrame(() => {
        sidebarResizeFrameRef.current = null;
        setSidebarWidth((current) => (
          current === pendingSidebarWidthRef.current ? current : pendingSidebarWidthRef.current
        ));
      });
    };

    const stopResize = () => {
      sidebarResizeStateRef.current = null;
      if (sidebarResizeFrameRef.current !== null) {
        window.cancelAnimationFrame(sidebarResizeFrameRef.current);
        sidebarResizeFrameRef.current = null;
      }
      setSidebarWidth((current) => (
        current === pendingSidebarWidthRef.current ? current : pendingSidebarWidthRef.current
      ));
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', stopResize);
      window.removeEventListener('pointercancel', stopResize);
    };

    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', stopResize);
    window.addEventListener('pointercancel', stopResize);
  }, [isSidebarAnimating, sidebarVisualCollapsed, sidebarWidth]);

  return {
    isSidebarCollapsed,
    sidebarWidth,
    isSidebarAnimating,
    sidebarVisualCollapsed,
    toggleSidebarCollapsed,
    startSidebarResize,
  };
}
