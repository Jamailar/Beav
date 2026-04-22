import { layout, prepare } from '@chenglou/pretext';
import {
  inspectRichpostHtmlLayout,
  loadRichpostPreviewHtml,
  type RichpostLayoutInspection,
  type RichpostZoneLayoutInspection,
} from './richpostPreviewImage';

type RichpostPreviewPageLike = {
  exists?: boolean | null;
  file?: string | null;
};

type RichpostPackageStateLike = {
  richpostPages?: RichpostPreviewPageLike[] | null;
  richpostPagePlanFile?: string | null;
};

type RichpostZoneFragment = {
  sourceBlockId?: string;
  kind?: string;
  level?: number | null;
  text?: string;
  continuedFromPrevious?: boolean;
  continuesToNext?: boolean;
};

type RichpostZoneAssignment = {
  blockIds?: string[];
  assetIds?: string[];
  fragments?: RichpostZoneFragment[];
};

type RichpostPlanPage = {
  id?: string;
  master?: string;
  template?: string;
  blockIds?: string[];
  assetIds?: string[];
  zones?: Record<string, RichpostZoneAssignment>;
  styleOverrides?: Record<string, unknown>;
};

type RichpostPlan = {
  version?: number;
  title?: string;
  generatedAt?: number;
  source?: string;
  pageCount?: number;
  pages: RichpostPlanPage[];
};

type RichpostOverflowFinding = {
  pageIndex: number;
  zoneName: 'title' | 'body';
  inspection: RichpostLayoutInspection;
};

const MAX_RICHPOST_PAGINATION_CORRECTIONS = 24;
const DEFAULT_RICHPOST_TEMPLATE = 'text-stack';
const DEFAULT_RICHPOST_MASTER = 'body';

function clonePlan(plan: RichpostPlan): RichpostPlan {
  return JSON.parse(JSON.stringify(plan)) as RichpostPlan;
}

function parseRichpostPlan(raw: unknown): RichpostPlan | null {
  if (!raw || typeof raw !== 'object') return null;
  const pages = Array.isArray((raw as { pages?: unknown[] }).pages)
    ? (raw as { pages: unknown[] }).pages.filter((page) => page && typeof page === 'object') as RichpostPlanPage[]
    : [];
  if (pages.length === 0) return null;
  return {
    ...(raw as Record<string, unknown>),
    pages,
  } as RichpostPlan;
}

async function readRichpostPlan(planFile: string | null | undefined): Promise<RichpostPlan | null> {
  if (!String(planFile || '').trim()) {
    return null;
  }
  const result = await window.ipcRenderer.invoke('manuscripts:read', String(planFile).trim()) as { content?: string };
  const content = String(result?.content || '').trim();
  if (!content) {
    return null;
  }
  try {
    return parseRichpostPlan(JSON.parse(content));
  } catch (error) {
    console.warn('Failed to parse richpost page plan:', error);
    return null;
  }
}

function ensureZones(page: RichpostPlanPage): Record<string, RichpostZoneAssignment> {
  if (!page.zones || typeof page.zones !== 'object') {
    page.zones = {};
  }
  return page.zones;
}

function ensureZone(page: RichpostPlanPage, zoneName: string): RichpostZoneAssignment {
  const zones = ensureZones(page);
  if (!zones[zoneName] || typeof zones[zoneName] !== 'object') {
    zones[zoneName] = {};
  }
  return zones[zoneName];
}

function normalizeStringArray(items: unknown): string[] {
  if (!Array.isArray(items)) return [];
  return items
    .map((item) => (typeof item === 'string' ? item.trim() : ''))
    .filter(Boolean);
}

function normalizeFragments(items: unknown): RichpostZoneFragment[] {
  if (!Array.isArray(items)) return [];
  return items
    .filter((item) => item && typeof item === 'object')
    .map((item) => ({ ...(item as RichpostZoneFragment) }));
}

function pageHasVisibleContent(page: RichpostPlanPage): boolean {
  const zones = ensureZones(page);
  return Object.values(zones).some((zone) => {
    const blockIds = normalizeStringArray(zone.blockIds);
    const assetIds = normalizeStringArray(zone.assetIds);
    const fragments = normalizeFragments(zone.fragments);
    return blockIds.length > 0 || assetIds.length > 0 || fragments.length > 0;
  });
}

