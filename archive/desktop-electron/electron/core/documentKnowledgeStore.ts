import fs from 'node:fs/promises';
import path from 'node:path';

export type DocumentSourceKind = 'copied-file' | 'tracked-folder' | 'obsidian-vault';

export interface DocumentSourceRecord {
  id: string;
  kind: DocumentSourceKind;
  name: string;
  rootPath: string;
  locked: boolean;
  indexing?: boolean;
  indexError?: string;
  indexedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface DocumentFileEntry {
  sourceId: string;
  sourceName: string;
  sourceKind: DocumentSourceKind;
  absolutePath: string;
  relativePath: string;
}

interface WorkspacePathsShape {
  knowledge: string;
}

const SOURCE_FILE_NAME = 'sources.json';
const TEXT_FILE_EXTENSIONS = new Set([
  '.md',
  '.markdown',
  '.mdx',
  '.txt',
  '.text',
]);
const SKIP_DIR_NAMES = new Set([
  '.obsidian',
  '.git',
  'node_modules',
  '.trash',
  '.idea',
  '.vscode',
]);

export const getKnowledgeDocsDir = (paths: WorkspacePathsShape): string => {
  return path.join(paths.knowledge, 'docs');
};

const getKnowledgeDocSourcesFile = (paths: WorkspacePathsShape): string => {
  return path.join(getKnowledgeDocsDir(paths), SOURCE_FILE_NAME);
};

export const getKnowledgeDocsImportedDir = (paths: WorkspacePathsShape): string => {
  return path.join(getKnowledgeDocsDir(paths), 'imported');
};

export const ensureKnowledgeDocsDir = async (paths: WorkspacePathsShape): Promise<void> => {
  await fs.mkdir(getKnowledgeDocsDir(paths), { recursive: true });
  await fs.mkdir(getKnowledgeDocsImportedDir(paths), { recursive: true });
};

const normalizeSource = (raw: unknown): DocumentSourceRecord | null => {
  if (!raw || typeof raw !== 'object') return null;
  const item = raw as Record<string, unknown>;
  const id = String(item.id || '').trim();
  const rawKind = String(item.kind || '').trim();
  const name = String(item.name || '').trim();
  const rootPath = String(item.rootPath || '').trim();
  if (!id || !name || !rootPath) return null;
  const normalizedKind =
    rawKind === 'copied-folder'
      ? 'tracked-folder'
      : rawKind;
  if (normalizedKind !== 'copied-file' && normalizedKind !== 'tracked-folder' && normalizedKind !== 'obsidian-vault') return null;
  return {
    id,
    kind: normalizedKind,
    name,
    rootPath: path.resolve(path.normalize(rootPath)),
    locked: normalizedKind === 'obsidian-vault' ? true : Boolean(item.locked),
    indexing: Boolean(item.indexing),
    indexError: String(item.indexError || '').trim() || undefined,
    indexedAt: String(item.indexedAt || '').trim() || undefined,
    createdAt: String(item.createdAt || new Date().toISOString()),
    updatedAt: String(item.updatedAt || new Date().toISOString()),
  };
};

export const loadDocumentSources = async (paths: WorkspacePathsShape): Promise<DocumentSourceRecord[]> => {
  await ensureKnowledgeDocsDir(paths);
  const sourcePath = getKnowledgeDocSourcesFile(paths);
  try {
    const content = await fs.readFile(sourcePath, 'utf-8');
    const parsed = JSON.parse(content);
    if (!Array.isArray(parsed)) return [];
    return parsed.map(normalizeSource).filter((item): item is DocumentSourceRecord => Boolean(item));
  } catch {
    return [];
  }
};

export const saveDocumentSources = async (paths: WorkspacePathsShape, sources: DocumentSourceRecord[]): Promise<void> => {
  await ensureKnowledgeDocsDir(paths);
  const sourcePath = getKnowledgeDocSourcesFile(paths);
  await fs.writeFile(sourcePath, `${JSON.stringify(sources, null, 2)}\n`, 'utf-8');
};

export const createDocumentSourceId = (): string => {
  return `docsrc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
};

const isTextFilePath = (filePath: string): boolean => {
  const ext = path.extname(filePath).toLowerCase();
  return TEXT_FILE_EXTENSIONS.has(ext);
};

const listTextFilesRecursively = async (rootPath: string, maxFiles: number): Promise<string[]> => {
  const output: string[] = [];
  const queue: string[] = [rootPath];
  while (queue.length > 0 && output.length < maxFiles) {
    const current = queue.shift();
    if (!current) break;
    let entries: Array<{ isDirectory: () => boolean; isFile: () => boolean; name: string }>;
    try {
      entries = (await fs.readdir(current, { withFileTypes: true })) as Array<{ isDirectory: () => boolean; isFile: () => boolean; name: string }>;
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (output.length >= maxFiles) break;
      const entryName = String(entry.name || '');
      const absolutePath = path.join(current, entryName);
      if (entry.isDirectory()) {
        if (SKIP_DIR_NAMES.has(entryName.toLowerCase())) continue;
        queue.push(absolutePath);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!isTextFilePath(absolutePath)) continue;
      output.push(absolutePath);
    }
  }
  return output;
};

export const listDocumentFilesFromSources = async (
  sources: DocumentSourceRecord[],
  options?: { maxFilesPerSource?: number }
): Promise<DocumentFileEntry[]> => {
  const maxFilesPerSource = Math.max(1, Number(options?.maxFilesPerSource || 200));
  const entries: DocumentFileEntry[] = [];
  for (const source of sources) {
    const sourceFiles = await listDocumentFilesForSource(source, { maxFiles: maxFilesPerSource });
    entries.push(...sourceFiles);
  }
  return entries;
};

export const listDocumentFilesForSource = async (
  source: DocumentSourceRecord,
  options?: { maxFiles?: number }
): Promise<DocumentFileEntry[]> => {
  const maxFiles = Math.max(1, Number(options?.maxFiles || 200));
  const rootPath = path.resolve(path.normalize(source.rootPath));
  try {
    const stat = await fs.stat(rootPath);
    if (stat.isFile()) {
      if (!isTextFilePath(rootPath)) return [];
      return [{
        sourceId: source.id,
        sourceName: source.name,
        sourceKind: source.kind,
        absolutePath: rootPath,
        relativePath: path.basename(rootPath),
      }];
    }

    if (!stat.isDirectory()) return [];
    const files = await listTextFilesRecursively(rootPath, maxFiles);
    return files.map((filePath) => ({
      sourceId: source.id,
      sourceName: source.name,
      sourceKind: source.kind,
      absolutePath: filePath,
      relativePath: path.relative(rootPath, filePath) || path.basename(filePath),
    }));
  } catch {
    return [];
  }
};
