import { useEffect, useState, useCallback, useRef } from 'react';
import { Lightbulb, Plus, Pencil, X, Check, FileText, RefreshCw, Power, Store, Search, Download, Loader2 } from 'lucide-react';
import { clsx } from 'clsx';

interface Skill {
    name: string;
    description: string;
    location: string;
    body: string;
    sourceScope?: string;
    isBuiltin?: boolean;
    disabled?: boolean;
}

interface MarketSkill {
    id: string;
    slug: string;
    skillName: string;
    description?: string;
    stars?: number;
    installs?: number;
    updatedAt?: string;
    marketUrl?: string;
    version?: string;
}

const formatSkillSourceScope = (scope?: string) => {
    switch (scope) {
        case 'builtin':
            return '内置';
        case 'user':
            return '用户目录';
        case 'workspace':
            return '当前空间';
        default:
            return scope || '';
    }
};

const formatMarketCount = (value?: number) => {
    const numericValue = Number(value || 0);
    if (!Number.isFinite(numericValue) || numericValue <= 0) return '0';
    if (numericValue >= 10000) return `${(numericValue / 10000).toFixed(1).replace(/\.0$/, '')}w`;
    if (numericValue >= 1000) return `${(numericValue / 1000).toFixed(1).replace(/\.0$/, '')}k`;
    return String(numericValue);
};

const formatMarketDate = (value?: string) => {
    if (!value) return '';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    return date.toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' });
};

