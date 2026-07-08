import { CheckCircle2, Link2, Loader2 } from 'lucide-react';
import { useI18n } from '../../i18n';
import { clipboardCapturePlatformLabel } from './clipboardDetector';
import { useClipboardCapturePrompt } from './useClipboardCapturePrompt';
import type { ClipboardCaptureCandidate } from './captureTypes';

function formatLogTime(timestamp: string) {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function platformIcon(candidate: ClipboardCaptureCandidate) {
  if (candidate.platform === 'xiaohongshu') {
    return <img src="/ecommerce-platform-icons/xiaohongshu-shop.svg" alt="" className="h-8 w-8 object-contain" />;
  }
  if (candidate.platform === 'douyin') {
    return <img src="/ecommerce-platform-icons/douyin-shop.png" alt="" className="h-8 w-8 object-contain" />;
  }
  if (candidate.platform === 'youtube') {
    return (
      <span className="flex h-8 w-8 items-center justify-center rounded-md bg-red-600 text-[11px] font-bold text-white">
        ▶
      </span>
    );
  }
  return <Link2 className="h-5 w-5" />;
}

export function ClipboardCapturePrompt({ disabled = false }: { disabled?: boolean }) {
  const { t } = useI18n();
  const clipboardCapture = useClipboardCapturePrompt({ disabled });

  if (!clipboardCapture.open || !clipboardCapture.candidate) {
    return null;
  }

  const candidateLabel = clipboardCapturePlatformLabel(clipboardCapture.candidate);
  const taskLogs = clipboardCapture.activeTask?.logs || [];
  const debugDetails = clipboardCapture.activeTask?.debugDetails || '';
  const showDiagnostics = clipboardCapture.status === 'saving' || clipboardCapture.status === 'error';
  const isSuccess = clipboardCapture.status === 'success';

  return (
    <div className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/35 px-4 backdrop-blur-[2px]">
      <div className="w-full max-w-[640px] overflow-hidden rounded-xl border border-border bg-surface-primary shadow-2xl">
        <div className="border-b border-border/70 px-5 py-4">
          <div className="flex items-start gap-3">
            <div className="inline-flex h-12 w-12 shrink-0 items-center justify-center rounded-xl border border-border bg-white shadow-sm">
              {platformIcon(clipboardCapture.candidate)}
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <h3 className="truncate text-base font-semibold text-text-primary">{candidateLabel}</h3>
                {isSuccess && <CheckCircle2 className="h-4 w-4 shrink-0 text-green-600" />}
              </div>
              <p className="mt-1 text-sm text-text-secondary">{t('app.clipboardCaptureDescription')}</p>
            </div>
          </div>
        </div>

        <div className="p-5">
          <div className="rounded-lg border border-border bg-surface-secondary/70 px-3 py-2.5">
            <div className="mb-1 flex items-center gap-1.5 text-[11px] font-semibold text-text-tertiary">
              <Link2 className="h-3.5 w-3.5" />
              <span>链接</span>
            </div>
            <div className="break-all text-xs leading-5 text-text-secondary">{clipboardCapture.candidate.rawUrl}</div>
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-3">
            {clipboardCapture.candidate.kind === 'xhs-note' && (
              <label className="inline-flex h-9 items-center gap-2 rounded-lg border border-border bg-surface-primary px-3 text-sm text-text-secondary">
                <input
                  type="checkbox"
                  checked={clipboardCapture.includeComments}
                  onChange={(event) => clipboardCapture.setIncludeComments(event.target.checked)}
                  disabled={clipboardCapture.status === 'saving'}
                  className="h-4 w-4 rounded border-border"
                />
                {t('app.clipboardCaptureIncludeComments')}
              </label>
            )}
            {clipboardCapture.isProfileCapture && (
              <label className="inline-flex h-9 items-center gap-2 rounded-lg border border-border bg-surface-primary px-3 text-sm text-text-secondary">
                <span>采集数量</span>
                <input
                  type="number"
                  min={clipboardCapture.minProfileLimit}
                  max={clipboardCapture.maxProfileLimit}
                  step={1}
                  value={clipboardCapture.profileLimit}
                  onChange={(event) => clipboardCapture.setProfileLimit(event.target.value)}
                  disabled={clipboardCapture.status === 'saving'}
                  className="h-8 w-20 rounded-md border border-border bg-surface-primary px-2 text-sm text-text-primary outline-none focus:border-accent-primary disabled:opacity-50"
                />
              </label>
            )}
          </div>

          {clipboardCapture.message && (
            <div className={`mt-4 rounded-lg px-3 py-2 text-sm ${
              clipboardCapture.status === 'error'
                ? 'bg-red-50 text-red-600'
                : clipboardCapture.status === 'success'
                  ? 'bg-green-50 text-green-700'
                  : 'bg-surface-secondary text-text-secondary'
            }`}>
              {clipboardCapture.message}
            </div>
          )}

          {showDiagnostics && (taskLogs.length > 0 || debugDetails) && (
            <div className="mt-3 rounded-lg border border-border bg-surface-secondary/45 px-3 py-2">
              <div className="mb-1.5 text-[11px] font-semibold text-text-tertiary">采集日志</div>
              {taskLogs.length > 0 && (
                <div className="max-h-28 space-y-1 overflow-y-auto text-[11px] leading-5">
                  {taskLogs.map((log, index) => (
                    <div
                      key={`${log.timestamp}-${index}`}
                      className={log.level === 'error' ? 'text-red-600' : log.level === 'warn' ? 'text-amber-600' : 'text-text-secondary'}
                    >
                      <span className="mr-2 text-text-tertiary">{formatLogTime(log.timestamp)}</span>
                      <span>{log.message}</span>
                    </div>
                  ))}
                </div>
              )}
              {debugDetails && (
                <pre className="mt-2 max-h-32 overflow-auto whitespace-pre-wrap break-words rounded-md bg-surface-primary px-2 py-1.5 text-[11px] leading-5 text-text-tertiary">
                  {debugDetails}
                </pre>
              )}
            </div>
          )}

          <div className="mt-5 flex items-center justify-end gap-2">
            <button
              onClick={clipboardCapture.close}
              disabled={clipboardCapture.status === 'saving'}
              className="h-9 rounded-md border border-border px-4 text-sm text-text-secondary hover:bg-surface-secondary hover:text-text-primary disabled:opacity-50"
            >
              {t('app.cancel')}
            </button>
            <button
              onClick={() => void clipboardCapture.confirm()}
              disabled={clipboardCapture.status === 'saving'}
              className="inline-flex h-9 items-center gap-2 rounded-md bg-[rgb(var(--color-accent-primary))] px-4 text-sm text-white hover:bg-[rgb(var(--color-accent-hover))] disabled:opacity-50"
            >
              {clipboardCapture.status === 'saving' && <Loader2 className="h-4 w-4 animate-spin" />}
              {t('app.confirmCapture')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
