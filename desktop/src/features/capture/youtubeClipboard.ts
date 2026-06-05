export interface YouTubeClipboardCandidate {
  videoId: string;
  videoUrl: string;
  rawUrl: string;
}

export function parseYouTubeCandidateFromUrl(rawInput: string): YouTubeClipboardCandidate | null {
  const trimmed = String(rawInput || '').trim();
  if (!trimmed) return null;

  const sanitized = trimmed
    .replace(/[)\]}>,.!?，。！？、]+$/g, '')
    .replace(/^<|>$/g, '');

  let parsed: URL;
  try {
    parsed = new URL(sanitized);
  } catch {
    return null;
  }

  const host = parsed.hostname.toLowerCase();
  const isYouTubeHost = host === 'youtu.be'
    || host.endsWith('.youtu.be')
    || host === 'youtube.com'
    || host.endsWith('.youtube.com');
  if (!isYouTubeHost) return null;

  let videoId = '';
  if (host.includes('youtu.be')) {
    videoId = parsed.pathname.split('/').filter(Boolean)[0] || '';
  } else {
    const pathParts = parsed.pathname.split('/').filter(Boolean);
    if (pathParts[0] === 'watch') {
      videoId = parsed.searchParams.get('v') || '';
    } else if (pathParts[0] === 'shorts' || pathParts[0] === 'embed' || pathParts[0] === 'live') {
      videoId = pathParts[1] || '';
    } else if (pathParts[0] === 'clip') {
      videoId = parsed.searchParams.get('v') || '';
    }
  }

  const normalizedVideoId = videoId.trim();
  if (!normalizedVideoId || !/^[a-zA-Z0-9_-]{6,}$/.test(normalizedVideoId)) {
    return null;
  }

  return {
    videoId: normalizedVideoId,
    videoUrl: `https://www.youtube.com/watch?v=${normalizedVideoId}`,
    rawUrl: sanitized,
  };
}

export function extractYouTubeCandidateFromClipboard(text: string): YouTubeClipboardCandidate | null {
  const raw = String(text || '').trim();
  if (!raw) return null;

  const direct = parseYouTubeCandidateFromUrl(raw);
  if (direct) return direct;

  const matches = raw.match(/https?:\/\/[^\s"'<>]+/gi) || [];
  for (const item of matches) {
    const candidate = parseYouTubeCandidateFromUrl(item);
    if (candidate) return candidate;
  }

  return null;
}
