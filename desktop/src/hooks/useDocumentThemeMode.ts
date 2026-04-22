import { useEffect, useState } from 'react';

export type DocumentThemeMode = 'light' | 'dark';

function readDocumentThemeMode(): DocumentThemeMode {
  if (typeof document === 'undefined') return 'light';
  const root = document.documentElement;
  const dataTheme = String(root.getAttribute('data-theme') || '').trim().toLowerCase();
  if (dataTheme === 'dark') return 'dark';
  if (dataTheme === 'light') return 'light';
  return root.classList.contains('dark') ? 'dark' : 'light';
}

export function useDocumentThemeMode(): DocumentThemeMode {
  const [themeMode, setThemeMode] = useState<DocumentThemeMode>(readDocumentThemeMode);

  useEffect(() => {
    if (typeof document === 'undefined') return undefined;
    const root = document.documentElement;
    const syncThemeMode = () => setThemeMode(readDocumentThemeMode());

    syncThemeMode();

    const observer = new MutationObserver(syncThemeMode);
    observer.observe(root, {
      attributes: true,
      attributeFilter: ['data-theme', 'class'],
    });

    return () => observer.disconnect();
  }, []);

  return themeMode;
}
