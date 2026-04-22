import path from 'node:path';
import fs from 'node:fs/promises';
import { getWorkspacePaths, getUserMemories as getDbUserMemories } from '../db';

export type MemoryType = 'general' | 'preference' | 'fact';
export type MemoryStatus = 'active' | 'archived';
export type MemoryHistoryAction = 'create' | 'update' | 'dedupe' | 'archive' | 'delete' | 'access';
export type MemoryMutationSource = 'user' | 'system' | 'maintenance';

export interface FileUserMemory {
  id: string;
  content: string;
  type: MemoryType;
  tags: string[];
  created_at: number;
  updated_at: number;
  last_accessed?: number;
  status?: MemoryStatus;
  archived_at?: number;
  archive_reason?: string;
  origin_id?: string;
  canonical_key?: string;
  revision?: number;
  last_conflict_at?: number;
}

export interface MemoryHistoryEntry {
  id: string;
  memory_id: string;
  origin_id: string;
  action: MemoryHistoryAction;
  reason?: string;
  timestamp: number;
  before?: Partial<FileUserMemory>;
  after?: Partial<FileUserMemory>;
  archived_memory_id?: string;
}

export interface MemorySearchResult extends FileUserMemory {
  score: number;
  matchReasons: string[];
}

export interface MemoryMutationEvent {
  action: Exclude<MemoryHistoryAction, 'access'>;
  source: MemoryMutationSource;
  memoryId?: string;
  originId?: string;
  reason?: string;
  timestamp: number;
}

interface MemoryFileData {
  version: number;
  updatedAt: number;
  memories: FileUserMemory[];
  history: MemoryHistoryEntry[];
}

const MEMORY_DIR = 'memory';
const MEMORY_FILE = 'user-memories.json';
const CURATED_MEMORY_FILE = 'MEMORY.md';
const ARCHIVE_MEMORY_FILE = 'MEMORY_ARCHIVE.md';
const MAX_ACTIVE_MEMORY_ITEMS = 500;
const MAX_ARCHIVED_MEMORY_ITEMS = 1000;
const MAX_HISTORY_ITEMS = 3000;
const memoryMutationListeners = new Set<(event: MemoryMutationEvent) => void>();

const now = (): number => Date.now();

const normalizeType = (type: unknown): MemoryType => {
  if (type === 'preference' || type === 'fact') return type;
  return 'general';
};

const normalizeStatus = (status: unknown): MemoryStatus => {
  return status === 'archived' ? 'archived' : 'active';
};

const uniqueTags = (tags: unknown): string[] => {
  if (!Array.isArray(tags)) return [];
  const set = new Set<string>();
  for (const tag of tags) {
    const value = String(tag || '').trim();
    if (!value) continue;
    set.add(value);
  }
  return Array.from(set);
};

const memoryFilePath = (): string => {
  const base = getWorkspacePaths().base;
  return path.join(base, MEMORY_DIR, MEMORY_FILE);
};

const curatedMemoryFilePath = (): string => {
  const base = getWorkspacePaths().base;
  return path.join(base, MEMORY_DIR, CURATED_MEMORY_FILE);
};

const archiveMemoryFilePath = (): string => {
  const base = getWorkspacePaths().base;
  return path.join(base, MEMORY_DIR, ARCHIVE_MEMORY_FILE);
};

const defaultData = (): MemoryFileData => ({
  version: 2,
  updatedAt: now(),
  memories: [],
  history: [],
});

const ensureDir = async (): Promise<void> => {
  await fs.mkdir(path.dirname(memoryFilePath()), { recursive: true });
};

const formatDateTime = (timestamp: number): string => {
  const date = new Date(Number(timestamp || Date.now()));
  if (Number.isNaN(date.getTime())) return new Date().toISOString();
  return date.toISOString();
};

const normalizeContentForDedup = (content: string): string => {
  return content
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, '')
    .trim();
};

const extractMemoryKey = (content: string): string => {
  const text = String(content || '').trim();
  if (!text) return '';

  const delimiters = ['：', ':', '=', '=>', '->', '是', '为'];
  for (const delimiter of delimiters) {
    const idx = text.indexOf(delimiter);
    if (idx > 0 && idx <= 40) {
      return text.slice(0, idx).trim().toLowerCase();
    }
  }

  return '';
};

const memoryWeight = (memory: FileUserMemory): number => {
  if (memory.status === 'archived') return -10;
  if (memory.type === 'preference' || memory.type === 'fact') return 2;
  return 1;
};

