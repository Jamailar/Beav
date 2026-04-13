import { create } from 'zustand';

type LexBoxMediaItem = {
  id: string;
  name: string;
  src: string;
  mimeType: string;
  duration: number;
  fps: number;
  width?: number;
  height?: number;
  thumbnailUrl?: string;
  blobUrl?: string;
  proxyUrl?: string | null;
  isBroken?: boolean;
  transcriptStatus?: 'idle' | 'processing' | 'ready' | 'error' | null;
};

type MediaPlacementHandle = {
  fileHandle?: FileSystemFileHandle | null;
};

type LexBoxMediaLibraryState = {
  mediaItems: LexBoxMediaItem[];
  mediaById: Record<string, LexBoxMediaItem>;
  importHandlesForPlacement: Record<string, MediaPlacementHandle>;
};

type LexBoxMediaLibraryActions = {
  syncMediaItems: (items: LexBoxMediaItem[]) => void;
};

export type CompositionDragData = {
  mediaId?: string;
  itemIds?: string[];
};

export type TimelineTemplateDragData = CompositionDragData;

export type OrphanedClipInfo = {
  clipId: string;
  mediaId: string;
};

export type ExtractedMediaFileEntry = {
  file: File;
  mediaId: string;
  mimeType: string;
  mediaType: 'video' | 'audio' | 'image';
  label: string;
};

export const useMediaLibraryStore = create<LexBoxMediaLibraryState & LexBoxMediaLibraryActions>((set) => ({
  mediaItems: [],
  mediaById: {},
  importHandlesForPlacement: {},
  syncMediaItems: (mediaItems) => set({
    mediaItems,
    mediaById: Object.fromEntries(mediaItems.map((item) => [item.id, item])),
  }),
}));

export function syncLexBoxMediaLibrary(items: LexBoxMediaItem[]) {
  useMediaLibraryStore.getState().syncMediaItems(items);
}

export function resolveMediaUrl(mediaIdOrUrl: string): string {
  return useMediaLibraryStore.getState().mediaById[mediaIdOrUrl]?.src || mediaIdOrUrl;
}

export function resolveProxyUrl(mediaIdOrUrl: string): string {
  return useMediaLibraryStore.getState().mediaById[mediaIdOrUrl]?.proxyUrl || resolveMediaUrl(mediaIdOrUrl);
}

export async function resolveMediaUrls<T>(value: T): Promise<T> {
  return value;
}

export function cleanupBlobUrls(): void {}

let currentDragData: unknown = null;

export function getMediaDragData() {
  return currentDragData;
}

export function setMediaDragData(data: unknown) {
  currentDragData = data;
}

export function clearMediaDragData() {
  currentDragData = null;
}

export function getMediaType(mimeType: string | undefined): 'video' | 'audio' | 'image' | 'unknown' {
  const normalized = String(mimeType || '').toLowerCase();
  if (normalized.startsWith('video/')) return 'video';
  if (normalized.startsWith('audio/')) return 'audio';
  if (normalized.startsWith('image/')) return 'image';
  return 'unknown';
}

export function getMimeType(file: File): string {
  return file.type || 'application/octet-stream';
}

export async function extractValidMediaFileEntriesFromDataTransfer(dataTransfer: DataTransfer | null) {
  if (!dataTransfer?.files?.length) {
    return { supported: false, entries: [] as ExtractedMediaFileEntry[], errors: [] as string[] };
  }

  const entries = Array.from(dataTransfer.files)
    .map((file) => {
      const mimeType = getMimeType(file);
      const mediaType = getMediaType(mimeType);
      if (mediaType === 'unknown') return null;
      return {
        file,
        mediaId: `${file.name}-${file.size}-${file.lastModified}`,
        mimeType,
        mediaType,
        label: file.name,
      } satisfies ExtractedMediaFileEntry;
    })
    .filter(Boolean) as ExtractedMediaFileEntry[];

  return {
    supported: entries.length > 0,
    entries,
    errors: [] as string[],
  };
}

export function supportsFileSystemDragDrop() {
  return false;
}

export const mediaLibraryService = {
  async getMedia(mediaId: string) {
    return useMediaLibraryStore.getState().mediaById[mediaId] || null;
  },
  async getMediaForProject() {
    return useMediaLibraryStore.getState().mediaItems;
  },
  async getMediaBlobUrl(mediaId: string) {
    const item = useMediaLibraryStore.getState().mediaById[mediaId];
    return item?.blobUrl || item?.src || null;
  },
  async getThumbnailBlobUrl(mediaId: string) {
    return useMediaLibraryStore.getState().mediaById[mediaId]?.thumbnailUrl || null;
  },
};

export const mediaProcessorService = {
  async processMedia(file: File, mimeType: string) {
    return {
      metadata: {
        mimeType,
        duration: 0,
        fps: 30,
        width: 0,
        height: 0,
        title: file.name,
      },
    };
  },
};

export const mediaTranscriptionService = {
  async getTranscript() {
    return null;
  },
  async transcribeMedia() {
    return null;
  },
  async insertTranscriptAsCaptions() {
    return {
      insertedItemCount: 0,
      removedItemCount: 0,
    };
  },
};

export function getMediaTranscriptionModelLabel(model: string) {
  return model || 'disabled';
}

export function getMediaTranscriptionModelOptions() {
  return [{ value: 'disabled', label: 'Disabled' }];
}

export const opfsService = {
  async getFile() {
    return null;
  },
};
