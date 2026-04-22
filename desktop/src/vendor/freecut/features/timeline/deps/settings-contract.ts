import { create } from 'zustand';
import { HOTKEYS, type HotkeyBindingMap } from '@/config/hotkeys';

type RedBoxSettingsState = {
  editorDensity: 'compact' | 'default';
  showWaveforms: boolean;
  showFilmstrips: boolean;
  defaultWhisperModel: string;
  maxUndoHistory: number;
};

type RedBoxSettingsActions = {
  syncRedBoxSettings: (patch: Partial<RedBoxSettingsState>) => void;
};

export const useSettingsStore = create<RedBoxSettingsState & RedBoxSettingsActions>((set) => ({
  editorDensity: 'compact',
  showWaveforms: true,
  showFilmstrips: true,
  defaultWhisperModel: 'base',
  maxUndoHistory: 80,
  syncRedBoxSettings: (patch) => set((state) => ({ ...state, ...patch })),
}));

export function syncRedBoxTimelineSettings(patch: Partial<RedBoxSettingsState>) {
  useSettingsStore.getState().syncRedBoxSettings(patch);
}

export function useResolvedHotkeys(): HotkeyBindingMap {
  return HOTKEYS;
}
