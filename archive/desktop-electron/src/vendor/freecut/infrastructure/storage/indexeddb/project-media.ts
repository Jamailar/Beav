import type { Project } from '@/types/project';
import type { MediaMetadata, ProjectMediaAssociation } from '@/types/storage';
import { getDB } from './connection';
import { getProject } from './projects';
import { createLogger } from '@/shared/logging/logger';

const logger = createLogger('IndexedDB:ProjectMedia');
const PROJECT_MEDIA_ITEM_TYPES = new Set(['video', 'audio', 'image']);

function collectMediaIdsFromItems(
  items: Array<{ type: string; mediaId?: string }> | undefined,
  mediaIds: Set<string>,
): void {
  if (!items) {
    return;
  }

  for (const item of items) {
    if (item.mediaId && PROJECT_MEDIA_ITEM_TYPES.has(item.type)) {
      mediaIds.add(item.mediaId);
    }
  }
}

/**
 * Collect all media IDs referenced anywhere in a project's timeline.
 *
 * Legacy projects can still carry valid timeline media references without
 * the newer projectMedia association rows, so we use this to backfill them.
 */
export function collectProjectTimelineMediaIds(
  project: Pick<Project, 'timeline'> | null | undefined
): string[] {
  if (!project?.timeline) {
    return [];
  }

  const mediaIds = new Set<string>();
  collectMediaIdsFromItems(project.timeline.items, mediaIds);

  for (const composition of project.timeline.compositions ?? []) {
    collectMediaIdsFromItems(composition.items, mediaIds);
  }

  return [...mediaIds];
}

/**
 * Associate media with a project.
 */
export async function associateMediaWithProject(
  projectId: string,
  mediaId: string
): Promise<void> {
  try {
    const db = await getDB();
    const association: ProjectMediaAssociation = {
      projectId,
      mediaId,
      addedAt: Date.now(),
    };
    await db.put('projectMedia', association);
  } catch (error) {
    logger.error(
      `Failed to associate media ${mediaId} with project ${projectId}:`,
      error
    );
    throw error;
  }
}

/**
 * Remove media association from a project.
 */
export async function removeMediaFromProject(
  projectId: string,
  mediaId: string
): Promise<void> {
  try {
    const db = await getDB();
    await db.delete('projectMedia', [projectId, mediaId]);
  } catch (error) {
    logger.error(
      `Failed to remove media ${mediaId} from project ${projectId}:`,
      error
    );
    throw error;
  }
}

/**
 * Get all media IDs associated with a project.
 */
export async function getProjectMediaIds(projectId: string): Promise<string[]> {
  try {
    const db = await getDB();
    const tx = db.transaction('projectMedia', 'readonly');
    const index = tx.store.index('projectId');
    const associations = await index.getAll(projectId);
    return associations.map((a) => a.mediaId);
  } catch (error) {
    logger.error(`Failed to get media for project ${projectId}:`, error);
    throw new Error(`Failed to get project media: ${projectId}`);
  }
}

/**
 * Get all project IDs that use a specific media item.
 */
export async function getProjectsUsingMedia(mediaId: string): Promise<string[]> {
  try {
    const db = await getDB();
    const tx = db.transaction('projectMedia', 'readonly');
    const index = tx.store.index('mediaId');
    const associations = await index.getAll(mediaId);
    return associations.map((a) => a.projectId);
  } catch (error) {
    logger.error(`Failed to get projects using media ${mediaId}:`, error);
    throw new Error(`Failed to get projects for media: ${mediaId}`);
  }
}

/**
 * Get all media metadata for a project.
 * Also cleans up orphaned projectMedia entries where the media no longer exists.
 */
export async function getMediaForProject(
  projectId: string
): Promise<MediaMetadata[]> {
  try {
    const db = await getDB();
    const existingMediaIds = await getProjectMediaIds(projectId);
    const project = await getProject(projectId);
    const referencedMediaIds = collectProjectTimelineMediaIds(project);
    const mediaIds = [...existingMediaIds];
    const associatedMediaIds = new Set(existingMediaIds);

    if (referencedMediaIds.length > 0) {
      const missingAssociationIds = referencedMediaIds.filter((id) => !associatedMediaIds.has(id));

      for (const mediaId of missingAssociationIds) {
        const media = await db.get('media', mediaId);
        if (!media) {
          continue;
        }

        await db.put('projectMedia', {
          projectId,
          mediaId,
          addedAt: Date.now(),
        } satisfies ProjectMediaAssociation);
        mediaIds.push(mediaId);
        associatedMediaIds.add(mediaId);
      }

      if (missingAssociationIds.length > 0) {
        logger.info(
          `Recovered ${Math.max(0, mediaIds.length - existingMediaIds.length)} missing projectMedia association(s) for project ${projectId}`
        );
      }
    }

    const media: MediaMetadata[] = [];
    const orphanedIds: string[] = [];

    for (const id of mediaIds) {
      const item = await db.get('media', id);
      if (item) {
        media.push(item);
      } else {
        orphanedIds.push(id);
      }
    }

    if (orphanedIds.length > 0) {
      logger.warn(
        `Cleaning up ${orphanedIds.length} orphaned projectMedia entries for project ${projectId}`
      );
      for (const mediaId of orphanedIds) {
        try {
          await db.delete('projectMedia', [projectId, mediaId]);
        } catch (error) {
          logger.warn(
            `Failed to clean up orphaned entry for media ${mediaId}:`,
            error
          );
        }
      }
    }

    return media;
  } catch (error) {
    logger.error(`Failed to get media for project ${projectId}:`, error);
    throw new Error(`Failed to load project media: ${projectId}`);
  }
}
