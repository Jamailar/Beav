import { useCallback, useEffect, useRef, useState } from 'react';
import { APP_BRAND } from '../../config/brand';
import type { ViewType } from './types';

type GlobalKnowledgeSearchItem = {
  itemId?: string;
  kind?: 'redbook-note' | 'youtube-video' | 'document-source' | string;
  title?: string;
  author?: string;
  siteName?: string;
  previewText?: string;
  updatedAt?: string;
};

type GlobalKnowledgeSearchResponse = {
  items?: GlobalKnowledgeSearchItem[];
  total?: number;
};

const GLOBAL_SEARCH_ANIMATION_MS = 220;
const GLOBAL_KNOWLEDGE_SEARCH_EVENT = 'redbox:global-knowledge-search';
const GLOBAL_KNOWLEDGE_SEARCH_STORAGE_KEY = 'redbox:global-knowledge-search-query';

export function useGlobalKnowledgeSearch(onNavigate: (view: ViewType) => void) {
  const [isGlobalSearchOpen, setIsGlobalSearchOpen] = useState(false);
  const [isGlobalSearchClosing, setIsGlobalSearchClosing] = useState(false);
  const [globalSearchQuery, setGlobalSearchQuery] = useState('');
  const [globalSearchResults, setGlobalSearchResults] = useState<GlobalKnowledgeSearchItem[]>([]);
  const [isGlobalSearchLoading, setIsGlobalSearchLoading] = useState(false);
  const globalSearchInputRef = useRef<HTMLInputElement | null>(null);
  const globalSearchRequestRef = useRef(0);
  const globalSearchAnimationTimerRef = useRef<number | null>(null);
  const isGlobalSearchVisible = isGlobalSearchOpen || isGlobalSearchClosing;

  const closeGlobalSearch = useCallback(() => {
    if (!isGlobalSearchOpen || isGlobalSearchClosing) return;
    setIsGlobalSearchClosing(true);
    globalSearchAnimationTimerRef.current = window.setTimeout(() => {
      setIsGlobalSearchOpen(false);
      setIsGlobalSearchClosing(false);
      globalSearchAnimationTimerRef.current = null;
    }, GLOBAL_SEARCH_ANIMATION_MS);
  }, [isGlobalSearchClosing, isGlobalSearchOpen]);

  useEffect(() => {
    if (!isGlobalSearchOpen) return;
    const focusTimer = window.setTimeout(() => globalSearchInputRef.current?.focus(), 80);
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        closeGlobalSearch();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.clearTimeout(focusTimer);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [closeGlobalSearch, isGlobalSearchOpen]);

  useEffect(() => {
    if (!isGlobalSearchOpen) {
      setGlobalSearchResults([]);
      setIsGlobalSearchLoading(false);
      return;
    }

    const query = globalSearchQuery.trim();
    if (!query) {
      setGlobalSearchResults([]);
      setIsGlobalSearchLoading(false);
      return;
    }

    const requestId = globalSearchRequestRef.current + 1;
    globalSearchRequestRef.current = requestId;
    setIsGlobalSearchLoading(true);
    const timer = window.setTimeout(() => {
      void window.ipcRenderer.knowledge.listPage<GlobalKnowledgeSearchResponse>({
        limit: 6,
        query,
        sort: 'updated-desc',
      }).then((response) => {
        if (requestId !== globalSearchRequestRef.current) return;
        setGlobalSearchResults(Array.isArray(response?.items) ? response.items : []);
      }).catch((error) => {
        if (requestId !== globalSearchRequestRef.current) return;
        console.warn(`[${APP_BRAND.displayName}] global knowledge search failed:`, error);
        setGlobalSearchResults([]);
      }).finally(() => {
        if (requestId === globalSearchRequestRef.current) {
          setIsGlobalSearchLoading(false);
        }
      });
    }, 160);

    return () => window.clearTimeout(timer);
  }, [globalSearchQuery, isGlobalSearchOpen]);

  useEffect(() => () => {
    if (globalSearchAnimationTimerRef.current !== null) {
      window.clearTimeout(globalSearchAnimationTimerRef.current);
    }
  }, []);

  const openGlobalSearch = useCallback(() => {
    if (globalSearchAnimationTimerRef.current !== null) {
      window.clearTimeout(globalSearchAnimationTimerRef.current);
      globalSearchAnimationTimerRef.current = null;
    }
    setIsGlobalSearchClosing(false);
    setIsGlobalSearchOpen(true);
  }, []);

  useEffect(() => {
    const handleGlobalSearchShortcut = (event: KeyboardEvent) => {
      const key = event.key.toLowerCase();
      if (!(event.metaKey || event.ctrlKey) || event.altKey || key !== 'f') return;

      event.preventDefault();
      event.stopPropagation();
      openGlobalSearch();
      window.setTimeout(() => {
        globalSearchInputRef.current?.focus();
        globalSearchInputRef.current?.select();
      }, 0);
    };

    window.addEventListener('keydown', handleGlobalSearchShortcut, true);
    return () => window.removeEventListener('keydown', handleGlobalSearchShortcut, true);
  }, [openGlobalSearch]);

  const navigateToGlobalSearch = useCallback((queryOverride?: string) => {
    const query = (queryOverride ?? globalSearchQuery).trim();
    if (query) {
      window.sessionStorage.setItem(GLOBAL_KNOWLEDGE_SEARCH_STORAGE_KEY, query);
    } else {
      window.sessionStorage.removeItem(GLOBAL_KNOWLEDGE_SEARCH_STORAGE_KEY);
    }
    onNavigate('knowledge');
    window.setTimeout(() => {
      window.dispatchEvent(new CustomEvent(GLOBAL_KNOWLEDGE_SEARCH_EVENT, { detail: { query } }));
    }, 0);
    closeGlobalSearch();
  }, [closeGlobalSearch, globalSearchQuery, onNavigate]);

  const submitGlobalSearch = useCallback(() => {
    navigateToGlobalSearch(globalSearchQuery);
  }, [globalSearchQuery, navigateToGlobalSearch]);

  return {
    globalSearchInputRef,
    globalSearchQuery,
    setGlobalSearchQuery,
    globalSearchResults,
    isGlobalSearchLoading,
    isGlobalSearchVisible,
    isGlobalSearchClosing,
    openGlobalSearch,
    closeGlobalSearch,
    submitGlobalSearch,
    navigateToGlobalSearch,
  };
}
