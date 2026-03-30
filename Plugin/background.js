const API_ROOT = 'http://127.0.0.1:23456/api';

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: 'redbox-save-selection',
    title: '保存选中文字到 RedBox',
    contexts: ['selection'],
  });
  chrome.contextMenus.create({
    id: 'redbox-save-page-link',
    title: '保存当前页面链接到 RedBox',
    contexts: ['page'],
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (!tab?.id) return;
  if (info.menuItemId === 'redbox-save-selection') {
    void saveSelectedTextFromTab(tab.id);
    return;
  }
  if (info.menuItemId === 'redbox-save-page-link') {
    void saveCurrentPageLinkFromTab(tab.id);
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  void (async () => {
    try {
      const result = await handleMessage(message, sender);
      sendResponse(result);
    } catch (error) {
      sendResponse({
        success: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  })();
  return true;
});

async function handleMessage(message, sender) {
  const tabId = Number(message?.tabId || sender?.tab?.id || 0);

  switch (message?.type) {
    case 'healthcheck':
      return await checkDesktopServer();
    case 'inspect-page':
      return await inspectPage(tabId);
    case 'save-xhs':
      return await saveXhsNoteFromTab(tabId);
    case 'save-youtube':
      return await saveYouTubeFromTab(tabId);
    case 'save-selection':
      return await saveSelectedTextFromTab(tabId);
    case 'save-page-link':
      return await saveCurrentPageLinkFromTab(tabId);
    default:
      return { success: false, error: 'Unsupported action' };
  }
}

async function inspectPage(tabId) {
  const pageInfo = await runExtraction(tabId, detectCaptureTarget).catch(async () => {
    try {
      const tab = await chrome.tabs.get(tabId);
      return detectCaptureTargetFromUrl(String(tab?.url || ''));
    } catch {
      return null;
    }
  });
  return {
    success: true,
    pageInfo: pageInfo || {
      kind: 'generic',
      label: '保存当前页面链接',
      description: '当前页面可作为链接收藏保存到知识库。',
    },
  };
}

function detectCaptureTargetFromUrl(rawUrl) {
  let hostname = '';
  let pathname = '';
  try {
    const parsed = new URL(String(rawUrl || ''));
    hostname = String(parsed.hostname || '').toLowerCase();
    pathname = String(parsed.pathname || '');
  } catch {
    return null;
  }

  if (hostname === 'mp.weixin.qq.com') {
    return {
      kind: 'wechat-article',
      action: 'save-page-link',
      label: '保存公众号文章到知识库',
      description: '当前页面已识别为公众号文章，将完整保存正文、图片和排版。',
    };
  }

  if (hostname === 'youtube.com' || hostname.endsWith('.youtube.com') || hostname === 'youtu.be') {
    const isVideoPage = pathname.startsWith('/watch') || pathname.startsWith('/shorts/') || hostname === 'youtu.be';
    if (isVideoPage) {
      return {
        kind: 'youtube',
        action: 'save-youtube',
        label: '保存youtube视频到知识库',
        description: '当前页面已识别为 YouTube 视频页。',
      };
    }
  }

  if (/(^|\.)xiaohongshu\.com$/i.test(hostname)) {
    return {
      kind: 'xhs-generic',
      action: 'save-xhs',
      label: '保存小红书图文到知识库',
      description: '当前页面已识别为小红书内容页。',
    };
  }

  return null;
}

async function checkDesktopServer() {
  try {
    const response = await fetch(`${API_ROOT}/status`, { method: 'GET' });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    return { success: true };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function postJson(endpoint, payload) {
  const response = await fetch(`${API_ROOT}${endpoint}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  let data = null;
  try {
    data = await response.json();
  } catch {
    data = null;
  }

  if (!response.ok || data?.success === false) {
    throw new Error(data?.error || `HTTP ${response.status}`);
  }

  return data || { success: true };
}

async function runExtraction(tabId, func, options = {}) {
  if (!tabId) {
    throw new Error('No active tab');
  }
  const [result] = await chrome.scripting.executeScript({
    target: { tabId },
    func,
    args: Array.isArray(options.args) ? options.args : [],
    world: options.world || 'ISOLATED',
  });
  if (!result) {
    throw new Error('Failed to execute page extraction');
  }
  return result.result;
}

async function saveSelectedTextFromTab(tabId) {
  const payload = await runExtraction(tabId, extractSelectedTextPayload);
  if (!payload || typeof payload !== 'object' || !payload?.text) {
    throw new Error('当前页面没有选中文字');
  }
  const response = await postJson('/save-text', payload);
  return {
    success: true,
    mode: 'selection',
    noteId: response.noteId || '',
  };
}

async function saveCurrentPageLinkFromTab(tabId) {
  const payload = await runExtraction(tabId, extractCurrentPageLinkPayload, { world: 'MAIN' });
  if (!payload || typeof payload !== 'object') {
    throw new Error('当前页面内容提取失败，请刷新页面后重试');
  }
  if (!String(payload.url || '').trim()) {
    throw new Error('当前页面缺少可保存的链接地址');
  }
  const response = await postJson('/save-text', payload);
  return {
    success: true,
    mode: 'page-link',
    noteId: response.noteId || '',
  };
}

async function saveYouTubeFromTab(tabId) {
  const payload = await runExtraction(tabId, extractYouTubePayload);
  if (!payload?.videoId) {
    throw new Error('当前页面不是可识别的 YouTube 视频页');
  }
  const response = await postJson('/youtube-notes', payload);
  return {
    success: true,
    mode: 'youtube',
    noteId: response.noteId || '',
    duplicate: Boolean(response.duplicate),
  };
}

async function saveXhsNoteFromTab(tabId) {
  const payload = await runExtraction(tabId, extractXhsNotePayload, { world: 'MAIN' });
  console.log('[redbox-plugin][xhs] payload', {
    title: payload?.title || '',
    imageCount: Array.isArray(payload?.images) ? payload.images.length : 0,
    hasCoverUrl: Boolean(payload?.coverUrl),
    videoUrl: String(payload?.videoUrl || ''),
    hasVideoDataUrl: Boolean(payload?.videoDataUrl),
  });
  if (!payload?.title && !payload?.content && !payload?.images?.length && !payload?.videoUrl) {
    throw new Error('当前页面未识别到可保存的小红书笔记或文章');
  }
  const response = await postJson('/notes', payload);
  return {
    success: true,
    mode: 'xhs',
    noteId: response.noteId || '',
  };
}

function extractSelectedTextPayload() {
  const text = String(window.getSelection?.()?.toString?.() || '').trim();
  return {
    title: document.title || 'Text Clipping',
    url: location.href,
    text,
  };
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function collectLinkArticleData() {
  function cleanText(value) {
    return String(value || '').replace(/\s+\n/g, '\n').replace(/\n{3,}/g, '\n\n').replace(/[ \t]{2,}/g, ' ').trim();
  }

  function pickContent(values) {
    for (const value of values) {
      const text = cleanText(value);
      if (text) return text;
    }
    return '';
  }

  function getMeta(selector, attr = 'content') {
    return document.querySelector(selector)?.getAttribute(attr) || '';
  }

  function toAbsoluteUrl(value) {
    const raw = String(value || '').trim();
    if (!raw) return '';
    try {
      return new URL(raw, location.href).toString();
    } catch {
      return raw;
    }
  }

  function scoreRoot(root) {
    if (!root) return 0;
    const text = cleanText(root.innerText || '');
    const textLength = text.length;
    const paragraphCount = root.querySelectorAll('p').length;
    const headingCount = root.querySelectorAll('h1,h2,h3').length;
    const articleBoost = root.matches?.('article, main, [role="main"]') ? 2000 : 0;
    return textLength + (paragraphCount * 120) + (headingCount * 50) + articleBoost;
  }

  function pickBestRoot() {
    if (location.hostname === 'mp.weixin.qq.com') {
      return document.querySelector('#js_content') || document.body;
    }

    const selectors = [
      '#js_content',
      '.rich_media_content',
      'article',
      'main',
      '[role="main"]',
      '.article',
      '.article-container',
      '.post-content',
      '.entry-content',
      '.markdown-body',
      '.rich-text',
      '.content',
      '.post',
      '.note-content',
    ];

    const candidates = selectors.flatMap((selector) => Array.from(document.querySelectorAll(selector)));
    if (!candidates.length) return document.body;
    return candidates
      .map((node) => ({ node, score: scoreRoot(node) }))
      .sort((a, b) => b.score - a.score)[0]?.node || document.body;
  }

  function collectParagraphText(root) {
    const selectors = 'h1,h2,h3,p,li,blockquote,pre';
    const nodes = Array.from(root.querySelectorAll(selectors));
    const parts = [];
    const seen = new Set();

    for (const node of nodes) {
      if (node.closest('nav, header, footer, aside, form, dialog, noscript')) continue;
      const text = cleanText(node.innerText || '');
      if (!text || text.length < 18) continue;
      if (seen.has(text)) continue;
      seen.add(text);
      parts.push(text);
      if (parts.join('\n\n').length > 24000) break;
    }

    if (parts.length > 0) return parts.join('\n\n');
    return cleanText(root.innerText || '').slice(0, 24000);
  }

  function collectImageUrls(root) {
    const urls = [];
    const push = (value) => {
      const url = toAbsoluteUrl(value);
      if (!/^https?:\/\//i.test(url)) return;
      if (!urls.includes(url)) urls.push(url);
    };

    push(getMeta('meta[property="og:image"]'));
    push(getMeta('meta[name="twitter:image"]'));

    const images = Array.from(root.querySelectorAll('img[src], img[data-src], img[data-original]'));
    for (const img of images) {
      push(img.getAttribute('src'));
      push(img.getAttribute('data-src'));
      push(img.getAttribute('data-original'));
      if (urls.length >= 4) break;
    }

    return urls.slice(0, 4);
  }

  function buildWechatRichHtmlDocument(root) {
    if (location.hostname !== 'mp.weixin.qq.com' || !root) {
      return { html: '', imageMap: [] };
    }

    const clone = root.cloneNode(true);
    const imageMap = [];
    let imageIndex = 0;

    clone.querySelectorAll('script, style, noscript, iframe, form, input, button, textarea, canvas, audio, video').forEach((node) => node.remove());

    const allNodes = [clone, ...clone.querySelectorAll('*')];
    for (const node of allNodes) {
      if (!(node instanceof Element)) continue;

      for (const attr of Array.from(node.attributes)) {
        const name = String(attr.name || '').toLowerCase();
        const value = String(attr.value || '');
        if (name.startsWith('on')) {
          node.removeAttribute(attr.name);
          continue;
        }
        if ((name === 'href' || name === 'src') && /^\s*javascript:/i.test(value)) {
          node.removeAttribute(attr.name);
        }
      }

      if (node.tagName === 'IMG') {
        const resolvedSrc = toAbsoluteUrl(
          node.getAttribute('data-src')
          || node.getAttribute('data-original')
          || node.getAttribute('src')
          || ''
        );
        if (!/^https?:\/\//i.test(resolvedSrc)) {
          node.remove();
          continue;
        }
        const token = `__REDBOX_WECHAT_IMAGE_${imageIndex++}__`;
        imageMap.push({ token, url: resolvedSrc });
        node.setAttribute('src', token);
        node.removeAttribute('data-src');
        node.removeAttribute('data-original');
        node.removeAttribute('srcset');
        node.setAttribute('loading', 'lazy');
        continue;
      }

      if (node.tagName === 'A') {
        const href = toAbsoluteUrl(node.getAttribute('href') || '');
        if (href) {
          node.setAttribute('href', href);
          node.setAttribute('target', '_blank');
          node.setAttribute('rel', 'noopener noreferrer');
        } else {
          node.removeAttribute('href');
        }
      }
    }

    const title = cleanText(document.querySelector('#activity-name')?.textContent || document.title || '公众号文章');
    const author = cleanText(
      document.querySelector('#js_name')?.textContent
      || document.querySelector('#js_author_name')?.textContent
      || ''
    );
    const publishTime = cleanText(document.querySelector('#publish_time')?.textContent || '');
    const accountName = cleanText(
      document.querySelector('#js_profile_qrcode strong')?.textContent
      || document.querySelector('#js_profile_qrcode span')?.textContent
      || ''
    );

    const bodyHtml = clone.innerHTML.trim();
    if (!bodyHtml) {
      return { html: '', imageMap: [] };
    }

    const subtitleParts = [author, publishTime, accountName].filter(Boolean);
    const subtitle = subtitleParts.join(' · ');
    const html = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(title)}</title>
  <style>
    :root { color-scheme: light; }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: #f5f5f3;
      color: #1f2937;
      font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Helvetica Neue", Arial, sans-serif;
      line-height: 1.85;
    }
    .rb-wechat-shell {
      max-width: 820px;
      margin: 0 auto;
      padding: 28px 20px 60px;
    }
    .rb-wechat-article {
      background: #ffffff;
      border-radius: 18px;
      padding: 32px 28px 40px;
      box-shadow: 0 12px 32px rgba(15, 23, 42, 0.08);
      border: 1px solid rgba(15, 23, 42, 0.06);
    }
    .rb-wechat-title {
      margin: 0;
      font-size: 30px;
      line-height: 1.3;
      font-weight: 700;
      color: #111827;
    }
    .rb-wechat-meta {
      margin-top: 12px;
      font-size: 13px;
      color: #6b7280;
    }
    .rb-wechat-body {
      margin-top: 26px;
      font-size: 17px;
      color: #1f2937;
      word-break: break-word;
    }
    .rb-wechat-body img {
      display: block;
      max-width: 100%;
      height: auto;
      margin: 18px auto;
      border-radius: 14px;
    }
    .rb-wechat-body p,
    .rb-wechat-body section,
    .rb-wechat-body div,
    .rb-wechat-body blockquote,
    .rb-wechat-body ul,
    .rb-wechat-body ol,
    .rb-wechat-body pre {
      margin-top: 0;
      margin-bottom: 1em;
    }
    .rb-wechat-body h1,
    .rb-wechat-body h2,
    .rb-wechat-body h3,
    .rb-wechat-body h4 {
      margin: 1.5em 0 0.8em;
      line-height: 1.35;
      color: #111827;
    }
    .rb-wechat-body blockquote {
      border-left: 4px solid #22c55e;
      background: #f0fdf4;
      padding: 12px 16px;
      border-radius: 10px;
      color: #166534;
    }
    .rb-wechat-body a {
      color: #15803d;
      text-decoration: underline;
      text-underline-offset: 2px;
    }
    .rb-wechat-body table {
      width: 100%;
      border-collapse: collapse;
      margin: 18px 0;
      font-size: 15px;
    }
    .rb-wechat-body table td,
    .rb-wechat-body table th {
      border: 1px solid #d1d5db;
      padding: 10px 12px;
      vertical-align: top;
    }
    .rb-wechat-body pre {
      white-space: pre-wrap;
      background: #111827;
      color: #f9fafb;
      padding: 14px 16px;
      border-radius: 12px;
      overflow: auto;
    }
  </style>
</head>
<body>
  <div class="rb-wechat-shell">
    <article class="rb-wechat-article">
      <h1 class="rb-wechat-title">${escapeHtml(title)}</h1>
      ${subtitle ? `<div class="rb-wechat-meta">${escapeHtml(subtitle)}</div>` : ''}
      <div class="rb-wechat-body">${bodyHtml}</div>
    </article>
  </div>
</body>
</html>`;

    return { html, imageMap };
  }

  const root = pickBestRoot();
  const title = pickContent([
    document.querySelector('#activity-name')?.textContent,
    getMeta('meta[property="og:title"]'),
    getMeta('meta[name="twitter:title"]'),
    document.querySelector('h1')?.innerText,
    document.title,
  ]) || 'Untitled Page';
  const content = collectParagraphText(root);
  const metaDescription = pickContent([
    getMeta('meta[property="og:description"]'),
    getMeta('meta[name="description"]'),
    getMeta('meta[name="twitter:description"]'),
  ]);
  const byline = pickContent([
    document.querySelector('#js_name')?.textContent,
    document.querySelector('#js_author_name')?.textContent,
    getMeta('meta[name="author"]'),
    document.querySelector('[rel="author"]')?.textContent,
    document.querySelector('.author, .byline, [class*="author"], [class*="byline"]')?.textContent,
  ]);
  const siteName = pickContent([
    document.querySelector('#js_profile_qrcode strong')?.textContent,
    getMeta('meta[property="og:site_name"]'),
    location.hostname.replace(/^www\./i, ''),
  ]);
  const richWechatSnapshot = buildWechatRichHtmlDocument(root);
  const images = richWechatSnapshot.imageMap.length > 0
    ? richWechatSnapshot.imageMap.map((item) => item.url).slice(0, 8)
    : collectImageUrls(root);
  const excerpt = metaDescription || content.slice(0, 180);
  const looksLikeArticle = content.length >= 280 || root.matches?.('article, main, [role="main"]');
  const isWechatArticle = location.hostname === 'mp.weixin.qq.com';

  return {
    looksLikeArticle: Boolean(looksLikeArticle),
    title,
    text: content || [title, metaDescription, location.href].filter(Boolean).join('\n\n'),
    excerpt,
    url: location.href,
    author: byline || '',
    siteName,
    coverUrl: images[0] || '',
    images,
    captureKind: isWechatArticle ? 'wechat-article' : 'link-article',
    tags: isWechatArticle ? ['公众号文章'] : [],
    richHtmlDocument: isWechatArticle ? richWechatSnapshot.html : '',
    richHtmlImageMap: isWechatArticle ? richWechatSnapshot.imageMap : [],
  };
}

async function extractCurrentPageLinkPayload() {
  function escapeHtml(value) {
    return String(value || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  async function collectLinkArticleDataLocal() {
    async function blobToDataUrl(blob) {
      return await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ''));
        reader.onerror = () => reject(reader.error || new Error('Failed to read blob as data url'));
        reader.readAsDataURL(blob);
      });
    }

    async function fetchBinaryAsDataUrl(url) {
      const target = toAbsoluteUrl(url);
      if (!/^https?:\/\//i.test(target)) return '';
      try {
        const response = await fetch(target, {
          credentials: 'include',
          cache: 'force-cache',
        });
        if (!response.ok) return '';
        const blob = await response.blob();
        if (!blob || !blob.size) return '';
        return await blobToDataUrl(blob);
      } catch {
        return '';
      }
    }

    function cleanText(value) {
      return String(value || '').replace(/\s+\n/g, '\n').replace(/\n{3,}/g, '\n\n').replace(/[ \t]{2,}/g, ' ').trim();
    }

    function pickContent(values) {
      for (const value of values) {
        const text = cleanText(value);
        if (text) return text;
      }
      return '';
    }

    function getMeta(selector, attr = 'content') {
      return document.querySelector(selector)?.getAttribute(attr) || '';
    }

    function toAbsoluteUrl(value) {
      const raw = String(value || '').trim();
      if (!raw) return '';
      try {
        return new URL(raw, location.href).toString();
      } catch {
        return raw;
      }
    }

    function scoreRoot(root) {
      if (!root) return 0;
      const text = cleanText(root.innerText || '');
      const textLength = text.length;
      const paragraphCount = root.querySelectorAll('p').length;
      const headingCount = root.querySelectorAll('h1,h2,h3').length;
      const articleBoost = root.matches?.('article, main, [role="main"]') ? 2000 : 0;
      return textLength + (paragraphCount * 120) + (headingCount * 50) + articleBoost;
    }

    function pickBestRoot() {
      if (location.hostname === 'mp.weixin.qq.com') {
        return document.querySelector('#js_content') || document.body;
      }

      const selectors = [
        '#js_content',
        '.rich_media_content',
        'article',
        'main',
        '[role="main"]',
        '.article',
        '.article-container',
        '.post-content',
        '.entry-content',
        '.markdown-body',
        '.rich-text',
        '.content',
        '.post',
        '.note-content',
      ];

      const candidates = selectors.flatMap((selector) => Array.from(document.querySelectorAll(selector)));
      if (!candidates.length) return document.body;
      return candidates
        .map((node) => ({ node, score: scoreRoot(node) }))
        .sort((a, b) => b.score - a.score)[0]?.node || document.body;
    }

    function collectParagraphText(root) {
      const selectors = 'h1,h2,h3,p,li,blockquote,pre';
      const nodes = Array.from(root.querySelectorAll(selectors));
      const parts = [];
      const seen = new Set();

      for (const node of nodes) {
        if (node.closest('nav, header, footer, aside, form, dialog, noscript')) continue;
        const text = cleanText(node.innerText || '');
        if (!text || text.length < 18) continue;
        if (seen.has(text)) continue;
        seen.add(text);
        parts.push(text);
        if (parts.join('\n\n').length > 24000) break;
      }

      if (parts.length > 0) return parts.join('\n\n');
      return cleanText(root.innerText || '').slice(0, 24000);
    }

    function collectImageUrls(root) {
      const urls = [];
      const push = (value) => {
        const url = toAbsoluteUrl(value);
        if (!/^https?:\/\//i.test(url)) return;
        if (!urls.includes(url)) urls.push(url);
      };

      push(getMeta('meta[property="og:image"]'));
      push(getMeta('meta[name="twitter:image"]'));

      const images = Array.from(root.querySelectorAll('img[src], img[data-src], img[data-original]'));
      for (const img of images) {
        push(img.getAttribute('src'));
        push(img.getAttribute('data-src'));
        push(img.getAttribute('data-original'));
        if (urls.length >= 8) break;
      }

      return urls.slice(0, 8);
    }

    function buildWechatRichHtmlDocument(root) {
      if (location.hostname !== 'mp.weixin.qq.com' || !root) {
        return { html: '', imageMap: [] };
      }

      const clone = root.cloneNode(true);
      const imageMap = [];
      let imageIndex = 0;

      clone.querySelectorAll('script, style, noscript, iframe, form, input, button, textarea, canvas, audio, video').forEach((node) => node.remove());

      const allNodes = [clone, ...clone.querySelectorAll('*')];
      for (const node of allNodes) {
        if (!(node instanceof Element)) continue;

        for (const attr of Array.from(node.attributes)) {
          const name = String(attr.name || '').toLowerCase();
          const value = String(attr.value || '');
          if (name.startsWith('on')) {
            node.removeAttribute(attr.name);
            continue;
          }
          if ((name === 'href' || name === 'src') && /^\s*javascript:/i.test(value)) {
            node.removeAttribute(attr.name);
          }
        }

        if (node.tagName === 'IMG') {
          const resolvedSrc = toAbsoluteUrl(
            node.getAttribute('data-src')
            || node.getAttribute('data-original')
            || node.getAttribute('src')
            || ''
          );
          if (!/^https?:\/\//i.test(resolvedSrc)) {
            node.remove();
            continue;
          }
          const token = `__REDBOX_WECHAT_IMAGE_${imageIndex++}__`;
          imageMap.push({ token, url: resolvedSrc });
          node.setAttribute('src', token);
          node.removeAttribute('data-src');
          node.removeAttribute('data-original');
          node.removeAttribute('srcset');
          node.setAttribute('loading', 'lazy');
          continue;
        }

        if (node.tagName === 'A') {
          const href = toAbsoluteUrl(node.getAttribute('href') || '');
          if (href) {
            node.setAttribute('href', href);
            node.setAttribute('target', '_blank');
            node.setAttribute('rel', 'noopener noreferrer');
          } else {
            node.removeAttribute('href');
          }
        }
      }

      const title = cleanText(document.querySelector('#activity-name')?.textContent || document.title || '公众号文章');
      const author = cleanText(
        document.querySelector('#js_name')?.textContent
        || document.querySelector('#js_author_name')?.textContent
        || ''
      );
      const publishTime = cleanText(document.querySelector('#publish_time')?.textContent || '');
      const accountName = cleanText(
        document.querySelector('#js_profile_qrcode strong')?.textContent
        || document.querySelector('#js_profile_qrcode span')?.textContent
        || ''
      );

      const bodyHtml = clone.innerHTML.trim();
      if (!bodyHtml) return { html: '', imageMap: [] };

      const subtitleParts = [author, publishTime, accountName].filter(Boolean);
      const subtitle = subtitleParts.join(' · ');
      const html = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(title)}</title>
  <style>
    :root { color-scheme: light; }
    * { box-sizing: border-box; }
    body { margin: 0; background: #f5f5f3; color: #1f2937; font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Helvetica Neue", Arial, sans-serif; line-height: 1.85; }
    .rb-wechat-shell { max-width: 820px; margin: 0 auto; padding: 28px 20px 60px; }
    .rb-wechat-article { background: #ffffff; border-radius: 18px; padding: 32px 28px 40px; box-shadow: 0 12px 32px rgba(15, 23, 42, 0.08); border: 1px solid rgba(15, 23, 42, 0.06); }
    .rb-wechat-title { margin: 0; font-size: 30px; line-height: 1.3; font-weight: 700; color: #111827; }
    .rb-wechat-meta { margin-top: 12px; font-size: 13px; color: #6b7280; }
    .rb-wechat-body { margin-top: 26px; font-size: 17px; color: #1f2937; word-break: break-word; }
    .rb-wechat-body img { display: block; max-width: 100%; height: auto; margin: 18px auto; border-radius: 14px; }
    .rb-wechat-body p, .rb-wechat-body section, .rb-wechat-body div, .rb-wechat-body blockquote, .rb-wechat-body ul, .rb-wechat-body ol, .rb-wechat-body pre { margin-top: 0; margin-bottom: 1em; }
    .rb-wechat-body h1, .rb-wechat-body h2, .rb-wechat-body h3, .rb-wechat-body h4 { margin: 1.5em 0 0.8em; line-height: 1.35; color: #111827; }
    .rb-wechat-body blockquote { border-left: 4px solid #22c55e; background: #f0fdf4; padding: 12px 16px; border-radius: 10px; color: #166534; }
    .rb-wechat-body a { color: #15803d; text-decoration: underline; text-underline-offset: 2px; }
    .rb-wechat-body table { width: 100%; border-collapse: collapse; margin: 18px 0; font-size: 15px; }
    .rb-wechat-body table td, .rb-wechat-body table th { border: 1px solid #d1d5db; padding: 10px 12px; vertical-align: top; }
    .rb-wechat-body pre { white-space: pre-wrap; background: #111827; color: #f9fafb; padding: 14px 16px; border-radius: 12px; overflow: auto; }
  </style>
</head>
<body>
  <div class="rb-wechat-shell">
    <article class="rb-wechat-article">
      <h1 class="rb-wechat-title">${escapeHtml(title)}</h1>
      ${subtitle ? `<div class="rb-wechat-meta">${escapeHtml(subtitle)}</div>` : ''}
      <div class="rb-wechat-body">${bodyHtml}</div>
    </article>
  </div>
</body>
</html>`;

      return { html, imageMap };
    }

    const root = pickBestRoot();
    const title = pickContent([
      document.querySelector('#activity-name')?.textContent,
      getMeta('meta[property="og:title"]'),
      getMeta('meta[name="twitter:title"]'),
      document.querySelector('h1')?.innerText,
      document.title,
    ]) || 'Untitled Page';
    const content = collectParagraphText(root);
    const metaDescription = pickContent([
      getMeta('meta[property="og:description"]'),
      getMeta('meta[name="description"]'),
      getMeta('meta[name="twitter:description"]'),
    ]);
    const byline = pickContent([
      document.querySelector('#js_name')?.textContent,
      document.querySelector('#js_author_name')?.textContent,
      getMeta('meta[name="author"]'),
      document.querySelector('[rel="author"]')?.textContent,
      document.querySelector('.author, .byline, [class*="author"], [class*="byline"]')?.textContent,
    ]);
    const siteName = pickContent([
      document.querySelector('#js_profile_qrcode strong')?.textContent,
      getMeta('meta[property="og:site_name"]'),
      location.hostname.replace(/^www\./i, ''),
    ]);
    const richWechatSnapshot = buildWechatRichHtmlDocument(root);
    const localizedWechatImageMap = [];
    if (richWechatSnapshot.imageMap.length > 0) {
      for (const entry of richWechatSnapshot.imageMap.slice(0, 80)) {
        const dataUrl = await fetchBinaryAsDataUrl(entry.url);
        localizedWechatImageMap.push({
          token: entry.token,
          url: dataUrl || entry.url,
        });
      }
    }

    const images = localizedWechatImageMap.length > 0
      ? localizedWechatImageMap.map((item) => item.url).filter(Boolean).slice(0, 8)
      : collectImageUrls(root);
    const excerpt = metaDescription || content.slice(0, 180);
    const looksLikeArticle = content.length >= 280 || root.matches?.('article, main, [role="main"]');
    const isWechatArticle = location.hostname === 'mp.weixin.qq.com';

    return {
      looksLikeArticle: Boolean(looksLikeArticle),
      title,
      text: content || [title, metaDescription, location.href].filter(Boolean).join('\n\n'),
      excerpt,
      url: location.href,
      author: byline || '',
      siteName,
      coverUrl: images[0] || '',
      images,
      captureKind: isWechatArticle ? 'wechat-article' : 'link-article',
      tags: isWechatArticle ? ['公众号文章'] : [],
      richHtmlDocument: isWechatArticle ? richWechatSnapshot.html : '',
      richHtmlImageMap: isWechatArticle ? localizedWechatImageMap : [],
    };
  }

  const article = await collectLinkArticleDataLocal();
  return {
    type: article.looksLikeArticle ? 'link-article' : 'text',
    captureKind: article.captureKind || '',
    title: article.title,
    url: article.url,
    text: article.text,
    htmlSnapshot: article.looksLikeArticle ? document.documentElement.outerHTML : '',
    excerpt: article.excerpt,
    author: article.author,
    siteName: article.siteName,
    coverUrl: article.coverUrl,
    images: article.images,
    tags: article.tags,
    richHtmlDocument: article.richHtmlDocument || '',
    richHtmlImageMap: Array.isArray(article.richHtmlImageMap) ? article.richHtmlImageMap : [],
  };
}

function extractYouTubePayload() {
  const url = new URL(location.href);
  let videoId = '';
  if (url.hostname.includes('youtu.be')) {
    videoId = url.pathname.split('/').filter(Boolean)[0] || '';
  } else if (url.pathname.startsWith('/watch')) {
    videoId = url.searchParams.get('v') || '';
  } else if (url.pathname.startsWith('/shorts/')) {
    videoId = url.pathname.split('/').filter(Boolean)[1] || '';
  }

  const title = document.querySelector('meta[property="og:title"]')?.getAttribute('content')
    || document.title
    || '';
  const description = document.querySelector('meta[property="og:description"]')?.getAttribute('content')
    || document.querySelector('meta[name="description"]')?.getAttribute('content')
    || '';
  const thumbnailUrl = document.querySelector('meta[property="og:image"]')?.getAttribute('content') || '';

  return {
    videoId: String(videoId || '').trim(),
    videoUrl: videoId ? `https://www.youtube.com/watch?v=${videoId}` : location.href,
    title: String(title || '').trim(),
    description: String(description || '').trim(),
    thumbnailUrl: String(thumbnailUrl || '').trim(),
  };
}

async function extractXhsNotePayload() {
  function parseCountText(value) {
    if (!value) return 0;
    const text = String(value).trim();
    const cleaned = text.replace(/[\s,]/g, '').replace(/[^0-9.\u4e00-\u9fa5]/g, '');
    if (!cleaned) return 0;
    if (cleaned.includes('亿')) {
      const num = parseFloat(cleaned.replace('亿', ''));
      return Number.isNaN(num) ? 0 : Math.round(num * 100000000);
    }
    if (cleaned.includes('万')) {
      const num = parseFloat(cleaned.replace('万', ''));
      return Number.isNaN(num) ? 0 : Math.round(num * 10000);
    }
    const num = parseFloat(cleaned);
    return Number.isNaN(num) ? 0 : Math.round(num);
  }

  function getInitialState() {
    const scripts = document.querySelectorAll('script');
    for (const script of scripts) {
      const text = script.textContent || '';
      if (!text.includes('window.__INITIAL_STATE__=')) continue;
      try {
        const jsonText = text
          .replace('window.__INITIAL_STATE__=', '')
          .replace(/undefined/g, 'null')
          .replace(/;$/, '');
        return JSON.parse(jsonText);
      } catch {
        return null;
      }
    }
    return null;
  }

  function getCurrentNoteRoot() {
    return (
      document.querySelector('#noteContainer.note-container[data-render-status]') ||
      document.querySelector('#noteContainer.note-container') ||
      document.querySelector('#noteContainer') ||
      document.querySelector('.note-container') ||
      document.querySelector('.note-content') ||
      document.body
    );
  }

  function getCurrentStateNote() {
    try {
      const detailMap = getInitialState()?.note?.noteDetailMap || {};
      const keys = Object.keys(detailMap);
      if (keys.length === 0) return null;
      const pathPart = location.pathname.split('/').filter(Boolean).pop() || '';
      if (pathPart && detailMap[pathPart]) {
        return detailMap[pathPart]?.note || detailMap[pathPart];
      }
      return detailMap[keys[0]]?.note || detailMap[keys[0]];
    } catch {
      return null;
    }
  }

  function pushUniqueUrl(list, value) {
    if (!value || typeof value !== 'string') return;
    const url = value.trim();
    if (!/^https?:\/\//i.test(url)) return;
    if (!list.includes(url)) {
      list.push(url);
    }
  }

  function getNoteTitle(root) {
    return (
      document.querySelector('#detail-title')?.innerText?.trim() ||
      root.querySelector('#detail-title')?.innerText?.trim() ||
      root.querySelector('.note-title')?.innerText?.trim() ||
      root.querySelector('.title')?.innerText?.trim() ||
      document.querySelector('meta[property="og:title"]')?.getAttribute('content') ||
      document.title ||
      '笔记'
    );
  }

  function getTextContent(root) {
    const textEls = Array.from(root.querySelectorAll('#detail-desc .note-text, .desc .note-text, .note-content .note-text'));
    const joined = textEls
      .map((el) => el.innerText?.trim())
      .filter(Boolean)
      .join('\n\n');
    if (joined) return joined;
    const metaDescription = document.querySelector('meta[property="og:description"]')?.getAttribute('content')
      || document.querySelector('meta[name="description"]')?.getAttribute('content')
      || '';
    return String(metaDescription || '').trim();
  }

  function getAuthor(root) {
    return (
      root.querySelector('.author .username')?.innerText?.trim() ||
      root.querySelector('.author-wrapper .username')?.innerText?.trim() ||
      root.querySelector('.username')?.innerText?.trim() ||
      '未知'
    );
  }

  function getImageUrls(root, stateNote) {
    const urls = [];
    const imageList = Array.isArray(stateNote?.imageList)
      ? stateNote.imageList
      : Array.isArray(stateNote?.images)
        ? stateNote.images
        : [];

    imageList.forEach((item) => {
      if (typeof item === 'string') {
        pushUniqueUrl(urls, item);
        return;
      }
      pushUniqueUrl(urls, item?.urlDefault);
      pushUniqueUrl(urls, item?.urlPre);
      pushUniqueUrl(urls, item?.url);
      pushUniqueUrl(urls, item?.urlDefaultWebp);
    });

    if (urls.length > 0) return urls;

    const imgEls = Array.from(root.querySelectorAll('.img-container img, .note-content .img-container img, .swiper-slide img'));
    imgEls.forEach((img) => {
      pushUniqueUrl(urls, img.getAttribute('src') || img.getAttribute('data-src') || '');
    });
    return urls;
  }

  function collectDeepHttpUrls(input, maxCount = 40) {
    const urls = [];
    const seenObjects = new WeakSet();
    const seenUrls = new Set();

    function walk(value) {
      if (!value || urls.length >= maxCount) return;
      if (typeof value === 'string') {
        const trimmed = value.trim();
        if (/^https?:\/\//i.test(trimmed) && !seenUrls.has(trimmed)) {
          seenUrls.add(trimmed);
          urls.push(trimmed);
        }
        return;
      }
      if (typeof value !== 'object') return;
      if (seenObjects.has(value)) return;
      seenObjects.add(value);

      if (Array.isArray(value)) {
        for (const item of value) {
          walk(item);
          if (urls.length >= maxCount) break;
        }
        return;
      }

      for (const key of Object.keys(value)) {
        walk(value[key]);
        if (urls.length >= maxCount) break;
      }
    }

    walk(input);
    return urls;
  }

  function scoreVideoCandidate(url) {
    const normalized = String(url || '').toLowerCase();
    let score = 0;
    if (/\.mp4(\?|$)/.test(normalized)) score += 120;
    if (/\.m3u8(\?|$)/.test(normalized)) score += 80;
    if (/master/.test(normalized)) score += 25;
    if (/stream|video|media/.test(normalized)) score += 15;
    if (/sns-video|xiaohongshu|xhscdn|alicdn|byteimg/.test(normalized)) score += 10;
    return score;
  }

  function getPerformanceMediaUrls() {
    try {
      return performance.getEntriesByType('resource')
        .map((entry) => String(entry?.name || '').trim())
        .filter((url) => /^https?:\/\//i.test(url))
        .filter((url) => /(\.mp4|\.m3u8|video|stream|master)/i.test(url))
        .slice(-20);
    } catch {
      return [];
    }
  }

  function getVideoUrl(root, stateNote) {
    const candidates = [];
    const h264 = stateNote?.video?.media?.stream?.h264 || [];
    const h265 = stateNote?.video?.media?.stream?.h265 || [];
    [...h264, ...h265].forEach((item) => {
      pushUniqueUrl(candidates, item?.masterUrl);
    });
    pushUniqueUrl(candidates, stateNote?.video?.media?.masterUrl);
    pushUniqueUrl(candidates, stateNote?.video?.media?.url);
    pushUniqueUrl(candidates, stateNote?.video?.url);
    collectDeepHttpUrls(stateNote?.video || stateNote, 80).forEach((url) => pushUniqueUrl(candidates, url));
    getPerformanceMediaUrls().forEach((url) => pushUniqueUrl(candidates, url));
    if (candidates.length > 0) {
      return candidates.sort((a, b) => scoreVideoCandidate(b) - scoreVideoCandidate(a))[0];
    }

    const videoEl = root.querySelector('video');
    if (videoEl?.src && !String(videoEl.src).startsWith('blob:')) return videoEl.src;
    const sourceEl = videoEl?.querySelector('source[src]');
    if (sourceEl?.src && !String(sourceEl.src).startsWith('blob:')) return sourceEl.src;
    return videoEl?.src || sourceEl?.src || null;
  }

  function captureVideoCoverDataUrl(root) {
    try {
      const videoEl = root.querySelector('video');
      if (!videoEl || !videoEl.videoWidth || !videoEl.videoHeight) return '';
      const canvas = document.createElement('canvas');
      canvas.width = videoEl.videoWidth;
      canvas.height = videoEl.videoHeight;
      const ctx = canvas.getContext('2d');
      if (!ctx) return '';
      ctx.drawImage(videoEl, 0, 0, canvas.width, canvas.height);
      return canvas.toDataURL('image/jpeg', 0.92);
    } catch {
      return '';
    }
  }

  function getCoverUrl(root, images, videoUrl) {
    const poster = root.querySelector('video')?.getAttribute('poster');
    if (poster) return poster;
    if (images[0]) return images[0];
    if (videoUrl) {
      return document.querySelector('meta[property="og:image"]')?.getAttribute('content') || null;
    }
    return document.querySelector('meta[property="og:image"]')?.getAttribute('content') || null;
  }

  function getStats() {
    const likeEl = Array.from(document.querySelectorAll('.like-wrapper .count,[class*="like-wrapper"] .count,[class*="like"] .count'))
      .find((el) => !el.closest('.comments-el') && !el.closest('[class*="comments-el"]'));
    const collectEl = Array.from(document.querySelectorAll('.collect-wrapper .count,[class*="collect-wrapper"] .count,[class*="collect"] .count'))
      .find((el) => !el.closest('.comments-el') && !el.closest('[class*="comments-el"]'));

    return {
      likes: parseCountText(likeEl?.innerText || ''),
      collects: parseCountText(collectEl?.innerText || ''),
    };
  }

  async function blobToDataUrl(blob) {
    return await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ''));
      reader.onerror = () => reject(reader.error || new Error('Failed to read blob as data url'));
      reader.readAsDataURL(blob);
    });
  }

  async function fetchBinaryAsDataUrl(url) {
    const target = String(url || '').trim();
    if (!/^https?:\/\//i.test(target)) return '';
    try {
      const response = await fetch(target, {
        credentials: 'include',
        cache: 'force-cache',
      });
      if (!response.ok) return '';
      const blob = await response.blob();
      if (!blob || !blob.size) return '';
      return await blobToDataUrl(blob);
    } catch {
      return '';
    }
  }

  const root = getCurrentNoteRoot();
  const stateNote = getCurrentStateNote();
  const title = String(getNoteTitle(root) || '').trim();
  const content = String(getTextContent(root) || '').trim();
  const images = getImageUrls(root, stateNote).slice(0, 9);
  const videoUrl = getVideoUrl(root, stateNote);
  const coverUrl = getCoverUrl(root, images, videoUrl);
  const capturedVideoCover = (!coverUrl && videoUrl) ? captureVideoCoverDataUrl(root) : '';

  const localizedImages = [];
  for (const imageUrl of images) {
    const dataUrl = await fetchBinaryAsDataUrl(imageUrl);
    localizedImages.push(dataUrl || imageUrl);
  }

  const localizedCoverUrl = coverUrl
    ? (await fetchBinaryAsDataUrl(coverUrl)) || coverUrl
    : (capturedVideoCover || '');
  const localizedVideoDataUrl = videoUrl && String(videoUrl).startsWith('blob:')
    ? (await fetchBinaryAsDataUrl(videoUrl))
    : '';

  return {
    noteId: `xhs_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    title,
    author: getAuthor(root),
    content,
    text: content,
    images: localizedImages,
    coverUrl: localizedCoverUrl || coverUrl,
    videoUrl,
    videoDataUrl: localizedVideoDataUrl || '',
    stats: getStats(),
    source: location.href,
  };
}

function detectCaptureTarget() {
  const hostname = String(location.hostname || '').toLowerCase();

  if (hostname === 'youtube.com' || hostname.endsWith('.youtube.com') || hostname === 'youtu.be') {
    const url = new URL(location.href);
    const isVideoPage = url.pathname.startsWith('/watch') || url.pathname.startsWith('/shorts/') || hostname === 'youtu.be';
    if (isVideoPage) {
      return {
        kind: 'youtube',
        action: 'save-youtube',
        label: '保存youtube视频到知识库',
        description: '当前页面已识别为 YouTube 视频页。',
      };
    }
  }

  if (/(^|\.)xiaohongshu\.com$/i.test(hostname)) {
    function getInitialState() {
      const scripts = document.querySelectorAll('script');
      for (const script of scripts) {
        const text = script.textContent || '';
        if (!text.includes('window.__INITIAL_STATE__=')) continue;
        try {
          const jsonText = text
            .replace('window.__INITIAL_STATE__=', '')
            .replace(/undefined/g, 'null')
            .replace(/;$/, '');
          return JSON.parse(jsonText);
        } catch {
          return null;
        }
      }
      return null;
    }

    function getCurrentStateNote() {
      try {
        const detailMap = getInitialState()?.note?.noteDetailMap || {};
        const keys = Object.keys(detailMap);
        if (keys.length === 0) return null;
        const pathPart = location.pathname.split('/').filter(Boolean).pop() || '';
        if (pathPart && detailMap[pathPart]) {
          return detailMap[pathPart]?.note || detailMap[pathPart];
        }
        return detailMap[keys[0]]?.note || detailMap[keys[0]];
      } catch {
        return null;
      }
    }

    const noteRoot = document.querySelector('#noteContainer, .note-container, .note-content');
    const stateNote = getCurrentStateNote();
    const stateHasVideo = Boolean(
      stateNote?.video?.media ||
      stateNote?.video?.stream ||
      stateNote?.video?.url ||
      stateNote?.video?.media?.masterUrl ||
      stateNote?.type === 'video' ||
      stateNote?.noteType === 'video'
    );
    const domHasVideo = Boolean(document.querySelector('#noteContainer video, .note-container video, .note-content video'));
    const isVideoNote = stateHasVideo || domHasVideo;

    if (noteRoot || stateNote) {
      return {
        kind: isVideoNote ? 'xhs-video' : 'xhs-image',
        action: 'save-xhs',
        label: isVideoNote ? '保存小红书视频笔记到知识库' : '保存小红书图文到知识库',
        description: isVideoNote ? '当前页面已识别为小红书视频笔记。' : '当前页面已识别为小红书图文笔记。'
      };
    }

    const articleRoot = document.querySelector('[class*="article"], .article-container, .content-container');
    if (articleRoot) {
      return {
        kind: 'xhs-article',
        action: 'save-xhs',
        label: '保存小红书图文到知识库',
        description: '当前页面已识别为小红书图文内容页。',
      };
    }
  }

  if (hostname === 'mp.weixin.qq.com') {
    return {
      kind: 'wechat-article',
      action: 'save-page-link',
      label: '保存公众号文章到知识库',
      description: '当前页面已识别为公众号文章，将完整保存正文、图片和排版。',
    };
  }

  const articleRoot = document.querySelector('#js_content, .rich_media_content, article, main, [role="main"], .article, .article-container, .post-content, .entry-content, .markdown-body, .content, .post, .note-content');
  const articleText = String(articleRoot?.innerText || '').replace(/\s+/g, ' ').trim();
  if (articleRoot && articleText.length >= 280) {
    return {
      kind: 'link-article',
      action: 'save-page-link',
      label: '保存链接文章到知识库',
      description: '将提取正文、来源和封面保存到知识库。',
    };
  }

  return {
    kind: 'generic',
    action: 'save-page-link',
    label: '保存当前页面链接到知识库',
    description: '当前页面可作为链接收藏保存到知识库。',
  };
}
