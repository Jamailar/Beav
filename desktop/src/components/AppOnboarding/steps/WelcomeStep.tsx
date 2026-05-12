import { Library, Sparkles, Timer } from 'lucide-react';
import { APP_BRAND } from '../../../config/brand';
import { FeatureCard } from '../FeatureCard';

export function WelcomeStep() {
  return (
    <div className="flex max-w-xl flex-col items-center gap-8 text-center">
      <div className="space-y-3">
        <h1 className="text-3xl font-bold tracking-tight text-text-primary">
          {APP_BRAND.displayName}
        </h1>
        <p className="text-sm leading-6 text-text-secondary">
          本地 AI 内容工作台，为小红书创作者打造
        </p>
      </div>

      <div className="grid w-full grid-cols-3 gap-4">
        <FeatureCard
          icon={Library}
          title="知识管理"
          desc="收藏笔记、视频、文档，构建专属知识库"
          colorClass="bg-module-ideateBg text-module-ideateIcon"
        />
        <FeatureCard
          icon={Sparkles}
          title="AI 创作"
          desc="文案、图片、视频、封面一站式生成"
          colorClass="bg-module-writeBg text-module-writeIcon"
        />
        <FeatureCard
          icon={Timer}
          title="自动化"
          desc="定时任务、背景执行，无需手动盯守"
          colorClass="bg-module-scheduleBg text-module-scheduleIcon"
        />
      </div>
    </div>
  );
}
