import { clickElement, typeElement } from './pageActions.js';

const DEFAULT_ITEM_LIMIT = 20;
const DEFAULT_COMMENT_LIMIT = 8;

const SITE_CARD_SELECTORS = Object.freeze({
  xiaohongshu: Object.freeze([
    'a[href*="/explore/"]',
    'a[href*="/discovery/item/"]',
    'a[href*="/user/profile/"] [href*="/explore/"]',
  ]),
  douyin: Object.freeze([
    'a[href*="/video/"]',
  ]),
});

const SITE_DETAIL_CLOSE_SELECTORS = Object.freeze({
  xiaohongshu: Object.freeze([
    '[class*="note-detail"] [class*="close"]',
    '[class*="modal"] [class*="close"]',
    'button[aria-label*="关闭"]',
    'button[aria-label*="close" i]',
    '[role="dialog"] [class*="close"]',
  ]),
  douyin: Object.freeze([
    '[role="dialog"] [class*="close"]',
    '[class*="modal"] [class*="close"]',
    'button[aria-label*="关闭"]',
    'button[aria-label*="close" i]',
  ]),
});

const PAGE_CLICK_DETAIL_SITES = new Set(['xiaohongshu', 'douyin']);
const DETAIL_SURFACES = new Set(['detail', 'detail_overlay']);

const SITE_SEARCH_UI = Object.freeze({
  xiaohongshu: Object.freeze({
    inputs: Object.freeze([
      '#search-input-in-feeds',
      '#search-input',
      'textarea[id*="search-input"]',
      'input[id*="search"]',
      'input.search-input',
      '[role="search"] input',
      'input[placeholder*="搜索"]',
      'input[type="search"]',
    ]),
    submits: Object.freeze([
      '.input-button',
      'button[type="submit"]',
      '[role="search"] button',
    ]),
  }),
  douyin: Object.freeze({
    inputs: Object.freeze([
      'input[data-e2e="searchbar-input"]',
      '[role="search"] input',
      'input[placeholder*="搜索"]',
      'input[type="search"]',
    ]),
    submits: Object.freeze([
      '[data-e2e="searchbar-button"]',
      'button[type="submit"]',
      '[role="search"] button',
      '[class*="search"] button',
    ]),
  }),
});

const SITE_FILTER_UI = Object.freeze({
  xiaohongshu: Object.freeze({
    sort: Object.freeze({
      group: ['排序方式', '排序'],
      values: { relevance: ['综合', '综合排序'], latest: ['最新', '最新发布'], most_liked: ['最多点赞'] },
    }),
    contentType: Object.freeze({
      group: ['笔记类型', '内容形式', '内容类型'],
      values: { all: ['不限', '全部'], image_text: ['图文'], video: ['视频'] },
    }),
    publishTime: Object.freeze({
      group: ['发布时间'],
      values: { all: ['不限', '全部'], day: ['一天内', '24小时内'], week: ['一周内'], half_year: ['半年内'] },
    }),
  }),
  douyin: Object.freeze({
    sort: Object.freeze({
      group: ['排序方式', '排序'],
      values: { relevance: ['综合排序', '综合'], latest: ['最新发布', '最新'], most_liked: ['最多点赞'] },
    }),
    contentType: Object.freeze({
      group: ['内容形式', '内容类型'],
      values: { all: ['不限', '全部'], image_text: ['图文'], video: ['视频'] },
    }),
    publishTime: Object.freeze({
      group: ['发布时间'],
      values: { all: ['不限', '全部'], day: ['一天内', '24小时内'], week: ['一周内'], half_year: ['半年内'] },
    }),
  }),
});

