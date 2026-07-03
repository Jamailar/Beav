import { Loader2, ShieldCheck } from 'lucide-react';
import { APP_BRAND } from '../../config/brand';

export type OfficialAuthGateMode = 'checking' | 'login' | 'expired';

export function OfficialLoginGate({ mode }: { mode: OfficialAuthGateMode }) {
  const isChecking = mode === 'checking';

  return (
    <main className="flex min-h-screen items-center justify-center bg-background px-6 text-text-primary">
      <section className="w-full max-w-sm rounded-2xl border border-border bg-surface-primary p-6 text-center shadow-xl">
        <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-accent-muted text-accent-primary">
          {isChecking ? (
            <Loader2 className="h-5 w-5 animate-spin" strokeWidth={1.8} />
          ) : (
            <ShieldCheck className="h-5 w-5" strokeWidth={1.8} />
          )}
        </div>
        <h1 className="mt-4 text-[17px] font-semibold text-text-primary">
          {isChecking ? '正在检查配置' : `${APP_BRAND.displayName} 开源版`}
        </h1>
        <p className="mt-2 text-[13px] leading-6 text-text-tertiary">
          开源 Electron 版不启用正式版登录门禁。请在设置中配置本地或自定义模型后继续使用。
        </p>
      </section>
    </main>
  );
}
