import { useEffect, useState, useCallback, useRef } from 'react';
import { Lightbulb, Plus, Pencil, X, Check, FileText, RefreshCw, Power } from 'lucide-react';
import { clsx } from 'clsx';

interface Skill {
    name: string;
    description: string;
    location: string;
    body: string;
    baseDir?: string;
    aliases?: string[];
    sourceScope?: string;
    isBuiltin?: boolean;
    disabled?: boolean;
    metadata?: SkillDefinition['metadata'];
    whenToUse?: string;
    userInvocable?: boolean;
    version?: string;
    argumentHint?: string;
    argumentNames?: string[];
    executionContext?: string;
    modelOverride?: string;
    effortOverride?: string;
    paths?: string[];
    usage?: {
        usageCount?: number;
        lastUsedAt?: number | null;
    };
}

const formatSkillSourceScope = (scope?: string) => {
    switch (scope) {
        case 'builtin':
            return '内置';
        case 'user':
            return '用户目录';
        case 'workspace':
            return '当前空间';
        case 'codex-home':
            return 'Codex 目录';
        case 'agents-home':
            return 'Agents 目录';
        case 'claude-home':
            return 'Claude 根目录';
        default:
            return scope || '';
    }
};

const formatLastUsed = (value?: number | null) => {
    if (!value) return '未使用';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '未使用';
    return date.toLocaleString('zh-CN', { hour12: false });
};

