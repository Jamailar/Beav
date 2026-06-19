(function () {
  const EVENT_NAME = 'redbox:locationchange';
  const INSTALL_KEY = '__redboxPageRouteBridgeInstalled__';

  if (window[INSTALL_KEY]) {
    return;
  }
  window[INSTALL_KEY] = true;

  function emitRouteChange(method, url) {
    window.dispatchEvent(new CustomEvent(EVENT_NAME, {
      detail: {
        method: String(method || ''),
        url: typeof url === 'string' ? url : '',
        href: location.href,
        ts: Date.now(),
      },
    }));
  }

  function wrapHistoryMethod(name) {
    const original = window.history?.[name];
    if (typeof original !== 'function') {
      return;
    }
    window.history[name] = function (...args) {
      const result = original.apply(this, args);
      emitRouteChange(name, args[2]);
      return result;
    };
  }

  wrapHistoryMethod('pushState');
  wrapHistoryMethod('replaceState');

  window.addEventListener('popstate', () => emitRouteChange('popstate', location.href), true);
  window.addEventListener('hashchange', () => emitRouteChange('hashchange', location.href), true);
  window.addEventListener('pageshow', () => emitRouteChange('pageshow', location.href), true);
})();
