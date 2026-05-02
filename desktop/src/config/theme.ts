import { APP_BRAND, type AppBrandTheme, type AppBrandThemeModeTokens } from './brand';

export type ThemeMode = 'light' | 'dark';

export type CustomThemePreference = {
  enabled: boolean;
  accentHex: string;
};

export const THEME_MODE_STORAGE_KEY = 'redbox:theme-mode:v1';
export const CUSTOM_THEME_STORAGE_KEY = 'redbox:custom-theme:v1';
export const CUSTOM_THEME_CHANGED_EVENT = 'redbox:custom-theme-changed';

const FALLBACK_ACCENT_HEX = '#a2784b';

const TOKEN_TO_CSS_VAR: Record<keyof AppBrandThemeModeTokens, string> = {
  background: '--color-background',
  surfacePrimary: '--color-surface-primary',
  surfaceSecondary: '--color-surface-secondary',
  surfaceTertiary: '--color-surface-tertiary',
  surfaceElevated: '--color-surface-elevated',
  border: '--color-border',
  divider: '--color-divider',
  textPrimary: '--color-text-primary',
  textSecondary: '--color-text-secondary',
  textTertiary: '--color-text-tertiary',
  accentPrimary: '--color-accent-primary',
  accentHover: '--color-accent-hover',
  accentMuted: '--color-accent-muted',
  accentBorder: '--color-accent-border',
  focusRing: '--color-focus-ring',
  primary: '--color-primary',
  primaryHover: '--color-primary-hover',
  primaryPressed: '--color-primary-pressed',
  primaryText: '--color-primary-text',
  statusSuccess: '--color-status-success',
  statusWarning: '--color-status-warning',
  statusError: '--color-status-error',
  successBg: '--color-success-bg',
  successText: '--color-success-text',
  warningBg: '--color-warning-bg',
  warningText: '--color-warning-text',
  dangerBg: '--color-danger-bg',
  dangerText: '--color-danger-text',
  info: '--color-info',
  infoBg: '--color-info-bg',
  infoText: '--color-info-text',
  brandRed: '--color-brand-red',
  brandRedText: '--color-brand-red-text',
  appShellBackground: '--app-shell-background',
  sidebarBackground: '--app-sidebar-background',
  sidebarItemColor: '--app-sidebar-item-color',
  sidebarItemHoverBackground: '--app-sidebar-item-hover-background',
  sidebarItemHoverColor: '--app-sidebar-item-hover-color',
  sidebarItemActiveBackground: '--app-sidebar-item-active-background',
  sidebarItemActiveColor: '--app-sidebar-item-active-color',
  sidebarItemActiveIconColor: '--app-sidebar-item-active-icon-color',
  cardShadow: '--app-card-shadow',
  cardHoverShadow: '--app-card-hover-shadow',
  aiPanelBackground: '--ai-panel-background',
  aiPanelBorder: '--ai-panel-border',
  aiPanelShadow: '--ai-panel-shadow',
  aiChipBackground: '--ai-chip-background',
  aiChipColor: '--ai-chip-color',
  aiChipBorder: '--ai-chip-border',
  moduleIdeateBg: '--module-ideate-bg',
  moduleIdeateIcon: '--module-ideate-icon',
  moduleWriteBg: '--module-write-bg',
  moduleWriteIcon: '--module-write-icon',
  moduleRepurposeBg: '--module-repurpose-bg',
  moduleRepurposeIcon: '--module-repurpose-icon',
  moduleScheduleBg: '--module-schedule-bg',
  moduleScheduleIcon: '--module-schedule-icon',
  moduleAnalyticsBg: '--module-analytics-bg',
  moduleAnalyticsIcon: '--module-analytics-icon',
  moduleBrandBg: '--module-brand-bg',
  moduleBrandIcon: '--module-brand-icon',
};

function clampChannel(value: number): number {
  return Math.max(0, Math.min(255, Math.round(value)));
}

