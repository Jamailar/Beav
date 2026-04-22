import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MediaMetadata, ProjectMediaAssociation } from '@/types/storage';

const dbState = vi.hoisted(() => ({
  mediaById: new Map<string, MediaMetadata>(),
  projectMedia: [] as ProjectMediaAssociation[],
}));

const connectionMocks = vi.hoisted(() => ({
  getDB: vi.fn(),
}));

const projectMocks = vi.hoisted(() => ({
  getProject: vi.fn(),
}));

vi.mock('./connection', () => ({
  getDB: connectionMocks.getDB,
}));

vi.mock('./projects', () => ({
  getProject: projectMocks.getProject,
}));

vi.mock('@/shared/logging/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import { collectProjectTimelineMediaIds, getMediaForProject } from './project-media';

function createMedia(id: string): MediaMetadata {
  return {
    id,
    storageType: 'opfs',
    opfsPath: `content/${id}`,
    fileName: `${id}.mp4`,
    fileSize: 1024,
    mimeType: 'video/mp4',
    duration: 1,
    width: 1920,
    height: 1080,
    fps: 30,
    codec: 'h264',
    bitrate: 1000,
    tags: [],
    createdAt: 1,
    updatedAt: 1,
  };
}

describe('project-media legacy recovery', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbState.mediaById = new Map<string, MediaMetadata>();
    dbState.projectMedia = [];

    connectionMocks.getDB.mockResolvedValue({
      transaction: () => ({
        store: {
          index: (name: 'projectId' | 'mediaId') => ({
            getAll: async (value: string) =>
              dbState.projectMedia.filter((association) => association[name] === value),
          }),
        },
      }),
      get: async (storeName: string, id: string) => {
        if (storeName === 'media') {
          return dbState.mediaById.get(id);
        }
        return undefined;
      },
      put: async (storeName: string, value: ProjectMediaAssociation) => {
        if (storeName !== 'projectMedia') {
          return;
        }

        const existingIndex = dbState.projectMedia.findIndex(
          (association) =>
            association.projectId === value.projectId && association.mediaId === value.mediaId
        );

        if (existingIndex === -1) {
          dbState.projectMedia.push(value);
        } else {
          dbState.projectMedia[existingIndex] = value;
        }
      },
      delete: async (storeName: string, key: [string, string]) => {
        if (storeName !== 'projectMedia') {
          return;
        }

        const [projectId, mediaId] = key;
        dbState.projectMedia = dbState.projectMedia.filter(
          (association) =>
            association.projectId !== projectId || association.mediaId !== mediaId
        );
      },
    });
  });

  it('collects unique media IDs from root and nested compositions', () => {
    const mediaIds = collectProjectTimelineMediaIds({
      timeline: {
        tracks: [],
        items: [
          {
            id: 'root-video',
            type: 'video',
            trackId: 'v1',
            from: 0,
            durationInFrames: 30,
            label: 'Root video',
            mediaId: 'media-root',
          },
          {
            id: 'root-text',
            type: 'text',
            trackId: 'v1',
            from: 0,
            durationInFrames: 30,
            label: 'Title',
          },
        ],
        compositions: [{
          id: 'comp-1',
          name: 'Nested',
          fps: 30,
          width: 1920,
          height: 1080,
          durationInFrames: 60,
          tracks: [],
          items: [
            {
              id: 'comp-audio',
              type: 'audio',
              trackId: 'a1',
              from: 0,
              durationInFrames: 60,
              label: 'Nested audio',
              mediaId: 'media-nested',
            },
            {
              id: 'comp-image',
              type: 'image',
              trackId: 'v1',
              from: 0,
              durationInFrames: 60,
              label: 'Nested image',
              mediaId: 'media-root',
            },
          ],
        }],
      },
    }).sort();

    expect(mediaIds).toEqual(['media-nested', 'media-root']);
  });

  it('backfills missing projectMedia associations from legacy timeline references', async () => {
    dbState.mediaById.set('media-existing', createMedia('media-existing'));
    dbState.mediaById.set('media-recovered', createMedia('media-recovered'));
    dbState.projectMedia = [{
      projectId: 'project-1',
      mediaId: 'media-existing',
      addedAt: 1,
    }];
    projectMocks.getProject.mockResolvedValue({
      id: 'project-1',
      timeline: {
        tracks: [],
        items: [
          {
            id: 'root-video',
            type: 'video',
            trackId: 'v1',
            from: 0,
            durationInFrames: 30,
            label: 'Root video',
            mediaId: 'media-existing',
          },
        ],
        compositions: [{
          id: 'comp-1',
          name: 'Nested',
          fps: 30,
          width: 1920,
          height: 1080,
          durationInFrames: 60,
          tracks: [],
          items: [
            {
              id: 'comp-audio',
              type: 'audio',
              trackId: 'a1',
              from: 0,
              durationInFrames: 60,
              label: 'Nested audio',
              mediaId: 'media-recovered',
            },
          ],
        }],
      },
    });

    const media = await getMediaForProject('project-1');

    expect(media.map((item) => item.id).sort()).toEqual([
      'media-existing',
      'media-recovered',
    ]);
    expect(
      dbState.projectMedia.some(
        (association) =>
          association.projectId === 'project-1' && association.mediaId === 'media-recovered'
      )
    ).toBe(true);
  });

  it('does not create associations for missing media metadata', async () => {
    dbState.mediaById.set('media-existing', createMedia('media-existing'));
    projectMocks.getProject.mockResolvedValue({
      id: 'project-1',
      timeline: {
        tracks: [],
        items: [
          {
            id: 'root-video',
            type: 'video',
            trackId: 'v1',
            from: 0,
            durationInFrames: 30,
            label: 'Root video',
            mediaId: 'media-existing',
          },
          {
            id: 'root-audio',
            type: 'audio',
            trackId: 'a1',
            from: 0,
            durationInFrames: 30,
            label: 'Missing audio',
            mediaId: 'media-missing',
          },
        ],
      },
    });

    const media = await getMediaForProject('project-1');

    expect(media.map((item) => item.id)).toEqual(['media-existing']);
    expect(
      dbState.projectMedia.some(
        (association) =>
          association.projectId === 'project-1' && association.mediaId === 'media-missing'
      )
    ).toBe(false);
  });
});
