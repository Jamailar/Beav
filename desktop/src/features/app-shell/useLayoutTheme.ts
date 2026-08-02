import { getCurrentWindow } from '@tauri-apps/api/window';
import { useCallback, useEffect, useState, type Dispatch, type SetStateAction } from 'react';
import { APP_BRAND } from '../../config/brand';
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
    const effectiveTheme = immersiveMode === 'dark' ? 'dark' : themeMode;
    const windowTheme = immersiveMode === 'dark' ? effectiveTheme : themePreference === 'system' ? null : effectiveTheme;
    applyAppTheme(effectiveTheme);
    void getCurrentWindow().setTheme(windowTheme).catch((error) => {
      console.warn(`[${APP_BRAND.displayName}] failed to apply window theme:`, error);
    });
  }, [immersiveMode, themeMode, themePreference]);

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
