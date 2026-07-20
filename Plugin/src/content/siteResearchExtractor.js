const DEFAULT_ITEM_LIMIT = 20;
const DEFAULT_COMMENT_LIMIT = 8;

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
  const site = normalizeSite(input.site || input.siteId || input.platform || inferSite(location.hostname));
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
  if (site === 'xiaohongshu') return { ...base, ...extractXiaohongshu(operation, limit, commentLimit) };
  if (site === 'douyin') return { ...base, ...extractDouyin(operation, limit, commentLimit) };
  if (site === 'youtube') return { ...base, ...extractYouTube(commentLimit) };
  return { ...base, ...extractGenericWeb(limit) };
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
    const cards = extractCards([
      'a[href*="/explore/"]',
      'a[href*="/discovery/item/"]',
      'a[href*="/user/profile/"] [href*="/explore/"]',
    ], limit, {
      title: ['[class*="title"]', '.title', '[data-v-note-title]'],
      author: ['[class*="author"]', '[class*="name"]', '.username'],
      engagement: ['[class*="like"]', '[class*="count"]'],
    });
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
    const cards = extractCards(['a[href*="/video/"]'], limit, {
      title: ['[class*="title"]', '[data-e2e*="desc"]'],
      author: ['[class*="author"]', '[data-e2e*="author"]'],
      engagement: ['[class*="count"]', '[data-e2e*="like"]'],
    });
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

function extractCards(selectors, limit, fields) {
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
      items.push({
        id: externalIdFromUrl(href),
        sourceUrl: href,
        title: title.slice(0, 500),
        author: text(firstNode(fields.author || [], root)).slice(0, 200),
        engagementText: text(firstNode(fields.engagement || [], root)).slice(0, 120),
        previewText: text(root).slice(0, 1_000),
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
  const blocker = security
    ? 'security_verification_required'
    : modal || /\/(login|signin)(\/|\?|$)/.test(path)
      ? 'login_required'
      : null;
  return { site, blocker, loggedIn: blocker ? false : null, url: location.href };
}

function firstVisible(selectors) {
  for (const selector of selectors) {
    const node = document.querySelector(selector);
    if (!node) continue;
    const style = getComputedStyle(node);
    const rect = node.getBoundingClientRect();
    if (style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0) return node;
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
