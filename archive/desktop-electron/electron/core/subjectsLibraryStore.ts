import * as fs from 'fs/promises';
import * as path from 'path';
import { randomUUID } from 'node:crypto';
import { getWorkspacePaths } from '../db';
import { toAppAssetUrl } from './localAssetManager';

export interface SubjectCategory {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
}

export interface SubjectAttribute {
  key: string;
  value: string;
}

export interface SubjectImageInput {
  name?: string;
  dataUrl?: string;
  relativePath?: string;
}

export interface SubjectVoiceInput {
  name?: string;
  dataUrl?: string;
  relativePath?: string;
  scriptText?: string;
}

export interface SubjectRecord {
  id: string;
  name: string;
  categoryId?: string;
  description?: string;
  tags: string[];
  attributes: SubjectAttribute[];
  imagePaths: string[];
  voicePath?: string;
  voiceScript?: string;
  createdAt: string;
  updatedAt: string;
}

export interface SubjectEntry extends SubjectRecord {
  absoluteImagePaths: string[];
  previewUrls: string[];
  primaryPreviewUrl?: string;
  absoluteVoicePath?: string;
  voicePreviewUrl?: string;
}

interface SubjectCatalog {
  version: 1;
  subjects: SubjectRecord[];
}

interface SubjectCategoriesFile {
  version: 1;
  categories: SubjectCategory[];
}

const DEFAULT_CATALOG: SubjectCatalog = {
  version: 1,
  subjects: [],
};

const BUILTIN_SUBJECT_CATEGORIES: SubjectCategory[] = [
  {
    id: 'subject_cat_person',
    name: '人物',
    createdAt: '1970-01-01T00:00:00.000Z',
    updatedAt: '1970-01-01T00:00:00.000Z',
  },
  {
    id: 'subject_cat_product',
    name: '商品',
    createdAt: '1970-01-01T00:00:00.000Z',
    updatedAt: '1970-01-01T00:00:00.000Z',
  },
];

const DEFAULT_CATEGORIES: SubjectCategoriesFile = {
  version: 1,
  categories: [...BUILTIN_SUBJECT_CATEGORIES],
};

function nowIso(): string {
  return new Date().toISOString();
}

function normalizeText(input: unknown): string {
  return String(input || '').trim();
}

function normalizeList(input: unknown): string[] {
  if (Array.isArray(input)) {
    return Array.from(new Set(input.map((item) => normalizeText(item)).filter(Boolean)));
  }
  const raw = normalizeText(input);
  if (!raw) return [];
  return Array.from(new Set(raw.split(',').map((item) => item.trim()).filter(Boolean)));
}