const mergeTags = (left: string[], right: string[]): string[] => {
  return uniqueTags([...left, ...right]);
};

const sortMemories = (memories: FileUserMemory[]): FileUserMemory[] => {
  return [...memories].sort((a, b) => {
    const w = memoryWeight(b) - memoryWeight(a);
    if (w !== 0) return w;
    const leftTime = b.status === 'archived' ? (b.archived_at || b.updated_at) : b.updated_at;
    const rightTime = a.status === 'archived' ? (a.archived_at || a.updated_at) : a.updated_at;
    return leftTime - rightTime;
  });
};

const activeMemoriesOf = (memories: FileUserMemory[]): FileUserMemory[] => {
  return memories.filter((memory) => normalizeStatus(memory.status) !== 'archived');
};

const archivedMemoriesOf = (memories: FileUserMemory[]): FileUserMemory[] => {
  return memories.filter((memory) => normalizeStatus(memory.status) === 'archived');
};

const createHistoryId = (): string => {
  return `mev_${now()}_${Math.random().toString(36).slice(2, 8)}`;
};

const generateMemoryId = (): string => {
  return `mem_${now()}_${Math.random().toString(36).slice(2, 8)}`;
};

const createArchiveSnapshot = (memory: FileUserMemory, reason: string): FileUserMemory => {
  const timestamp = now();
  const originId = memory.origin_id || memory.id;
  return {
    ...memory,
    id: `${originId}__arch_${timestamp}_${Math.random().toString(36).slice(2, 6)}`,
    status: 'archived',
    archived_at: timestamp,
    archive_reason: reason,
    origin_id: originId,
  };
};

const appendHistory = (
  data: MemoryFileData,
  entry: Omit<MemoryHistoryEntry, 'id' | 'timestamp'> & Partial<Pick<MemoryHistoryEntry, 'timestamp'>>
): void => {
  data.history.push({
    id: createHistoryId(),
    timestamp: entry.timestamp || now(),
    ...entry,
  });
  if (data.history.length > MAX_HISTORY_ITEMS) {
    data.history = data.history.slice(-MAX_HISTORY_ITEMS);
  }
};

const emitMemoryMutation = (event: MemoryMutationEvent): void => {
  for (const listener of memoryMutationListeners) {
    try {
      listener(event);
    } catch (error) {
      console.warn('[MemoryStore] memory mutation listener failed:', error);
    }
  }
};

export function addMemoryMutationListener(listener: (event: MemoryMutationEvent) => void): () => void {
  memoryMutationListeners.add(listener);
  return () => {
    memoryMutationListeners.delete(listener);
  };
}

const normalizeMemory = (item: any): FileUserMemory | null => {
  const content = String(item?.content || '').trim();
  if (!content) return null;
  const canonicalKey = extractMemoryKey(content);
  const status = normalizeStatus(item?.status);
  const id = String(item?.id || generateMemoryId());
  const originId = String(item?.origin_id || (status === 'archived' ? id.split('__arch_')[0] || id : id));

  return {
    id,
    content,
    type: normalizeType(item?.type),
    tags: uniqueTags(item?.tags),
    created_at: Number(item?.created_at || now()),
    updated_at: Number(item?.updated_at || now()),
    last_accessed: item?.last_accessed ? Number(item.last_accessed) : undefined,
    status,
    archived_at: item?.archived_at ? Number(item.archived_at) : undefined,
    archive_reason: item?.archive_reason ? String(item.archive_reason) : undefined,
    origin_id: originId,
    canonical_key: String(item?.canonical_key || canonicalKey || ''),
    revision: Math.max(1, Number(item?.revision || 1)),
    last_conflict_at: item?.last_conflict_at ? Number(item.last_conflict_at) : undefined,
  };
};

const normalizeHistoryEntry = (item: any): MemoryHistoryEntry | null => {
  const action = String(item?.action || '').trim() as MemoryHistoryAction;
  const memoryId = String(item?.memory_id || '').trim();
  const originId = String(item?.origin_id || '').trim() || memoryId;
  if (!memoryId || !originId) return null;
  if (!['create', 'update', 'dedupe', 'archive', 'delete', 'access'].includes(action)) return null;
  return {
    id: String(item?.id || createHistoryId()),
    memory_id: memoryId,
    origin_id: originId,
    action,
    reason: item?.reason ? String(item.reason) : undefined,
    timestamp: Number(item?.timestamp || now()),
    before: item?.before && typeof item.before === 'object' ? item.before : undefined,
    after: item?.after && typeof item.after === 'object' ? item.after : undefined,
    archived_memory_id: item?.archived_memory_id ? String(item.archived_memory_id) : undefined,
  };
};

