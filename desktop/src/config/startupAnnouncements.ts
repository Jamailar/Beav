import type { ViewType } from '../App';
import { APP_BRAND } from './brand';

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
    id: 'release-1.10.3-runtime-collaboration',
    version: '1.10.3',
    badge: 'v1.10.3 更新',
    title: `${APP_BRAND.displayName} 更新了`,
    summary: '自动化、审批和全局聊天记录现在更集中。',
    highlights: [
      'MCP 工具目录、执行计划和权限边界更清晰。',
      '协作工作台支持任务评论、执行报告保留和成员能力匹配。',
      '聊天过程展示更紧凑，自动更新、知识库和插件采集也做了稳定性修复。',
    ],
    hero: [
      { id: 'automation', label: '打开自动化工作台', icon: 'automation' },
    ],
    shortcuts: [
      { id: 'automation', label: '去自动化', view: 'automation' },
      { id: 'redclaw', label: `去 ${APP_BRAND.aiDisplayName}`, view: 'redclaw' },
      { id: 'skills', label: '去技能', view: 'skills' },
    ],
  },
  {
    id: 'release-1.9.4-product-workflow',
    version: '1.9.4',
    badge: 'v1.9.4 新功能',
    title: `${APP_BRAND.displayName} 有新功能`,
    summary: '更新提醒更轻，入口更清楚。',
    highlights: [
      '默认只展示简短摘要，不再堆很多说明文字。',
      '需要时可以给当前版本挂 3 个以内的快捷入口按钮。',
      '如果某个版本需要讲解导航，再单独配置引导步骤。',
    ],
    hero: [
      { id: 'draft', label: '查看新功能', icon: 'draft' },
    ],
    shortcuts: [
      { id: 'generation-studio', label: '去创作', view: 'generation-studio' },
      { id: 'redclaw', label: `去 ${APP_BRAND.aiDisplayName}`, view: 'redclaw' },
    ],
    steps: [
      {
        id: 'generation-studio',
        selector: '[data-guide-id="nav-generation-studio"]',
        title: '1/2 创作页统一处理画面生成',
        description: '生图、生视频和参考图视频都走创作页。',
        placement: 'right',
        view: 'generation-studio',
      },
      {
        id: 'redclaw',
        selector: '[data-guide-id="nav-redclaw"]',
        title: `2/2 ${APP_BRAND.aiDisplayName} 负责持续执行`,
        description: `自动执行、工具串联和值守任务继续交给 ${APP_BRAND.aiDisplayName}。`,
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
