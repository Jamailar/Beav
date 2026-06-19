(() => {
  const registry = [];

  function register(adapter) {
    registry.push(adapter);
  }

  function text(selector, root = document) {
    return normalize(root.querySelector(selector)?.innerText || root.querySelector(selector)?.textContent || '');
  }

  function attr(selector, name, root = document) {
    return root.querySelector(selector)?.getAttribute(name) || '';
  }

  function normalize(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
  }

  function links(selector, root = document, limit = 100) {
    return [...root.querySelectorAll(selector)]
      .map((node) => ({
        href: node.href || node.getAttribute('href') || '',
        text: normalize(node.innerText || node.textContent || node.getAttribute('aria-label') || ''),
      }))
      .filter((item) => item.href)
      .slice(0, limit);
  }

  register({
    id: 'youtube',
    label: 'YouTube',
    matches: ({ hostname }) => hostname.includes('youtube.com') || hostname === 'youtu.be',
    suggestedFields: [
      { name: 'title', type: 'text', source: 'adapter' },
      { name: 'channel', type: 'text', source: 'adapter' },
      { name: 'views', type: 'text', source: 'adapter' },
      { name: 'publishedAt', type: 'text', source: 'adapter' },
      { name: 'description', type: 'text', source: 'adapter' },
      { name: 'videoUrl', type: 'url', source: 'adapter' },
    ],
    extract() {
      return {
        videoUrl: location.href,
        title: text('h1 yt-formatted-string') || document.title.replace(/ - YouTube$/, ''),
        channel: text('#owner #channel-name a, ytd-channel-name a'),
        views: text('#info span:nth-child(1), ytd-watch-info-text span:nth-child(1)'),
        publishedAt: text('#info span:nth-child(3), ytd-watch-info-text span:nth-child(3)'),
        description: text('#description, ytd-text-inline-expander'),
        recommendations: links('a#video-title, a.yt-simple-endpoint[href*="/watch"]', document, 40),
      };
    },
  });

  register({
    id: 'google-maps',
    label: 'Google Maps',
    matches: ({ hostname }) => hostname.includes('google.') && location.pathname.includes('/maps'),
    suggestedFields: [
      { name: 'name', type: 'text', source: 'adapter' },
      { name: 'rating', type: 'number', source: 'adapter' },
      { name: 'reviews', type: 'text', source: 'adapter' },
      { name: 'address', type: 'text', source: 'adapter' },
      { name: 'phone', type: 'phone', source: 'adapter' },
      { name: 'website', type: 'url', source: 'adapter' },
    ],
    extract() {
      return {
        name: text('h1'),
        rating: text('[role="img"][aria-label*="stars"], [aria-label*="星"]'),
        reviews: text('button[aria-label*="reviews"], button[aria-label*="条评价"]'),
        address: text('[data-item-id="address"], button[data-item-id="address"]'),
        phone: text('[data-item-id^="phone"], button[data-item-id^="phone"]'),
        website: attr('a[data-item-id="authority"]', 'href'),
        places: links('a[href*="/maps/place/"]', document, 100),
      };
    },
  });

  register({
    id: 'xiaohongshu',
    label: 'Xiaohongshu',
    matches: ({ hostname }) => hostname.includes('xiaohongshu.com') || hostname.includes('rednote.com'),
    suggestedFields: [
      { name: 'title', type: 'text', source: 'adapter' },
      { name: 'author', type: 'text', source: 'adapter' },
      { name: 'content', type: 'text', source: 'adapter' },
      { name: 'likes', type: 'number', source: 'adapter' },
      { name: 'noteUrl', type: 'url', source: 'adapter' },
    ],
    extract() {
      return {
        noteUrl: location.href,
        title: text('#detail-title, .title, h1'),
        author: text('.author, .username, [class*="author"]'),
        content: text('#detail-desc, .desc, [class*="content"]'),
        likes: text('[class*="like"], [aria-label*="like"]'),
        noteLinks: links('a[href*="/explore/"], a[href*="/discovery/item/"]', document, 100),
      };
    },
  });

  window.XWOW_SITE_ADAPTERS = {
    all: registry,
    match() {
      const url = new URL(location.href);
      return registry.find((adapter) => {
        try {
          return adapter.matches(url);
        } catch {
          return false;
        }
      }) || null;
    },
  };
})();
