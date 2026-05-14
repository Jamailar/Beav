import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

export type AppLanguage = 'zh-CN' | 'en-US';

type I18nContextValue = {
  language: AppLanguage;
  setLanguage: (language: AppLanguage) => void;
  t: (key: I18nKey, params?: Record<string, string | number>) => string;
};

const LANGUAGE_STORAGE_KEY = 'redbox:language:v1';

const LANGUAGE_LABELS: Record<AppLanguage, string> = {
  'zh-CN': '中文',
  'en-US': 'English',
};

export const SUPPORTED_LANGUAGES = Object.entries(LANGUAGE_LABELS).map(([value, label]) => ({
  value: value as AppLanguage,
  label,
}));

const zhCN = {
  'app.loadingPage': '页面加载中...',
  'app.authExpired': '当前账号登陆失效，请重新登陆。',
  'app.youtubeDetected': '检测到 YouTube 链接',
  'app.youtubeCaptureDescription': '确认后将立即在后台采集并保存到知识库（YouTube）。',
  'app.confirmCapture': '确认采集',
  'app.cancel': '取消',
  'app.confirm': '确定',
  'app.processing': '处理中...',

  'nav.newChat': '新对话',
  'nav.search': '知识库',
  'nav.assets': '资产库',
  'nav.automation': '自动化',
  'nav.home': '主页',
  'nav.wander': '漫步',
  'nav.settings': '设置',

  'layout.expandSidebar': '展开侧边栏',
  'layout.collapseSidebar': '收起侧边栏',
  'layout.openNotificationCenter': '打开通知中心',
  'layout.closeNotificationCenter': '关闭通知中心',
  'layout.switchToLight': '切换到白天模式',
  'layout.switchToDark': '切换到黑夜模式',
  'layout.space': '空间',
  'layout.noSpace': '暂无空间',
  'layout.createSpace': '新建空间',
  'layout.renameSpace': '重命名空间',
  'layout.deleteSpace': '删除空间',
  'layout.deleteSpaceConfirm': '确定删除空间“{name}”？该空间内的本地工作区文件也会一并删除。',
  'layout.spaceNameRequired': '空间名称不能为空',
  'layout.createSpaceFailed': '创建空间失败',
  'layout.createSpaceFailedRetry': '创建空间失败，请重试',
  'layout.switchSpaceFailed': '切换空间失败',
  'layout.switchSpaceFailedRetry': '切换空间失败，请重试',
  'layout.renameSpaceFailed': '重命名失败',
  'layout.renameSpaceFailedRetry': '重命名空间失败，请重试',
  'layout.renameSpaceMissing': '未找到要重命名的空间',
  'layout.deleteSpaceFailed': '删除空间失败',
  'layout.deleteSpaceFailedRetry': '删除空间失败，请重试',
  'layout.spaceNamePlaceholder': '请输入空间名称',
  'layout.defaultSpaceName': '暂无空间',
  'layout.openDownloadFailed': '打开下载页面失败',
  'layout.softwareUpdate': '软件更新',
  'layout.close': '关闭',
  'layout.newVersionFound': '发现新版本',
  'layout.currentReleaseNotes': '本版更新',
  'layout.currentVersion': '当前版本 {version}',
  'layout.publishedAt': '发布于 {date}',
  'layout.opening': '打开中...',
  'layout.downloadAndInstall': '下载并安装',
  'layout.releaseNotes': '更新说明',
  'layout.noReleaseNotes': '暂无更新说明。',

  'settings.title': '设置',
  'settings.tabs.ai': 'AI 模型',
  'settings.tabs.general': '常规设置',
  'settings.tabs.team': '团队',
  'settings.tabs.skills': '技能',
  'settings.tabs.mcp': 'MCP 服务器',
  'settings.tabs.profile': '用户档案',
  'settings.tabs.tools': '工具管理',
  'settings.tabs.experimental': '实验功能',
  'settings.ai.title': 'AI 模型设置',
  'settings.language.title': '语言',
  'settings.language.description': '切换后立即生效，并会在下次启动时保留。',
  'settings.language.selectLabel': '界面语言',
  'settings.general.title': '常规设置',
  'settings.general.appVersion': '应用版本',
  'settings.general.currentVersion': '当前版本:',
  'settings.general.viewCurrentReleaseNotes': '查看本版更新',
  'settings.general.loading': '加载中...',
  'settings.general.updateDescription': '启动时自动检查新版本，安装包从应用下载源获取。',
  'settings.general.openDownloadPage': '打开下载页',
  'settings.general.browserPlugin': '浏览器插件',
  'settings.general.installPlugin': '安装插件',
  'settings.general.workspaceRoot': '工作区根目录',
  'settings.general.workspaceDescription': 'RedConvert 会在这里创建完整工作区结构。留空则使用默认目录 ~/.redconvert',
  'settings.general.pickFolder': '选择文件夹',
  'settings.general.restoreDefault': '恢复默认',
  'settings.general.workspaceWarningPrefix': '不要直接选择现有的稿件目录、',
  'settings.general.workspaceWarningMiddle': '目录或',
  'settings.general.workspaceWarningSuffix': '目录，否则应用会在其中创建',
  'settings.general.workspaceWarningEnd': '等完整工作区结构。',
  'settings.general.notificationCenter': '通知中心',
  'settings.general.enabled': '已开启',
  'settings.general.disabled': '已关闭',
  'settings.general.sound': '声音提醒',
  'settings.general.volume': '音量',
  'settings.save.profile': '保存档案',
  'settings.save.config': '保存配置',
  'settings.save.saved': '保存成功',
  'settings.save.error': '保存失败',
  'settings.save.saving': '保存中...',
} as const;

