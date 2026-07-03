import { useCallback, useEffect, useState, type Dispatch, type SetStateAction } from 'react';
import {
  applyAppTheme,
  CUSTOM_THEME_CHANGED_EVENT,
  readThemePreference,
  resolveThemeMode,
  writeThemePreference,
  type ThemeMode,
  type ThemePreference,
} from '../../config/theme';
import type { ImmersiveMode } from './types';

function readInitialThemePreference(): ThemePreference {
  if (typeof window === 'undefined') return 'light';
  return readThemePreference();
}

function subscribeToSystemThemeChange(listener: () => void): () => void {
  if (typeof window === 'undefined' || !window.matchMedia) return () => {};
  const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
  if (typeof mediaQuery.addEventListener === 'function') {
    mediaQuery.addEventListener('change', listener);
    return () => mediaQuery.removeEventListener('change', listener);
  }
  mediaQuery.addListener(listener);
  return () => mediaQuery.removeListener(listener);
}

export function useLayoutTheme(immersiveMode: ImmersiveMode): {
  themeMode: ThemeMode;
  setManualThemeMode: Dispatch<SetStateAction<ThemeMode>>;
} {
  const [themePreference, setThemePreference] = useState<ThemePreference>(readInitialThemePreference);
  const [systemThemeMode, setSystemThemeMode] = useState<ThemeMode>(() => resolveThemeMode('system'));
  const themeMode = themePreference === 'system' ? systemThemeMode : themePreference;

  const setManualThemeMode = useCallback<Dispatch<SetStateAction<ThemeMode>>>((nextMode) => {
    setThemePreference((currentPreference) => {
      const currentMode = currentPreference === 'system' ? resolveThemeMode('system') : currentPreference;
      const resolvedMode = typeof nextMode === 'function' ? nextMode(currentMode) : nextMode;
      writeThemePreference(resolvedMode);
      return resolvedMode;
    });
  }, []);

  useEffect(() => {
    setSystemThemeMode(resolveThemeMode('system'));
    return subscribeToSystemThemeChange(() => setSystemThemeMode(resolveThemeMode('system')));
  }, []);

  useEffect(() => {
    applyAppTheme(immersiveMode === 'dark' ? 'dark' : themeMode);
  }, [immersiveMode, themeMode]);

  useEffect(() => {
    const handleCustomThemeChanged = () => {
      applyAppTheme(immersiveMode === 'dark' ? 'dark' : themeMode);
    };
    window.addEventListener(CUSTOM_THEME_CHANGED_EVENT, handleCustomThemeChanged);
    return () => window.removeEventListener(CUSTOM_THEME_CHANGED_EVENT, handleCustomThemeChanged);
  }, [immersiveMode, themeMode]);

  return {
    themeMode,
    setManualThemeMode,
  };
}
