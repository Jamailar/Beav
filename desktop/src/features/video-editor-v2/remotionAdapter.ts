import type { RemotionCompositionConfig } from '../../components/manuscripts/remotion/types';
import type { VideoEditorV2Project } from '../../../shared/videoAutoEdit';
import { buildVideoEditorV2RemotionComposition } from '../../../shared/videoAutoEditRemotion';

export function buildRemotionCompositionFromV2Project(project: VideoEditorV2Project): RemotionCompositionConfig | null {
  return buildVideoEditorV2RemotionComposition(project) as RemotionCompositionConfig | null;
}
