import type { ClipboardCaptureCandidate, ClipboardCaptureSource } from '../captureTypes';
import { hostnameMatches, parseHttpUrl, sanitizeClipboardUrl } from '../clipboardUrlExtractor';

function candidateId(kind: string, key: string): string {
  return `${kind}:${key}`;
}

export function detectYouTubeClipboardCandidate(
  rawUrl: string,
  rawText: string,
  source: ClipboardCaptureSource,
): ClipboardCaptureCandidate | null {
  const sanitized = sanitizeClipboardUrl(rawUrl);
  const parsed = parseHttpUrl(sanitized);
  if (!parsed || !hostnameMatches(parsed, ['youtube.com', 'youtu.be'])) return null;

  const host = parsed.hostname.toLowerCase();
  const pathParts = parsed.pathname.split('/').filter(Boolean);
  let videoId = '';

  if (host === 'youtu.be' || host.endsWith('.youtu.be')) {
    videoId = pathParts[0] || '';
  } else if (pathParts[0] === 'watch') {
    videoId = parsed.searchParams.get('v') || '';
  } else if (pathParts[0] === 'shorts' || pathParts[0] === 'embed' || pathParts[0] === 'live') {
    videoId = pathParts[1] || '';
  } else if (pathParts[0] === 'clip') {
    videoId = parsed.searchParams.get('v') || '';
  }

  const normalizedVideoId = videoId.trim();
  if (!normalizedVideoId || !/^[a-zA-Z0-9_-]{6,}$/.test(normalizedVideoId)) return null;

  return {
    id: candidateId('youtube-video', normalizedVideoId),
    kind: 'youtube-video',
    platform: 'youtube',
    rawText,
    rawUrl: sanitized,
    canonicalUrl: `https://www.youtube.com/watch?v=${normalizedVideoId}`,
    externalId: normalizedVideoId,
    confidence: 'exact',
    source,
    detectedAt: new Date().toISOString(),
    title: `YouTube_${normalizedVideoId}`,
  };
}