function recomputePageBlockIds(page: RichpostPlanPage) {
  const zones = ensureZones(page);
  const orderedIds: string[] = [];
  const pushId = (value: string) => {
    if (!value || orderedIds.includes(value)) return;
    orderedIds.push(value);
  };
  for (const zoneName of ['title', 'body', 'media', 'footer', 'background', 'overlay', 'decoration']) {
    const zone = zones[zoneName];
    if (!zone) continue;
    for (const blockId of normalizeStringArray(zone.blockIds)) {
      pushId(blockId);
    }
    for (const fragment of normalizeFragments(zone.fragments)) {
      const sourceBlockId = typeof fragment.sourceBlockId === 'string' ? fragment.sourceBlockId.trim() : '';
      if (sourceBlockId) {
        pushId(sourceBlockId);
      }
    }
  }
  page.blockIds = orderedIds;
  page.assetIds = normalizeStringArray(page.assetIds);
}

function normalizePlanBookkeeping(plan: RichpostPlan) {
  plan.pages = plan.pages.filter((page) => pageHasVisibleContent(page));
  if (plan.pages.length === 0) {
    plan.pages = [{
      id: 'page-001',
      master: DEFAULT_RICHPOST_MASTER,
      template: DEFAULT_RICHPOST_TEMPLATE,
      blockIds: [],
      assetIds: [],
      zones: {},
    }];
  }
  plan.pages.forEach((page, index) => {
    page.id = `page-${String(index + 1).padStart(3, '0')}`;
    page.template = String(page.template || DEFAULT_RICHPOST_TEMPLATE);
    page.assetIds = normalizeStringArray(page.assetIds);
    recomputePageBlockIds(page);
  });
  if (plan.pages.length > 1) {
    plan.pages.forEach((page, index) => {
      if (index === 0) {
        page.master = 'cover';
      } else if (index === plan.pages.length - 1) {
        page.master = 'ending';
      } else {
        page.master = 'body';
      }
    });
  } else {
    plan.pages[0].master = String(plan.pages[0].master || DEFAULT_RICHPOST_MASTER);
  }
  plan.pageCount = plan.pages.length;
}

function ensureNextPage(plan: RichpostPlan, pageIndex: number, templateHint: string): RichpostPlanPage {
  if (plan.pages[pageIndex + 1]) {
    return plan.pages[pageIndex + 1];
  }
  const nextPage: RichpostPlanPage = {
    id: '',
    master: DEFAULT_RICHPOST_MASTER,
    template: templateHint || DEFAULT_RICHPOST_TEMPLATE,
    blockIds: [],
    assetIds: [],
    zones: {},
  };
  plan.pages.splice(pageIndex + 1, 0, nextPage);
  return nextPage;
}

function prependZoneFragment(zone: RichpostZoneAssignment, fragment: RichpostZoneFragment) {
  const fragments = normalizeFragments(zone.fragments);
  fragments.unshift(fragment);
  zone.fragments = fragments;
}

function prependZoneBlockId(zone: RichpostZoneAssignment, blockId: string) {
  const blockIds = normalizeStringArray(zone.blockIds);
  blockIds.unshift(blockId);
  zone.blockIds = blockIds;
}

function popLastZoneFragment(zone: RichpostZoneAssignment): RichpostZoneFragment | null {
  const fragments = normalizeFragments(zone.fragments);
  const fragment = fragments.pop() || null;
  zone.fragments = fragments;
  return fragment;
}

function popLastZoneBlockId(zone: RichpostZoneAssignment): string | null {
  const blockIds = normalizeStringArray(zone.blockIds);
  const blockId = blockIds.pop() || null;
  zone.blockIds = blockIds;
  return blockId;
}

