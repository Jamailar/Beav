import { Download, X } from 'lucide-react';
import { clsx } from 'clsx';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useI18n } from '../../i18n';
import type { AppUpdateNoticePayload } from './useAppUpdateNotice';

interface AppUpdateNoticeModalProps {
  notice: AppUpdateNoticePayload;
  publishedDateLabel: string;
  isOpeningReleasePage: boolean;
  openReleasePage: () => void;
  closeNotice: () => void;
}

export function AppUpdateNoticeModal({
  notice,
  publishedDateLabel,
  isOpeningReleasePage,
  openReleasePage,
  closeNotice,
}: AppUpdateNoticeModalProps) {
  const { t } = useI18n();

  return (
    <div
      className="fixed inset-0 z-[140] bg-black/45 flex items-center justify-center px-6 py-6"
      onMouseDown={closeNotice}
    >
      <div
        className="w-full max-w-5xl max-h-[86vh] bg-surface-primary border border-border rounded-3xl shadow-2xl flex flex-col"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="px-8 pt-6 pb-4 border-b border-border flex items-center justify-between gap-3">
          <h2 className="text-2xl font-semibold text-text-primary">{t('layout.softwareUpdate')}</h2>
          <button
            type="button"
            onClick={closeNotice}
            className="h-9 w-9 rounded-lg border border-border text-text-secondary hover:text-text-primary hover:bg-surface-secondary transition-colors inline-flex items-center justify-center"
            title={t('layout.close')}
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="px-8 py-6 border-b border-border">
          <div className="flex items-center justify-between gap-6">
            <div className="flex items-center gap-4">
              <div className="h-12 w-12 rounded-xl bg-surface-secondary text-text-secondary inline-flex items-center justify-center">
                <Download className="w-6 h-6" />
              </div>
              <div>
                <div className="text-3xl font-semibold text-text-primary leading-tight">
                  {notice.mode === 'current' ? t('layout.currentReleaseNotes') : t('layout.newVersionFound')}
                </div>
                <div className="text-xl text-text-secondary mt-1">→ {notice.latestVersion}</div>
                <div className="text-xs text-text-tertiary mt-2">
                  {t('layout.currentVersion', { version: notice.currentVersion })}
                  {publishedDateLabel ? ` · ${t('layout.publishedAt', { date: publishedDateLabel })}` : ''}
                </div>
              </div>
            </div>
            {notice.mode !== 'current' && (
              <button
                type="button"
                onClick={() => {
                  void openReleasePage();
                }}
                disabled={isOpeningReleasePage}
                className="h-11 px-5 rounded-lg bg-accent-primary text-white text-sm font-medium hover:bg-accent-hover disabled:opacity-60 transition-colors whitespace-nowrap"
              >
                {isOpeningReleasePage ? t('layout.opening') : t('layout.downloadAndInstall')}
              </button>
            )}
          </div>
        </div>

        <div className="px-8 py-6 overflow-y-auto min-h-0">
          <div className="text-3xl font-semibold text-text-primary mb-4">
            {notice.name || t('layout.releaseNotes')}
          </div>
          <div
            className={clsx(
              'text-base leading-7 text-text-secondary',
              '[&_h1]:text-3xl [&_h1]:font-semibold [&_h1]:text-text-primary [&_h1]:mt-8 [&_h1]:mb-4',
              '[&_h2]:text-2xl [&_h2]:font-semibold [&_h2]:text-text-primary [&_h2]:mt-7 [&_h2]:mb-3',
              '[&_h3]:text-xl [&_h3]:font-semibold [&_h3]:text-text-primary [&_h3]:mt-6 [&_h3]:mb-3',
              '[&_p]:my-3',
              '[&_ul]:list-disc [&_ul]:pl-6 [&_ul]:my-3',
              '[&_ol]:list-decimal [&_ol]:pl-6 [&_ol]:my-3',
              '[&_li]:my-1.5',
              '[&_a]:text-accent-primary [&_a]:underline',
              '[&_img]:rounded-xl [&_img]:border [&_img]:border-border [&_img]:my-4 [&_img]:max-w-full',
              '[&_code]:bg-surface-secondary [&_code]:px-1.5 [&_code]:py-0.5 [&_code]:rounded [&_code]:text-sm',
              '[&_pre]:bg-surface-secondary [&_pre]:border [&_pre]:border-border [&_pre]:rounded-lg [&_pre]:p-4 [&_pre]:overflow-x-auto [&_pre]:my-4'
            )}
          >
            <ReactMarkdown remarkPlugins={[remarkGfm]}>
              {String(notice.body || '').trim() || t('layout.noReleaseNotes')}
            </ReactMarkdown>
          </div>
        </div>
      </div>
    </div>
  );
}
