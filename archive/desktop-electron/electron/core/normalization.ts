export interface KnowledgeItem {
  id: string; // Global UUID for vector entry
  sourceId: string; // Original source ID (noteId, videoId, filePath)
  sourceType: 'note' | 'video' | 'file';

  // Core content for embedding & retrieval
  title: string;
  content: string;

  // Unified display metadata (for UI rendering without reading files)
  displayData: {
    coverUrl?: string;
    url?: string;
    author?: string;
    publishDate?: string;
    duration?: string;
    platform?: string;
  };

  // Scope for isolation
  scope: 'user' | 'advisor';
  advisorId?: string;
}

/**
 * Adapter for Redbook/Text Notes
 */
export function normalizeNote(
  noteId: string,
  meta: any,
  content: string
): KnowledgeItem {
  return {
    id: noteId,
    sourceId: noteId,
    sourceType: 'note',
    title: meta.title || 'Untitled Note',
    content: content || meta.content || '',
    displayData: {
      coverUrl: meta.cover || (meta.images && meta.images[0]),
      url: meta.sourceUrl || meta.url,
      author: meta.author,
      publishDate: meta.createdAt,
      platform: 'redbook' // Default or derive
    },
    scope: 'user'
  };
}

/**
 * Adapter for YouTube Videos
 */
export function normalizeVideo(
  videoId: string, // noteId (e.g. youtube_xxx)
  meta: any,
  transcript: string,
  scope: 'user' | 'advisor' = 'user',
  advisorId?: string
): KnowledgeItem {
  return {
    id: videoId,
    sourceId: meta.videoId || videoId,
    sourceType: 'video',
    title: meta.title || 'Untitled Video',
    content: transcript || meta.description || '',
    displayData: {
      coverUrl: meta.thumbnail || meta.thumbnailUrl,
      url: meta.videoUrl || (meta.videoId ? `https://www.youtube.com/watch?v=${meta.videoId}` : undefined),
      author: meta.channelName, // If available
      publishDate: meta.createdAt,
      duration: meta.duration,
      platform: 'youtube'
    },
    scope,
    advisorId
  };
}

/**
 * Adapter for Generic Files (e.g. Advisor knowledge)
 */
export function normalizeFile(
  fileId: string, // Unique ID
  fileName: string,
  content: string,
  scope: 'user' | 'advisor' = 'advisor',
  advisorId?: string
): KnowledgeItem {
  return {
    id: fileId,
    sourceId: fileName, // Use filename as source ID for files
    sourceType: 'file',
    title: fileName,
    content: content,
    displayData: {
      platform: 'file',
      publishDate: new Date().toISOString()
    },
    scope,
    advisorId
  };
}

/**
 * Adapter for Archive Samples
 */
export function normalizeArchiveSample(
  sample: any,
  profile: any
): KnowledgeItem {
  return {
    id: sample.id,
    sourceId: sample.id,
    sourceType: 'file', // Treat as file or note
    title: sample.title || 'Untitled Sample',
    content: sample.content || '',
    displayData: {
      platform: sample.platform || profile.platform,
      url: sample.source_url,
      publishDate: sample.sample_date || sample.created_at,
      // First image if available
      coverUrl: sample.images && sample.images.length > 0 ? sample.images[0] : undefined
    },
    scope: 'user'
  };
}