function parseHexColor(value: string): [number, number, number] | null {
  const normalized = String(value || '').trim().replace(/^#/, '');
  const expanded = normalized.length === 3
    ? normalized.split('').map((char) => `${char}${char}`).join('')
    : normalized;
  if (!/^[0-9a-fA-F]{6}$/.test(expanded)) return null;
  return [
    Number.parseInt(expanded.slice(0, 2), 16),
    Number.parseInt(expanded.slice(2, 4), 16),
    Number.parseInt(expanded.slice(4, 6), 16),
  ];
}

function rgbToToken(rgb: [number, number, number]): string {
  return rgb.map(clampChannel).join(' ');
}

function tokenToHex(value: string | undefined): string | null {
  const channels = String(value || '').trim().split(/\s+/).map((channel) => Number.parseInt(channel, 10));
  if (channels.length !== 3 || channels.some((channel) => !Number.isFinite(channel))) return null;
  return `#${channels.map((channel) => clampChannel(channel).toString(16).padStart(2, '0')).join('')}`;
}

function defaultAccentHex(): string {
  return tokenToHex(APP_BRAND.theme.light?.accentPrimary) || FALLBACK_ACCENT_HEX;
}

function mixRgb(left: [number, number, number], right: [number, number, number], amount: number): [number, number, number] {
  return [
    left[0] + (right[0] - left[0]) * amount,
    left[1] + (right[1] - left[1]) * amount,
    left[2] + (right[2] - left[2]) * amount,
  ];
}

export function normalizeAccentHex(value: string): string {
  const rgb = parseHexColor(value);
  if (!rgb) return defaultAccentHex();
  return `#${rgb.map((channel) => clampChannel(channel).toString(16).padStart(2, '0')).join('')}`;
}

export function readThemeMode(): ThemeMode {
  if (typeof window === 'undefined') return 'light';
  const saved = String(window.localStorage.getItem(THEME_MODE_STORAGE_KEY) || '').trim().toLowerCase();
  if (saved === 'light' || saved === 'dark') return saved;
  return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export function readCustomThemePreference(): CustomThemePreference {
  if (typeof window === 'undefined') {
    return { enabled: false, accentHex: defaultAccentHex() };
  }
  try {
    const parsed = JSON.parse(window.localStorage.getItem(CUSTOM_THEME_STORAGE_KEY) || '{}') as Partial<CustomThemePreference>;
    return {
      enabled: parsed.enabled === true,
      accentHex: normalizeAccentHex(String(parsed.accentHex || defaultAccentHex())),
    };
  } catch {
    return { enabled: false, accentHex: defaultAccentHex() };
  }
}

export function writeCustomThemePreference(next: CustomThemePreference) {
  if (typeof window === 'undefined') return;
  const normalized = {
    enabled: next.enabled === true,
    accentHex: normalizeAccentHex(next.accentHex),
  };
  window.localStorage.setItem(CUSTOM_THEME_STORAGE_KEY, JSON.stringify(normalized));
  window.dispatchEvent(new CustomEvent(CUSTOM_THEME_CHANGED_EVENT, { detail: normalized }));
}

function applyTokenSet(tokens: AppBrandThemeModeTokens | undefined) {
  if (!tokens || typeof document === 'undefined') return;
  const root = document.documentElement;
  for (const [key, cssVar] of Object.entries(TOKEN_TO_CSS_VAR) as Array<[keyof AppBrandThemeModeTokens, string]>) {
    const value = String(tokens[key] || '').trim();
    if (value) {
      root.style.setProperty(cssVar, value);
    }
  }
}

function customTokensForMode(mode: ThemeMode, preference: CustomThemePreference): AppBrandThemeModeTokens | null {
  if (!preference.enabled) return null;
  const accent = parseHexColor(preference.accentHex);
  if (!accent) return null;
  if (mode === 'dark') {
    return {
      accentPrimary: rgbToToken(mixRgb(accent, [255, 255, 255], 0.22)),
      accentHover: rgbToToken(mixRgb(accent, [255, 255, 255], 0.36)),
      accentMuted: rgbToToken(mixRgb(accent, [0, 0, 0], 0.62)),
      brandRed: rgbToToken(mixRgb(accent, [255, 255, 255], 0.22)),
      brandRedText: rgbToToken(mixRgb(accent, [255, 255, 255], 0.58)),
    };
  }
  return {
    accentPrimary: rgbToToken(accent),
    accentHover: rgbToToken(mixRgb(accent, [0, 0, 0], 0.18)),
    accentMuted: rgbToToken(mixRgb(accent, [255, 255, 255], 0.84)),
    brandRed: rgbToToken(accent),
    brandRedText: rgbToToken(mixRgb(accent, [0, 0, 0], 0.22)),
  };
}

export function applyAppTheme(mode: ThemeMode, brandTheme: AppBrandTheme = APP_BRAND.theme) {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  root.setAttribute('data-theme', mode);
  root.classList.toggle('dark', mode === 'dark');
  applyTokenSet(mode === 'dark' ? brandTheme.dark : brandTheme.light);
  applyTokenSet(customTokensForMode(mode, readCustomThemePreference()) || undefined);
}
