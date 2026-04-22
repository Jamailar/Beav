import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { getCoverRootDir } from './coverStudioStore';

export interface CoverTemplateRecord {
  id: string;
  name: string;
  templateImage?: string;
  styleHint: string;
  titleGuide: string;
  promptSwitches?: {
    learnTypography?: boolean;
    learnColorMood?: boolean;
    beautifyFace?: boolean;
    replaceBackground?: boolean;
  };
  model: string;
  quality: string;
  count: number;
  updatedAt: string;
  prompt?: string;
  referenceImages?: string[];
}

interface CoverTemplateCatalog {
  version: 1;
  templates: CoverTemplateRecord[];
}

const DEFAULT_CATALOG: CoverTemplateCatalog = {
  version: 1,
  templates: [],
};

function getCatalogPath(): string {
  return path.join(getCoverRootDir(), 'templates.json');
}

async function ensureTemplateDir(): Promise<void> {
  await fs.mkdir(getCoverRootDir(), { recursive: true });
}

async function readCatalog(): Promise<CoverTemplateCatalog> {
  await ensureTemplateDir();
  try {
    const raw = await fs.readFile(getCatalogPath(), 'utf-8');
    const parsed = JSON.parse(raw) as CoverTemplateCatalog;
    if (!parsed || !Array.isArray(parsed.templates)) {
      return DEFAULT_CATALOG;
    }
    return {
      version: 1,
      templates: parsed.templates.map(normalizeTemplate).filter((item): item is CoverTemplateRecord => Boolean(item)),
    };
  } catch {
    return DEFAULT_CATALOG;
  }
}

async function writeCatalog(catalog: CoverTemplateCatalog): Promise<void> {
  await ensureTemplateDir();
  await fs.writeFile(getCatalogPath(), `${JSON.stringify(catalog, null, 2)}\n`, 'utf-8');
}

function nowIso(): string {
  return new Date().toISOString();
}

function normalizeTemplate(input: unknown): CoverTemplateRecord | null {
  if (!input || typeof input !== 'object') return null;
  const item = input as Record<string, unknown>;
  const name = String(item.name || '').trim();
  if (!name) return null;

  return {
    id: String(item.id || `cover_tpl_${Date.now()}_${randomUUID().slice(0, 8)}`).trim(),
    name,
    templateImage: String(item.templateImage || '').trim() || undefined,
    styleHint: String(item.styleHint || '').trim(),
    titleGuide: String(item.titleGuide || '').trim(),
    promptSwitches: item.promptSwitches && typeof item.promptSwitches === 'object'
      ? item.promptSwitches as CoverTemplateRecord['promptSwitches']
      : undefined,
    model: String(item.model || 'gpt-image-1').trim() || 'gpt-image-1',
    quality: String(item.quality || 'standard').trim() || 'standard',
    count: Math.max(1, Math.min(4, Number(item.count || 1) || 1)),
    updatedAt: String(item.updatedAt || nowIso()),
    prompt: String(item.prompt || '').trim() || undefined,
    referenceImages: Array.isArray(item.referenceImages)
      ? item.referenceImages.map((value) => String(value || '').trim()).filter(Boolean)
      : undefined,
  };
}

export async function listCoverTemplates(): Promise<CoverTemplateRecord[]> {
  const catalog = await readCatalog();
  return [...catalog.templates].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

export async function saveCoverTemplate(input: unknown): Promise<CoverTemplateRecord> {
  const nextTemplate = normalizeTemplate({
    ...(input && typeof input === 'object' ? input : {}),
    updatedAt: nowIso(),
  });
  if (!nextTemplate) {
    throw new Error('Invalid cover template payload');
  }

  const catalog = await readCatalog();
  const nextTemplates = catalog.templates.filter((item) => item.id !== nextTemplate.id);
  nextTemplates.unshift(nextTemplate);
  await writeCatalog({
    version: 1,
    templates: nextTemplates,
  });
  return nextTemplate;
}

export async function deleteCoverTemplate(templateId: string): Promise<CoverTemplateRecord[]> {
  const normalizedId = String(templateId || '').trim();
  const catalog = await readCatalog();
  const nextTemplates = catalog.templates.filter((item) => item.id !== normalizedId);
  await writeCatalog({
    version: 1,
    templates: nextTemplates,
  });
  return nextTemplates;
}

export async function importLegacyCoverTemplates(input: unknown[]): Promise<CoverTemplateRecord[]> {
  const catalog = await readCatalog();
  const merged = new Map<string, CoverTemplateRecord>();

  for (const template of catalog.templates) {
    merged.set(template.id, template);
  }

  for (const raw of input) {
    const normalized = normalizeTemplate(raw);
    if (!normalized) continue;
    merged.set(normalized.id, {
      ...normalized,
      updatedAt: nowIso(),
    });
  }

  const nextTemplates = [...merged.values()].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  await writeCatalog({
    version: 1,
    templates: nextTemplates,
  });
  return nextTemplates;
}