const enUS: Record<keyof typeof zhCN, string> = {
  'app.loadingPage': 'Loading page...',
  'app.authExpired': 'Your account session has expired. Please sign in again.',
  'app.youtubeDetected': 'YouTube link detected',
  'app.youtubeCaptureDescription': 'Confirm to collect it in the background and save it to Knowledge (YouTube).',
  'app.confirmCapture': 'Capture',
  'app.cancel': 'Cancel',
  'app.confirm': 'Confirm',
  'app.processing': 'Processing...',

  'nav.newChat': 'New chat',
  'nav.search': 'Knowledge',
  'nav.assets': 'Assets',
  'nav.automation': 'Automation',
  'nav.home': 'Home',
  'nav.wander': 'Wander',
  'nav.settings': 'Settings',

  'layout.expandSidebar': 'Expand sidebar',
  'layout.collapseSidebar': 'Collapse sidebar',
  'layout.openNotificationCenter': 'Open notification center',
  'layout.closeNotificationCenter': 'Close notification center',
  'layout.switchToLight': 'Switch to light mode',
  'layout.switchToDark': 'Switch to dark mode',
  'layout.space': 'Space',
  'layout.noSpace': 'No spaces',
  'layout.createSpace': 'New space',
  'layout.renameSpace': 'Rename space',
  'layout.deleteSpace': 'Delete space',
  'layout.deleteSpaceConfirm': 'Delete space "{name}"? Local workspace files in this space will also be deleted.',
  'layout.spaceNameRequired': 'Space name is required',
  'layout.createSpaceFailed': 'Failed to create space',
  'layout.createSpaceFailedRetry': 'Failed to create space. Please try again.',
  'layout.switchSpaceFailed': 'Failed to switch space',
  'layout.switchSpaceFailedRetry': 'Failed to switch space. Please try again.',
  'layout.renameSpaceFailed': 'Rename failed',
  'layout.renameSpaceFailedRetry': 'Failed to rename space. Please try again.',
  'layout.renameSpaceMissing': 'Could not find the space to rename',
  'layout.deleteSpaceFailed': 'Failed to delete space',
  'layout.deleteSpaceFailedRetry': 'Failed to delete space. Please try again.',
  'layout.spaceNamePlaceholder': 'Enter a space name',
  'layout.defaultSpaceName': 'No space',
  'layout.openDownloadFailed': 'Failed to open the download page',
  'layout.softwareUpdate': 'Software update',
  'layout.close': 'Close',
  'layout.newVersionFound': 'New version available',
  'layout.currentReleaseNotes': 'This version',
  'layout.currentVersion': 'Current version {version}',
  'layout.publishedAt': 'Published {date}',
  'layout.opening': 'Opening...',
  'layout.downloadAndInstall': 'Download and install',
  'layout.releaseNotes': 'Release notes',
  'layout.noReleaseNotes': 'No release notes.',

  'settings.title': 'Settings',
  'settings.tabs.ai': 'AI models',
  'settings.tabs.general': 'General',
  'settings.tabs.team': 'Team',
  'settings.tabs.skills': 'Skills',
  'settings.tabs.mcp': 'MCP Servers',
  'settings.tabs.profile': 'Profile',
  'settings.tabs.tools': 'Tools',
  'settings.tabs.experimental': 'Experimental',
  'settings.ai.title': 'AI model settings',
  'settings.language.title': 'Language',
  'settings.language.description': 'Changes apply immediately and are kept for the next launch.',
  'settings.language.selectLabel': 'Interface language',
  'settings.general.title': 'General settings',
  'settings.general.appVersion': 'App version',
  'settings.general.currentVersion': 'Current version:',
  'settings.general.viewCurrentReleaseNotes': 'View changes',
  'settings.general.loading': 'Loading...',
  'settings.general.updateDescription': 'The app checks for updates on launch. Installers are downloaded from the configured release source.',
  'settings.general.openDownloadPage': 'Open downloads',
  'settings.general.browserPlugin': 'Browser plugin',
  'settings.general.installPlugin': 'Install plugin',
  'settings.general.workspaceRoot': 'Workspace root',
  'settings.general.workspaceDescription': 'RedConvert creates the full workspace structure here. Leave blank to use ~/.redconvert.',
  'settings.general.pickFolder': 'Choose folder',
  'settings.general.restoreDefault': 'Restore default',
  'settings.general.workspaceWarningPrefix': 'Do not choose an existing draft directory, ',
  'settings.general.workspaceWarningMiddle': ' directory, or ',
  'settings.general.workspaceWarningSuffix': ' directory directly. RedConvert will create ',
  'settings.general.workspaceWarningEnd': ' and the rest of the workspace structure inside it.',
  'settings.general.notificationCenter': 'Notifications',
  'settings.general.enabled': 'On',
  'settings.general.disabled': 'Off',
  'settings.general.sound': 'Sound',
  'settings.general.volume': 'Volume',
  'settings.save.profile': 'Save profile',
  'settings.save.config': 'Save settings',
  'settings.save.saved': 'Saved',
  'settings.save.error': 'Save failed',
  'settings.save.saving': 'Saving...',
};

