import { Video, LayoutGrid, Users } from 'lucide-react';
import { FeatureCard } from '../FeatureCard';

export function HighlightsStep() {
  return (
    <div className="flex max-w-2xl flex-col items-center gap-8 text-center">
      <div className="space-y-2">
        <h2 className="text-xl font-semibold text-text-primary">亮点功能</h2>
        <p className="text-sm text-text-tertiary">这些能力让你的创作效率大幅提升</p>
      </div>

      <div className="grid w-full grid-cols-3 gap-5">
        <FeatureCard
          icon={Video}
          title="视频分析"
          desc="导入 YouTube 或本地视频，AI 自动转写、提取要点，一键生成小红书文案"
          colorClass="bg-accent-primary/10 text-accent-primary"
        />
        <FeatureCard
          icon={LayoutGrid}
          title="套图制作"
          desc="批量生成风格统一的图文笔记，多图轮播、封面排版，专为小红书优化"
          colorClass="bg-module-repurposeBg text-module-repurposeIcon"
        />
        <FeatureCard
          icon={Users}
          title="角色创建与使用"
          desc="定义角色外貌、人设、声音，贯穿文案、图片、视频生成，保持人设一致"
          colorClass="bg-module-brandBg text-module-brandIcon"
        />
      </div>
    </div>
  );
}
