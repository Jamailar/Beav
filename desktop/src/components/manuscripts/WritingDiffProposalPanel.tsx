import { useMemo } from 'react';
import clsx from 'clsx';
import { diffLines } from 'diff';
import { AlertTriangle, Check, GitCompareArrows, Loader2, Sparkles, X } from 'lucide-react';

type WritingDiffProposalPanelProps = {
  createdAt?: string | null;
  baseBody: string;
  proposedBody: string;
  isStale?: boolean;
  isApplying?: boolean;
  isRejecting?: boolean;
  onAccept: () => void;
  onReject: () => void;
};

type DiffRow =
  | {
    kind: 'context' | 'add' | 'remove';
    key: string;
    oldLineNumber?: number;
    newLineNumber?: number;
    text: string;
  }
  | {
    kind: 'collapse';
    key: string;
    count: number;
  };

function normalizeDiffText(value: string): string {
  return String(value || '').replace(/\r\n?/g, '\n');
}

function splitDiffLines(value: string): string[] {
  const normalized = normalizeDiffText(value);
  if (!normalized) return [];
  const lines = normalized.split('\n');
  if (normalized.endsWith('\n')) {
    lines.pop();
  }
  return lines;
}

function buildDiffRows(before: string, after: string) {
  const changes = diffLines(normalizeDiffText(before), normalizeDiffText(after));
  const rows: DiffRow[] = [];
  let oldLineNumber = 1;
  let newLineNumber = 1;

  changes.forEach((change, changeIndex) => {
    const lines = splitDiffLines(change.value);
    if (lines.length === 0) return;
    lines.forEach((line, lineIndex) => {
      if (change.added) {
        rows.push({
          kind: 'add',
          key: `add-${changeIndex}-${lineIndex}-${newLineNumber}`,
          newLineNumber,
          text: line,
        });
        newLineNumber += 1;
        return;
      }
      if (change.removed) {
        rows.push({
          kind: 'remove',
          key: `remove-${changeIndex}-${lineIndex}-${oldLineNumber}`,
          oldLineNumber,
          text: line,
        });
        oldLineNumber += 1;
        return;
      }
      rows.push({
        kind: 'context',
        key: `context-${changeIndex}-${lineIndex}-${oldLineNumber}-${newLineNumber}`,
        oldLineNumber,
        newLineNumber,
        text: line,
      });
      oldLineNumber += 1;
      newLineNumber += 1;
    });
  });

  const collapsedRows: DiffRow[] = [];
  let index = 0;
  while (index < rows.length) {
    if (rows[index]?.kind !== 'context') {
      collapsedRows.push(rows[index]!);
      index += 1;
      continue;
    }
    let end = index;
    while (end < rows.length && rows[end]?.kind === 'context') {
      end += 1;
    }
    const contextRows = rows.slice(index, end);
    if (contextRows.length > 10) {
      collapsedRows.push(...contextRows.slice(0, 2));
      collapsedRows.push({
        kind: 'collapse',
        key: `collapse-${index}-${end}`,
        count: contextRows.length - 4,
      });
      collapsedRows.push(...contextRows.slice(-2));
    } else {
      collapsedRows.push(...contextRows);
    }
    index = end;
  }

  const addedCount = rows.filter((row) => row.kind === 'add').length;
  const removedCount = rows.filter((row) => row.kind === 'remove').length;
  const changedBlockCount = rows.reduce((count, row, rowIndex) => {
    if (row.kind === 'context' || row.kind === 'collapse') return count;
    const previous = rows[rowIndex - 1];
    return previous && previous.kind !== 'context' && previous.kind !== 'collapse' ? count : count + 1;
  }, 0);

  return {
    rows: collapsedRows,
    addedCount,
    removedCount,
    changedBlockCount,
  };
}

