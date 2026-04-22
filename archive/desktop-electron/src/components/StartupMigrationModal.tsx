type StartupMigrationState = {
    status?: string;
    needsDbImport?: boolean;
    needsProjectUpgrade?: boolean;
    shouldShowModal?: boolean;
    legacyDbPath?: string | null;
    legacyWorkspacePath?: string | null;
    workspacePath?: string | null;
    currentStep?: string | null;
    message?: string | null;
    error?: string | null;
    progress?: number;
    legacyMarkdownCount?: number | null;
    importedCounts?: Record<string, number> | null;
    projectUpgradeCounts?: Record<string, number> | null;
};

interface StartupMigrationModalProps {
    open: boolean;
    state: StartupMigrationState | null;
    busy: boolean;
    onStart: () => void;
    onClose: () => void;
}

function countLine(label: string, value: number | undefined) {
    return (
        <div className="flex items-center justify-between gap-3">
            <span>{label}</span>
            <span className="text-text-primary">{typeof value === 'number' ? value : 0}</span>
        </div>
    );
}

export function StartupMigrationModal({
    open,
    state,
    busy,
    onStart,
    onClose,
}: StartupMigrationModalProps) {
    if (!open || !state) return null;

    const status = state.status || 'pending';
    const isRunning = status === 'running';
    const isCompleted = status === 'completed';
    const isFailed = status === 'failed';
    const progress = Math.max(0, Math.min(1, Number(state.progress || 0)));
    const counts = state.importedCounts || null;
    const projectCounts = state.projectUpgradeCounts || null;
    const legacyMarkdownCount = Math.max(0, Number(state.legacyMarkdownCount || 0));
    const needsDbImport = Boolean(state.needsDbImport);
    const needsProjectUpgrade = Boolean(state.needsProjectUpgrade || legacyMarkdownCount > 0);
    const strategyLabel = needsDbImport && needsProjectUpgrade
        ? '数据库导入 + 旧 Markdown 稿件升级为 .redpost 图文工程。'
        : needsDbImport
            ? '只导入旧版数据库，继续沿用原有文件目录。'
            : '只升级 manuscripts 下旧 `.md` 稿件为 `.redpost` 图文工程。';

    return (
        <div className="fixed inset-0 z-[140] flex items-center justify-center bg-black/45 backdrop-blur-sm">
            <div className="w-full max-w-xl rounded-3xl border border-border bg-surface-primary shadow-2xl">
                <div className="border-b border-border px-6 py-5">
                    <div className="text-lg font-semibold text-text-primary">启动迁移检查</div>
                    <div className="mt-2 text-sm leading-6 text-text-secondary whitespace-pre-wrap">
                        {state.message || '检测到旧版数据或稿件格式，需要先完成一次性迁移。'}
                    </div>
                </div>

                <div className="space-y-5 px-6 py-5">
                    <div className="rounded-2xl border border-border bg-surface-secondary/60 p-4 text-xs leading-6 text-text-secondary">
                        <div>旧版工作目录：{state.legacyWorkspacePath || '未检测到'}</div>
                        <div>旧版数据库：{state.legacyDbPath || '未检测到'}</div>
                        <div>当前工作目录：{state.workspacePath || '未确定'}</div>
                        <div>待升级 Markdown 稿件：{legacyMarkdownCount}</div>
                        <div>迁移策略：{strategyLabel}</div>
                    </div>

                    {(isRunning || isCompleted || isFailed) && (
                        <div className="space-y-2">
                            <div className="flex items-center justify-between text-xs text-text-tertiary">
                                <span>{state.currentStep || '准备中'}</span>
                                <span>{Math.round(progress * 100)}%</span>
                            </div>
                            <div className="h-2 overflow-hidden rounded-full bg-surface-secondary">
                                <div
                                    className={`h-full rounded-full transition-all ${
                                        isFailed ? 'bg-red-500' : 'bg-accent-primary'
                                    }`}
                                    style={{ width: `${Math.max(progress * 100, isCompleted ? 100 : 6)}%` }}
                                />
                            </div>
                        </div>
                    )}

                    {state.error && (
                        <div className="rounded-2xl border border-red-500/30 bg-red-500/10 p-4 text-sm leading-6 text-red-200 whitespace-pre-wrap">
                            {state.error}
                        </div>
                    )}

                    {isCompleted && counts && (
                        <div className="rounded-2xl border border-border bg-surface-secondary/60 p-4 text-sm text-text-secondary">
                            <div className="mb-3 font-medium text-text-primary">数据库导入结果</div>
                            <div className="space-y-2">
                                {countLine('空间', counts.spaces)}
                                {countLine('聊天会话', counts.chatSessions)}
                                {countLine('聊天消息', counts.chatMessages)}
                                {countLine('转录记录', counts.transcriptRecords)}
                                {countLine('检查点', counts.checkpoints)}
                                {countLine('工具结果', counts.toolResults)}
                                {countLine('漫步历史', counts.wanderHistory)}
                            </div>
                        </div>
                    )}

                    {isCompleted && projectCounts && (
                        <div className="rounded-2xl border border-border bg-surface-secondary/60 p-4 text-sm text-text-secondary">
                            <div className="mb-3 font-medium text-text-primary">工程升级结果</div>
                            <div className="space-y-2">
                                {countLine('发现旧 Markdown', projectCounts.found)}
                                {countLine('已升级为 .redpost', projectCounts.upgraded)}
                                {countLine('跳过同名工程冲突', projectCounts.skipped)}
                            </div>
                        </div>
                    )}
                </div>

                <div className="flex items-center justify-end gap-2 border-t border-border px-6 py-4">
                    {!isRunning && (
                        <button
                            type="button"
                            onClick={onClose}
                            className="rounded-xl border border-border px-3 py-2 text-sm text-text-secondary hover:bg-surface-secondary"
                        >
                            {isCompleted ? '进入应用' : '稍后处理'}
                        </button>
                    )}
                    {!isCompleted && (
                        <button
                            type="button"
                            onClick={onStart}
                            disabled={busy || isRunning}
                            className="rounded-xl bg-accent-primary px-4 py-2 text-sm text-white disabled:cursor-not-allowed disabled:opacity-60"
                        >
                            {isFailed ? '重新迁移' : isRunning ? '迁移中...' : '开始迁移'}
                        </button>
                    )}
                </div>
            </div>
        </div>
    );
}
