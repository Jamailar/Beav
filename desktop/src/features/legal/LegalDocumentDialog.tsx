import { X } from 'lucide-react';
import type { LegalDocument } from './legalDocuments';

interface LegalDocumentDialogProps {
  document: LegalDocument | null;
  onClose: () => void;
}

export function LegalDocumentDialog({ document, onClose }: LegalDocumentDialogProps) {
  if (!document) return null;

  return (
    <div className="fixed inset-0 z-[90] flex items-center justify-center bg-black/38 px-4 py-6 backdrop-blur-sm">
      <div className="flex max-h-[86vh] w-full max-w-3xl flex-col overflow-hidden rounded-xl border border-border bg-surface-primary shadow-2xl">
        <div className="flex shrink-0 items-start justify-between gap-4 border-b border-border px-5 py-4">
          <div className="min-w-0">
            <h2 className="text-base font-bold text-text-primary">{document.title}</h2>
            <p className="mt-1 text-xs text-text-tertiary">
              生效日期：{document.effectiveDate} · 更新日期：{document.updatedAt}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-text-tertiary transition-colors hover:bg-surface-secondary hover:text-text-primary"
            title="关闭"
            aria-label="关闭"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          <p className="rounded-lg border border-border/70 bg-surface-secondary/40 px-3 py-2 text-xs leading-5 text-text-secondary">
            {document.summary}
          </p>

          <div className="mt-4 space-y-5">
            {document.sections.map((section) => (
              <section key={section.title} className="space-y-2">
                <h3 className="text-sm font-bold text-text-primary">{section.title}</h3>
                <div className="space-y-2 text-sm leading-7 text-text-secondary">
                  {section.body.map((paragraph) => (
                    <p key={paragraph}>{paragraph}</p>
                  ))}
                </div>
              </section>
            ))}
          </div>
        </div>

        <div className="flex shrink-0 justify-end border-t border-border px-5 py-3">
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-9 items-center justify-center rounded-lg bg-accent-primary px-4 text-sm font-bold text-white transition-all hover:brightness-105 active:scale-[0.99]"
          >
            我已了解
          </button>
        </div>
      </div>
    </div>
  );
}
