import { create } from 'zustand';
import { HOTKEYS, type HotkeyBindingMap } from '@/config/hotkeys';

type LexBoxSettingsState = {
  editorDensity: 'compact' | 'default';
  showWaveforms: boolean;
  showFilmstrips: boolean;
  defaultWhisperModel: string;
  maxUndoHistory: number;
};

type LexBoxSettingsActions = {
  syncLexBoxSettings: (patch: Partial<LexBoxSettingsState>) => void;
};

export const useSettingsStore = create<LexBoxSettingsState & LexBoxSettingsActions>((set) => ({
  editorDensity: 'compact',
  showWaveforms: true,
  showFilmstrips: true,
  defaultWhisperModel: 'base',
  maxUndoHistory: 80,
  syncLexBoxSettings: (patch) => set((state) => ({ ...state, ...patch })),
}));

export function syncLexBoxTimelineSettings(patch: Partial<LexBoxSettingsState>) {
  useSettingsStore.getState().syncLexBoxSettings(patch);
}

export function useResolvedHotkeys(): HotkeyBindingMap {
  return HOTKEYS;
}
