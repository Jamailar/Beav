import type { ClipboardCaptureCandidate } from './captureTypes';
import { clipboardCaptureDedupeKey } from './clipboardDetector';

const STORAGE_KEY = 'redbox:clipboard-capture-dedupe:v1';
const DEFAULT_TTL_MS = 10 * 60 * 1000;

type DedupeRecord = Record<string, number>;

function nowMs(): number {
  return Date.now();
}

function readRecords(): DedupeRecord {
  if (typeof window === 'undefined') return {};
  try {
    const parsed = JSON.parse(window.localStorage.getItem(STORAGE_KEY) || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as DedupeRecord : {};
  } catch {
    return {};
  }
}

function writeRecords(records: DedupeRecord): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(records));
  } catch {
    // Ignore storage failures; in-memory flow still works for the current turn.
  }
}

class ClipboardCaptureDedupeStore {
  private readonly seen = new Map<string, number>();

  has(candidate: ClipboardCaptureCandidate, ttlMs = DEFAULT_TTL_MS): boolean {
    const key = clipboardCaptureDedupeKey(candidate);
    this.hydrate();
    this.prune(ttlMs);
    const timestamp = this.seen.get(key);
    return typeof timestamp === 'number' && nowMs() - timestamp < ttlMs;
  }

  mark(candidate: ClipboardCaptureCandidate): void {
    this.hydrate();
    this.seen.set(clipboardCaptureDedupeKey(candidate), nowMs());
    this.persist();
  }

  private hydrate(): void {
    if (this.seen.size > 0) return;
    const records = readRecords();
    for (const [key, timestamp] of Object.entries(records)) {
      if (Number.isFinite(timestamp)) this.seen.set(key, Number(timestamp));
    }
  }

  private prune(ttlMs: number): void {
    const cutoff = nowMs() - ttlMs;
    let changed = false;
    for (const [key, timestamp] of this.seen.entries()) {
      if (timestamp < cutoff) {
        this.seen.delete(key);
        changed = true;
      }
    }
    if (changed) this.persist();
  }

  private persist(): void {
    const records: DedupeRecord = {};
    for (const [key, timestamp] of this.seen.entries()) {
      records[key] = timestamp;
    }
    writeRecords(records);
  }
}

export const clipboardCaptureDedupeStore = new ClipboardCaptureDedupeStore();
