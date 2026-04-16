/**
 * 功能开关管理 Hook
 * 使用 localStorage 持久化存储
 */

import { useState, useEffect, useCallback } from 'react';

export interface FeatureFlags {
  vectorRecommendation: boolean; // 向量推荐 - 分栏模式下知识库按相似度排序
}

const STORAGE_KEY = 'redconvert:feature-flags';

const DEFAULT_FLAGS: FeatureFlags = {
  vectorRecommendation: false, // 默认关闭
};

// 获取当前功能开关状态
export const getFeatureFlags = (): FeatureFlags => {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      return { ...DEFAULT_FLAGS, ...JSON.parse(stored) };
    }
  } catch (e) {
    console.error('Failed to load feature flags:', e);
  }
  return DEFAULT_FLAGS;
};

// 保存功能开关状态
export const saveFeatureFlags = (flags: Partial<FeatureFlags>): FeatureFlags => {
  const current = getFeatureFlags();
  const updated = { ...current, ...flags };
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(updated));
  } catch (e) {
    console.error('Failed to save feature flags:', e);
  }
  return updated;
};

// React Hook
export function useFeatureFlags() {
  const [flags, setFlags] = useState<FeatureFlags>(getFeatureFlags);

  // 监听其他 tab 的变化
  useEffect(() => {
    const handleStorage = (e: StorageEvent) => {
      if (e.key === STORAGE_KEY) {
        setFlags(getFeatureFlags());
      }
    };
    window.addEventListener('storage', handleStorage);
    return () => window.removeEventListener('storage', handleStorage);
  }, []);

  const updateFlag = useCallback(<K extends keyof FeatureFlags>(key: K, value: FeatureFlags[K]) => {
    const updated = saveFeatureFlags({ [key]: value });
    setFlags(updated);
  }, []);

  const toggleFlag = useCallback(<K extends keyof FeatureFlags>(key: K) => {
    const current = getFeatureFlags();
    const updated = saveFeatureFlags({ [key]: !current[key] });
    setFlags(updated);
  }, []);

  return {
    flags,
    updateFlag,
    toggleFlag,
  };
}

// 单个标志的快捷 Hook
export function useFeatureFlag<K extends keyof FeatureFlags>(key: K): boolean {
  const [value, setValue] = useState(() => getFeatureFlags()[key]);

  useEffect(() => {
    const handleStorage = () => {
      setValue(getFeatureFlags()[key]);
    };
    window.addEventListener('storage', handleStorage);
    // 也监听自定义事件，用于同一页面内的更新
    window.addEventListener('featureflags:updated', handleStorage);
    return () => {
      window.removeEventListener('storage', handleStorage);
      window.removeEventListener('featureflags:updated', handleStorage);
    };
  }, [key]);

  return value;
}