const normalizeClawHubSlug = (input: string): string => {
    const value = input.trim();
    if (!value) return '';

    if (/^https?:\/\//i.test(value)) {
        try {
            const url = new URL(value);
            if (url.hostname !== 'clawhub.ai' && url.hostname !== 'www.clawhub.ai') return '';
            const parts = url.pathname.split('/').filter(Boolean);
            if (parts[0] === 'skills' && parts[1]) return parts[1].trim().toLowerCase();
            return '';
        } catch {
            return '';
        }
    }

    return value
        .replace(/^clawhub\//i, '')
        .replace(/^\/+|\/+$/g, '')
        .trim()
        .toLowerCase();
};

type SkillsNavigationAction = {
    action: 'open-market';
    nonce: number;
};

export function Skills({
    isActive = true,
    navigationAction,
}: {
    isActive?: boolean;
    navigationAction?: SkillsNavigationAction | null;
}) {
    const [skills, setSkills] = useState<Skill[]>([]);
    const [selectedSkill, setSelectedSkill] = useState<Skill | null>(null);
    const [isEditing, setIsEditing] = useState(false);
    const [editContent, setEditContent] = useState('');
    const [isLoading, setIsLoading] = useState(true);

    // 创建技能相关状态
    const [isCreateModalOpen, setIsCreateModalOpen] = useState(false);
    const [newSkillName, setNewSkillName] = useState('');
    const [createError, setCreateError] = useState('');
    const [isMarketOpen, setIsMarketOpen] = useState(false);
    const [marketQuery, setMarketQuery] = useState('');
    const [marketResults, setMarketResults] = useState<MarketSkill[]>([]);
    const [isMarketLoading, setIsMarketLoading] = useState(false);
    const [marketError, setMarketError] = useState('');
    const [marketNotice, setMarketNotice] = useState('');
    const [marketInstallSource, setMarketInstallSource] = useState('');
    const [installingMarketSlug, setInstallingMarketSlug] = useState('');
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
            return list || [];
        } catch (e) {
            if (requestId !== loadRequestRef.current) return;
            console.error('Failed to load skills:', e);
            return [];
        } finally {
            if (requestId === loadRequestRef.current) {
                setIsLoading(false);
            }
        }
    }, []);

    const loadMarketSkills = useCallback(async (query = marketQuery) => {
        setIsMarketLoading(true);
        setMarketError('');
        setMarketNotice('');
        try {
            const result = await window.ipcRenderer.skills.marketSearch<MarketSkill[]>({ query });
            setMarketResults(Array.isArray(result) ? result : []);
        } catch (e) {
            console.error('Failed to load skill market:', e);
            setMarketError('市场读取失败');
        } finally {
            setIsMarketLoading(false);
        }
    }, [marketQuery]);

    useEffect(() => {
        if (!isActive) return;
        void loadSkills();
    }, [isActive, loadSkills]);

    const handleSelectSkill = (skill: Skill) => {
        setSelectedSkill(skill);
        setEditContent(skill.body);
        setIsEditing(false);
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
            await window.ipcRenderer.skills.save({
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

    const handleOpenMarket = useCallback(() => {
        setIsMarketOpen(true);
        if (marketResults.length === 0 && !isMarketLoading) {
            void loadMarketSkills('');
        }
    }, [isMarketLoading, loadMarketSkills, marketResults.length]);

    useEffect(() => {
        if (!isActive || navigationAction?.action !== 'open-market') return;
        handleOpenMarket();
    }, [handleOpenMarket, isActive, navigationAction?.action, navigationAction?.nonce]);

    const handleCloseMarket = () => {
        setIsMarketOpen(false);
        setMarketError('');
        setMarketNotice('');
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
            const result = await window.ipcRenderer.skills.create<{ success: boolean; error?: string; location?: string }>({ name });

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
                ? await window.ipcRenderer.skills.enable<{ success?: boolean; error?: string }>({ name: selectedSkill.name })
                : await window.ipcRenderer.skills.disable<{ success?: boolean; error?: string }>({ name: selectedSkill.name });
            if (!result?.success) {
                return;
            }
            await loadSkills();
        } catch (e) {
            console.error('Failed to toggle skill:', e);
        }
    };

    const installMarketSkillBySlug = async (slugInput: string, displayName?: string, tag?: string) => {
        const slug = normalizeClawHubSlug(slugInput);
        if (!slug) return;
        setInstallingMarketSlug(slug);
        setMarketError('');
        setMarketNotice('');
        try {
            const result = await window.ipcRenderer.skills.marketInstall<{ success?: boolean; error?: string; location?: string; displayName?: string }>({
                slug,
                tag: tag || 'latest',
            });
            if (!result?.success) {
                setMarketError(result?.error || '安装失败');
                return;
            }
            const list = await loadSkills();
            const installedSkill = (list || []).find((item) => item.location === result.location)
                || (list || []).find((item) => item.name === result.displayName || item.name === displayName || item.name === slug);
            if (installedSkill) {
                handleSelectSkill(installedSkill);
            }
            setMarketInstallSource('');
            setMarketNotice(`${result.displayName || displayName || slug} 已安装`);
        } catch (e) {
            console.error('Failed to install market skill:', e);
            setMarketError('安装失败');
        } finally {
            setInstallingMarketSlug('');
        }
    };

    const handleInstallMarketSkill = async (skill: MarketSkill) => {
        await installMarketSkillBySlug(skill.slug || skill.id, skill.skillName, skill.version || 'latest');
    };

    const handleInstallMarketSource = async () => {
        const slug = normalizeClawHubSlug(marketInstallSource);
        if (!slug) {
            setMarketError('请输入 ClawHub 技能 slug 或技能链接');
            setMarketNotice('');
            return;
        }
        await installMarketSkillBySlug(slug);
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
                            onClick={handleOpenMarket}
                            className="p-1.5 text-text-tertiary hover:text-accent-primary hover:bg-surface-primary rounded transition-colors"
                            title="技能市场"
                        >
                            <Store className="w-4 h-4" />
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

            {/* Skill Market Modal */}
            {isMarketOpen && (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm" onMouseDown={handleCloseMarket}>
                    <div
                        className="w-full max-w-3xl max-h-[82vh] mx-4 bg-surface-primary rounded-xl border border-border shadow-2xl overflow-hidden flex flex-col"
                        onMouseDown={(event) => event.stopPropagation()}
                    >
                        <div className="px-5 py-3 border-b border-border flex items-center justify-between gap-3">
                            <div className="flex items-center gap-2 min-w-0">
                                <Store className="w-4 h-4 text-accent-primary" />
                                <h3 className="text-sm font-semibold text-text-primary">技能市场</h3>
                            </div>
                            <div className="flex items-center gap-2">
                                <button
                                    onClick={() => void loadMarketSkills(marketQuery)}
                                    disabled={isMarketLoading}
                                    className="flex items-center gap-1.5 px-3 py-1.5 text-xs text-text-secondary hover:text-text-primary border border-border rounded-md transition-colors disabled:opacity-50"
                                >
                                    <RefreshCw className={clsx('w-3 h-3', isMarketLoading && 'animate-spin')} />
                                    刷新
                                </button>
                                <button
                                    onClick={handleCloseMarket}
                                    className="p-1.5 text-text-tertiary hover:text-text-primary hover:bg-surface-secondary rounded transition-colors"
                                    aria-label="关闭技能市场"
                                >
                                    <X className="w-4 h-4" />
                                </button>
                            </div>
                        </div>

                        <form
                            className="px-5 py-3 border-b border-border"
                            onSubmit={(event) => {
                                event.preventDefault();
                                void loadMarketSkills(marketQuery);
                            }}
                        >
                            <div className="relative">
                                <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-text-tertiary" />
                                <input
                                    value={marketQuery}
                                    onChange={(event) => setMarketQuery(event.target.value)}
                                    placeholder="搜索技能"
                                    className="w-full bg-surface-secondary border border-border rounded-lg pl-9 pr-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-accent-primary"
                                />
                            </div>
                        </form>

                        <form
                            className="flex items-center gap-2 border-b border-border px-5 py-3"
                            onSubmit={(event) => {
                                event.preventDefault();
                                void handleInstallMarketSource();
                            }}
                        >
                            <input
                                value={marketInstallSource}
                                onChange={(event) => {
                                    setMarketInstallSource(event.target.value);
                                    setMarketError('');
                                }}
                                placeholder="输入技能标识或 ClawHub 链接"
                                className="min-w-0 flex-1 rounded-lg border border-border bg-surface-secondary px-3 py-2 text-xs text-text-primary outline-none transition-colors placeholder:text-text-tertiary focus:border-accent-primary"
                            />
                            <button
                                type="submit"
                                disabled={!marketInstallSource.trim() || Boolean(installingMarketSlug)}
                                className="flex shrink-0 items-center gap-1.5 rounded-md bg-accent-primary px-3 py-2 text-xs font-medium text-white transition-colors hover:bg-accent-primary/90 disabled:opacity-40"
                            >
                                {installingMarketSlug && normalizeClawHubSlug(marketInstallSource) === installingMarketSlug
                                    ? <Loader2 className="h-3 w-3 animate-spin" />
                                    : <Download className="h-3 w-3" />}
                                安装
                            </button>
                        </form>

                        {(marketError || marketNotice) && (
                            <div className={clsx(
                                'mx-5 mt-3 rounded-lg border px-3 py-2 text-xs',
                                marketError
                                    ? 'border-red-200 bg-red-50 text-red-600'
                                    : 'border-emerald-200 bg-emerald-50 text-emerald-600'
                            )}>
                                {marketError || marketNotice}
                            </div>
                        )}

                        <div className="flex-1 overflow-auto">
                            {isMarketLoading && marketResults.length === 0 ? (
                                <div className="flex items-center justify-center gap-2 py-10 text-xs text-text-tertiary">
                                    <Loader2 className="w-4 h-4 animate-spin" />
                                    正在读取市场
                                </div>
                            ) : marketResults.length === 0 ? (
                                <div className="py-10 text-center text-xs text-text-tertiary">
                                    {marketQuery.trim() ? '没有匹配技能' : '市场暂无技能'}
                                </div>
                            ) : (
                                <div className="divide-y divide-border">
                                    {marketResults.map((skill) => {
                                        const slug = skill.slug || skill.id;
                                        const normalizedSlug = slug.trim().toLowerCase();
                                        const normalizedName = (skill.skillName || '').trim().toLowerCase();
                                        const isInstalled = skills.some((item) => {
                                            const name = item.name.trim().toLowerCase();
                                            return name === normalizedName || name === normalizedSlug;
                                        });
                                        const isInstalling = installingMarketSlug === slug;
                                        return (
                                            <div key={skill.id || slug} className="px-5 py-4">
                                                <div className="flex items-start justify-between gap-4">
                                                    <div className="min-w-0 flex-1">
                                                        <div className="flex flex-wrap items-center gap-2">
                                                            <h4 className="truncate text-sm font-semibold text-text-primary">{skill.skillName || slug}</h4>
                                                            {skill.version && (
                                                                <span className="rounded bg-surface-secondary px-1.5 py-0.5 text-[10px] text-text-tertiary">{skill.version}</span>
                                                            )}
                                                            {isInstalled && (
                                                                <span className="rounded bg-emerald-100 px-1.5 py-0.5 text-[10px] text-emerald-600">已安装</span>
                                                            )}
                                                        </div>
                                                        <p className="mt-1 line-clamp-2 text-xs leading-5 text-text-secondary">
                                                            {skill.description || '无描述'}
                                                        </p>
                                                        <div className="mt-2 flex flex-wrap items-center gap-3 text-[10px] text-text-tertiary">
                                                            <span>{formatMarketCount(skill.installs)} 安装</span>
                                                            <span>{formatMarketCount(skill.stars)} 收藏</span>
                                                            {formatMarketDate(skill.updatedAt) && <span>{formatMarketDate(skill.updatedAt)} 更新</span>}
                                                            {slug && <span className="font-mono">{slug}</span>}
                                                        </div>
                                                    </div>
                                                    <button
                                                        onClick={() => void handleInstallMarketSkill(skill)}
                                                        disabled={!slug || isInstalled || Boolean(installingMarketSlug)}
                                                        className="flex shrink-0 items-center gap-1.5 px-3 py-1.5 text-xs text-white bg-accent-primary hover:bg-accent-primary/90 rounded-md transition-colors disabled:opacity-40"
                                                    >
                                                        {isInstalling ? <Loader2 className="w-3 h-3 animate-spin" /> : <Download className="w-3 h-3" />}
                                                        {isInstalling ? '安装中' : isInstalled ? '已安装' : '安装'}
                                                    </button>
                                                </div>
                                            </div>
                                        );
                                    })}
                                </div>
                            )}
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
