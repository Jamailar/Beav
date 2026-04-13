export type SceneCut = {
  frame: number;
  confidence?: number;
};

export type SceneDetectionProgress = {
  processedFrames: number;
  totalFrames: number;
};

export type VerificationModel = {
  value: string;
  label: string;
};

export async function detectScenes(): Promise<SceneCut[]> {
  return [];
}

export function getSceneVerificationModelLabel(model: string): string {
  return model || 'disabled';
}

export function getSceneVerificationModelOptions(): VerificationModel[] {
  return [{ value: 'disabled', label: 'Disabled' }];
}