const dedupeActiveMemories = (activeMemories: FileUserMemory[], data: MemoryFileData): FileUserMemory[] => {
  const byExact = new Map<string, FileUserMemory>();
  const byKey = new Map<string, FileUserMemory>();

  for (const raw of sortMemories(activeMemories)) {
    const contentNorm = normalizeContentForDedup(raw.content);
    const scopedType = normalizeType(raw.type);
    const key = raw.canonical_key || extractMemoryKey(raw.content);
    const keyBucket = (scopedType === 'fact' || scopedType === 'preference') && key
      ? `${scopedType}::${key}`
      : '';

    const exactHit = contentNorm ? byExact.get(contentNorm) : undefined;
    if (exactHit) {
      exactHit.tags = mergeTags(exactHit.tags, raw.tags);
      exactHit.updated_at = Math.max(exactHit.updated_at, raw.updated_at);
      exactHit.last_accessed = Math.max(exactHit.last_accessed || 0, raw.last_accessed || 0);
      exactHit.revision = Math.max(exactHit.revision || 1, raw.revision || 1);
      if (exactHit.type === 'general' && scopedType !== 'general') {
        exactHit.type = scopedType;
      }
      if (keyBucket) {
        byKey.set(keyBucket, exactHit);
      }
      appendHistory(data, {
        memory_id: exactHit.id,
        origin_id: exactHit.origin_id || exactHit.id,
        action: 'dedupe',
        reason: 'normalized-exact-merge',
        before: { id: raw.id, content: raw.content, type: raw.type, tags: raw.tags },
        after: { id: exactHit.id, content: exactHit.content, type: exactHit.type, tags: exactHit.tags },
      });
      continue;
    }

    if (keyBucket && byKey.has(keyBucket)) {
      const keyHit = byKey.get(keyBucket)!;
      const archivedSnapshot = createArchiveSnapshot(raw, 'startup-key-merge');
      keyHit.tags = mergeTags(keyHit.tags, raw.tags);
      keyHit.updated_at = Math.max(keyHit.updated_at, raw.updated_at);
      keyHit.last_accessed = Math.max(keyHit.last_accessed || 0, raw.last_accessed || 0);
      keyHit.revision = Math.max(keyHit.revision || 1, raw.revision || 1);
      data.memories.push(archivedSnapshot);
      appendHistory(data, {
        memory_id: keyHit.id,
        origin_id: keyHit.origin_id || keyHit.id,
        action: 'archive',
        reason: 'startup-key-conflict-normalized',
        before: { id: raw.id, content: raw.content, type: raw.type, tags: raw.tags },
        after: { id: keyHit.id, content: keyHit.content, type: keyHit.type, tags: keyHit.tags },
        archived_memory_id: archivedSnapshot.id,
      });
      if (contentNorm) {
        byExact.set(contentNorm, keyHit);
      }
      continue;
    }

    const next: FileUserMemory = {
      ...raw,
      type: scopedType,
      tags: uniqueTags(raw.tags),
      status: 'active',
      origin_id: raw.origin_id || raw.id,
      canonical_key: key || '',
      revision: Math.max(1, raw.revision || 1),
    };
    if (contentNorm) {
      byExact.set(contentNorm, next);
    }
    if (keyBucket) {
      byKey.set(keyBucket, next);
    }
  }

  const deduped = sortMemories(Array.from(new Set(byExact.values())));
  const kept = deduped.slice(0, MAX_ACTIVE_MEMORY_ITEMS);
  const overflow = deduped.slice(MAX_ACTIVE_MEMORY_ITEMS);
  for (const item of overflow) {
    const archivedSnapshot = createArchiveSnapshot(item, 'capacity-prune');
    data.memories.push(archivedSnapshot);
    appendHistory(data, {
      memory_id: archivedSnapshot.id,
      origin_id: archivedSnapshot.origin_id || item.id,
      action: 'archive',
      reason: 'capacity-prune',
      after: { ...archivedSnapshot },
    });
  }
  return kept;
};

