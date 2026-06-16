(function installRedBoxCaptureRuntime() {
  const VERSION = 1;
  const RUNTIME_KEY = '__REDBOX_CAPTURE_RUNTIME__';

  function normalizeText(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
  }

  function normalizeBlockText(value) {
    return String(value || '').replace(/\r/g, '').replace(/\n{3,}/g, '\n\n').trim();
  }

  function parseCountText(value) {
    const text = normalizeText(value).replace(/[\s,]/g, '');
    if (!text) return 0;
    const match = text.match(/(\d+(?:\.\d+)?)(万|亿)?/);
    if (!match) return 0;
    const number = parseFloat(match[1]);
    if (Number.isNaN(number)) return 0;
    if (match[2] === '万') return Math.round(number * 10000);
    if (match[2] === '亿') return Math.round(number * 100000000);
    return Math.round(number);
  }

  function wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function isVisible(el, options = {}) {
    if (!el || !(el instanceof Element)) return false;
    const minWidth = Number(options.minWidth || 20);
    const minHeight = Number(options.minHeight || 10);
    const style = window.getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    return style.display !== 'none'
      && style.visibility !== 'hidden'
      && rect.width > minWidth
      && rect.height > minHeight;
  }

  function firstElement(selectors, root = document) {
    for (const selector of Array.isArray(selectors) ? selectors : [selectors]) {
      if (!selector) continue;
      const node = root.querySelector(selector);
      if (node) return node;
    }
    return null;
  }

  function collectVisibleNodes(selectors, options = {}) {
    const roots = Array.isArray(options.roots) && options.roots.length > 0 ? options.roots : [options.root || document];
    const seen = new Set();
    const nodes = [];
    for (const root of roots) {
      if (!root?.querySelectorAll) continue;
      for (const selector of Array.isArray(selectors) ? selectors : [selectors]) {
        if (!selector) continue;
        for (const node of Array.from(root.querySelectorAll(selector))) {
          if (seen.has(node) || !isVisible(node, options.visibility || {})) continue;
          seen.add(node);
          nodes.push(node);
        }
      }
    }
    return nodes;
  }

  function findScrollableContainer(root, options = {}) {
    const selectors = Array.isArray(options.fallbackSelectors) ? options.fallbackSelectors : [];
    const candidates = [
      root,
      root?.closest?.(selectors.join(',') || 'body'),
      ...selectors.map((selector) => document.querySelector(selector)),
      document.scrollingElement,
      document.documentElement,
    ].filter(Boolean);
    for (const candidate of candidates) {
      if (candidate.scrollHeight > candidate.clientHeight + Number(options.minOverflow || 80)) {
        return candidate;
      }
    }
    return document.scrollingElement || document.documentElement;
  }

  function nodeSignature(nodes, options = {}) {
    const limit = Number(options.limit || 80);
    const sample = nodes.slice(0, limit).map((node) => {
      const id = normalizeText(node.getAttribute?.('id') || '');
      const dataId = normalizeText(node.getAttribute?.('data-id') || node.getAttribute?.('data-comment-id') || '');
      const text = normalizeText(node.textContent || '').slice(0, 80);
      return `${id}|${dataId}|${text}`;
    });
    return sample.join('\n');
  }

  function readMatchingText(selectors, matcher, options = {}) {
    const roots = Array.isArray(options.roots) && options.roots.length > 0 ? options.roots : [options.root || document];
    for (const root of roots) {
      if (!root?.querySelectorAll) continue;
      for (const selector of Array.isArray(selectors) ? selectors : [selectors]) {
        if (!selector) continue;
        for (const node of Array.from(root.querySelectorAll(selector))) {
          if (!isVisible(node, options.visibility || {})) continue;
          const text = normalizeText(node.textContent || '');
          if (!text) continue;
          if (!matcher || matcher(text)) return text;
        }
      }
    }
    return '';
  }

  async function clickVisibleButtons(options = {}) {
    const root = options.root || document;
    const selectors = options.selectors || ['button', '.show-more', '.more', '[role="button"]', 'span', 'div'];
    const pattern = options.pattern || /展开|全部回复|条回复|查看更多|更多回复/i;
    const buttons = collectVisibleNodes(selectors, { root })
      .filter((el) => pattern.test(normalizeText(el.textContent || '')))
      .slice(0, Number(options.limit || 18));
    for (const button of buttons) {
      try {
        button.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
        await wait(Number(options.delayMs || 180));
      } catch {
        // Protected sites can reject synthetic events. Treat as a soft miss.
      }
    }
    return buttons.length;
  }

  function isChallengePage() {
    const title = normalizeText(document.title).toLowerCase();
    const shortBody = normalizeText(document.body?.innerText || '').slice(0, 1200).toLowerCase();
    const patterns = [
      'just a moment',
      'attention required',
      'human verification',
      'verifying you are human',
      'security check',
      'access denied',
      'checking your browser',
      '人机验证',
      '人类验证',
      '安全验证',
      '访问被拒绝',
    ];
    return patterns.some((item) => title.includes(item) || shortBody.includes(item));
  }

  async function scrollAndTrackContentChange(options = {}) {
    const diagnostics = [];
    const startedAt = Date.now();
    const itemSelectors = options.itemSelectors || [];
    const targetCount = Math.max(1, Number(options.targetCount || 200));
    const maxRounds = Math.max(1, Number(options.maxRounds || 28));
    const stallLimit = Math.max(1, Number(options.stallLimit || 5));
    let root = typeof options.rootResolver === 'function' ? options.rootResolver() : options.root;
    const scroller = findScrollableContainer(root, options.scroll || {});
    let nodes = collectVisibleNodes(itemSelectors, { root: root || document });
    let previousCount = nodes.length;
    let previousSignature = nodeSignature(nodes);
    let stalledRounds = 0;

    diagnostics.push({
      event: 'capture.scroll.start',
      count: previousCount,
      targetCount,
      challenge: isChallengePage(),
    });

    for (let round = 0; round < maxRounds; round += 1) {
      if (isChallengePage()) {
        diagnostics.push({ event: 'capture.scroll.challenge', round });
        break;
      }
      if (typeof options.beforeRound === 'function') {
        await options.beforeRound({ round, nodes, diagnostics });
      }
      root = typeof options.rootResolver === 'function' ? options.rootResolver() : options.root;
      nodes = collectVisibleNodes(itemSelectors, { root: root || document });
      const signature = nodeSignature(nodes);
      if (nodes.length >= targetCount) {
        diagnostics.push({ event: 'capture.scroll.target_reached', round, count: nodes.length });
        break;
      }
      if (nodes.length <= previousCount && signature === previousSignature) {
        stalledRounds += 1;
      } else {
        stalledRounds = 0;
        previousCount = nodes.length;
        previousSignature = signature;
      }
      if (stalledRounds >= stallLimit) {
        diagnostics.push({ event: 'capture.scroll.stalled', round, count: nodes.length, stalledRounds });
        break;
      }

      const distance = Math.max(
        Number(options.scroll?.minDistance || 420),
        Math.floor((scroller?.clientHeight || window.innerHeight || 600) * Number(options.scroll?.viewportRatio || 0.75)),
      );
      if (scroller === document.scrollingElement || scroller === document.documentElement) {
        window.scrollBy({ top: distance, behavior: options.smooth === false ? 'auto' : 'smooth' });
      } else if (scroller) {
        scroller.scrollTop += distance;
      }
      const waitMs = Number(options.waitMs || 520) + Math.min(round, 5) * Number(options.waitStepMs || 80);
      await wait(waitMs);
      diagnostics.push({ event: 'capture.scroll.round', round, count: nodes.length, waitMs });
    }

    if (typeof options.afterScroll === 'function') {
      await options.afterScroll({ nodes, diagnostics });
    }
    await wait(Number(options.finalWaitMs || 240));
    root = typeof options.rootResolver === 'function' ? options.rootResolver() : options.root;
    nodes = collectVisibleNodes(itemSelectors, { root: root || document });
    diagnostics.push({
      event: 'capture.scroll.complete',
      count: nodes.length,
      durationMs: Date.now() - startedAt,
    });
    return { nodes, diagnostics };
  }

  window[RUNTIME_KEY] = {
    version: VERSION,
    normalizeText,
    normalizeBlockText,
    parseCountText,
    wait,
    isVisible,
    firstElement,
    collectVisibleNodes,
    findScrollableContainer,
    nodeSignature,
    readMatchingText,
    clickVisibleButtons,
    isChallengePage,
    scrollAndTrackContentChange,
  };
})();
