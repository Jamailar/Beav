import generatedBrand from './brand.generated.json';

type GeneratedBrandConfig = {
  variant?: string;
  displayName?: string;
  windowTitle?: string;
  htmlTitle?: string;
  aiDisplayName?: string;
  logoSrc?: string;
  tagline?: string;
  downloadUrl?: string;
  githubIssuesUrl?: string;
  githubRepoUrl?: string;
  theme?: AppBrandTheme;
};

const config = generatedBrand as GeneratedBrandConfig;

export type AppBrandThemeModeTokens = Partial<{
  background: string;
  surfacePrimary: string;
  surfaceSecondary: string;
  surfaceTertiary: string;
  surfaceElevated: string;
  border: string;
  divider: string;
  textPrimary: string;
  textSecondary: string;
  textTertiary: string;
  accentPrimary: string;
  accentHover: string;
  accentMuted: string;
  accentBorder: string;
  focusRing: string;
  primary: string;
  primaryHover: string;
  primaryPressed: string;
  primaryText: string;
  statusSuccess: string;
  statusWarning: string;
  statusError: string;
  successBg: string;
  successText: string;
  warningBg: string;
  warningText: string;
  dangerBg: string;
  dangerText: string;
  info: string;
  infoBg: string;
  infoText: string;
  brandRed: string;
  brandRedText: string;
  appShellBackground: string;
  sidebarBackground: string;
  sidebarItemColor: string;
  sidebarItemHoverBackground: string;
  sidebarItemHoverColor: string;
  sidebarItemActiveBackground: string;
  sidebarItemActiveColor: string;
  sidebarItemActiveIconColor: string;
  cardShadow: string;
  cardHoverShadow: string;
  aiPanelBackground: string;
  aiPanelBorder: string;
  aiPanelShadow: string;
  aiChipBackground: string;
  aiChipColor: string;
  aiChipBorder: string;
  moduleIdeateBg: string;
  moduleIdeateIcon: string;
  moduleWriteBg: string;
  moduleWriteIcon: string;
  moduleRepurposeBg: string;
  moduleRepurposeIcon: string;
  moduleScheduleBg: string;
  moduleScheduleIcon: string;
  moduleAnalyticsBg: string;
  moduleAnalyticsIcon: string;
  moduleBrandBg: string;
  moduleBrandIcon: string;
}>;

export type AppBrandTheme = Partial<{
  light: AppBrandThemeModeTokens;
  dark: AppBrandThemeModeTokens;
}>;

export const APP_BRAND = {
  variant: String(config.variant || 'redbox'),
  displayName: String(config.displayName || 'App'),
  windowTitle: String(config.windowTitle || config.displayName || 'App'),
  htmlTitle: String(config.htmlTitle || config.windowTitle || config.displayName || 'App'),
  aiDisplayName: String(config.aiDisplayName || config.displayName || 'App'),
  logoSrc: String(config.logoSrc || '/branding/logo.png'),
  tagline: String(config.tagline || ''),
  downloadUrl: String(config.downloadUrl || ''),
  githubIssuesUrl: String(config.githubIssuesUrl || ''),
  githubRepoUrl: String(config.githubRepoUrl || ''),
  theme: config.theme || {},
} as const;