export function extractSiteResearch(input = {}) {
  const site = normalizeSite(input.site?.id || input.siteId || input.site || input.platform || inferSite(location.hostname));
  const operation = String(input.operation || input.researchOperation || 'content_scan').trim().toLowerCase();
  const limit = clamp(input.limit, 1, 100, DEFAULT_ITEM_LIMIT);
  const commentLimit = clamp(input.commentLimit, 0, 100, DEFAULT_COMMENT_LIMIT);
  const pageState = readPageState(site);
  const base = {
    success: true,
    site,
    operation,
    sourceUrl: location.href,
    title: document.title || '',
    capturedAt: new Date().toISOString(),
    pageState,
  };
  if (pageState.blocker) return { ...base, success: false, reason: pageState.blocker };
  if (operation === 'content_scan' && PAGE_CLICK_DETAIL_SITES.has(site) && !DETAIL_SURFACES.has(pageState.surface)) {
    return {
      ...base,
      success: false,
      reason: 'detail_surface_unavailable',
      message: 'social-media detail extraction requires a detail page opened from the source page UI',
    };
  }
  if (site === 'xiaohongshu') return { ...base, ...extractXiaohongshu(operation, limit, commentLimit) };
  if (site === 'douyin') return { ...base, ...extractDouyin(operation, limit, commentLimit) };
  if (site === 'youtube') return { ...base, ...extractYouTube(commentLimit) };
  return { ...base, ...extractGenericWeb(limit) };
}

export async function submitSiteResearchSearch(input = {}) {
  const site = normalizeSite(input.site?.id || input.siteId || input.site || input.platform || inferSite(location.hostname));
  const query = String(input.query || input.keyword || '').trim();
  const pageState = readPageState(site);
  if (pageState.blocker) return { success: false, reason: pageState.blocker, sourceUrl: location.href };
  if (!query) return { success: false, reason: 'search_query_missing', message: 'page UI search requires query', sourceUrl: location.href };
  const spec = SITE_SEARCH_UI[site];
  if (!spec) return { success: false, reason: 'search_ui_site_unsupported', message: `${site} does not support page UI search`, sourceUrl: location.href };
  const inputSelector = spec.inputs.find((selector) => firstVisible([selector]));
  if (!inputSelector) {
    return { success: false, reason: 'search_input_unavailable', message: 'platform search input is not visible', sourceUrl: location.href };
  }
  const typed = await typeElement({ selector: inputSelector, text: query, replace: true, timeoutMs: 3_000 });
  if (typed?.success !== true) {
    return { success: false, reason: 'search_input_failed', message: typed?.error || 'platform search input failed', sourceUrl: location.href };
  }
  await delay(80);
  const submitSelector = spec.submits.find((selector) => firstVisible([selector]));
  if (submitSelector) {
    const clicked = await clickElement({ selector: submitSelector });
    if (clicked?.success === true) {
      return { success: true, submitted: true, method: 'click', inputSelector, submitSelector, sourceUrl: location.href };
    }
  }
  const inputNode = firstVisible([inputSelector]);
  if (!inputNode) {
    return { success: false, reason: 'search_input_detached', message: 'platform search input was replaced before submit', sourceUrl: location.href };
  }
  for (const type of ['keydown', 'keypress', 'keyup']) {
    inputNode.dispatchEvent(new KeyboardEvent(type, {
      key: 'Enter',
      code: 'Enter',
      keyCode: 13,
      which: 13,
      bubbles: true,
      cancelable: true,
    }));
  }
  return { success: true, submitted: true, method: 'enter', inputSelector, sourceUrl: location.href };
}

export async function prepareSiteResearchItemClick(input = {}) {
  const site = normalizeSite(input.site?.id || input.siteId || input.site || input.platform || inferSite(location.hostname));
  if (!PAGE_CLICK_DETAIL_SITES.has(site)) {
    return { success: false, reason: 'page_click_site_unsupported', sourceUrl: location.href };
  }
  const interactionRef = input.interactionRef && typeof input.interactionRef === 'object'
    ? input.interactionRef
    : input.item?.interactionRef && typeof input.item.interactionRef === 'object'
      ? input.item.interactionRef
      : {};
  if (interactionRef.kind !== 'site_card' || normalizeSite(interactionRef.site) !== site) {
    return {
      success: false,
      reason: 'item_interaction_ref_invalid',
      message: 'social-media card opening requires the typed interactionRef from the source-page extractor',
      sourceUrl: location.href,
    };
  }
  const itemId = String(interactionRef.itemId || input.item?.id || input.itemId || '').trim();
  const expectedUrl = normalizeUrl(interactionRef.sourceUrl || input.item?.sourceUrl || input.sourceUrl || '');
  const anchor = findSiteCardAnchor(site, { itemId, expectedUrl });
  if (!anchor) {
    return {
      success: false,
      reason: 'item_click_target_unavailable',
      message: 'the selected social-media card is no longer present on the source page',
      itemId,
      sourceUrl: location.href,
    };
  }
  anchor.scrollIntoView({ block: 'center', inline: 'center', behavior: 'auto' });
  await delay(160);
  const rect = anchor.getBoundingClientRect();
  if (rect.width <= 4 || rect.height <= 4) {
    return {
      success: false,
      reason: 'item_click_target_not_visible',
      itemId,
      sourceUrl: location.href,
    };
  }
  const observedUrl = normalizeUrl(anchor.href || anchor.getAttribute('href') || '');
  return {
    success: true,
    site,
    itemId: externalIdFromUrl(observedUrl) || itemId,
    sourceUrl: location.href,
    observedUrl,
    clickPoint: {
      x: Number((rect.left + rect.width / 2).toFixed(3)),
      y: Number((rect.top + rect.height / 2).toFixed(3)),
      coordinateSpace: 'viewport',
    },
  };
}

