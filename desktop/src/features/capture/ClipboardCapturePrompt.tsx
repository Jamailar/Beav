import { Link2, Loader2 } from 'lucide-react';
import { useI18n } from '../../i18n';
import { useClipboardCapturePrompt } from './useClipboardCapturePrompt';

export function ClipboardCapturePrompt() {
  const { t } = useI18n();
  const clipboardCapture = useClipboardCapturePrompt();

  if (!clipboardCapture.open || !clipboardCapture.candidate) {
    return null;
  }

  return (
    <div className="fixed inset-0 z-[10000] bg-black/35 flex items-center justify-center px-4">
      <div className="w-full max-w-[560px] rounded-xl border border-border bg-surface-primary shadow-2xl p-5">
        <div className="flex items-start gap-3">
          <div className="h-10 w-10 rounded-lg bg-red-50 text-red-600 inline-flex items-center justify-center shrink-0">
            <Link2 className="w-5 h-5" />
          </div>
          <div className="flex-1 min-w-0">
            <h3 className="text-base font-semibold text-text-primary">{t('app.youtubeDetected')}</h3>
            <p className="text-sm text-text-secondary mt-1">{t('app.youtubeCaptureDescription')}</p>
            <div className="mt-3 rounded-md border border-border bg-surface-secondary px-3 py-2 text-xs text-text-tertiary break-all">
              {clipboardCapture.candidate.rawUrl}
            </div>
            <div className="mt-2 text-xs text-text-secondary">
              videoId: <span className="font-mono">{clipboardCapture.candidate.videoId}</span>
            </div>
          </div>
        </div>

        {clipboardCapture.message && (
          <div className={`mt-4 text-sm ${
            clipboardCapture.status === 'error' ? 'text-red-600' : clipboardCapture.status === 'success' ? 'text-green-600' : 'text-text-secondary'
          }`}>
            {clipboardCapture.message}
          </div>
        )}

        <div className="mt-5 flex items-center justify-end gap-2">
          <button
            onClick={clipboardCapture.close}
            disabled={clipboardCapture.status === 'saving'}
            className="h-9 px-4 rounded-md border border-border text-sm text-text-secondary hover:text-text-primary hover:bg-surface-secondary disabled:opacity-50"
          >
            {t('app.cancel')}
          </button>
          <button
            onClick={() => void clipboardCapture.confirm()}
            disabled={clipboardCapture.status === 'saving'}
            className="h-9 px-4 rounded-md bg-[rgb(var(--color-accent-primary))] text-white text-sm hover:bg-[rgb(var(--color-accent-hover))] disabled:opacity-50 inline-flex items-center gap-2"
          >
            {clipboardCapture.status === 'saving' && <Loader2 className="w-4 h-4 animate-spin" />}
            {t('app.confirmCapture')}
          </button>
        </div>
      </div>
    </div>
  );
}