export function Skills({ isActive = true }: { isActive?: boolean }) {
    const [skills, setSkills] = useState<Skill[]>([]);
    const [selectedSkill, setSelectedSkill] = useState<Skill | null>(null);
    const [isEditing, setIsEditing] = useState(false);
    const [editContent, setEditContent] = useState('');
    const [isLoading, setIsLoading] = useState(true);
    const [previewRuntimeMode, setPreviewRuntimeMode] = useState('redclaw');
    const [previewMessage, setPreviewMessage] = useState('');
    const [previewIntent, setPreviewIntent] = useState('');
    const [previewTouchedPaths, setPreviewTouchedPaths] = useState('');
    const [previewArgs, setPreviewArgs] = useState('');
    const [activationPreview, setActivationPreview] = useState<SkillActivationPreviewResult | null>(null);
    const [invokePreview, setInvokePreview] = useState<SkillInvokeResult | null>(null);
    const [isPreviewing, setIsPreviewing] = useState(false);
    const [isInvoking, setIsInvoking] = useState(false);

    // 创建技能相关状态
    const [isCreateModalOpen, setIsCreateModalOpen] = useState(false);
    const [newSkillName, setNewSkillName] = useState('');
    const [createError, setCreateError] = useState('');
    const skillsRef = useRef<Skill[]>([]);
    const hasLoadedSnapshotRef = useRef(false);
    const loadRequestRef = useRef(0);

    useEffect(() => {
        skillsRef.current = skills;
    }, [skills]);

    const loadSkills = useCallback(async () => {
        const requestId = loadRequestRef.current + 1;
        loadRequestRef.current = requestId;
        const hasLocalSkills = hasLoadedSnapshotRef.current || skillsRef.current.length > 0;
        if (!hasLocalSkills) {
            setIsLoading(true);
        }
        try {
            const list = await window.ipcRenderer.listSkills();
            if (requestId !== loadRequestRef.current) return;
            setSkills(list || []);
            hasLoadedSnapshotRef.current = true;
        } catch (e) {
            if (requestId !== loadRequestRef.current) return;
            console.error('Failed to load skills:', e);
        } finally {
            if (requestId === loadRequestRef.current) {
                setIsLoading(false);
            }
        }
    }, []);

    useEffect(() => {
        if (!isActive) return;
        void loadSkills();
    }, [isActive, loadSkills]);

    const handleSelectSkill = (skill: Skill) => {
        setSelectedSkill(skill);
        setEditContent(skill.body);
        setIsEditing(false);
        setActivationPreview(null);
        setInvokePreview(null);
    };

    const handleStartEdit = () => {
        if (selectedSkill) {
            setEditContent(selectedSkill.body);
            setIsEditing(true);
        }
    };

    const handleCancelEdit = () => {
        if (selectedSkill) {
            setEditContent(selectedSkill.body);
        }
        setIsEditing(false);
    };

    const handleSaveSkill = async () => {
        if (!selectedSkill) return;

        try {
            await window.ipcRenderer.saveSkill({
                location: selectedSkill.location,
                content: editContent
            });

            // Update local state
            setSelectedSkill({ ...selectedSkill, body: editContent });
            setSkills(skills.map(s =>
                s.location === selectedSkill.location
                    ? { ...s, body: editContent }
                    : s
            ));
            setIsEditing(false);
        } catch (e) {
            console.error('Failed to save skill:', e);
        }
    };

    const handleOpenCreateModal = () => {
        setNewSkillName('');
        setCreateError('');
        setIsCreateModalOpen(true);
    };

    const handleCloseCreateModal = () => {
        setIsCreateModalOpen(false);
        setNewSkillName('');
        setCreateError('');
    };

    const handleCreateSkill = async () => {
        const name = newSkillName.trim();
        if (!name) {
            setCreateError('请输入技能名称');
            return;
        }

        try {
            const result = await window.ipcRenderer.createSkill({ name });

            if (result.success) {
                handleCloseCreateModal();
                await loadSkills();
            } else {
                setCreateError(result.error || '创建失败');
            }
        } catch (e) {
            console.error('Failed to create skill:', e);
            setCreateError('创建失败，请重试');
        }
    };

    const handleToggleSkill = async () => {
        if (!selectedSkill) return;
        try {
            const result = selectedSkill.disabled
                ? await window.ipcRenderer.enableSkill({ name: selectedSkill.name })
                : await window.ipcRenderer.disableSkill({ name: selectedSkill.name });
            if (!result?.success) {
                return;
            }
            await loadSkills();
        } catch (e) {
            console.error('Failed to toggle skill:', e);
        }
    };

    const handlePreviewActivation = async () => {
        if (!selectedSkill) return;
        setIsPreviewing(true);
        try {
            const touchedPaths = previewTouchedPaths
                .split('\n')
                .map(item => item.trim())
                .filter(Boolean);
            const metadata: Record<string, unknown> = {
                activeSkills: [selectedSkill.name]
            };
            if (previewIntent.trim()) {
                metadata.intent = previewIntent.trim();
            }
            if (touchedPaths.length > 0) {
                metadata.associatedFilePath = touchedPaths[0];
            }
            const result = await window.ipcRenderer.previewSkillActivation({
                runtimeMode: previewRuntimeMode,
                message: previewMessage.trim() || undefined,
                intent: previewIntent.trim() || undefined,
                args: previewArgs.trim() || undefined,
                metadata,
                touchedPaths
            });
            setActivationPreview(result);
        } catch (e) {
            console.error('Failed to preview skill activation:', e);
        } finally {
            setIsPreviewing(false);
        }
    };

    const handleInvokeSkill = async () => {
        if (!selectedSkill) return;
        setIsInvoking(true);
        try {
            const result = await window.ipcRenderer.invokeSkill({
                name: selectedSkill.name,
                args: previewArgs.trim() || undefined
            });
            setInvokePreview(result);
        } catch (e) {
            console.error('Failed to invoke skill:', e);
        } finally {
            setIsInvoking(false);
        }
    };

    return (
        <div className="flex h-full">
            {/* Skill List - Left Panel */}
            <div className="w-72 border-r border-border bg-surface-secondary/30 flex flex-col">
                <div className="p-4 border-b border-border flex items-center justify-between">
                    <h2 className="text-sm font-semibold text-text-primary">技能库</h2>
                    <div className="flex items-center gap-1">
                        <button
                            onClick={() => void loadSkills()}
                            className="p-1.5 text-text-tertiary hover:text-accent-primary hover:bg-surface-primary rounded transition-colors"
                            title="刷新技能"
                        >
                            <RefreshCw className="w-4 h-4" />
                        </button>
                        <button
                            onClick={handleOpenCreateModal}
                            className="p-1.5 text-text-tertiary hover:text-accent-primary hover:bg-surface-primary rounded transition-colors"
                            title="创建新技能"
                        >
                            <Plus className="w-4 h-4" />
                        </button>
                    </div>
                </div>

                <div className="flex-1 overflow-auto p-2 space-y-1">
                    {isLoading && skills.length === 0 ? (
                        <div className="text-center text-text-tertiary text-xs py-8">
                            加载中...
                        </div>
                    ) : skills.length === 0 ? (
                        <div className="text-center text-text-tertiary text-xs py-8">
                            <Lightbulb className="w-8 h-8 mx-auto mb-2 opacity-30" />
                            <p>暂无技能</p>
                            <button
                                onClick={handleOpenCreateModal}
                                className="mt-2 text-accent-primary hover:underline"
                            >
                                点击创建第一个技能
                            </button>
                        </div>
                    ) : (
                        skills.map((skill) => (
                            <button
                                key={skill.location}
                                onClick={() => handleSelectSkill(skill)}
                                className={clsx(
                                    "w-full text-left px-3 py-2.5 rounded-lg transition-colors",
                                    selectedSkill?.location === skill.location
                                        ? "bg-accent-primary/10 text-accent-primary border border-accent-primary/30"
                                        : "hover:bg-surface-primary text-text-primary"
                                )}
                            >
                                <div className="flex items-center gap-2">
                                    <Lightbulb className={clsx(
                                        "w-4 h-4 shrink-0",
                                        selectedSkill?.location === skill.location
                                            ? "text-accent-primary"
                                            : "text-text-tertiary"
                                    )} />
                                    <div className="flex-1 min-w-0">
                                        <div className="flex items-center gap-2">
                                            <div className="text-sm font-medium truncate">{skill.name}</div>
                                            {skill.disabled && (
                                                <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-red-100 text-red-600">
                                                    已禁用
                                                </span>
                                            )}
                                        </div>
                                        <div className="text-xs text-text-tertiary truncate mt-0.5">
                                            {skill.description || '无描述'}
                                        </div>
                                        <div className="text-[11px] text-text-tertiary mt-1 flex items-center gap-2">
                                            {skill.executionContext && <span>{skill.executionContext}</span>}
                                            {typeof skill.usage?.usageCount === 'number' && (
                                                <span>使用 {skill.usage.usageCount} 次</span>
                                            )}
                                        </div>
                                    </div>
                                </div>
                            </button>
                        ))
                    )}
                </div>
            </div>

            {/* Skill Content - Right Panel */}
            <div className="flex-1 flex flex-col min-w-0">
                {selectedSkill ? (
                    <>
                        {/* Header */}
                        <div className="px-6 py-4 border-b border-border flex items-center justify-between">
                            <div>
                                <div className="flex items-center gap-2">
                                    <h1 className="text-lg font-semibold text-text-primary">{selectedSkill.name}</h1>
                                    {selectedSkill.disabled ? (
                                        <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-red-100 text-red-600">已禁用</span>
                                    ) : (
                                        <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-emerald-100 text-emerald-600">已启用</span>
                                    )}
                                    {selectedSkill.sourceScope && (
                                        <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-blue-100 text-blue-600">{formatSkillSourceScope(selectedSkill.sourceScope)}</span>
                                    )}
                                </div>
                                <p className="text-xs text-text-tertiary mt-0.5">{selectedSkill.description}</p>
                                <div className="flex flex-wrap gap-2 mt-2 text-[11px] text-text-tertiary">
                                    {selectedSkill.executionContext && (
                                        <span className="px-2 py-1 rounded-full bg-surface-secondary border border-border">
                                            context: {selectedSkill.executionContext}
                                        </span>
                                    )}
                                    {selectedSkill.version && (
                                        <span className="px-2 py-1 rounded-full bg-surface-secondary border border-border">
                                            version: {selectedSkill.version}
                                        </span>
                                    )}
                                    {selectedSkill.modelOverride && (
                                        <span className="px-2 py-1 rounded-full bg-surface-secondary border border-border">
                                            model: {selectedSkill.modelOverride}
                                        </span>
                                    )}
                                    {selectedSkill.effortOverride && (
                                        <span className="px-2 py-1 rounded-full bg-surface-secondary border border-border">
                                            effort: {selectedSkill.effortOverride}
                                        </span>
                                    )}
                                    <span className="px-2 py-1 rounded-full bg-surface-secondary border border-border">
                                        userInvocable: {selectedSkill.userInvocable === false ? 'false' : 'true'}
                                    </span>
                                    <span className="px-2 py-1 rounded-full bg-surface-secondary border border-border">
                                        使用次数: {selectedSkill.usage?.usageCount || 0}
                                    </span>
                                </div>
                            </div>
                            <div className="flex items-center gap-2">
                                <button
                                    onClick={() => void handleToggleSkill()}
                                    className={clsx(
                                        'flex items-center gap-1.5 px-3 py-1.5 text-xs border rounded-md transition-colors',
                                        selectedSkill.disabled
                                            ? 'text-emerald-600 border-emerald-200 hover:bg-emerald-50'
                                            : 'text-red-500 border-red-200 hover:bg-red-50'
                                    )}
                                >
                                    <Power className="w-3 h-3" />
                                    {selectedSkill.disabled ? '启用' : '禁用'}
                                </button>
                                {isEditing ? (
                                    <>
                                        <button
                                            onClick={handleCancelEdit}
                                            className="flex items-center gap-1.5 px-3 py-1.5 text-xs text-text-secondary hover:text-text-primary border border-border rounded-md transition-colors"
                                        >
                                            <X className="w-3 h-3" />
                                            取消
                                        </button>
                                        <button
                                            onClick={handleSaveSkill}
                                            className="flex items-center gap-1.5 px-3 py-1.5 text-xs text-white bg-accent-primary hover:bg-accent-primary/90 rounded-md transition-colors"
                                        >
                                            <Check className="w-3 h-3" />
                                            保存
                                        </button>
                                    </>
                                ) : (
                                    <button
                                        onClick={handleStartEdit}
                                        className="flex items-center gap-1.5 px-3 py-1.5 text-xs text-text-secondary hover:text-accent-primary border border-border rounded-md transition-colors"
                                    >
                                        <Pencil className="w-3 h-3" />
                                        编辑
                                    </button>
                                )}
                            </div>
                        </div>

                        {/* Content */}
                        <div className="flex-1 overflow-auto p-6">
                            <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_320px] gap-6 h-full">
                                <div className="min-h-0">
                            {isEditing ? (
                                <textarea
                                    value={editContent}
                                    onChange={(e) => setEditContent(e.target.value)}
                                    className="w-full h-full bg-surface-secondary border border-border rounded-lg p-4 text-sm font-mono resize-none focus:outline-none focus:ring-1 focus:ring-accent-primary"
                                    placeholder="输入技能内容 (Markdown 格式)..."
                                />
                            ) : (
                                <div className="prose prose-sm max-w-none">
                                    <pre className="text-sm text-text-primary whitespace-pre-wrap font-mono bg-surface-secondary/50 p-4 rounded-lg border border-border">
                                        {selectedSkill.body || '(无内容)'}
                                    </pre>
                                </div>
                            )}
                                </div>
                                <div className="space-y-4 overflow-auto">
                                    <div className="rounded-lg border border-border bg-surface-secondary/40 p-4">
                                        <div className="text-xs font-medium text-text-secondary mb-2">触发与执行</div>
                                        <div className="space-y-2 text-xs text-text-tertiary">
                                            <div>whenToUse: {selectedSkill.whenToUse || '未配置'}</div>
                                            <div>argumentHint: {selectedSkill.argumentHint || '未配置'}</div>
                                            <div>argumentNames: {(selectedSkill.argumentNames || []).join(', ') || '无'}</div>
                                            <div>allowedRuntimeModes: {(selectedSkill.metadata?.allowedRuntimeModes || []).join(', ') || 'all'}</div>
                                            <div>autoActivateWhenIntents: {(selectedSkill.metadata?.autoActivateWhenIntents || []).join(', ') || '无'}</div>
                                            <div>autoActivateWhenContextTypes: {(selectedSkill.metadata?.autoActivateWhenContextTypes || []).join(', ') || '无'}</div>
                                            <div>paths: {(selectedSkill.paths || []).join(', ') || '无'}</div>
                                            <div>aliases: {(selectedSkill.aliases || []).join(', ') || '无'}</div>
                                        </div>
                                    </div>
                                    <div className="rounded-lg border border-border bg-surface-secondary/40 p-4">
                                        <div className="text-xs font-medium text-text-secondary mb-2">权限与覆盖</div>
                                        <div className="space-y-2 text-xs text-text-tertiary">
                                            <div>allowedToolPack: {selectedSkill.metadata?.allowedToolPack || '未配置'}</div>
                                            <div>allowedTools: {(selectedSkill.metadata?.allowedTools || []).join(', ') || '无'}</div>
                                            <div>blockedTools: {(selectedSkill.metadata?.blockedTools || []).join(', ') || '无'}</div>
                                            <div>agent: {selectedSkill.metadata?.agent || '未配置'}</div>
                                            <div>shell: {selectedSkill.metadata?.shell || '未配置'}</div>
                                        </div>
                                    </div>
                                    <div className="rounded-lg border border-border bg-surface-secondary/40 p-4">
                                        <div className="text-xs font-medium text-text-secondary mb-2">来源与使用</div>
                                        <div className="space-y-2 text-xs text-text-tertiary">
                                            <div>location: {selectedSkill.location}</div>
                                            {selectedSkill.baseDir && <div>baseDir: {selectedSkill.baseDir}</div>}
                                            <div>lastUsedAt: {formatLastUsed(selectedSkill.usage?.lastUsedAt)}</div>
                                            <div>hook groups: {Object.keys(selectedSkill.metadata?.hooks || {}).length}</div>
                                        </div>
                                    </div>
                                    <div className="rounded-lg border border-border bg-surface-secondary/40 p-4">
                                        <div className="flex items-center justify-between mb-2">
                                            <div className="text-xs font-medium text-text-secondary">激活预演</div>
                                            <div className="flex items-center gap-2">
                                                <button
                                                    onClick={() => void handlePreviewActivation()}
                                                    disabled={isPreviewing}
                                                    className="px-2 py-1 text-[11px] rounded border border-border hover:bg-surface-primary disabled:opacity-50"
                                                >
                                                    {isPreviewing ? '预演中...' : '预演'}
                                                </button>
                                                <button
                                                    onClick={() => void handleInvokeSkill()}
                                                    disabled={isInvoking}
                                                    className="px-2 py-1 text-[11px] rounded border border-border hover:bg-surface-primary disabled:opacity-50"
                                                >
                                                    {isInvoking ? '生成中...' : '调用'}
                                                </button>
                                            </div>
                                        </div>
                                        <div className="space-y-2 text-xs text-text-tertiary">
                                            <div>
                                                <div className="mb-1">runtimeMode</div>
                                                <select
                                                    value={previewRuntimeMode}
                                                    onChange={(e) => setPreviewRuntimeMode(e.target.value)}
                                                    className="w-full bg-surface-primary border border-border rounded px-2 py-1 text-xs"
                                                >
                                                    {['default', 'redclaw', 'knowledge', 'video-editor', 'diagnostics'].map((mode) => (
                                                        <option key={mode} value={mode}>{mode}</option>
                                                    ))}
                                                </select>
                                            </div>
                                            <div>
                                                <div className="mb-1">intent</div>
                                                <input
                                                    value={previewIntent}
                                                    onChange={(e) => setPreviewIntent(e.target.value)}
                                                    placeholder="例如 manuscript_creation"
                                                    className="w-full bg-surface-primary border border-border rounded px-2 py-1 text-xs"
                                                />
                                            </div>
                                            <div>
                                                <div className="mb-1">message</div>
                                                <textarea
                                                    value={previewMessage}
                                                    onChange={(e) => setPreviewMessage(e.target.value)}
                                                    placeholder="输入本轮请求，观察技能是否被激活"
                                                    className="w-full min-h-20 bg-surface-primary border border-border rounded px-2 py-1 text-xs resize-y"
                                                />
                                            </div>
                                            <div>
                                                <div className="mb-1">touchedPaths</div>
                                                <textarea
                                                    value={previewTouchedPaths}
                                                    onChange={(e) => setPreviewTouchedPaths(e.target.value)}
                                                    placeholder="/workspace/manuscripts/post.md"
                                                    className="w-full min-h-16 bg-surface-primary border border-border rounded px-2 py-1 text-xs resize-y"
                                                />
                                            </div>
                                            <div>
                                                <div className="mb-1">args</div>
                                                <input
                                                    value={previewArgs}
                                                    onChange={(e) => setPreviewArgs(e.target.value)}
                                                    placeholder={selectedSkill.argumentHint || '可选参数'}
                                                    className="w-full bg-surface-primary border border-border rounded px-2 py-1 text-xs"
                                                />
                                            </div>
                                        </div>
                                        {activationPreview && (
                                            <div className="mt-3 rounded border border-border bg-surface-primary p-3 text-[11px] text-text-tertiary space-y-2">
                                                <div>activeSkills: {activationPreview.activeSkills.map(item => item.name).join(', ') || '无'}</div>
                                                <div>selectedActive: {activationPreview.activeSkills.some(item => item.name === selectedSkill.name) ? 'true' : 'false'}</div>
                                                <div>allowedTools: {activationPreview.allowedTools.join(', ') || '无'}</div>
                                                <div>modelOverride: {activationPreview.modelOverride || '无'}</div>
                                                <div>effortOverride: {activationPreview.effortOverride || '无'}</div>
                                            </div>
                                        )}
                                        {invokePreview?.invocation?.renderedPrompt && (
                                            <div className="mt-3 rounded border border-border bg-surface-primary p-3">
                                                <div className="text-[11px] text-text-secondary mb-2">调用结果</div>
                                                <div className="text-[11px] text-text-tertiary mb-2">
                                                    executionContext: {invokePreview.invocation.executionContext || 'inline'}
                                                    {' · '}
                                                    rules: {invokePreview.invocation.ruleCount || 0}
                                                    {' · '}
                                                    refs: {invokePreview.invocation.referencesIncluded ? 'yes' : 'no'}
                                                    {' · '}
                                                    scripts: {invokePreview.invocation.scriptsIncluded ? 'yes' : 'no'}
                                                </div>
                                                <pre className="text-[11px] whitespace-pre-wrap font-mono text-text-primary bg-surface-secondary/50 p-3 rounded border border-border max-h-64 overflow-auto">
                                                    {invokePreview.invocation.renderedPrompt}
                                                </pre>
                                            </div>
                                        )}
                                    </div>
                                </div>
                            </div>
                        </div>
                    </>
                ) : (
                    <div className="flex-1 flex items-center justify-center text-text-tertiary">
                        <div className="text-center">
                            <FileText className="w-12 h-12 mx-auto mb-3 opacity-30" />
                            <p className="text-sm">选择一个技能查看详情</p>
                        </div>
                    </div>
                )}
            </div>

            {/* Create Skill Modal */}
            {isCreateModalOpen && (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
                    <div className="w-full max-w-md mx-4 bg-surface-primary rounded-xl border border-border shadow-2xl overflow-hidden">
                        <div className="px-6 py-4 border-b border-border">
                            <h3 className="text-base font-semibold text-text-primary">创建新技能</h3>
                        </div>

                        <div className="px-6 py-4 space-y-4">
                            <div>
                                <label className="block text-xs font-medium text-text-secondary mb-1.5">
                                    技能名称
                                </label>
                                <input
                                    type="text"
                                    value={newSkillName}
                                    onChange={(e) => {
                                        setNewSkillName(e.target.value);
                                        setCreateError('');
                                    }}
                                    onKeyDown={(e) => e.key === 'Enter' && handleCreateSkill()}
                                    placeholder="例如：写标题、数据分析..."
                                    className="w-full bg-surface-secondary border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-accent-primary"
                                    autoFocus
                                />
                                {createError && (
                                    <p className="text-xs text-red-500 mt-1.5">{createError}</p>
                                )}
                            </div>
                        </div>

                        <div className="px-6 py-4 bg-surface-secondary border-t border-border flex items-center justify-end gap-3">
                            <button
                                onClick={handleCloseCreateModal}
                                className="px-4 py-2 text-sm text-text-secondary hover:text-text-primary border border-border rounded-lg transition-colors"
                            >
                                取消
                            </button>
                            <button
                                onClick={handleCreateSkill}
                                className="px-4 py-2 text-sm text-white bg-accent-primary hover:bg-accent-primary/90 rounded-lg transition-colors"
                            >
                                创建
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
