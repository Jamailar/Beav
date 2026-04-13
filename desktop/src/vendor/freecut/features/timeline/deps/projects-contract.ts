import { create } from 'zustand';

type ProjectMetadata = {
  width: number;
  height: number;
  fps: number;
};

type LexBoxProjectState = {
  currentProject: {
    id: string;
    metadata: ProjectMetadata;
  } | null;
};

type LexBoxProjectActions = {
  syncCurrentProject: (project: LexBoxProjectState['currentProject']) => void;
};

export const useProjectStore = create<LexBoxProjectState & LexBoxProjectActions>((set) => ({
  currentProject: {
    id: 'lexbox-project',
    metadata: {
      width: 1080,
      height: 1920,
      fps: 30,
    },
  },
  syncCurrentProject: (currentProject) => set({ currentProject }),
}));

export function syncLexBoxTimelineProject(project: LexBoxProjectState['currentProject']) {
  useProjectStore.getState().syncCurrentProject(project);
}
