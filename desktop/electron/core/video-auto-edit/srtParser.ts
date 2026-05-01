import type { SrtSegment, SrtSegmentTag } from '../../../shared/videoAutoEdit';

const TIMECODE_PATTERN = /(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})\s*-->\s*(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})/;

function normalizeMsPart(value: string): number {
  const padded = String(value || '0').padEnd(3, '0').slice(0, 3);
  return Number(padded) || 0;
}

export function parseSrtTimestamp(value: string): number {
  const match = String(value || '').trim().match(/^(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})$/);
  if (!match) {
    throw new Error(`Invalid SRT timestamp: ${value}`);
  }
  const hours = Number(match[1]) || 0;
  const minutes = Number(match[2]) || 0;
  const seconds = Number(match[3]) || 0;
  return (hours * 60 * 60 * 1000) + (minutes * 60 * 1000) + (seconds * 1000) + normalizeMsPart(match[4]);
}

export function formatSrtTimestamp(ms: number): string {
  const safeMs = Math.max(0, Math.round(Number(ms) || 0));
  const hours = Math.floor(safeMs / 3600000);
  const minutes = Math.floor((safeMs % 3600000) / 60000);
  const seconds = Math.floor((safeMs % 60000) / 1000);
  const milliseconds = safeMs % 1000;
  return [
    String(hours).padStart(2, '0'),
    String(minutes).padStart(2, '0'),
    String(seconds).padStart(2, '0'),
  ].join(':') + `,${String(milliseconds).padStart(3, '0')}`;
}

function buildSegmentId(trackId: string, index: number, startMs: number, endMs: number): string {
  return `${trackId}_seg_${String(index).padStart(5, '0')}_${startMs}_${endMs}`;
}

function normalizeTags(tags?: unknown): SrtSegmentTag[] {
  if (!Array.isArray(tags)) return [];
  const allowed = new Set<SrtSegmentTag>(['keep', 'remove', 'highlight', 'hook', 'filler', 'unclear']);
  return Array.from(new Set(tags.map((item) => String(item || '').trim()).filter((item): item is SrtSegmentTag => allowed.has(item as SrtSegmentTag))));
}

export function parseSrt(input: string, options: {
  assetId: string;
  trackId: string;
}): SrtSegment[] {
  const text = String(input || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
  if (!text) return [];

  const blocks = text.split(/\n{2,}/g);
  const segments: SrtSegment[] = [];

  for (const block of blocks) {
    const lines = block.split('\n').map((line) => line.trimEnd()).filter((line) => line.trim().length > 0);
    if (lines.length < 2) continue;

    const timeLineIndex = lines.findIndex((line) => TIMECODE_PATTERN.test(line));
    if (timeLineIndex < 0) continue;

    const timeMatch = lines[timeLineIndex].match(TIMECODE_PATTERN);
    if (!timeMatch) continue;

    const indexCandidate = Number(lines[Math.max(0, timeLineIndex - 1)]);
    const startMs = parseSrtTimestamp(`${timeMatch[1]}:${timeMatch[2]}:${timeMatch[3]},${timeMatch[4]}`);
    const rawEndMs = parseSrtTimestamp(`${timeMatch[5]}:${timeMatch[6]}:${timeMatch[7]},${timeMatch[8]}`);
    const endMs = Math.max(startMs + 1, rawEndMs);
    const subtitleText = lines.slice(timeLineIndex + 1).join('\n').trim();

    if (!subtitleText) continue;

    const index = Number.isFinite(indexCandidate) && indexCandidate > 0
      ? indexCandidate
      : segments.length + 1;

    segments.push({
      id: buildSegmentId(options.trackId, index, startMs, endMs),
      index,
      assetId: options.assetId,
      startMs,
      endMs,
      text: subtitleText,
      confidence: null,
      speaker: null,
      tags: [],
    });
  }

  return normalizeSrtSegments(segments, options);
}

export function normalizeSrtSegments(segments: SrtSegment[], options: {
  assetId: string;
  trackId: string;
}): SrtSegment[] {
  const sorted = [...segments]
    .filter((segment) => Number.isFinite(segment.startMs) && Number.isFinite(segment.endMs) && String(segment.text || '').trim())
    .sort((left, right) => left.startMs - right.startMs || left.endMs - right.endMs);

  return sorted.map((segment, index) => {
    const previous = index > 0 ? sorted[index - 1] : null;
    const startMs = Math.max(0, Math.round(Number(segment.startMs) || 0));
    const minimumEnd = startMs + 1;
    const nextEnd = Math.max(minimumEnd, Math.round(Number(segment.endMs) || minimumEnd));
    const correctedStart = previous && startMs < previous.endMs ? previous.endMs : startMs;
    const correctedEnd = Math.max(correctedStart + 1, nextEnd);
    const displayIndex = index + 1;
    return {
      ...segment,
      id: segment.id || buildSegmentId(options.trackId, displayIndex, correctedStart, correctedEnd),
      index: displayIndex,
      assetId: segment.assetId || options.assetId,
      startMs: correctedStart,
      endMs: correctedEnd,
      text: String(segment.text || '').trim(),
      tags: normalizeTags(segment.tags),
    };
  });
}

export function serializeSegmentsToSrt(segments: SrtSegment[]): string {
  return normalizeSrtSegments(segments, {
    assetId: segments[0]?.assetId || 'asset',
    trackId: 'edited',
  }).map((segment, index) => [
    String(index + 1),
    `${formatSrtTimestamp(segment.startMs)} --> ${formatSrtTimestamp(segment.endMs)}`,
    segment.text,
  ].join('\n')).join('\n\n') + '\n';
}
