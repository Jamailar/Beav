import { Cpu, FolderOpen } from 'lucide-react';
import { APP_BRAND } from '../../../config/brand';

export function SetupStep() {
  return (
    <div className="flex max-w-lg flex-col items-center gap-8 text-center">
      <div className="space-y-2">
        <h2 className="text-xl font-semibold text-text-primary">开始前的准备</h2>
        <p className="text-sm text-text-tertiary">完成这两步，{APP_BRAND.displayName} 就能全力运转</p>
      </div>

      <div className="grid w-full gap-4">
        <div className="flex items-start gap-4 rounded-2xl border border-border bg-surface-secondary/60 p-5 text-left">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-module-ideateBg text-module-ideateIcon">
            <Cpu className="h-5 w-5" strokeWidth={1.6} />
          </div>
          <div className="min-w-0">
            <div className="text-sm font-semibold text-text-primary">配置 AI 模型</div>
            <div className="mt-1 text-xs leading-5 text-text-tertiary">
              添加 API 端点和服务商 Key，选择你偏好的模型。支持 OpenAI、Anthropic、Google 等多种服务商。
            </div>
            <div className="mt-2 text-xs text-text-tertiary">
              完成后可在 <span className="font-medium text-text-secondary">设置 → AI 模型</span> 中随时修改
            </div>
          </div>
        </div>

        <div className="flex items-start gap-4 rounded-2xl border border-border bg-surface-secondary/60 p-5 text-left">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-module-writeBg text-module-writeIcon">
            <FolderOpen className="h-5 w-5" strokeWidth={1.6} />
          </div>
          <div className="min-w-0">
            <div className="text-sm font-semibold text-text-primary">设置工作目录</div>
            <div className="mt-1 text-xs leading-5 text-text-tertiary">
              选择一个本地文件夹存放知识库、生成素材和稿件。所有数据完全本地化，安全私密。
            </div>
            <div className="mt-2 text-xs text-text-tertiary">
              完成后可在 <span className="font-medium text-text-secondary">设置 → 通用</span> 中随时修改
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
