import { useCallback, useEffect, useState } from 'react';

export interface FeatureFlags {
  vectorRecommendation: boolean;
  runtimeContextBundleV2: boolean;
  runtimeMemoryRecallV2: boolean;
  runtimeSubagentRuntimeV2: boolean;
  runtimeExecuteScriptV1: boolean;
  runtimeAgentJobV1: boolean;
}

const STORAGE_KEY = 'redconvert:feature-flags';
const UPDATE_EVENT = 'featureflags:updated';

export const DEFAULT_FLAGS: FeatureFlags = {
  vectorRecommendation: false,
  runtimeContextBundleV2: true,
  runtimeMemoryRecallV2: false,
  runtimeSubagentRuntimeV2: false,
  runtimeExecuteScriptV1: false,
  runtimeAgentJobV1: false,
};

const normalizeFeatureFlags = (value: unknown): FeatureFlags => {
  if (!value || typeof value !== 'object') {
    return { ...DEFAULT_FLAGS };
  }
  const candidate = value as Record<string, unknown>;
  return {
    vectorRecommendation: candidate.vectorRecommendation === true,
    runtimeContextBundleV2: candidate.runtimeContextBundleV2 === true,
    runtimeMemoryRecallV2: candidate.runtimeMemoryRecallV2 === true,
    runtimeSubagentRuntimeV2: candidate.runtimeSubagentRuntimeV2 === true,
    runtimeExecuteScriptV1: candidate.runtimeExecuteScriptV1 === true,
    runtimeAgentJobV1: candidate.runtimeAgentJobV1 === true,
  };
};

const normalizeFeatureFlagPatch = (value: Partial<FeatureFlags>): Partial<FeatureFlags> => {
  const patch: Partial<FeatureFlags> = {};
  for (const key of Object.keys(DEFAULT_FLAGS) as Array<keyof FeatureFlags>) {
    if (typeof value[key] === 'boolean') {
      patch[key] = value[key];
    }
  }
  return patch;
};

const readStoredFeatureFlags = (): FeatureFlags => {
  if (typeof window === 'undefined') {
    return { ...DEFAULT_FLAGS };
  }
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (!stored) {
      return { ...DEFAULT_FLAGS };
    }
    return normalizeFeatureFlags(JSON.parse(stored));
  } catch (error) {
    console.error('Failed to load feature flags:', error);
    return { ...DEFAULT_FLAGS };
  }
};

const persistLocalFeatureFlags = (flags: FeatureFlags): FeatureFlags => {
  if (typeof window === 'undefined') {
    return flags;
  }
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(flags));
  } catch (error) {
    console.error('Failed to save feature flags:', error);
  }
  return flags;
};

const emitFeatureFlagsUpdated = (flags: FeatureFlags) => {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(UPDATE_EVENT, { detail: flags }));
};

const syncHostFeatureFlags = async (flags: FeatureFlags) => {
  if (typeof window === 'undefined' || !window.ipcRenderer?.saveSettings) {
    return;
  }
  try {
    await window.ipcRenderer.saveSettings({ feature_flags: flags });
  } catch (error) {
    console.error('Failed to sync feature flags to host settings:', error);
  }
};

const loadHostFeatureFlags = async (): Promise<FeatureFlags | null> => {
  if (typeof window === 'undefined' || !window.ipcRenderer?.getSettings) {
    return null;
  }
  try {
    const settings = await window.ipcRenderer.getSettings();
    return normalizeFeatureFlags(settings?.feature_flags);
  } catch (error) {
    console.error('Failed to load host feature flags:', error);
    return null;
  }
};

export const getFeatureFlags = (): FeatureFlags => readStoredFeatureFlags();

export const saveFeatureFlags = (flags: Partial<FeatureFlags>): FeatureFlags => {
  const updated = {
    ...readStoredFeatureFlags(),
    ...normalizeFeatureFlagPatch(flags),
  };
  persistLocalFeatureFlags(updated);
  emitFeatureFlagsUpdated(updated);
  void syncHostFeatureFlags(updated);
  return updated;
};

export function useFeatureFlags() {
  const [flags, setFlags] = useState<FeatureFlags>(getFeatureFlags);

  useEffect(() => {
    let cancelled = false;
    void loadHostFeatureFlags().then((hostFlags) => {
      if (cancelled || !hostFlags) return;
      persistLocalFeatureFlags(hostFlags);
      setFlags(hostFlags);
      emitFeatureFlagsUpdated(hostFlags);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const handleStorage = (event?: Event) => {
      if (event instanceof StorageEvent && event.key && event.key !== STORAGE_KEY) {
        return;
      }
      setFlags(readStoredFeatureFlags());
    };
    window.addEventListener('storage', handleStorage);
    window.addEventListener(UPDATE_EVENT, handleStorage);
    return () => {
      window.removeEventListener('storage', handleStorage);
      window.removeEventListener(UPDATE_EVENT, handleStorage);
    };
  }, []);

  const updateFlag = useCallback(<K extends keyof FeatureFlags>(key: K, value: FeatureFlags[K]) => {
    const updated = {
      ...readStoredFeatureFlags(),
      [key]: value,
    };
    persistLocalFeatureFlags(updated);
    setFlags(updated);
    emitFeatureFlagsUpdated(updated);
    void syncHostFeatureFlags(updated);
  }, []);

  const toggleFlag = useCallback(<K extends keyof FeatureFlags>(key: K) => {
    const current = readStoredFeatureFlags();
    const updated = {
      ...current,
      [key]: !current[key],
    };
    persistLocalFeatureFlags(updated);
    setFlags(updated);
    emitFeatureFlagsUpdated(updated);
    void syncHostFeatureFlags(updated);
  }, []);

  return {
    flags,
    updateFlag,
    toggleFlag,
  };
}

export function useFeatureFlag<K extends keyof FeatureFlags>(key: K): boolean {
  const [value, setValue] = useState(() => getFeatureFlags()[key]);

  useEffect(() => {
    const handleStorage = (event?: Event) => {
      if (event instanceof StorageEvent && event.key && event.key !== STORAGE_KEY) {
        return;
      }
      setValue(readStoredFeatureFlags()[key]);
    };
    window.addEventListener('storage', handleStorage);
    window.addEventListener(UPDATE_EVENT, handleStorage);
    return () => {
      window.removeEventListener('storage', handleStorage);
      window.removeEventListener(UPDATE_EVENT, handleStorage);
    };
  }, [key]);

  return value;
}