export async function prepareSiteResearchItemClose(input = {}) {
  const site = normalizeSite(input.site?.id || input.siteId || input.site || input.platform || inferSite(location.hostname));
  const closeTarget = firstVisible(SITE_DETAIL_CLOSE_SELECTORS[site] || []);
  if (!closeTarget) {
    return { success: false, reason: 'detail_close_target_unavailable', sourceUrl: location.href };
  }
  closeTarget.scrollIntoView({ block: 'center', inline: 'center', behavior: 'auto' });
  await delay(80);
  const rect = closeTarget.getBoundingClientRect();
  if (rect.width <= 4 || rect.height <= 4) {
    return { success: false, reason: 'detail_close_target_not_visible', sourceUrl: location.href };
  }
  return {
    success: true,
    site,
    sourceUrl: location.href,
    clickPoint: {
      x: Number((rect.left + rect.width / 2).toFixed(3)),
      y: Number((rect.top + rect.height / 2).toFixed(3)),
      coordinateSpace: 'viewport',
    },
  };
}

export async function applySiteResearchFilters(input = {}) {
  const site = normalizeSite(input.site?.id || input.site || input.siteId || input.platform || inferSite(location.hostname));
  const filters = input.filters && typeof input.filters === 'object' && !Array.isArray(input.filters)
    ? input.filters
    : {};
  const siteSpec = SITE_FILTER_UI[site];
  if (!siteSpec) return { success: false, reason: 'filter_site_unsupported', message: `${site} does not support filters` };
  const applied = {};
  for (const [filter, value] of Object.entries(filters)) {
    const filterSpec = siteSpec[filter];
    const optionTexts = filterSpec?.values?.[value];
    if (!filterSpec || !optionTexts) {
      return { success: false, reason: 'filter_option_unsupported', filter, value };
    }
    let option = findFilterOption(filterSpec.group, optionTexts);
    if (!option) {
      const trigger = findVisibleExactText(['筛选', '搜索筛选']);
      if (trigger) {
        trigger.click();
        await delay(160);
        option = findFilterOption(filterSpec.group, optionTexts);
      }
    }
    if (!option) {
      return {
        success: false,
        reason: 'filter_option_unavailable',
        message: `filter option is not visible: ${filter}=${value}`,
        filter,
        value,
      };
    }
    if (!isSelectedOption(option)) {
      option.click();
      await delay(180);
    }
    applied[filter] = value;
  }
  return { success: true, applied };
}

function findFilterOption(groupTexts, optionTexts) {
  const groupLabel = findVisibleExactText(groupTexts);
  if (groupLabel) {
    let root = groupLabel.parentElement;
    for (let depth = 0; root && depth < 6; depth += 1, root = root.parentElement) {
      const scoped = findVisibleExactText(optionTexts, root);
      if (scoped) return scoped;
    }
  }
  return findVisibleExactText(optionTexts);
}

function findVisibleExactText(values, root = document) {
  const candidates = root.querySelectorAll('button, [role="button"], [role="option"], [role="menuitem"], label, li, span, div');
  for (const candidate of candidates) {
    const candidateText = text(candidate);
    if (values.includes(candidateText) && isVisible(candidate)) return candidate;
  }
  return null;
}

