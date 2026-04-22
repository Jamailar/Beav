import type { ComponentType } from 'react';

export interface OfficialAiPanelProps {
  onReloadSettings: (options?: { preserveViewState?: boolean; preserveRemoteModels?: boolean }) => Promise<void> | void;
}

export interface OfficialAiPanelModule {
  default: ComponentType<OfficialAiPanelProps>;
  tabLabel?: string;
}

export const hasOfficialAiPanel = true;
export const officialAiPanelTabLabel = '登录';

export const loadOfficialAiPanelModule = async (): Promise<OfficialAiPanelModule | null> => {
  try {
    const module = await import('./generatedOfficialAiPanel');
    if (!module?.hasOfficialAiPanel || !module?.default) {
      return null;
    }
    return {
      default: module.default as ComponentType<OfficialAiPanelProps>,
      tabLabel: module.tabLabel || officialAiPanelTabLabel,
    };
  } catch (error) {
    console.error('Failed to load official AI panel module', error);
    return null;
  }
};
