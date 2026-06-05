import { useI18n } from '../../i18n';

interface AppSpaceRenameDialogProps {
  name: string;
  setName: (name: string) => void;
  isSubmitting: boolean;
  submit: () => Promise<void> | void;
  close: () => void;
}

export function AppSpaceRenameDialog({
  name,
  setName,
  isSubmitting,
  submit,
  close,
}: AppSpaceRenameDialogProps) {
  const { t } = useI18n();

  return (
    <div
      className="fixed inset-0 z-[120] bg-black/30 flex items-center justify-center"
      onMouseDown={close}
    >
      <div
        className="w-80 rounded-lg border border-border bg-surface-primary shadow-xl p-4 space-y-3"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="text-sm font-medium text-text-primary">
          {t('layout.renameSpace')}
        </div>
        <input
          autoFocus
          value={name}
          onChange={(event) => setName(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              void submit();
            } else if (event.key === 'Escape') {
              close();
            }
          }}
          className="w-full h-9 rounded-md border border-border bg-surface-secondary px-3 text-sm text-text-primary focus:outline-none focus:ring-1 focus:ring-accent-primary"
          placeholder={t('layout.spaceNamePlaceholder')}
        />
        <div className="flex items-center justify-end gap-2">
          <button
            onClick={close}
            disabled={isSubmitting}
            className="h-8 px-3 text-xs rounded-md border border-border text-text-secondary hover:text-text-primary hover:bg-surface-secondary disabled:opacity-50"
          >
            {t('app.cancel')}
          </button>
          <button
            onClick={() => {
              void submit();
            }}
            disabled={isSubmitting}
            className="h-8 px-3 text-xs rounded-md bg-accent-primary text-white hover:bg-accent-hover disabled:opacity-50"
          >
            {isSubmitting ? t('app.processing') : t('app.confirm')}
          </button>
        </div>
      </div>
    </div>
  );
}
