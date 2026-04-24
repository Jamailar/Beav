import type { ViewType } from '../App';

export interface StartupAnnouncementStep {
  id: string;
  selector: string;
  title: string;
  description: string;
  placement: 'top' | 'top-start' | 'top-end' | 'bottom' | 'bottom-start' | 'bottom-end' | 'left' | 'left-start' | 'left-end' | 'right' | 'right-start' | 'right-end';
  view?: ViewType;
}

export interface StartupAnnouncementShortcut {
  id: string;
  label: string;
  view: ViewType;
}

export interface StartupAnnouncementFeature {
  id: string;
  label: string;
  icon: 'knowledge' | 'wander' | 'draft' | 'generate' | 'automation';
}

export interface StartupAnnouncement {
  id: string;
  version: string;
  badge: string;
  title: string;
  summary: string;
  highlights: string[];
  hero: StartupAnnouncementFeature[];
  shortcuts?: StartupAnnouncementShortcut[];
  steps?: StartupAnnouncementStep[];
}

const ANNOUNCEMENT_STORAGE_PREFIX = 'redbox:startup-announcement:v1:';

// 每次发新版本时，在这里追加一条新配置。
// 只要 `id` 或 `version` 变化，弹窗就会对该版本重新展示一次。
export const STARTUP_ANNOUNCEMENTS: StartupAnnouncement[] = [
  {
    id: 'release-1.9.4-product-workflow',
    version: '1.9.4',
    badge: 'v1.9.4 新功能',
    title: '启动弹窗现在可以按版本独立管理',
    summary: '这次更新把首个弹窗改成了版本化内容位。每个版本都能有自己的标题、摘要、按钮和可选引导。',
    highlights: [
      '默认只展示简短摘要，不再堆很多说明文字。',
      '需要时可以给当前版本挂 3 个以内的快捷入口按钮。',
      '如果某个版本需要讲解导航，再单独配置引导步骤。',
    ],
    hero: [
      { id: 'draft', label: '版本弹窗', icon: 'draft' },
      { id: 'generate', label: '快捷入口', icon: 'generate' },
      { id: 'automation', label: '可选引导', icon: 'automation' },
    ],
    shortcuts: [
      { id: 'manuscripts', label: '去稿件', view: 'manuscripts' },
      { id: 'generation-studio', label: '去创作', view: 'generation-studio' },
      { id: 'redclaw', label: '去 RedClaw', view: 'redclaw' },
    ],
    steps: [
      {
        id: 'manuscripts',
        selector: '[data-guide-id="nav-manuscripts"]',
        title: '1/3 稿件是默认工作台',
        description: '启动后先回到稿件，继续处理正在生产的内容。',
        placement: 'right',
        view: 'manuscripts',
      },
      {
        id: 'generation-studio',
        selector: '[data-guide-id="nav-generation-studio"]',
        title: '2/3 创作页统一处理画面生成',
        description: '生图、生视频和参考图视频都走创作页。',
        placement: 'right',
        view: 'generation-studio',
      },
      {
        id: 'redclaw',
        selector: '[data-guide-id="nav-redclaw"]',
        title: '3/3 RedClaw 负责持续执行',
        description: '自动执行、工具串联和值守任务继续交给 RedClaw。',
        placement: 'right',
        view: 'redclaw',
      },
    ],
  },
];

export function getStartupAnnouncementByVersion(version: string): StartupAnnouncement | null {
  const normalized = String(version || '').trim();
  if (!normalized) return null;
  return STARTUP_ANNOUNCEMENTS.find((item) => item.version === normalized) || null;
}

export function getStartupAnnouncementSeenKey(id: string): string {
  return `${ANNOUNCEMENT_STORAGE_PREFIX}${id}`;
}
