import { useEffect, useMemo, useState } from 'react';
import {
    Archive,
    Plus,
    Search,
    Upload,
    Sparkles,
    FileText,
    Filter,
    Star,
    Tag,
    Target,
    UserRound,
    Pencil,
    Trash2,
    X,
    Check
} from 'lucide-react';
import { clsx } from 'clsx';

interface ArchiveProfileRecord {
    id: string;
    name: string;
    platform?: string;
    goal?: string;
    domain?: string;
    audience?: string;
    tone_tags?: string[];
    created_at: number;
    updated_at: number;
}

interface ArchiveSampleRecord {
    id: string;
    profile_id: string;
    title?: string;
    content?: string;
    excerpt?: string;
    tags?: string[];
    images?: string[];
    platform?: string;
    source_url?: string;
    sample_date?: string;
    is_featured?: number;
    created_at: number;
}

interface ArchiveProfile {
    id: string;
    name: string;
    platform: string;
    goal: string;
    domain: string;
    audience: string;
    toneTags: string[];
    createdAt: number;
    updatedAt: number;
}

interface ArchiveSample {
    id: string;
    profileId: string;
    title: string;
    content: string;
    excerpt: string;
    tags: string[];
    platform: string;
    sourceUrl: string;
    sampleDate: string;
    isFeatured: boolean;
    createdAt: number;
}

const normalizeProfile = (profile: ArchiveProfileRecord): ArchiveProfile => ({
    id: profile.id,
    name: profile.name,
    platform: profile.platform || '',
    goal: profile.goal || '',
    domain: profile.domain || '',
    audience: profile.audience || '',
    toneTags: profile.tone_tags || [],
    createdAt: profile.created_at,
    updatedAt: profile.updated_at
});

const normalizeSample = (sample: ArchiveSampleRecord): ArchiveSample => ({
    id: sample.id,
    profileId: sample.profile_id,
    title: sample.title || '未命名样本',
    content: sample.content || '',
    excerpt: sample.excerpt || '',
    tags: sample.tags || [],
    platform: sample.platform || '',
    sourceUrl: sample.source_url || '',
    sampleDate: sample.sample_date || '',
    isFeatured: Boolean(sample.is_featured),
    createdAt: sample.created_at
});

const formatDate = (sample: ArchiveSample) => {
    if (sample.sampleDate) return sample.sampleDate;
    const date = new Date(sample.createdAt);
    return Number.isNaN(date.valueOf()) ? '' : date.toISOString().slice(0, 10);
};

