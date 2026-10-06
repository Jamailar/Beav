(() => {
  const BRIDGE_FLAG = '__REDBOX_XHS_BRIDGE_INSTALLED__';
  const RESPONSE_STORE = '__REDBOX_XHS_RESPONSES__';
  const MAX_RESPONSES = 120;

  if (window[BRIDGE_FLAG]) return;
  window[BRIDGE_FLAG] = true;
  window[RESPONSE_STORE] = Array.isArray(window[RESPONSE_STORE]) ? window[RESPONSE_STORE] : [];

  function shouldCapture(url) {
    try {
      const parsed = new URL(String(url || ''), location.href);
      return /(^|\.)xiaohongshu\.com$/i.test(parsed.hostname)
        || /(^|\.)rednote\.com$/i.test(parsed.hostname);
    } catch {
      return false;
    }
  }

  function parseJsonSafely(text) {
    const raw = String(text || '').trim();
    if (!raw || !/^[\[{]/.test(raw)) return null;
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  function remember(record) {
    if (!record?.url || !record?.result) return;
    const next = {
      url: String(record.url),
      method: String(record.method || 'GET').toUpperCase(),
      body: record.body || null,
      result: record.result,
      capturedAt: Date.now(),
    };
    const store = Array.isArray(window[RESPONSE_STORE]) ? window[RESPONSE_STORE] : [];
    store.push(next);
    while (store.length > MAX_RESPONSES) store.shift();
    window[RESPONSE_STORE] = store;
    window.postMessage({
      source: 'redbox-xhs-bridge',
      type: 'api-response',
      payload: {
        url: next.url,
        method: next.method,
        capturedAt: next.capturedAt,
      },
    }, '*');
  }

  function requestUrl(input) {
    if (typeof input === 'string') return input;
    if (input instanceof URL) return input.toString();
    if (input && typeof input.url === 'string') return input.url;
    return '';
  }

  function requestMethod(input, init) {
    return init?.method || input?.method || 'GET';
  }

  const nativeFetch = window.fetch;
  if (typeof nativeFetch === 'function') {
    window.fetch = async function redboxFetch(input, init) {
      const response = await nativeFetch.apply(this, arguments);
      const url = requestUrl(input);
      if (!shouldCapture(url)) return response;
      try {
        const clone = response.clone();
        const text = await clone.text();
        const result = parseJsonSafely(text);
        if (result) {
          remember({
            url: response.url || url,
            method: requestMethod(input, init),
            body: typeof init?.body === 'string' ? parseJsonSafely(init.body) : null,
            result,
          });
        }
      } catch {
        // Capture is best-effort and must never affect the page request.
      }
      return response;
    };
  }

  if (window.XMLHttpRequest?.prototype) {
    const nativeOpen = XMLHttpRequest.prototype.open;
    const nativeSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function redboxXhrOpen(method, url) {
      this.__redboxXhsMethod = method || 'GET';
      this.__redboxXhsUrl = url || '';
      return nativeOpen.apply(this, arguments);
    };
    XMLHttpRequest.prototype.send = function redboxXhrSend(body) {
      this.addEventListener('loadend', () => {
        const url = this.responseURL || this.__redboxXhsUrl || '';
        if (!shouldCapture(url)) return;
        try {
          const result = parseJsonSafely(this.responseText);
          if (result) {
            remember({
              url,
              method: this.__redboxXhsMethod || 'GET',
              body: typeof body === 'string' ? parseJsonSafely(body) : null,
              result,
            });
          }
        } catch {
          // Capture is best-effort.
        }
      });
      return nativeSend.apply(this, arguments);
    };
  }
})();