function formatProposalTime(value?: string | null): string {
  if (!value) return '刚刚生成';
  const time = new Date(value);
  if (Number.isNaN(time.getTime())) return '刚刚生成';
  return time.toLocaleString('zh-CN', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function WritingDiffProposalPanel({
  createdAt,
  baseBody,
  proposedBody,
  isStale = false,
  isApplying = false,
  isRejecting = false,
  onAccept,
  onReject,
}: WritingDiffProposalPanelProps) {
  const diff = useMemo(
    () => buildDiffRows(baseBody, proposedBody),
    [baseBody, proposedBody]
  );

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <div className="border-b border-border bg-surface-primary/92 px-8 py-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-[280px] flex-1">
            <div className="flex items-center gap-2 text-sm font-medium text-text-primary">
              <GitCompareArrows className="h-4 w-4 text-accent-primary" />
              AI 改稿提案
            </div>
            <div className="mt-2 max-w-[720px] text-sm leading-6 text-text-secondary">
              AI 没有直接覆盖稿件，所有修改都会先在这里展示差异。确认后再写回正文。
            </div>
            <div className="mt-4 flex flex-wrap items-center gap-2 text-xs text-text-tertiary">
              <span className="rounded-full border border-border bg-background px-3 py-1">生成时间 {formatProposalTime(createdAt)}</span>
              <span className="rounded-full border border-emerald-500/20 bg-emerald-500/10 px-3 py-1 text-emerald-700">+{diff.addedCount} 行新增</span>
              <span className="rounded-full border border-rose-500/20 bg-rose-500/10 px-3 py-1 text-rose-700">-{diff.removedCount} 行删除</span>
              <span className="rounded-full border border-border bg-background px-3 py-1">{diff.changedBlockCount} 处修改</span>
            </div>
          </div>

          <div className="flex shrink-0 items-center gap-3">
            <button
              type="button"
              onClick={onReject}
              disabled={isApplying || isRejecting}
              className={clsx(
                'inline-flex items-center gap-2 rounded-full border px-4 py-2 text-sm transition',
                isApplying || isRejecting
                  ? 'cursor-not-allowed border-border bg-surface-secondary text-text-tertiary'
                  : 'border-border bg-background text-text-secondary hover:bg-surface-secondary hover:text-text-primary'
              )}
            >
              {isRejecting ? <Loader2 className="h-4 w-4 animate-spin" /> : <X className="h-4 w-4" />}
              拒绝
            </button>
            <button
              type="button"
              onClick={onAccept}
              disabled={isApplying || isRejecting}
              className={clsx(
                'inline-flex items-center gap-2 rounded-full px-4 py-2 text-sm font-medium transition',
                isApplying || isRejecting
                  ? 'cursor-not-allowed bg-accent-primary/30 text-white/80'
                  : 'bg-accent-primary text-white shadow-[0_12px_30px_rgba(var(--color-accent-primary-rgb,37_99_235)/0.28)] hover:bg-accent-primary/92'
              )}
            >
              {isApplying ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
              接受修改
            </button>
          </div>
        </div>

        {isStale ? (
          <div className="mt-4 flex items-start gap-3 rounded-2xl border border-amber-500/20 bg-amber-500/10 px-4 py-3 text-sm text-amber-800">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <div>当前稿件在提案生成后又发生了变化。接受提案会用 AI 的版本覆盖你现在的正文。</div>
          </div>
        ) : (
          <div className="mt-4 flex items-start gap-3 rounded-2xl border border-accent-primary/15 bg-accent-primary/8 px-4 py-3 text-sm text-text-secondary">
            <Sparkles className="mt-0.5 h-4 w-4 shrink-0 text-accent-primary" />
            <div>先看差异，再决定是否写回。这样你可以明确知道 AI 改了哪几段、删了什么、补了什么。</div>
          </div>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-auto px-8 py-8">
        <div className="overflow-hidden rounded-[28px] border border-border bg-surface-primary">
          <div className="grid grid-cols-[72px_72px_minmax(0,1fr)] border-b border-border bg-surface-secondary/70 px-5 py-3 text-[11px] font-semibold uppercase tracking-[0.18em] text-text-tertiary">
            <div>Old</div>
            <div>New</div>
            <div>Changes</div>
          </div>

          <div className="divide-y divide-border/60 font-mono text-[13px] leading-7 text-text-primary">
            {diff.rows.length > 0 ? diff.rows.map((row) => {
              if (row.kind === 'collapse') {
                return (
                  <div key={row.key} className="grid grid-cols-[72px_72px_minmax(0,1fr)] bg-surface-secondary/45 px-5 py-2 text-xs text-text-tertiary">
                    <div />
                    <div />
                    <div>省略 {row.count} 行未改动内容</div>
                  </div>
                );
              }

              return (
                <div
                  key={row.key}
                  className={clsx(
                    'grid grid-cols-[72px_72px_minmax(0,1fr)] px-5 py-1.5',
                    row.kind === 'add' && 'bg-emerald-500/10',
                    row.kind === 'remove' && 'bg-rose-500/10',
                    row.kind === 'context' && 'bg-transparent'
                  )}
                >
                  <div className="select-none pr-4 text-right text-xs text-text-tertiary">{row.oldLineNumber ?? ''}</div>
                  <div className="select-none pr-4 text-right text-xs text-text-tertiary">{row.newLineNumber ?? ''}</div>
                  <div
                    className={clsx(
                      'min-w-0 whitespace-pre-wrap break-words',
                      row.kind === 'add' && 'text-emerald-800',
                      row.kind === 'remove' && 'text-rose-800'
                    )}
                  >
                    <span className="mr-3 select-none text-text-tertiary">
                      {row.kind === 'add' ? '+' : row.kind === 'remove' ? '-' : '·'}
                    </span>
                    {row.text || ' '}
                  </div>
                </div>
              );
            }) : (
              <div className="px-6 py-10 text-sm text-text-tertiary">没有检测到正文差异。</div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