export function Archives() {
    const [profiles, setProfiles] = useState<ArchiveProfile[]>([]);
    const [samples, setSamples] = useState<ArchiveSample[]>([]);
    const [selectedProfileId, setSelectedProfileId] = useState('');
    const [selectedSampleId, setSelectedSampleId] = useState('');
    const [isLoadingProfiles, setIsLoadingProfiles] = useState(true);
    const [isLoadingSamples, setIsLoadingSamples] = useState(true);
    const [isProfileModalOpen, setIsProfileModalOpen] = useState(false);
    const [isSampleModalOpen, setIsSampleModalOpen] = useState(false);
    const [editingProfile, setEditingProfile] = useState<ArchiveProfile | null>(null);
    const [editingSample, setEditingSample] = useState<ArchiveSample | null>(null);

    const [profileForm, setProfileForm] = useState({
        name: '',
        platform: '',
        goal: '',
        domain: '',
        audience: '',
        toneTags: ''
    });

    const [sampleForm, setSampleForm] = useState({
        title: '',
        content: '',
        tags: '',
        platform: '',
        sampleDate: '',
        isFeatured: false
    });

    const selectedProfile = useMemo(
        () => profiles.find(profile => profile.id === selectedProfileId) || null,
        [profiles, selectedProfileId]
    );

    const selectedSample = useMemo(
        () => samples.find(sample => sample.id === selectedSampleId) || null,
        [samples, selectedSampleId]
    );

    const loadProfiles = async () => {
        setIsLoadingProfiles(true);
        try {
            const result = await window.ipcRenderer.invoke('archives:list') as ArchiveProfileRecord[];
            const list = (result || []).map(normalizeProfile);
            setProfiles(list);
            if (list.length > 0) {
                setSelectedProfileId(prev => {
                    const exists = list.some(profile => profile.id === prev);
                    return exists ? prev : list[0].id;
                });
            } else {
                setSelectedProfileId('');
                setSamples([]);
                setSelectedSampleId('');
                setIsLoadingSamples(false);
            }
        } catch (error) {
            console.error('Failed to load archives:', error);
        } finally {
            setIsLoadingProfiles(false);
        }
    };

    const loadSamples = async (profileId: string) => {
        if (!profileId) return;
        setIsLoadingSamples(true);
        try {
            const result = await window.ipcRenderer.invoke('archives:samples:list', profileId) as ArchiveSampleRecord[];
            const list = (result || []).map(normalizeSample);
            setSamples(list);
            setSelectedSampleId(list[0]?.id || '');
        } catch (error) {
            console.error('Failed to load samples:', error);
        } finally {
            setIsLoadingSamples(false);
        }
    };

    useEffect(() => {
        loadProfiles();
    }, []);

    useEffect(() => {
        if (selectedProfileId) {
            loadSamples(selectedProfileId);
        }
    }, [selectedProfileId]);

    useEffect(() => {
        const handleSampleCreated = (_event: unknown, data: { profileId: string }) => {
            if (data.profileId === selectedProfileId) {
                loadSamples(selectedProfileId);
            }
        };
        window.ipcRenderer.on('archives:sample-created', handleSampleCreated);
        return () => window.ipcRenderer.off('archives:sample-created', handleSampleCreated);
    }, [selectedProfileId]);

    const openCreateProfile = () => {
        setEditingProfile(null);
        setProfileForm({
            name: '',
            platform: '',
            goal: '',
            domain: '',
            audience: '',
            toneTags: ''
        });
        setIsProfileModalOpen(true);
    };

    const openEditProfile = () => {
        if (!selectedProfile) return;
        setEditingProfile(selectedProfile);
        setProfileForm({
            name: selectedProfile.name,
            platform: selectedProfile.platform,
            goal: selectedProfile.goal,
            domain: selectedProfile.domain,
            audience: selectedProfile.audience,
            toneTags: selectedProfile.toneTags.join(', ')
        });
        setIsProfileModalOpen(true);
    };

    const saveProfile = async () => {
        const toneTags = profileForm.toneTags
            .split(',')
            .map(tag => tag.trim())
            .filter(Boolean);

        if (!profileForm.name.trim()) return;

        if (editingProfile) {
            await window.ipcRenderer.invoke('archives:update', {
                id: editingProfile.id,
                name: profileForm.name.trim(),
                platform: profileForm.platform.trim(),
                goal: profileForm.goal.trim(),
                domain: profileForm.domain.trim(),
                audience: profileForm.audience.trim(),
                toneTags
            });
        } else {
            const created = await window.ipcRenderer.invoke('archives:create', {
                name: profileForm.name.trim(),
                platform: profileForm.platform.trim(),
                goal: profileForm.goal.trim(),
                domain: profileForm.domain.trim(),
                audience: profileForm.audience.trim(),
                toneTags
            }) as ArchiveProfileRecord;
            const normalized = created ? normalizeProfile(created) : null;
            if (normalized) {
                setSelectedProfileId(normalized.id);
            }
        }

        setIsProfileModalOpen(false);
        await loadProfiles();
    };

    const deleteProfile = async () => {
        if (!selectedProfile) return;
        if (!window.confirm(`确定删除档案“${selectedProfile.name}”及其样本吗？`)) return;
        await window.ipcRenderer.invoke('archives:delete', selectedProfile.id);
        await loadProfiles();
    };

    const openCreateSample = () => {
        if (!selectedProfile) return;
        setEditingSample(null);
        setSampleForm({
            title: '',
            content: '',
            tags: '',
            platform: selectedProfile.platform,
            sampleDate: new Date().toISOString().slice(0, 10),
            isFeatured: false
        });
        setIsSampleModalOpen(true);
    };

    const openEditSample = () => {
        if (!selectedSample) return;
        setEditingSample(selectedSample);
        setSampleForm({
            title: selectedSample.title,
            content: selectedSample.content,
            tags: selectedSample.tags.join(', '),
            platform: selectedSample.platform,
            sampleDate: selectedSample.sampleDate || formatDate(selectedSample),
            isFeatured: selectedSample.isFeatured
        });
        setIsSampleModalOpen(true);
    };

    const saveSample = async () => {
        if (!selectedProfile) return;
        const tags = sampleForm.tags
            .split(',')
            .map(tag => tag.trim())
            .filter(Boolean);

        if (editingSample) {
            await window.ipcRenderer.invoke('archives:samples:update', {
                id: editingSample.id,
                profileId: selectedProfile.id,
                title: sampleForm.title.trim(),
                content: sampleForm.content.trim(),
                tags,
                platform: sampleForm.platform.trim(),
                sampleDate: sampleForm.sampleDate,
                isFeatured: sampleForm.isFeatured
            });
        } else {
            await window.ipcRenderer.invoke('archives:samples:create', {
                profileId: selectedProfile.id,
                title: sampleForm.title.trim(),
                content: sampleForm.content.trim(),
                tags,
                platform: sampleForm.platform.trim(),
                sampleDate: sampleForm.sampleDate,
                isFeatured: sampleForm.isFeatured
            });
        }

        setIsSampleModalOpen(false);
        await loadSamples(selectedProfile.id);
    };

    const deleteSample = async () => {
        if (!selectedSample) return;
        if (!window.confirm(`确定删除样本“${selectedSample.title}”吗？`)) return;
        await window.ipcRenderer.invoke('archives:samples:delete', selectedSample.id);
        await loadSamples(selectedProfileId);
    };

    const markFeatured = async () => {
        if (!selectedSample || !selectedProfile) return;
        await window.ipcRenderer.invoke('archives:samples:update', {
            id: selectedSample.id,
            profileId: selectedProfile.id,
            title: selectedSample.title,
            content: selectedSample.content,
            tags: selectedSample.tags,
            platform: selectedSample.platform,
            sampleDate: selectedSample.sampleDate || formatDate(selectedSample),
            isFeatured: true
        });
        await loadSamples(selectedProfile.id);
    };

    return (
        <div className="flex h-full min-h-0">
            <div className="w-72 border-r border-border bg-surface-secondary/30 flex flex-col">
                <div className="p-4 border-b border-border">
                    <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2 text-text-primary font-semibold">
                            <Archive className="w-4 h-4" />
                            档案
                        </div>
                        <button
                            onClick={openCreateProfile}
                            className="p-1.5 text-text-tertiary hover:text-accent-primary hover:bg-surface-primary rounded transition-colors"
                        >
                            <Plus className="w-4 h-4" />
                        </button>
                    </div>
                    <div className="mt-3 relative">
                        <Search className="w-4 h-4 text-text-tertiary absolute left-3 top-1/2 -translate-y-1/2" />
                        <input
                            className="w-full bg-surface-primary border border-border rounded-lg pl-9 pr-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-accent-primary"
                            placeholder="搜索档案"
                        />
                    </div>
                </div>
                <div className="flex-1 overflow-y-auto p-3 space-y-2">
                    {isLoadingProfiles ? (
                        <div className="text-xs text-text-tertiary px-2">加载中...</div>
                    ) : profiles.length === 0 ? (
                        <div className="text-xs text-text-tertiary px-2">暂无档案，先创建一个吧</div>
                    ) : (
                        profiles.map(profile => (
                            <button
                                key={profile.id}
                                onClick={() => setSelectedProfileId(profile.id)}
                                className={clsx(
                                    'w-full text-left p-3 rounded-lg border transition-colors',
                                    selectedProfileId === profile.id
                                        ? 'bg-surface-primary border-border shadow-sm'
                                        : 'bg-transparent border-transparent hover:bg-surface-primary'
                                )}
                            >
                                <div className="text-sm font-medium text-text-primary">{profile.name}</div>
                                <div className="mt-1 text-xs text-text-tertiary">{profile.platform} · {profile.goal}</div>
                                <div className="mt-2 flex flex-wrap gap-1">
                                    {profile.toneTags.slice(0, 2).map(tag => (
                                        <span key={tag} className="text-[10px] px-1.5 py-0.5 rounded bg-surface-secondary text-text-secondary">
                                            {tag}
                                        </span>
                                    ))}
                                </div>
                            </button>
                        ))
                    )}
                </div>
                <div className="p-3 border-t border-border text-xs text-text-tertiary">
                    支持多账号档案，建议按平台拆分
                </div>
            </div>

            <div className="flex-1 flex flex-col min-w-0 bg-surface-primary">
                <div className="px-6 py-4 border-b border-border flex items-center justify-between">
                    <div>
                        <div className="text-lg font-semibold text-text-primary">{selectedProfile?.name || '档案详情'}</div>
                        <div className="text-sm text-text-tertiary">
                            {selectedProfile ? `最近更新 ${new Date(selectedProfile.updatedAt).toISOString().slice(0, 10)}` : '请选择档案'}
                        </div>
                    </div>
                    <div className="flex items-center gap-2">
                        <button
                            onClick={openCreateSample}
                            disabled={!selectedProfile}
                            className="flex items-center gap-1.5 px-3 py-1.5 border border-border rounded text-xs hover:bg-surface-secondary transition-colors disabled:opacity-50"
                        >
                            <Upload className="w-3.5 h-3.5" />
                            导入样本
                        </button>
                        <button
                            className="flex items-center gap-1.5 px-3 py-1.5 border border-border rounded text-xs hover:bg-surface-secondary transition-colors"
                        >
                            <Sparkles className="w-3.5 h-3.5" />
                            生成风格摘要
                        </button>
                        <button
                            onClick={openEditProfile}
                            disabled={!selectedProfile}
                            className="flex items-center gap-1.5 px-3 py-1.5 border border-border rounded text-xs hover:bg-surface-secondary transition-colors disabled:opacity-50"
                        >
                            <Pencil className="w-3.5 h-3.5" />
                            编辑档案
                        </button>
                        <button
                            onClick={deleteProfile}
                            disabled={!selectedProfile}
                            className="flex items-center gap-1.5 px-3 py-1.5 border border-border rounded text-xs text-red-500 hover:bg-red-50 transition-colors disabled:opacity-50"
                        >
                            <Trash2 className="w-3.5 h-3.5" />
                            删除
                        </button>
                    </div>
                </div>

                <div className="flex-1 overflow-y-auto p-6 space-y-4">
                    <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
                        <div className="bg-surface-secondary/50 rounded-lg border border-border p-4">
                            <div className="flex items-center gap-2 text-sm font-medium text-text-primary mb-3">
                                <UserRound className="w-4 h-4 text-text-secondary" />
                                基础信息
                            </div>
                            {selectedProfile ? (
                                <div className="space-y-2 text-sm text-text-secondary">
                                    <div className="flex items-center justify-between">
                                        <span>平台</span>
                                        <span className="text-text-primary">{selectedProfile.platform || '-'}</span>
                                    </div>
                                    <div className="flex items-center justify-between">
                                        <span>领域</span>
                                        <span className="text-text-primary">{selectedProfile.domain || '-'}</span>
                                    </div>
                                    <div className="flex items-center justify-between">
                                        <span>目标</span>
                                        <span className="text-text-primary">{selectedProfile.goal || '-'}</span>
                                    </div>
                                    <div className="flex items-start justify-between">
                                        <span>受众画像</span>
                                        <span className="text-text-primary text-right max-w-[240px]">{selectedProfile.audience || '-'}</span>
                                    </div>
                                </div>
                            ) : (
                                <div className="text-xs text-text-tertiary">请选择档案查看详情</div>
                            )}
                            <div className="mt-4 flex items-center gap-2 text-xs text-text-tertiary">
                                <Target className="w-3.5 h-3.5" />
                                快捷编辑支持标签与目标快速更新
                            </div>
                        </div>

                        <div className="bg-surface-secondary/50 rounded-lg border border-border p-4">
                            <div className="flex items-center gap-2 text-sm font-medium text-text-primary mb-3">
                                <Archive className="w-4 h-4 text-text-secondary" />
                                风格画像
                            </div>
                            {selectedProfile ? (
                                <div className="mb-3">
                                    <div className="text-xs text-text-tertiary mb-2">语气与风格词</div>
                                    <div className="flex flex-wrap gap-2">
                                        {selectedProfile.toneTags.length > 0 ? (
                                            selectedProfile.toneTags.map(tag => (
                                                <span key={tag} className="px-2 py-1 text-xs rounded bg-surface-primary border border-border text-text-secondary">
                                                    {tag}
                                                </span>
                                            ))
                                        ) : (
                                            <span className="text-xs text-text-tertiary">暂无风格标签</span>
                                        )}
                                    </div>
                                </div>
                            ) : (
                                <div className="text-xs text-text-tertiary">暂无档案</div>
                            )}
                        </div>
                    </div>

                    <div className="bg-surface-secondary/50 rounded-lg border border-border p-4">
                        <div className="flex items-center justify-between">
                            <div className="flex items-center gap-2 text-sm font-medium text-text-primary">
                                <FileText className="w-4 h-4 text-text-secondary" />
                                样本库
                            </div>
                            <div className="flex items-center gap-2">
                                <button className="flex items-center gap-1.5 px-2.5 py-1 border border-border rounded text-xs hover:bg-surface-secondary transition-colors">
                                    <Filter className="w-3.5 h-3.5" />
                                    平台
                                </button>
                                <button className="flex items-center gap-1.5 px-2.5 py-1 border border-border rounded text-xs hover:bg-surface-secondary transition-colors">
                                    <Tag className="w-3.5 h-3.5" />
                                    主题
                                </button>
                                <button className="flex items-center gap-1.5 px-2.5 py-1 border border-border rounded text-xs hover:bg-surface-secondary transition-colors">
                                    <Star className="w-3.5 h-3.5" />
                                    代表作
                                </button>
                            </div>
                        </div>

                        <div className="mt-4 grid grid-cols-1 xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)] gap-4">
                            <div className="space-y-3">
                                {isLoadingSamples ? (
                                    <div className="text-xs text-text-tertiary">加载中...</div>
                                ) : samples.length === 0 ? (
                                    <div className="text-xs text-text-tertiary">暂无样本，先添加一条内容吧</div>
                                ) : (
                                    samples.map(sample => (
                                        <button
                                            key={sample.id}
                                            onClick={() => setSelectedSampleId(sample.id)}
                                            className={clsx(
                                                'w-full text-left bg-surface-primary border rounded-lg p-3 transition-colors',
                                                selectedSampleId === sample.id ? 'border-accent-primary/60' : 'border-border hover:border-text-tertiary'
                                            )}
                                        >
                                            <div className="flex items-center justify-between">
                                                <div className="text-sm font-medium text-text-primary">{sample.title}</div>
                                                {sample.isFeatured ? (
                                                    <span className="flex items-center gap-1 text-xs text-amber-600">
                                                        <Star className="w-3.5 h-3.5" />
                                                        代表作
                                                    </span>
                                                ) : (
                                                    <span className="text-xs text-text-tertiary">普通样本</span>
                                                )}
                                            </div>
                                            <div className="mt-1 text-xs text-text-tertiary">{sample.platform || '-'} · {formatDate(sample) || '-'}</div>
                                            <div className="mt-2 flex flex-wrap gap-1.5">
                                                {sample.tags.map(tag => (
                                                    <span key={tag} className="text-[10px] px-1.5 py-0.5 rounded bg-surface-secondary text-text-secondary">
                                                        {tag}
                                                    </span>
                                                ))}
                                            </div>
                                        </button>
                                    ))
                                )}
                            </div>

                            <div className="bg-surface-primary border border-border rounded-lg p-3 h-fit">
                                <div className="flex items-center gap-2 text-sm font-medium text-text-primary mb-2">
                                    <FileText className="w-4 h-4 text-text-secondary" />
                                    样本详情
                                </div>
                                {selectedSample ? (
                                    <>
                                        <div className="text-sm text-text-primary mb-1">{selectedSample.title}</div>
                                        <div className="text-xs text-text-tertiary mb-3">{selectedSample.platform || '-'} · {formatDate(selectedSample) || '-'}</div>
                                        <p className="text-xs text-text-secondary leading-relaxed">{selectedSample.excerpt || '暂无摘要'}</p>
                                        <div className="mt-3 flex flex-wrap gap-1.5">
                                            {selectedSample.tags.map(tag => (
                                                <span key={tag} className="text-[10px] px-1.5 py-0.5 rounded bg-surface-secondary text-text-secondary">
                                                    {tag}
                                                </span>
                                            ))}
                                        </div>
                                        <div className="mt-4 space-y-2">
                                            <button
                                                onClick={markFeatured}
                                                className="w-full flex items-center justify-center gap-1.5 px-3 py-2 border border-border rounded text-xs hover:bg-surface-secondary transition-colors"
                                            >
                                                <Star className="w-3.5 h-3.5" />
                                                设为代表作
                                            </button>
                                            <button
                                                onClick={openEditSample}
                                                className="w-full flex items-center justify-center gap-1.5 px-3 py-2 border border-border rounded text-xs hover:bg-surface-secondary transition-colors"
                                            >
                                                <Pencil className="w-3.5 h-3.5" />
                                                编辑样本
                                            </button>
                                            <button
                                                onClick={deleteSample}
                                                className="w-full flex items-center justify-center gap-1.5 px-3 py-2 border border-border rounded text-xs text-red-500 hover:bg-red-50 transition-colors"
                                            >
                                                <Trash2 className="w-3.5 h-3.5" />
                                                删除样本
                                            </button>
                                        </div>
                                    </>
                                ) : (
                                    <div className="text-xs text-text-tertiary">选择样本查看详情</div>
                                )}
                            </div>
                        </div>
                    </div>
                </div>
            </div>

            {isProfileModalOpen && (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
                    <div className="w-full max-w-lg mx-4 bg-surface-primary rounded-xl border border-border shadow-2xl overflow-hidden">
                        <div className="px-6 py-4 border-b border-border flex items-center justify-between">
                            <h3 className="text-base font-semibold text-text-primary">{editingProfile ? '编辑档案' : '创建档案'}</h3>
                            <button
                                onClick={() => setIsProfileModalOpen(false)}
                                className="p-1.5 text-text-tertiary hover:text-text-primary"
                            >
                                <X className="w-4 h-4" />
                            </button>
                        </div>

                        <div className="px-6 py-4 space-y-4">
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                                <label className="text-xs text-text-secondary">
                                    档案名称
                                    <input
                                        className="mt-1 w-full bg-surface-secondary border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-accent-primary"
                                        value={profileForm.name}
                                        onChange={(event) => setProfileForm({ ...profileForm, name: event.target.value })}
                                    />
                                </label>
                                <label className="text-xs text-text-secondary">
                                    平台
                                    <input
                                        className="mt-1 w-full bg-surface-secondary border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-accent-primary"
                                        value={profileForm.platform}
                                        onChange={(event) => setProfileForm({ ...profileForm, platform: event.target.value })}
                                    />
                                </label>
                                <label className="text-xs text-text-secondary">
                                    领域
                                    <input
                                        className="mt-1 w-full bg-surface-secondary border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-accent-primary"
                                        value={profileForm.domain}
                                        onChange={(event) => setProfileForm({ ...profileForm, domain: event.target.value })}
                                    />
                                </label>
                                <label className="text-xs text-text-secondary">
                                    目标
                                    <input
                                        className="mt-1 w-full bg-surface-secondary border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-accent-primary"
                                        value={profileForm.goal}
                                        onChange={(event) => setProfileForm({ ...profileForm, goal: event.target.value })}
                                    />
                                </label>
                            </div>
                            <label className="text-xs text-text-secondary">
                                受众画像
                                <input
                                    className="mt-1 w-full bg-surface-secondary border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-accent-primary"
                                    value={profileForm.audience}
                                    onChange={(event) => setProfileForm({ ...profileForm, audience: event.target.value })}
                                />
                            </label>
                            <label className="text-xs text-text-secondary">
                                风格词（用逗号分隔）
                                <input
                                    className="mt-1 w-full bg-surface-secondary border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-accent-primary"
                                    value={profileForm.toneTags}
                                    onChange={(event) => setProfileForm({ ...profileForm, toneTags: event.target.value })}
                                />
                            </label>
                        </div>

                        <div className="px-6 py-4 bg-surface-secondary border-t border-border flex items-center justify-end gap-3">
                            <button
                                onClick={() => setIsProfileModalOpen(false)}
                                className="px-4 py-2 text-sm text-text-secondary hover:text-text-primary border border-border rounded-lg transition-colors"
                            >
                                取消
                            </button>
                            <button
                                onClick={saveProfile}
                                className="px-4 py-2 text-sm text-white bg-accent-primary hover:bg-accent-primary/90 rounded-lg transition-colors"
                            >
                                <Check className="w-4 h-4 inline-block mr-1" />
                                保存
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {isSampleModalOpen && (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
                    <div className="w-full max-w-2xl mx-4 bg-surface-primary rounded-xl border border-border shadow-2xl overflow-hidden">
                        <div className="px-6 py-4 border-b border-border flex items-center justify-between">
                            <h3 className="text-base font-semibold text-text-primary">{editingSample ? '编辑样本' : '新增样本'}</h3>
                            <button
                                onClick={() => setIsSampleModalOpen(false)}
                                className="p-1.5 text-text-tertiary hover:text-text-primary"
                            >
                                <X className="w-4 h-4" />
                            </button>
                        </div>

                        <div className="px-6 py-4 space-y-4">
                            <label className="text-xs text-text-secondary">
                                标题
                                <input
                                    className="mt-1 w-full bg-surface-secondary border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-accent-primary"
                                    value={sampleForm.title}
                                    onChange={(event) => setSampleForm({ ...sampleForm, title: event.target.value })}
                                />
                            </label>
                            <label className="text-xs text-text-secondary">
                                正文内容
                                <textarea
                                    className="mt-1 w-full min-h-[140px] bg-surface-secondary border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-accent-primary"
                                    value={sampleForm.content}
                                    onChange={(event) => setSampleForm({ ...sampleForm, content: event.target.value })}
                                />
                            </label>
                            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                                <label className="text-xs text-text-secondary">
                                    标签（逗号分隔）
                                    <input
                                        className="mt-1 w-full bg-surface-secondary border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-accent-primary"
                                        value={sampleForm.tags}
                                        onChange={(event) => setSampleForm({ ...sampleForm, tags: event.target.value })}
                                    />
                                </label>
                                <label className="text-xs text-text-secondary">
                                    平台
                                    <input
                                        className="mt-1 w-full bg-surface-secondary border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-accent-primary"
                                        value={sampleForm.platform}
                                        onChange={(event) => setSampleForm({ ...sampleForm, platform: event.target.value })}
                                    />
                                </label>
                                <label className="text-xs text-text-secondary">
                                    日期
                                    <input
                                        type="date"
                                        className="mt-1 w-full bg-surface-secondary border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-accent-primary"
                                        value={sampleForm.sampleDate}
                                        onChange={(event) => setSampleForm({ ...sampleForm, sampleDate: event.target.value })}
                                    />
                                </label>
                            </div>
                            <label className="flex items-center gap-2 text-xs text-text-secondary">
                                <input
                                    type="checkbox"
                                    checked={sampleForm.isFeatured}
                                    onChange={(event) => setSampleForm({ ...sampleForm, isFeatured: event.target.checked })}
                                />
                                设为代表作
                            </label>
                        </div>

                        <div className="px-6 py-4 bg-surface-secondary border-t border-border flex items-center justify-end gap-3">
                            <button
                                onClick={() => setIsSampleModalOpen(false)}
                                className="px-4 py-2 text-sm text-text-secondary hover:text-text-primary border border-border rounded-lg transition-colors"
                            >
                                取消
                            </button>
                            <button
                                onClick={saveSample}
                                className="px-4 py-2 text-sm text-white bg-accent-primary hover:bg-accent-primary/90 rounded-lg transition-colors"
                            >
                                <Check className="w-4 h-4 inline-block mr-1" />
                                保存
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