function selectMeasurementFont(
  fragment: RichpostZoneFragment,
  zoneMetrics: RichpostZoneLayoutInspection,
): { font: string; lineHeightPx: number } {
  if (fragment.kind === 'heading') {
    return {
      font: zoneMetrics.font,
      lineHeightPx: zoneMetrics.lineHeightPx,
    };
  }
  return {
    font: zoneMetrics.paragraphFont || zoneMetrics.font,
    lineHeightPx: zoneMetrics.paragraphLineHeightPx || zoneMetrics.lineHeightPx,
  };
}

function measureTextHeightPx(
  text: string,
  font: string,
  widthPx: number,
  lineHeightPx: number,
): number {
  const prepared = prepare(text, font, {
    whiteSpace: 'pre-wrap',
  });
  return layout(prepared, Math.max(1, widthPx), Math.max(1, lineHeightPx)).height;
}

function findNaturalSplitIndex(chars: string[], preferredIndex: number): number {
  const punctuation = new Set(['。', '！', '？', '；', ';', '，', '、', ',', '：', ':', '）', ')', ']', '】', '》']);
  const whitespace = new Set([' ', '\t', '\n']);
  const minIndex = Math.max(1, preferredIndex - 32);
  for (let index = preferredIndex; index >= minIndex; index -= 1) {
    const previous = chars[index - 1];
    if (punctuation.has(previous) || whitespace.has(previous)) {
      return index;
    }
  }
  return preferredIndex;
}