const normalizeAndPruneData = (data: MemoryFileData): MemoryFileData => {
  const history = Array.isArray(data.history)
    ? data.history.map(normalizeHistoryEntry).filter((item): item is MemoryHistoryEntry => Boolean(item)).slice(-MAX_HISTORY_ITEMS)
    : [];

  const normalizedMemories = Array.isArray(data.memories)
    ? data.memories.map(normalizeMemory).filter((item): item is FileUserMemory => Boolean(item))
    : [];

  const archived = sortMemories(archivedMemoriesOf(normalizedMemories)).slice(0, MAX_ARCHIVED_MEMORY_ITEMS);
  const nextData: MemoryFileData = {
    version: 2,
    updatedAt: now(),
    memories: archived,
    history,
  };
  const active = dedupeActiveMemories(activeMemoriesOf(normalizedMemories), nextData);
  nextData.memories = [...active, ...sortMemories(archivedMemoriesOf(nextData.memories)).slice(0, MAX_ARCHIVED_MEMORY_ITEMS)];
  return nextData;
};

const buildCuratedMemoryMarkdown = (memories: FileUserMemory[]): string => {
  const selected = sortMemories(memories).slice(0, 120);
  const preference = selected.filter((item) => item.type === 'preference');
  const fact = selected.filter((item) => item.type === 'fact');
  const general = selected.filter((item) => item.type === 'general');

  const renderSection = (title: string, items: FileUserMemory[]): string[] => {
    if (items.length === 0) {
      return [`## ${title}`, '(暂无)'];
    }

    return [
      `## ${title}`,
      ...items.map((item) => {
        const tags = item.tags.length > 0 ? ` [${item.tags.join(', ')}]` : '';
        const revision = (item.revision || 1) > 1 ? ` · rev ${item.revision}` : '';
        return `- ${item.content}${tags}${revision} (updated: ${formatDateTime(item.updated_at)})`;
      }),
    ];
  };

  return [
    '# MEMORY.md',
    '',
    '这个文件是用户长期记忆摘要（当前有效版本，可人工编辑）。',
    '自动生成时间：' + new Date().toISOString(),
    '',
    ...renderSection('偏好 Preferences', preference),
    '',
    ...renderSection('事实 Facts', fact),
    '',
    ...renderSection('其他 General', general),
    '',
    '> 说明：本文件只展示当前有效记忆。若同一主题发生更新或冲突，系统会保留旧版本到 MEMORY_ARCHIVE.md，并以最新明确指令为准。',
  ].join('\n');
};

const buildArchiveMemoryMarkdown = (memories: FileUserMemory[], history: MemoryHistoryEntry[]): string => {
  const archived = sortMemories(memories).slice(0, 200);
  const recentHistory = [...history].sort((a, b) => b.timestamp - a.timestamp).slice(0, 80);

  return [
    '# MEMORY_ARCHIVE.md',
    '',
    '这个文件记录已归档的旧版本记忆、冲突覆盖与去重轨迹。',
    '自动生成时间：' + new Date().toISOString(),
    '',
    '## Archived Memories',
    ...(archived.length === 0 ? ['(暂无)'] : archived.map((item) => {
      const tags = item.tags.length > 0 ? ` [${item.tags.join(', ')}]` : '';
      const reason = item.archive_reason ? ` · reason=${item.archive_reason}` : '';
      return `- ${item.content}${tags}${reason} (origin: ${item.origin_id || item.id}, archived: ${formatDateTime(item.archived_at || item.updated_at)})`;
    })),
    '',
    '## Recent History',
    ...(recentHistory.length === 0 ? ['(暂无)'] : recentHistory.map((entry) => {
      return `- ${formatDateTime(entry.timestamp)} · ${entry.action} · origin=${entry.origin_id}${entry.reason ? ` · ${entry.reason}` : ''}`;
    })),
  ].join('\n');
};

const syncCuratedMemoryMarkdown = async (memories: FileUserMemory[], history: MemoryHistoryEntry[]): Promise<void> => {
  await ensureDir();

  const activeFilePath = curatedMemoryFilePath();
  const activeTempPath = `${activeFilePath}.tmp`;
  const activeMarkdown = buildCuratedMemoryMarkdown(activeMemoriesOf(memories));
  await fs.writeFile(activeTempPath, activeMarkdown, 'utf-8');
  await fs.rename(activeTempPath, activeFilePath);

  const archiveFilePath = archiveMemoryFilePath();
  const archiveTempPath = `${archiveFilePath}.tmp`;
  const archiveMarkdown = buildArchiveMemoryMarkdown(archivedMemoriesOf(memories), history);
  await fs.writeFile(archiveTempPath, archiveMarkdown, 'utf-8');
  await fs.rename(archiveTempPath, archiveFilePath);
};

