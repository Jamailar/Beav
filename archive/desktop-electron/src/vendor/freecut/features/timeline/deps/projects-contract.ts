import { create } from 'zustand';

type ProjectMetadata = {
  width: number;
  height: number;
  fps: number;
};

type RedBoxProjectState = {
  currentProject: {
    id: string;
    metadata: ProjectMetadata;
  } | null;
};

type RedBoxProjectActions = {
  syncCurrentProject: (project: RedBoxProjectState['currentProject']) => void;
};

export const useProjectStore = create<RedBoxProjectState & RedBoxProjectActions>((set) => ({
  currentProject: {
    id: 'redbox-project',
    metadata: {
      width: 1080,
      height: 1920,
      fps: 30,
    },
  },
  syncCurrentProject: (currentProject) => set({ currentProject }),
}));

export function syncRedBoxTimelineProject(project: RedBoxProjectState['currentProject']) {
  useProjectStore.getState().syncCurrentProject(project);
}