function splitFragmentTextToFit(
  text: string,
  font: string,
  widthPx: number,
  lineHeightPx: number,
  maxHeightPx: number,
): { head: string; tail: string } | null {
  const chars = Array.from(text);
  if (chars.length < 2 || maxHeightPx <= lineHeightPx) {
    return null;
  }
  let low = 1;
  let high = chars.length - 1;
  let best = 0;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const candidate = chars.slice(0, middle).join('').trimEnd();
    if (!candidate) {
      low = middle + 1;
      continue;
    }
    const heightPx = measureTextHeightPx(candidate, font, widthPx, lineHeightPx);
    if (heightPx <= maxHeightPx) {
      best = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  if (best <= 0 || best >= chars.length) {
    return null;
  }
  const naturalIndex = findNaturalSplitIndex(chars, best);
  const head = chars.slice(0, naturalIndex).join('').trimEnd();
  const tail = chars.slice(naturalIndex).join('').trimStart();
  if (!head || !tail) {
    return null;
  }
  return { head, tail };
}

function correctOverflowOnBodyPage(
  plan: RichpostPlan,
  pageIndex: number,
  inspection: RichpostLayoutInspection,
): boolean {
  const page = plan.pages[pageIndex];
  if (!page) return false;
  const pageTemplate = String(page.template || DEFAULT_RICHPOST_TEMPLATE);
  const bodyZone = ensureZone(page, 'body');
  const bodyMetrics = inspection.body;
  const fragments = normalizeFragments(bodyZone.fragments);
  const blockIds = normalizeStringArray(bodyZone.blockIds);
  const itemCount = fragments.length + blockIds.length;

  if (fragments.length > 0) {
    const lastFragment = fragments[fragments.length - 1];
    const lastText = typeof lastFragment.text === 'string' ? lastFragment.text.trim() : '';
    if (bodyMetrics && itemCount <= 1 && lastText) {
      const { font, lineHeightPx } = selectMeasurementFont(lastFragment, bodyMetrics);
      const split = splitFragmentTextToFit(
        lastText,
        font,
        bodyMetrics.widthPx,
        lineHeightPx,
        Math.max(0, bodyMetrics.availableHeightPx - 2),
      );
      if (split) {
        fragments[fragments.length - 1] = {
          ...lastFragment,
          text: split.head,
          continuesToNext: true,
        };
        bodyZone.fragments = fragments;
        const nextPage = ensureNextPage(plan, pageIndex, pageTemplate);
        const nextBody = ensureZone(nextPage, 'body');
        prependZoneFragment(nextBody, {
          ...lastFragment,
          text: split.tail,
          continuedFromPrevious: true,
        });
        normalizePlanBookkeeping(plan);
        return true;
      }
    }
    const movedFragment = popLastZoneFragment(bodyZone);
    if (!movedFragment) return false;
    const nextPage = ensureNextPage(plan, pageIndex, pageTemplate);
    prependZoneFragment(ensureZone(nextPage, 'body'), movedFragment);
    normalizePlanBookkeeping(plan);
    return true;
  }

  if (blockIds.length > 0) {
    const movedBlockId = popLastZoneBlockId(bodyZone);
    if (!movedBlockId) return false;
    const nextPage = ensureNextPage(plan, pageIndex, pageTemplate);
    prependZoneBlockId(ensureZone(nextPage, 'body'), movedBlockId);
    normalizePlanBookkeeping(plan);
    return true;
  }

  return false;
}

function correctOverflowOnTitlePage(plan: RichpostPlan, pageIndex: number): boolean {
  const page = plan.pages[pageIndex];
  if (!page) return false;
  const pageTemplate = String(page.template || DEFAULT_RICHPOST_TEMPLATE);
  const titleZone = ensureZone(page, 'title');
  const movedBlockId = popLastZoneBlockId(titleZone);
  if (!movedBlockId) return false;
  const nextPage = ensureNextPage(plan, pageIndex, pageTemplate);
  prependZoneBlockId(ensureZone(nextPage, 'title'), movedBlockId);
  normalizePlanBookkeeping(plan);
  return true;
}

function correctPlanForOverflow(
  plan: RichpostPlan,
  finding: RichpostOverflowFinding,
): boolean {
  if (finding.zoneName === 'body') {
    return correctOverflowOnBodyPage(plan, finding.pageIndex, finding.inspection);
  }
  if (finding.zoneName === 'title') {
    return correctOverflowOnTitlePage(plan, finding.pageIndex);
  }
  return false;
}

async function findFirstOverflow(
  state: RichpostPackageStateLike,
): Promise<RichpostOverflowFinding | null> {
  const pages = Array.isArray(state.richpostPages) ? state.richpostPages : [];
  for (let index = 0; index < pages.length; index += 1) {
    const page = pages[index];
    const readPath = typeof page?.file === 'string' ? page.file.trim() : '';
    if (!page?.exists || !readPath) {
      continue;
    }
    const html = await loadRichpostPreviewHtml(readPath);
    const inspection = await inspectRichpostHtmlLayout(html);
    if (inspection.body?.overflowY) {
      return {
        pageIndex: index,
        zoneName: 'body',
        inspection,
      };
    }
    if (inspection.title?.overflowY) {
      return {
        pageIndex: index,
        zoneName: 'title',
        inspection,
      };
    }
  }
  return null;
}

export async function stabilizeRichpostPagination<TState extends RichpostPackageStateLike>(
  input: {
    filePath: string;
    state: TState;
    plan?: unknown;
  },
): Promise<{ state: TState; plan: RichpostPlan | null; corrected: boolean }> {
  let currentState = input.state;
  let currentPlan = parseRichpostPlan(input.plan) || await readRichpostPlan(currentState.richpostPagePlanFile);
  let corrected = false;

  if (!currentPlan || !Array.isArray(currentState.richpostPages) || currentState.richpostPages.length === 0) {
    return { state: currentState, plan: currentPlan, corrected };
  }

  for (let iteration = 0; iteration < MAX_RICHPOST_PAGINATION_CORRECTIONS; iteration += 1) {
    const overflow = await findFirstOverflow(currentState);
    if (!overflow) {
      return { state: currentState, plan: currentPlan, corrected };
    }
    const nextPlan = clonePlan(currentPlan);
    const changed = correctPlanForOverflow(nextPlan, overflow);
    if (!changed) {
      break;
    }
    const result = await window.ipcRenderer.invoke('manuscripts:apply-richpost-page-plan', {
      filePath: input.filePath,
      plan: nextPlan,
    }) as {
      success?: boolean;
      error?: string;
      state?: TState;
      plan?: unknown;
    };
    if (!result?.success || !result.state) {
      throw new Error(result?.error || '回写图文分页方案失败');
    }
    currentState = result.state;
    currentPlan = parseRichpostPlan(result.plan) || nextPlan;
    corrected = true;
  }

  return { state: currentState, plan: currentPlan, corrected };
}
