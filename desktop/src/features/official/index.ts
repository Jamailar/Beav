import type { ComponentType } from 'react';
import GeneratedOfficialAiPanel, {
  hasOfficialAiPanel as generatedHasOfficialAiPanel,
  tabLabel as generatedTabLabel,
} from './generatedOfficialAiPanel';

export interface OfficialAiPanelProps {
  onReloadSettings: () => Promise<void> | void;
}

export interface OfficialAiPanelModule {
  default: ComponentType<OfficialAiPanelProps>;
  tabLabel?: string;
}

export const hasOfficialAiPanel = generatedHasOfficialAiPanel;
export const officialAiPanelTabLabel = generatedTabLabel || '登录';

export const loadOfficialAiPanelModule = async (): Promise<OfficialAiPanelModule | null> => {
  if (!generatedHasOfficialAiPanel) {
    return null;
  }
  return {
    default: GeneratedOfficialAiPanel as ComponentType<OfficialAiPanelProps>,
    tabLabel: officialAiPanelTabLabel,
  };
};