const DICTIONARIES = {
  'zh-CN': zhCN,
  'en-US': enUS,
} satisfies Record<AppLanguage, Record<keyof typeof zhCN, string>>;

export type I18nKey = keyof typeof zhCN;

function normalizeLanguage(value: unknown): AppLanguage | null {
  const text = String(value || '').trim().toLowerCase();
  if (text === 'zh' || text === 'zh-cn' || text === 'zh-hans' || text.startsWith('zh-')) return 'zh-CN';
  if (text === 'en' || text === 'en-us' || text.startsWith('en-')) return 'en-US';
  return null;
}

function getInitialLanguage(): AppLanguage {
  if (typeof window === 'undefined') return 'zh-CN';
  try {
    const saved = normalizeLanguage(window.localStorage.getItem(LANGUAGE_STORAGE_KEY));
    if (saved) return saved;
    const preferred = normalizeLanguage(window.navigator.language);
    return preferred || 'zh-CN';
  } catch {
    return 'zh-CN';
  }
}

function formatMessage(template: string, params?: Record<string, string | number>): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (match, name) => {
    const value = params[name];
    return value === undefined ? match : String(value);
  });
}

const I18nContext = createContext<I18nContextValue | null>(null);

export function I18nProvider({ children }: { children: ReactNode }) {
  const [language, setLanguageState] = useState<AppLanguage>(getInitialLanguage);

  const setLanguage = useCallback((nextLanguage: AppLanguage) => {
    setLanguageState(nextLanguage);
  }, []);

  useEffect(() => {
    const root = document.documentElement;
    root.lang = language === 'zh-CN' ? 'zh-CN' : 'en-US';
    try {
      window.localStorage.setItem(LANGUAGE_STORAGE_KEY, language);
    } catch {
      // Local storage can be unavailable in restricted webviews.
    }
  }, [language]);

  const value = useMemo<I18nContextValue>(() => ({
    language,
    setLanguage,
    t: (key, params) => formatMessage(DICTIONARIES[language][key] || zhCN[key] || key, params),
  }), [language, setLanguage]);

  return (
    <I18nContext.Provider value={value}>
      {children}
    </I18nContext.Provider>
  );
}

export function useI18n(): I18nContextValue {
  const context = useContext(I18nContext);
  if (!context) {
    throw new Error('useI18n must be used within I18nProvider');
  }
  return context;
}