const readData = async (): Promise<MemoryFileData> => {
  const filePath = memoryFilePath();
  try {
    const raw = await fs.readFile(filePath, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<MemoryFileData>;
    return normalizeAndPruneData({
      version: Number(parsed.version || 1),
      updatedAt: Number(parsed.updatedAt || now()),
      memories: Array.isArray(parsed.memories) ? parsed.memories as FileUserMemory[] : [],
      history: Array.isArray(parsed.history) ? parsed.history as MemoryHistoryEntry[] : [],
    });
  } catch {
    return defaultData();
  }
};

const writeData = async (data: MemoryFileData): Promise<void> => {
  await ensureDir();
  const filePath = memoryFilePath();
  const payload = normalizeAndPruneData(data);
  const tempPath = `${filePath}.tmp`;
  await fs.writeFile(tempPath, JSON.stringify(payload, null, 2), 'utf-8');
  await fs.rename(tempPath, filePath);
  await syncCuratedMemoryMarkdown(payload.memories, payload.history);
};

const migrateFromDbIfNeeded = async (): Promise<void> => {
  const filePath = memoryFilePath();
  try {
    await fs.access(filePath);
    return;
  } catch {
    // continue migration
  }

  const dbMemories = getDbUserMemories();
  if (!dbMemories.length) {
    await writeData(defaultData());
    return;
  }

  const migrated: FileUserMemory[] = dbMemories.map((m) => ({
    id: m.id,
    content: m.content,
    type: normalizeType(m.type),
    tags: uniqueTags(m.tags),
    created_at: m.created_at,
    updated_at: m.updated_at,
    last_accessed: m.last_accessed,
    status: 'active',
    origin_id: m.id,
    canonical_key: extractMemoryKey(m.content),
    revision: 1,
  }));
  await writeData({
    version: 2,
    updatedAt: now(),
    memories: migrated,
    history: [],
  });
};

const looksSensitiveMemory = (content: string): boolean => {
  const text = String(content || '');
  if (!text) return false;
  const patterns = [
    /sk-[a-z0-9]{16,}/i,
    /Bearer\s+[A-Za-z0-9\-_.=]{16,}/i,
    /ghp_[A-Za-z0-9]{20,}/i,
    /AKIA[0-9A-Z]{16}/,
    /sessionid[=:]\s*[A-Za-z0-9%_.\-]{10,}/i,
    /api[_ -]?key[=:：]\s*[A-Za-z0-9_\-]{10,}/i,
    /token[=:：]\s*[A-Za-z0-9_\-]{10,}/i,
  ];
  return patterns.some((pattern) => pattern.test(text));
};

const ensureMemoryContentAllowed = (content: string): void => {
  const normalized = String(content || '').trim();
  if (!normalized) {
    throw new Error('记忆内容不能为空');
  }
  if (looksSensitiveMemory(normalized)) {
    throw new Error('检测到疑似敏感凭据，拒绝写入长期记忆');
  }
};

const findActiveMemoryById = (data: MemoryFileData, id: string): FileUserMemory | undefined => {
  return data.memories.find((item) => item.id === id && normalizeStatus(item.status) !== 'archived');
};

export async function listUserMemoriesFromFile(): Promise<FileUserMemory[]> {
  await migrateFromDbIfNeeded();
  const data = await readData();
  await syncCuratedMemoryMarkdown(data.memories, data.history);
  return sortMemories(activeMemoriesOf(data.memories));
}

export async function listArchivedMemoriesFromFile(): Promise<FileUserMemory[]> {
  await migrateFromDbIfNeeded();
  const data = await readData();
  await syncCuratedMemoryMarkdown(data.memories, data.history);
  return sortMemories(archivedMemoriesOf(data.memories));
}

export async function listMemoryHistoryFromFile(originId?: string): Promise<MemoryHistoryEntry[]> {
  await migrateFromDbIfNeeded();
  const data = await readData();
  const history = [...data.history].sort((a, b) => b.timestamp - a.timestamp);
  if (!originId) return history;
  return history.filter((item) => item.origin_id === originId || item.memory_id === originId);
}

export async function searchUserMemoriesInFile(query: string, options?: {
  includeArchived?: boolean;
  limit?: number;
}): Promise<MemorySearchResult[]> {
  await migrateFromDbIfNeeded();
  const normalizedQuery = String(query || '').trim().toLowerCase();
  if (!normalizedQuery) return [];

  const data = await readData();
  const tokens = normalizedQuery.split(/\s+/).map((item) => item.trim()).filter(Boolean);
  const source = options?.includeArchived
    ? [...data.memories]
    : activeMemoriesOf(data.memories);

  const scored = source.map((memory) => {
    const haystack = `${memory.content}\n${memory.tags.join(' ')}\n${memory.type}`.toLowerCase();
    const reasons: string[] = [];
    let score = 0;

    if (memory.content.toLowerCase() === normalizedQuery) {
      score += 120;
      reasons.push('exact-content');
    } else if (memory.content.toLowerCase().includes(normalizedQuery)) {
      score += 80;
      reasons.push('content-contains');
    }

    if (memory.tags.some((tag) => tag.toLowerCase() === normalizedQuery)) {
      score += 60;
      reasons.push('tag-exact');
    }

    if (memory.type.toLowerCase() === normalizedQuery) {
      score += 40;
      reasons.push('type-exact');
    }

    for (const token of tokens) {
      if (!token) continue;
      if (haystack.includes(token)) {
        score += 12;
      }
    }

    if (memory.canonical_key && normalizedQuery.includes(memory.canonical_key.toLowerCase())) {
      score += 24;
      reasons.push('canonical-key');
    }

    const freshnessBoost = Math.max(0, 10 - Math.floor((Date.now() - Number(memory.updated_at || memory.created_at || Date.now())) / (1000 * 60 * 60 * 24 * 7)));
    score += freshnessBoost;

    return {
      ...memory,
      score,
      matchReasons: Array.from(new Set(reasons)),
    };
  }).filter((item) => item.score > 0);

  return scored
    .sort((a, b) => b.score - a.score || b.updated_at - a.updated_at)
    .slice(0, Math.max(1, Math.min(100, Number(options?.limit || 20))));
}

export async function addUserMemoryToFile(
  content: string,
  type: MemoryType = 'general',
  tags: string[] = [],
  options?: { source?: MemoryMutationSource; reason?: string }
): Promise<FileUserMemory> {
  await migrateFromDbIfNeeded();
  const data = await readData();
  const timestamp = now();
  const normalizedContent = String(content || '').trim();
  ensureMemoryContentAllowed(normalizedContent);

  const item: FileUserMemory = {
    id: generateMemoryId(),
    content: normalizedContent,
    type: normalizeType(type),
    tags: uniqueTags(tags),
    created_at: timestamp,
    updated_at: timestamp,
    last_accessed: timestamp,
    status: 'active',
    origin_id: '',
    canonical_key: extractMemoryKey(normalizedContent),
    revision: 1,
  };
  item.origin_id = item.id;

  const activeMemories = activeMemoriesOf(data.memories);
  const normalized = normalizeContentForDedup(item.content);
  const exactHit = normalized
    ? activeMemories.find((existing) => normalizeContentForDedup(existing.content) === normalized)
    : undefined;

  if (exactHit) {
    const before = { ...exactHit };
    exactHit.tags = mergeTags(exactHit.tags, item.tags);
    exactHit.updated_at = timestamp;
    exactHit.last_accessed = timestamp;
    exactHit.revision = Math.max(1, exactHit.revision || 1);
    if (exactHit.type === 'general' && item.type !== 'general') {
      exactHit.type = item.type;
    }
    appendHistory(data, {
      memory_id: exactHit.id,
      origin_id: exactHit.origin_id || exactHit.id,
      action: 'dedupe',
      reason: 'exact-duplicate-merge',
      before,
      after: { ...exactHit },
    });
    await writeData(data);
    emitMemoryMutation({
      action: 'dedupe',
      source: options?.source || 'user',
      memoryId: exactHit.id,
      originId: exactHit.origin_id || exactHit.id,
      reason: options?.reason || 'exact-duplicate-merge',
      timestamp,
    });
    return exactHit;
  }

  const canMergeByKey = (item.type === 'preference' || item.type === 'fact') && (item.canonical_key || '').length >= 2;
  if (canMergeByKey) {
    const existing = activeMemories.find((candidate) => {
      if (candidate.type !== item.type) return false;
      return (candidate.canonical_key || extractMemoryKey(candidate.content)) === item.canonical_key;
    });

    if (existing) {
      const before = { ...existing };
      const archivedSnapshot = createArchiveSnapshot(existing, 'superseded-by-latest');
      data.memories.push(archivedSnapshot);
      existing.content = item.content;
      existing.tags = mergeTags(existing.tags, item.tags);
      existing.updated_at = timestamp;
      existing.last_accessed = timestamp;
      existing.canonical_key = item.canonical_key;
      existing.revision = Math.max(1, existing.revision || 1) + 1;
      existing.last_conflict_at = timestamp;
      appendHistory(data, {
        memory_id: existing.id,
        origin_id: existing.origin_id || existing.id,
        action: 'update',
        reason: 'same-key-latest-wins',
        before,
        after: { ...existing },
        archived_memory_id: archivedSnapshot.id,
      });
      appendHistory(data, {
        memory_id: archivedSnapshot.id,
        origin_id: archivedSnapshot.origin_id || existing.id,
        action: 'archive',
        reason: 'same-key-superseded',
        after: { ...archivedSnapshot },
      });
      await writeData(data);
      emitMemoryMutation({
        action: 'update',
        source: options?.source || 'user',
        memoryId: existing.id,
        originId: existing.origin_id || existing.id,
        reason: options?.reason || 'same-key-latest-wins',
        timestamp,
      });
      return existing;
    }
  }

  data.memories.push(item);
  appendHistory(data, {
    memory_id: item.id,
    origin_id: item.origin_id || item.id,
    action: 'create',
    reason: 'new-memory',
    after: { ...item },
  });
  await writeData(data);
  emitMemoryMutation({
    action: 'create',
    source: options?.source || 'user',
    memoryId: item.id,
    originId: item.origin_id || item.id,
    reason: options?.reason || 'new-memory',
    timestamp,
  });
  return item;
}

export async function deleteUserMemoryFromFile(
  id: string,
  options?: { source?: MemoryMutationSource; reason?: string }
): Promise<void> {
  await migrateFromDbIfNeeded();
  const data = await readData();
  const existing = data.memories.find((item) => item.id === id);
  if (!existing) return;
  data.memories = data.memories.filter((item) => item.id !== id);
  appendHistory(data, {
    memory_id: existing.id,
    origin_id: existing.origin_id || existing.id,
    action: 'delete',
    reason: 'manual-delete',
    before: { ...existing },
  });
  await writeData(data);
  emitMemoryMutation({
    action: 'delete',
    source: options?.source || 'user',
    memoryId: existing.id,
    originId: existing.origin_id || existing.id,
    reason: options?.reason || 'manual-delete',
    timestamp: now(),
  });
}

export async function updateUserMemoryInFile(
  id: string,
  updates: Partial<Pick<FileUserMemory, 'content' | 'type' | 'tags'>>,
  options?: { source?: MemoryMutationSource; reason?: string }
): Promise<void> {
  await migrateFromDbIfNeeded();
  const data = await readData();
  const current = findActiveMemoryById(data, id);
  if (!current) return;

  const nextContent = updates.content !== undefined ? String(updates.content || '').trim() : current.content;
  ensureMemoryContentAllowed(nextContent);
  const nextType = updates.type !== undefined ? normalizeType(updates.type) : current.type;
  const nextTags = updates.tags !== undefined ? uniqueTags(updates.tags) : current.tags;
  const timestamp = now();
  const before = { ...current };
  const contentChanged = nextContent !== current.content;
  const typeChanged = nextType !== current.type;
  const tagsChanged = JSON.stringify(nextTags) !== JSON.stringify(current.tags);

  if (!contentChanged && !typeChanged && !tagsChanged) {
    return;
  }

  if (contentChanged) {
    const archivedSnapshot = createArchiveSnapshot(current, 'manual-update');
    data.memories.push(archivedSnapshot);
    appendHistory(data, {
      memory_id: archivedSnapshot.id,
      origin_id: archivedSnapshot.origin_id || current.id,
      action: 'archive',
      reason: 'manual-update-snapshot',
      after: { ...archivedSnapshot },
    });
  }

  current.content = nextContent;
  current.type = nextType;
  current.tags = nextTags;
  current.updated_at = timestamp;
  current.last_accessed = timestamp;
  current.canonical_key = extractMemoryKey(nextContent);
  current.revision = Math.max(1, current.revision || 1) + (contentChanged ? 1 : 0);
  if (contentChanged) {
    current.last_conflict_at = timestamp;
  }

  appendHistory(data, {
    memory_id: current.id,
    origin_id: current.origin_id || current.id,
    action: 'update',
    reason: options?.reason || (contentChanged ? 'manual-content-update' : 'manual-metadata-update'),
    before,
    after: { ...current },
  });

  await writeData(data);
  emitMemoryMutation({
    action: 'update',
    source: options?.source || 'user',
    memoryId: current.id,
    originId: current.origin_id || current.id,
    reason: options?.reason || (contentChanged ? 'manual-content-update' : 'manual-metadata-update'),
    timestamp,
  });
}

export async function archiveUserMemoryInFile(
  id: string,
  reason = 'manual-archive',
  options?: { source?: MemoryMutationSource }
): Promise<void> {
  await migrateFromDbIfNeeded();
  const data = await readData();
  const current = findActiveMemoryById(data, id);
  if (!current) return;

  const archivedSnapshot = createArchiveSnapshot(current, reason);
  data.memories = data.memories.filter((item) => item.id !== current.id);
  data.memories.push(archivedSnapshot);
  appendHistory(data, {
    memory_id: archivedSnapshot.id,
    origin_id: archivedSnapshot.origin_id || current.id,
    action: 'archive',
    reason,
    before: { ...current },
    after: { ...archivedSnapshot },
  });
  await writeData(data);
  emitMemoryMutation({
    action: 'archive',
    source: options?.source || 'user',
    memoryId: archivedSnapshot.id,
    originId: archivedSnapshot.origin_id || current.id,
    reason,
    timestamp: now(),
  });
}

export async function markMemoryAccessed(id: string): Promise<void> {
  await migrateFromDbIfNeeded();
  const data = await readData();
  const item = findActiveMemoryById(data, id);
  if (!item) return;
  item.last_accessed = now();
  item.updated_at = now();
  appendHistory(data, {
    memory_id: item.id,
    origin_id: item.origin_id || item.id,
    action: 'access',
    reason: 'prompt-read',
    after: { id: item.id, last_accessed: item.last_accessed, updated_at: item.updated_at },
  });
  await writeData(data);
}

export async function getLongTermMemoryPrompt(maxItems = 30, workspaceBase?: string): Promise<string> {
  const data = workspaceBase
    ? await (async () => {
        const filePath = path.join(workspaceBase, MEMORY_DIR, MEMORY_FILE);
        try {
          const raw = await fs.readFile(filePath, 'utf-8');
          const parsed = JSON.parse(raw) as Partial<MemoryFileData>;
          return normalizeAndPruneData({
            version: Number(parsed.version || 1),
            updatedAt: Number(parsed.updatedAt || now()),
            memories: Array.isArray(parsed.memories) ? parsed.memories as FileUserMemory[] : [],
            history: Array.isArray(parsed.history) ? parsed.history as MemoryHistoryEntry[] : [],
          });
        } catch {
          return defaultData();
        }
      })()
    : await readData();
  const memories = sortMemories(activeMemoriesOf(data.memories));
  const curatedMemoryMarkdown = await (async () => {
    try {
      return await fs.readFile(
        workspaceBase
          ? path.join(workspaceBase, MEMORY_DIR, CURATED_MEMORY_FILE)
          : curatedMemoryFilePath(),
        'utf-8',
      );
    } catch {
      return '';
    }
  })();
  if (!memories.length && !curatedMemoryMarkdown.trim()) return '';

  const selected = memories.slice(0, Math.max(1, maxItems));
  const listPrompt = selected.map((m, index) => {
    const tagText = m.tags.length ? ` [tags: ${m.tags.join(', ')}]` : '';
    const revision = (m.revision || 1) > 1 ? ` [rev: ${m.revision}]` : '';
    return `${index + 1}. [${m.type}] ${m.content}${tagText}${revision}`;
  }).join('\n');

  if (!curatedMemoryMarkdown.trim()) {
    return listPrompt;
  }

  return [
    '<memory_markdown>',
    curatedMemoryMarkdown.slice(0, 16000),
    '</memory_markdown>',
    '',
    '<memory_index>',
    listPrompt,
    '</memory_index>',
    '',
    '<memory_policy>',
    '同一主题若出现冲突，以最新明确指令为准；旧版本会进入归档与历史，不应再当作当前事实使用。',
    '</memory_policy>',
  ].join('\n');
}