function isSelectedOption(node) {
  return node.getAttribute('aria-selected') === 'true'
    || node.getAttribute('aria-checked') === 'true'
    || node.getAttribute('data-selected') === 'true'
    || /(^|\s)(active|selected|checked)(\s|$)/i.test(String(node.className || ''));
}

function isVisible(node) {
  const style = getComputedStyle(node);
  const rect = node.getBoundingClientRect();
  return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function extractXiaohongshu(operation, limit, commentLimit) {
  if (operation === 'search' || operation === 'author_scan') {
    const cards = extractCards(SITE_CARD_SELECTORS.xiaohongshu, limit, {
      title: ['[class*="title"]', '.title', '[data-v-note-title]'],
      author: ['[class*="author"]', '[class*="name"]', '.username'],
      engagement: ['[class*="like"]', '[class*="count"]'],
    }, 'xiaohongshu');
    return {
      items: cards,
      author: operation === 'author_scan' ? extractAuthorHeader() : null,
      hasMore: cards.length >= limit,
    };
  }
  return extractContent({
    title: ['#detail-title', '[class*="note-detail"] [class*="title"]', 'h1'],
    author: ['[class*="author"] [class*="name"]', '[class*="author"]', '.username'],
    body: ['#detail-desc', '[class*="note-detail"] [class*="desc"]', '[class*="content"]'],
    comments: ['[class*="comment-item"]', '[class*="commentItem"]', '[data-testid*="comment"]'],
    commentLimit,
  });
}

function extractDouyin(operation, limit, commentLimit) {
  if (operation === 'search' || operation === 'author_scan') {
    const cards = extractCards(SITE_CARD_SELECTORS.douyin, limit, {
      title: ['[class*="title"]', '[data-e2e*="desc"]'],
      author: ['[class*="author"]', '[data-e2e*="author"]'],
      engagement: ['[class*="count"]', '[data-e2e*="like"]'],
    }, 'douyin');
    return {
      items: cards,
      author: operation === 'author_scan' ? extractAuthorHeader() : null,
      hasMore: cards.length >= limit,
    };
  }
  return extractContent({
    title: ['[data-e2e="video-desc"]', '[class*="video-info"] h1', 'h1'],
    author: ['[data-e2e*="author"]', '[class*="author"]'],
    body: ['[data-e2e="video-desc"]', '[class*="desc"]'],
    comments: ['[data-e2e*="comment-item"]', '[class*="comment-item"]', '[class*="commentItem"]'],
    commentLimit,
  });
}

function extractYouTube(commentLimit) {
  return extractContent({
    title: ['h1 yt-formatted-string', 'h1'],
    author: ['#owner #channel-name a', 'ytd-channel-name a'],
    body: ['#description-inline-expander', '#description', 'ytd-text-inline-expander'],
    comments: ['ytd-comment-thread-renderer'],
    commentLimit,
  });
}

function extractGenericWeb(limit) {
  const main = firstNode(['main', 'article', '[role="main"]', 'body']);
  return {
    content: {
      title: text(firstNode(['h1'])) || document.title || '',
      author: readMeta(['author', 'article:author']),
      body: text(main).slice(0, 80_000),
      sourceUrl: location.href,
      comments: [],
      media: extractMedia(50),
    },
    items: extractCards(['main a[href]', 'article a[href]', '[role="main"] a[href]'], limit, {}),
  };
}

function extractContent({ title, author, body, comments, commentLimit }) {
  return {
    content: {
      title: text(firstNode(title)) || document.title || '',
      author: text(firstNode(author)),
      body: text(firstNode(body)).slice(0, 80_000),
      sourceUrl: location.href,
      comments: extractComments(comments, commentLimit),
      media: extractMedia(100),
    },
    items: [],
  };
}

function extractCards(selectors, limit, fields, site = 'web') {
  const seen = new Set();
  const items = [];
  for (const selector of selectors) {
    for (const anchor of document.querySelectorAll(selector)) {
      const href = normalizeUrl(anchor.href || anchor.getAttribute('href') || '');
      if (!href || seen.has(href)) continue;
      const root = anchor.closest('article, li, section, [role="listitem"]') || anchor.parentElement || anchor;
      const title = text(firstNode(fields.title || [], root)) || text(anchor);
      if (!title && !isLikelyContentUrl(href)) continue;
      seen.add(href);
      const itemId = externalIdFromUrl(href);
      items.push({
        id: itemId,
        sourceUrl: href,
        title: title.slice(0, 500),
        author: text(firstNode(fields.author || [], root)).slice(0, 200),
        engagementText: text(firstNode(fields.engagement || [], root)).slice(0, 120),
        previewText: text(root).slice(0, 1_000),
        interactionRef: {
          kind: 'site_card',
          site,
          itemId,
          sourceUrl: href,
          rank: items.length,
        },
      });
      if (items.length >= limit) return items;
    }
  }
  return items;
}

function extractComments(selectors, limit) {
  if (!limit) return [];
  const comments = [];
  const seen = new Set();
  for (const selector of selectors) {
    for (const node of document.querySelectorAll(selector)) {
      const content = text(node).slice(0, 2_000);
      if (!content || seen.has(content)) continue;
      seen.add(content);
      comments.push({
        id: node.getAttribute('data-id') || node.id || `comment-${comments.length + 1}`,
        parentId: node.getAttribute('data-parent-id') || null,
        author: text(firstNode(['[class*="author"]', '[class*="name"]', 'a'], node)).slice(0, 200),
        content,
      });
      if (comments.length >= limit) return comments;
    }
  }
  return comments;
}

function extractAuthorHeader() {
  return {
    id: externalIdFromUrl(location.href),
    name: text(firstNode(['[class*="user-name"]', '[class*="nickname"]', '[class*="username"]', 'h1'])).slice(0, 200),
    bio: text(firstNode(['[class*="user-desc"]', '[class*="bio"]', '[class*="signature"]'])).slice(0, 2_000),
    sourceUrl: location.href,
  };
}

function extractMedia(limit) {
  const items = [];
  const seen = new Set();
  for (const node of document.querySelectorAll('img[src], video[src], video source[src]')) {
    const sourceUrl = normalizeUrl(node.currentSrc || node.src || node.getAttribute('src') || '');
    if (!sourceUrl || sourceUrl.startsWith('data:') || seen.has(sourceUrl)) continue;
    seen.add(sourceUrl);
    items.push({
      type: node.tagName === 'IMG' ? 'image' : 'video',
      sourceUrl,
      alt: node.tagName === 'IMG' ? String(node.alt || '').slice(0, 500) : '',
    });
    if (items.length >= limit) break;
  }
  return items;
}

function readPageState(site) {
  const modal = firstVisible([
    '[class*="login-modal"]',
    '[class*="login-container"]',
    '[data-testid*="login"]',
    'iframe[src*="login"]',
  ]);
  const security = firstVisible([
    '[class*="captcha"]',
    '[class*="verify"]',
    '[class*="security"]',
    'iframe[src*="captcha"]',
  ]);
  const path = `${location.pathname}${location.search}`.toLowerCase();
  const unavailableText = `${document.title || ''}\n${String(document.body?.innerText || '').slice(0, 4_000)}`;
  const unavailable = /\/404(?:\/|\?|$)/.test(location.pathname.toLowerCase())
    || /(?:你访问的页面不见了|当前笔记暂时无法浏览|视频已失效|内容不存在)/i.test(unavailableText);
  const blocker = unavailable
    ? 'content_unavailable'
    : security
    ? 'security_verification_required'
    : modal || /\/(login|signin)(\/|\?|$)/.test(path)
      ? 'login_required'
      : null;
  return {
    site,
    blocker,
    loggedIn: blocker === 'login_required' || blocker === 'security_verification_required' ? false : null,
    surface: detectSiteSurface(site, blocker),
    url: location.href,
  };
}

function detectSiteSurface(site, blocker) {
  if (blocker) return 'blocked';
  const pathname = location.pathname.toLowerCase();
  if (site === 'xiaohongshu') {
    if (firstVisible(['#detail-title', '#detail-desc', '[class*="note-detail"]'])) {
      return /\/(explore|discovery\/item)\//.test(pathname) ? 'detail' : 'detail_overlay';
    }
    if (/\/(explore|discovery\/item)\//.test(pathname)) return 'detail';
    if (/search_result/.test(pathname)) return 'search_results';
    return 'entry';
  }
  if (site === 'douyin') {
    if (firstVisible(['[data-e2e="video-desc"]', '[class*="video-info"]', '[role="dialog"] [class*="video"]'])) {
      return /\/video\//.test(pathname) ? 'detail' : 'detail_overlay';
    }
    if (/\/video\//.test(pathname)) return 'detail';
    if (/search/.test(pathname)) return 'search_results';
    return 'entry';
  }
  return 'page';
}

function findSiteCardAnchor(site, { itemId, expectedUrl }) {
  const selectors = SITE_CARD_SELECTORS[site] || [];
  let urlMatch = null;
  let idMatch = null;
  for (const selector of selectors) {
    for (const anchor of document.querySelectorAll(selector)) {
      const href = normalizeUrl(anchor.href || anchor.getAttribute('href') || '');
      if (!href || !isRenderable(anchor)) continue;
      if (expectedUrl && href === expectedUrl) urlMatch ||= anchor;
      if (itemId && externalIdFromUrl(href) === itemId) idMatch ||= anchor;
    }
  }
  return urlMatch || idMatch;
}

function isRenderable(node) {
  const style = getComputedStyle(node);
  const rect = node.getBoundingClientRect();
  return style.display !== 'none'
    && style.visibility !== 'hidden'
    && style.opacity !== '0'
    && style.pointerEvents !== 'none'
    && rect.width > 4
    && rect.height > 4;
}

function firstVisible(selectors) {
  for (const selector of selectors) {
    for (const node of document.querySelectorAll(selector)) {
      const style = getComputedStyle(node);
      const rect = node.getBoundingClientRect();
      const disabled = node.disabled || node.getAttribute?.('aria-disabled') === 'true';
      if (!disabled
        && style.display !== 'none'
        && style.visibility !== 'hidden'
        && style.opacity !== '0'
        && style.pointerEvents !== 'none'
        && rect.width > 4
        && rect.height > 4) return node;
    }
  }
  return null;
}

function firstNode(selectors, root = document) {
  for (const selector of selectors || []) {
    try {
      const node = root.querySelector(selector);
      if (node) return node;
    } catch {
      // Ignore a stale site selector and continue to the next stable fallback.
    }
  }
  return null;
}

function text(node) {
  return String(node?.innerText || node?.textContent || '').replace(/\s+/g, ' ').trim();
}

function readMeta(names) {
  for (const name of names) {
    const value = document.querySelector(`meta[name="${name}"], meta[property="${name}"]`)?.content;
    if (value) return String(value).trim();
  }
  return '';
}

function normalizeSite(value) {
  const aliases = { xhs: 'xiaohongshu', redbook: 'xiaohongshu', rednote: 'xiaohongshu', dy: 'douyin', yt: 'youtube', generic_web: 'web', generic: 'web' };
  const normalized = String(value || '').trim().toLowerCase();
  return aliases[normalized] || normalized || 'web';
}

function inferSite(hostname) {
  const host = String(hostname || '').toLowerCase();
  if (host.includes('xiaohongshu.com') || host.includes('rednote.com')) return 'xiaohongshu';
  if (host.includes('douyin.com')) return 'douyin';
  if (host.includes('youtube.com') || host === 'youtu.be') return 'youtube';
  return 'web';
}

function normalizeUrl(value) {
  try {
    const url = new URL(String(value || ''), location.href);
    return /^https?:$/.test(url.protocol) ? url.toString() : '';
  } catch {
    return '';
  }
}

function externalIdFromUrl(value) {
  try {
    const parts = new URL(value, location.href).pathname.split('/').filter(Boolean);
    return parts.at(-1) || '';
  } catch {
    return '';
  }
}

function isLikelyContentUrl(value) {
  return /\/(explore|discovery\/item|video|watch)\//.test(value) || /[?&]v=/.test(value);
}

function clamp(value, minimum, maximum, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(maximum, Math.max(minimum, Math.floor(number))) : fallback;
}