function normalizeAttributes(input: SubjectAttribute[] | unknown): SubjectAttribute[] {
  if (!Array.isArray(input)) return [];
  const seen = new Set<string>();
  const result: SubjectAttribute[] = [];
  for (const item of input) {
    if (!item || typeof item !== 'object') continue;
    const key = normalizeText((item as SubjectAttribute).key);
    const value = normalizeText((item as SubjectAttribute).value);
    if (!key && !value) continue;
    const dedupeKey = `${key}::${value}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    result.push({ key, value });
  }
  return result;
}

function normalizeRelativeStorePath(input: string): string {
  const normalized = path.normalize(String(input || '')).replace(/\\/g, '/').replace(/^\.\/+/, '');
  if (!normalized || normalized === '.' || normalized === '..') {
    throw new Error('Invalid relative path');
  }
  if (normalized.startsWith('../') || normalized.includes('/../')) {
    throw new Error('Path traversal is not allowed');
  }
  return normalized;
}

function sanitizeFileName(input: string): string {
  const normalized = normalizeText(input)
    .replace(/[\\/:*?"<>|]+/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
  return normalized || `image-${Date.now()}`;
}

function buildManagedAssetName(prefix: 'image' | 'voice', ext: string, index?: number): string {
  const stamp = Date.now();
  const suffix = randomUUID().slice(0, 8);
  const ordinal = Number.isFinite(index) ? `-${Number(index) + 1}` : '';
  return `${prefix}-${stamp}${ordinal}-${suffix}.${ext}`;
}

function getSubjectsRootDir(): string {
  const paths = getWorkspacePaths() as ReturnType<typeof getWorkspacePaths> & { subjects?: string };
  return paths.subjects || path.join(paths.base, 'subjects');
}

function getCatalogPath(): string {
  return path.join(getSubjectsRootDir(), 'catalog.json');
}

function getCategoriesPath(): string {
  return path.join(getSubjectsRootDir(), 'categories.json');
}

function getSubjectDir(subjectId: string): string {
  return path.join(getSubjectsRootDir(), subjectId);
}

function getSubjectJsonPath(subjectId: string): string {
  return path.join(getSubjectDir(subjectId), 'subject.json');
}

function getSubjectImagesDir(subjectId: string): string {
  return path.join(getSubjectDir(subjectId), 'images');
}

function getSubjectVoiceDir(subjectId: string): string {
  return path.join(getSubjectDir(subjectId), 'voice');
}

async function ensureSubjectsRoot(): Promise<void> {
  await fs.mkdir(getSubjectsRootDir(), { recursive: true });
}

async function readCatalog(): Promise<SubjectCatalog> {
  await ensureSubjectsRoot();
  try {
    const raw = await fs.readFile(getCatalogPath(), 'utf-8');
    const parsed = JSON.parse(raw) as SubjectCatalog;
    if (parsed && Array.isArray(parsed.subjects)) {
      return {
        version: 1,
        subjects: parsed.subjects.map((item) => normalizeSubjectRecord(item)),
      };
    }
  } catch {
    // ignore
  }
  return DEFAULT_CATALOG;
}

async function writeCatalog(catalog: SubjectCatalog): Promise<void> {
  await ensureSubjectsRoot();
  await fs.writeFile(getCatalogPath(), JSON.stringify(catalog, null, 2), 'utf-8');
}

async function readCategoriesFile(): Promise<SubjectCategoriesFile> {
  await ensureSubjectsRoot();
  try {
    const raw = await fs.readFile(getCategoriesPath(), 'utf-8');
    const parsed = JSON.parse(raw) as SubjectCategoriesFile;
    if (parsed && Array.isArray(parsed.categories)) {
      const normalized = {
        version: 1,
        categories: parsed.categories.map((item) => ({
          id: normalizeText(item.id),
          name: normalizeText(item.name),
          createdAt: normalizeText(item.createdAt) || nowIso(),
          updatedAt: normalizeText(item.updatedAt) || nowIso(),
        })),
      };
      const merged = ensureBuiltinCategories(normalized.categories);
      if (merged.changed) {
        await writeCategoriesFile({ version: 1, categories: merged.categories });
      }
      return {
        version: 1,
        categories: merged.categories,
      };
    }
  } catch {
    // ignore
  }
  await writeCategoriesFile(DEFAULT_CATEGORIES);
  return DEFAULT_CATEGORIES;
}

async function writeCategoriesFile(data: SubjectCategoriesFile): Promise<void> {
  await ensureSubjectsRoot();
  const merged = ensureBuiltinCategories(data.categories);
  await fs.writeFile(getCategoriesPath(), JSON.stringify({
    version: 1,
    categories: merged.categories,
  }, null, 2), 'utf-8');
}

function ensureBuiltinCategories(categories: SubjectCategory[]): { categories: SubjectCategory[]; changed: boolean } {
  const next = [...categories];
  let changed = false;
  for (const builtin of BUILTIN_SUBJECT_CATEGORIES) {
    const byId = next.find((item) => item.id === builtin.id);
    if (!byId) {
      next.unshift({ ...builtin });
      changed = true;
      continue;
    }
    if (byId.name !== builtin.name) {
      byId.name = builtin.name;
      changed = true;
    }
  }
  next.sort((a, b) => {
    const aBuiltin = BUILTIN_SUBJECT_CATEGORIES.some((item) => item.id === a.id) ? 0 : 1;
    const bBuiltin = BUILTIN_SUBJECT_CATEGORIES.some((item) => item.id === b.id) ? 0 : 1;
    if (aBuiltin !== bBuiltin) return aBuiltin - bBuiltin;
    return a.name.localeCompare(b.name, 'zh-CN');
  });
  return { categories: next, changed };
}

function isBuiltinCategoryId(categoryId: string): boolean {
  return BUILTIN_SUBJECT_CATEGORIES.some((item) => item.id === categoryId);
}

function normalizeSubjectRecord(input: SubjectRecord): SubjectRecord {
  return {
    id: normalizeText(input.id),
    name: normalizeText(input.name),
    categoryId: normalizeText(input.categoryId) || undefined,
    description: normalizeText(input.description) || undefined,
    tags: normalizeList(input.tags),
    attributes: normalizeAttributes(input.attributes),
    imagePaths: Array.isArray(input.imagePaths)
      ? input.imagePaths.map((item) => normalizeRelativeStorePath(String(item || ''))).filter(Boolean)
      : [],
    voicePath: normalizeText(input.voicePath) ? normalizeRelativeStorePath(String(input.voicePath || '')) : undefined,
    voiceScript: normalizeText(input.voiceScript) || undefined,
    createdAt: normalizeText(input.createdAt) || nowIso(),
    updatedAt: normalizeText(input.updatedAt) || nowIso(),
  };
}

async function writeSubjectFile(subject: SubjectRecord): Promise<void> {
  const normalized = normalizeSubjectRecord(subject);
  await fs.mkdir(getSubjectImagesDir(normalized.id), { recursive: true });
  await fs.writeFile(getSubjectJsonPath(normalized.id), JSON.stringify(normalized, null, 2), 'utf-8');
}

function extFromMime(mimeType: string): string {
  const lower = mimeType.toLowerCase();
  if (lower.includes('mpeg')) return 'mp3';
  if (lower.includes('wav')) return 'wav';
  if (lower.includes('aac')) return 'aac';
  if (lower.includes('ogg')) return 'ogg';
  if (lower.includes('webm')) return 'webm';
  if (lower.includes('mp4')) return 'm4a';
  if (lower.includes('jpeg') || lower.includes('jpg')) return 'jpg';
  if (lower.includes('webp')) return 'webp';
  if (lower.includes('gif')) return 'gif';
  return 'png';
}

function decodeDataUrl(dataUrl: string): { buffer: Buffer; ext: string } {
  const matched = String(dataUrl || '').match(/^data:(.+?);base64,(.+)$/);
  if (!matched) {
    throw new Error('Invalid data URL');
  }
  return {
    buffer: Buffer.from(matched[2], 'base64'),
    ext: extFromMime(matched[1]),
  };
}

async function materializeSubjectImages(subjectId: string, inputs: SubjectImageInput[] | undefined, existingPaths: string[]): Promise<string[]> {
  const normalizedInputs = Array.isArray(inputs) ? inputs : [];
  if (normalizedInputs.length > 5) {
    throw new Error('A subject can contain at most 5 images');
  }
  const subjectDir = getSubjectDir(subjectId);
  const imagesDir = getSubjectImagesDir(subjectId);
  await fs.mkdir(imagesDir, { recursive: true });

  const nextPaths: string[] = [];
  const keepSet = new Set<string>();
  for (let index = 0; index < normalizedInputs.length; index += 1) {
    const item = normalizedInputs[index];
    const existingRelative = normalizeText(item.relativePath);
    if (existingRelative) {
      const normalizedRelative = normalizeRelativeStorePath(existingRelative);
      const absolute = path.join(subjectDir, normalizedRelative);
      await fs.access(absolute);
      keepSet.add(normalizedRelative);
      nextPaths.push(normalizedRelative);
      continue;
    }

    const dataUrl = normalizeText(item.dataUrl);
    if (!dataUrl) continue;
    const { buffer, ext } = decodeDataUrl(dataUrl);
    const fileName = buildManagedAssetName('image', ext, index);
    const relative = normalizeRelativeStorePath(path.join('images', fileName));
    const absolute = path.join(subjectDir, relative);
    await fs.writeFile(absolute, buffer);
    keepSet.add(relative);
    nextPaths.push(relative);
  }

  for (const oldRelative of existingPaths) {
    if (keepSet.has(oldRelative)) continue;
    const oldAbsolute = path.join(subjectDir, oldRelative);
    await fs.rm(oldAbsolute, { force: true });
  }

  return nextPaths;
}

async function materializeSubjectVoice(subjectId: string, input: SubjectVoiceInput | undefined, existingPath?: string): Promise<{ voicePath?: string; voiceScript?: string }> {
  const subjectDir = getSubjectDir(subjectId);
  const voiceDir = getSubjectVoiceDir(subjectId);
  await fs.mkdir(voiceDir, { recursive: true });

  const normalizedInput = input && typeof input === 'object' ? input : undefined;
  if (!normalizedInput) {
    if (existingPath) {
      const oldAbsolute = path.join(subjectDir, existingPath);
      await fs.rm(oldAbsolute, { force: true });
    }
    return {};
  }

  const existingRelative = normalizeText(normalizedInput.relativePath);
  const scriptText = normalizeText(normalizedInput.scriptText) || undefined;
  if (existingRelative) {
    const normalizedRelative = normalizeRelativeStorePath(existingRelative);
    const absolute = path.join(subjectDir, normalizedRelative);
    await fs.access(absolute);
    if (existingPath && existingPath !== normalizedRelative) {
      await fs.rm(path.join(subjectDir, existingPath), { force: true });
    }
    return { voicePath: normalizedRelative, voiceScript: scriptText };
  }

  const dataUrl = normalizeText(normalizedInput.dataUrl);
  if (!dataUrl) {
    if (existingPath) {
      const oldAbsolute = path.join(subjectDir, existingPath);
      await fs.rm(oldAbsolute, { force: true });
    }
    return { voiceScript: scriptText };
  }

  const { buffer, ext } = decodeDataUrl(dataUrl);
  const fileName = buildManagedAssetName('voice', ext);
  const relative = normalizeRelativeStorePath(path.join('voice', fileName));
  const absolute = path.join(subjectDir, relative);
  await fs.writeFile(absolute, buffer);
  if (existingPath && existingPath !== relative) {
    await fs.rm(path.join(subjectDir, existingPath), { force: true });
  }
  return { voicePath: relative, voiceScript: scriptText };
}

async function enrichSubject(subject: SubjectRecord): Promise<SubjectEntry> {
  const subjectDir = getSubjectDir(subject.id);
  const absoluteImagePaths = subject.imagePaths.map((relative) => path.join(subjectDir, relative));
  const previewUrls: string[] = [];
  const existingAbsoluteImagePaths: string[] = [];
  for (const absolute of absoluteImagePaths) {
    try {
      await fs.access(absolute);
      existingAbsoluteImagePaths.push(absolute);
      previewUrls.push(toAppAssetUrl(absolute));
    } catch {
      // ignore missing image
    }
  }
  let absoluteVoicePath: string | undefined;
  let voicePreviewUrl: string | undefined;
  if (subject.voicePath) {
    const voiceAbsolute = path.join(subjectDir, subject.voicePath);
    try {
      await fs.access(voiceAbsolute);
      absoluteVoicePath = voiceAbsolute;
      voicePreviewUrl = toAppAssetUrl(voiceAbsolute);
    } catch {
      // ignore missing voice
    }
  }
  return {
    ...subject,
    absoluteImagePaths: existingAbsoluteImagePaths,
    previewUrls,
    primaryPreviewUrl: previewUrls[0],
    absoluteVoicePath,
    voicePreviewUrl,
  };
}

export async function listSubjectCategories(): Promise<SubjectCategory[]> {
  const data = await readCategoriesFile();
  return [...data.categories].sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
}

export async function createSubjectCategory(name: string): Promise<SubjectCategory> {
  const normalizedName = normalizeText(name);
  if (!normalizedName) {
    throw new Error('Category name is required');
  }
  const data = await readCategoriesFile();
  const exists = data.categories.some((item) => item.name.toLowerCase() === normalizedName.toLowerCase());
  if (exists) {
    throw new Error(`Category already exists: ${normalizedName}`);
  }
  const category: SubjectCategory = {
    id: `subject_cat_${Date.now()}_${randomUUID().slice(0, 8)}`,
    name: normalizedName,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
  data.categories.push(category);
  await writeCategoriesFile(data);
  return category;
}

export async function updateSubjectCategory(input: { id: string; name: string }): Promise<SubjectCategory> {
  const normalizedId = normalizeText(input.id);
  const normalizedName = normalizeText(input.name);
  if (!normalizedId || !normalizedName) {
    throw new Error('Category id and name are required');
  }
  if (isBuiltinCategoryId(normalizedId)) {
    throw new Error('默认分类不能重命名');
  }
  const data = await readCategoriesFile();
  const category = data.categories.find((item) => item.id === normalizedId);
  if (!category) {
    throw new Error('Category not found');
  }
  const duplicate = data.categories.find((item) => item.id !== normalizedId && item.name.toLowerCase() === normalizedName.toLowerCase());
  if (duplicate) {
    throw new Error(`Category already exists: ${normalizedName}`);
  }
  category.name = normalizedName;
  category.updatedAt = nowIso();
  await writeCategoriesFile(data);
  return category;
}

export async function deleteSubjectCategory(id: string): Promise<void> {
  const normalizedId = normalizeText(id);
  if (!normalizedId) {
    throw new Error('Category id is required');
  }
  if (isBuiltinCategoryId(normalizedId)) {
    throw new Error('默认分类不能删除');
  }
  const catalog = await readCatalog();
  const usedBy = catalog.subjects.find((item) => item.categoryId === normalizedId);
  if (usedBy) {
    throw new Error(`Category is still used by subject: ${usedBy.name}`);
  }
  const data = await readCategoriesFile();
  const next = data.categories.filter((item) => item.id !== normalizedId);
  if (next.length === data.categories.length) {
    throw new Error('Category not found');
  }
  await writeCategoriesFile({ version: 1, categories: next });
}

export async function listSubjects(limit = 500): Promise<SubjectEntry[]> {
  const catalog = await readCatalog();
  const sorted = [...catalog.subjects].sort((a, b) => {
    return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
  });
  const items = sorted.slice(0, Math.max(1, limit));
  return Promise.all(items.map((item) => enrichSubject(item)));
}

export async function getSubject(id: string): Promise<SubjectEntry> {
  const normalizedId = normalizeText(id);
  if (!normalizedId) {
    throw new Error('Subject id is required');
  }
  const raw = await fs.readFile(getSubjectJsonPath(normalizedId), 'utf-8');
  const subject = normalizeSubjectRecord(JSON.parse(raw) as SubjectRecord);
  return enrichSubject(subject);
}

export async function createSubject(input: {
  name: string;
  categoryId?: string;
  description?: string;
  tags?: string[] | string;
  attributes?: SubjectAttribute[];
  images?: SubjectImageInput[];
  voice?: SubjectVoiceInput;
}): Promise<SubjectEntry> {
  const name = normalizeText(input.name);
  if (!name) {
    throw new Error('Subject name is required');
  }
  const id = `subject_${Date.now()}_${randomUUID().slice(0, 8)}`;
  const subject: SubjectRecord = {
    id,
    name,
    categoryId: normalizeText(input.categoryId) || undefined,
    description: normalizeText(input.description) || undefined,
    tags: normalizeList(input.tags),
    attributes: normalizeAttributes(input.attributes),
    imagePaths: [],
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
  subject.imagePaths = await materializeSubjectImages(id, input.images, []);
  const voiceResult = await materializeSubjectVoice(id, input.voice, undefined);
  subject.voicePath = voiceResult.voicePath;
  subject.voiceScript = voiceResult.voiceScript;
  await writeSubjectFile(subject);
  const catalog = await readCatalog();
  catalog.subjects.push(subject);
  await writeCatalog(catalog);
  return enrichSubject(subject);
}

export async function updateSubject(input: {
  id: string;
  name?: string;
  categoryId?: string;
  description?: string;
  tags?: string[] | string;
  attributes?: SubjectAttribute[];
  images?: SubjectImageInput[];
  voice?: SubjectVoiceInput;
}): Promise<SubjectEntry> {
  const existing = await getSubject(input.id);
  const next: SubjectRecord = {
    ...existing,
    name: input.name !== undefined ? normalizeText(input.name) || existing.name : existing.name,
    categoryId: input.categoryId !== undefined ? normalizeText(input.categoryId) || undefined : existing.categoryId,
    description: input.description !== undefined ? normalizeText(input.description) || undefined : existing.description,
    tags: input.tags !== undefined ? normalizeList(input.tags) : existing.tags,
    attributes: input.attributes !== undefined ? normalizeAttributes(input.attributes) : existing.attributes,
    imagePaths: existing.imagePaths,
    voicePath: existing.voicePath,
    voiceScript: existing.voiceScript,
    updatedAt: nowIso(),
  };
  if (!next.name) {
    throw new Error('Subject name is required');
  }
  if (input.images !== undefined) {
    next.imagePaths = await materializeSubjectImages(existing.id, input.images, existing.imagePaths);
  }
  if (input.voice !== undefined) {
    const voiceResult = await materializeSubjectVoice(existing.id, input.voice, existing.voicePath);
    next.voicePath = voiceResult.voicePath;
    next.voiceScript = voiceResult.voiceScript;
  }
  await writeSubjectFile(next);
  const catalog = await readCatalog();
  const index = catalog.subjects.findIndex((item) => item.id === existing.id);
  if (index === -1) {
    catalog.subjects.push(next);
  } else {
    catalog.subjects[index] = next;
  }
  await writeCatalog(catalog);
  return enrichSubject(next);
}

export async function deleteSubject(id: string): Promise<void> {
  const normalizedId = normalizeText(id);
  if (!normalizedId) {
    throw new Error('Subject id is required');
  }
  const catalog = await readCatalog();
  const nextSubjects = catalog.subjects.filter((item) => item.id !== normalizedId);
  if (nextSubjects.length === catalog.subjects.length) {
    throw new Error('Subject not found');
  }
  await writeCatalog({ version: 1, subjects: nextSubjects });
  await fs.rm(getSubjectDir(normalizedId), { recursive: true, force: true });
}

export async function searchSubjects(query: string, options?: { categoryId?: string; limit?: number }): Promise<SubjectEntry[]> {
  const normalizedQuery = normalizeText(query).toLowerCase();
  const categoryId = normalizeText(options?.categoryId) || '';
  const all = await listSubjects(Math.max(1, options?.limit || 500));
  if (!normalizedQuery && !categoryId) {
    return all.slice(0, Math.max(1, options?.limit || 200));
  }
  const scored = all
    .filter((item) => !categoryId || item.categoryId === categoryId)
    .map((item) => {
      const haystack = [
        item.name,
        item.description || '',
        item.tags.join(' '),
        item.attributes.map((attr) => `${attr.key} ${attr.value}`).join(' '),
        item.categoryId || '',
      ].join('\n').toLowerCase();
      let score = 0;
      if (!normalizedQuery) {
        score = 1;
      } else {
        if (item.name.toLowerCase().includes(normalizedQuery)) score += 8;
        if ((item.description || '').toLowerCase().includes(normalizedQuery)) score += 4;
        if (item.tags.some((tag) => tag.toLowerCase().includes(normalizedQuery))) score += 3;
        if (item.attributes.some((attr) => `${attr.key} ${attr.value}`.toLowerCase().includes(normalizedQuery))) score += 2;
        if (haystack.includes(normalizedQuery)) score += 1;
      }
      return { item, score };
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return new Date(b.item.updatedAt).getTime() - new Date(a.item.updatedAt).getTime();
    });
  return scored.slice(0, Math.max(1, options?.limit || 50)).map((entry) => entry.item);
}
