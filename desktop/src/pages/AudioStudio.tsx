import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { AlertCircle, CheckCircle2, Clock3, Loader2, Mic2, PlayCircle, RefreshCw, RotateCcw, Send, SlidersHorizontal, Sparkles, UserRound, X, XCircle } from 'lucide-react';
import { clsx } from 'clsx';
import { useMediaJobSubscription } from '../features/media-jobs/useMediaJobSubscription';
import { useMediaJobsStore } from '../features/media-jobs/useMediaJobsStore';
import { isMediaJobSuccessful, isMediaJobTerminal, type MediaJobProjection } from '../features/media-jobs/types';
import { SelectMenu, type SelectMenuOption } from '../components/ui/SelectMenu';

type AudioStudioProps = {
    isActive?: boolean;
    onReturnHome?: () => void;
};

type VoiceOption = {
    id: string;
    label: string;
    detail: string;
    source: 'asset' | 'voice';
};

type SubjectRecord = {
    id: string;
    name: string;
    voice?: Record<string, unknown>;
};

type SettingsShape = {
    voice_tts_model?: string;
    tts_model?: string;
};

const AUDIO_JOB_FILTER = { kind: 'audio' as const, source: 'audio_studio', limit: 50 };
const MANUAL_VOICE_VALUE = '__manual_voice_id__';
const LANGUAGE_OPTIONS = [
    { value: '', label: '自动' },
    { value: 'Chinese', label: '中文' },
    { value: 'English', label: '英文' },
    { value: 'Japanese', label: '日文' },
    { value: 'Korean', label: '韩文' },
];
const FORMAT_OPTIONS: SelectMenuOption[] = [
    { value: 'mp3', label: 'MP3', description: '体积小，适合发布' },
    { value: 'wav', label: 'WAV', description: '无压缩，适合后期' },
];

function stringValue(value: unknown): string {
    return typeof value === 'string' ? value.trim() : '';
}

function shortId(value: string): string {
    if (value.length <= 22) return value;
    return `${value.slice(0, 12)}...${value.slice(-6)}`;
}

function collectVoiceRecords(value: unknown): Record<string, unknown>[] {
    if (!value || typeof value !== 'object') return [];
    if (Array.isArray(value)) {
        return value.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === 'object' && !Array.isArray(item)));
    }
    const raw = value as Record<string, unknown>;
    for (const key of ['voices', 'items', 'data', 'results']) {
        const nested = raw[key];
        if (Array.isArray(nested)) return collectVoiceRecords(nested);
    }
    return [];
}

function voiceIdFromRecord(record: Record<string, unknown>): string {
    return stringValue(record.voiceId) || stringValue(record.voice_id) || stringValue(record.id);
}

function normalizeVoiceOptions(result: unknown): VoiceOption[] {
    if (!result || typeof result !== 'object') return [];
    const raw = result as Record<string, unknown>;
    return collectVoiceRecords(raw.voices ?? raw)
        .map((record): VoiceOption | null => {
            const id = voiceIdFromRecord(record);
            if (!id) return null;
            const name = stringValue(record.name) || stringValue(record.voiceName) || id;
            const language = stringValue(record.language);
            return {
                id,
                label: name,
                detail: language ? `${language} · ${shortId(id)}` : shortId(id),
                source: 'voice',
            };
        })
        .filter((item): item is VoiceOption => Boolean(item));
}

function subjectVoiceId(subject: SubjectRecord): string {
    const voice = subject.voice || {};
    return stringValue(voice.voiceId) || stringValue(voice.voice_id);
}

function audioUrlFromJob(job: MediaJobProjection): string {
    const artifact = job.artifacts.find((item) => item.kind === 'audio') || job.artifacts[0];
    const artifactAsset = artifact?.metadata?.asset;
    const resultAsset = job.result?.asset;
    if (resultAsset && typeof resultAsset === 'object') {
        const previewUrl = stringValue((resultAsset as Record<string, unknown>).previewUrl);
        if (previewUrl) return previewUrl;
    }
    if (artifactAsset && typeof artifactAsset === 'object') {
        const previewUrl = stringValue((artifactAsset as Record<string, unknown>).previewUrl);
        if (previewUrl) return previewUrl;
    }
    return stringValue(artifact?.previewUrl);
}

function jobTitle(job: MediaJobProjection): string {
    const request = job.request || {};
    return stringValue(request.title) || stringValue(request.input).slice(0, 32) || '声音合成';
}

function jobStatusLabel(job: MediaJobProjection): string {
    if (isMediaJobSuccessful(job.status)) return '已完成';
    if (job.status === 'failed' || job.status === 'dead_lettered') return '失败';
    if (job.status === 'cancelled') return '已取消';
    if (job.status === 'queued' || job.status === 'accepted') return '排队中';
    return '生成中';
}

function formatDate(value: string): string {
    const timestamp = Date.parse(value);
    if (!Number.isFinite(timestamp)) return '';
    return new Date(timestamp).toLocaleString(undefined, {
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
    });
}

export function AudioStudio({ isActive = true, onReturnHome }: AudioStudioProps) {
    const [text, setText] = useState('');
    const [voiceId, setVoiceId] = useState('');
    const [model, setModel] = useState('');
    const [languageBoost, setLanguageBoost] = useState('Chinese');
    const [responseFormat, setResponseFormat] = useState('mp3');
    const [voiceOptions, setVoiceOptions] = useState<VoiceOption[]>([]);
    const [loadingContext, setLoadingContext] = useState(false);
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState('');
    const [activeJobId, setActiveJobId] = useState<string | null>(null);
    const loadedOnceRef = useRef(false);
    const jobsById = useMediaJobsStore((state) => state.jobsById);

    useMediaJobSubscription(activeJobId ? [activeJobId] : [], {
        enabled: isActive,
        bootstrapFilter: AUDIO_JOB_FILTER,
    });

    const audioJobs = useMemo(() => (
        Object.values(jobsById)
            .filter((job) => job.kind === 'audio' && job.source === 'audio_studio')
            .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
    ), [jobsById]);

    const activeJob = activeJobId ? jobsById[activeJobId] || null : null;
    const selectedVoiceOption = useMemo(
        () => voiceOptions.find((option) => option.id === voiceId) || null,
        [voiceId, voiceOptions],
    );
    const voiceSelectOptions = useMemo<SelectMenuOption[]>(() => [
        { value: MANUAL_VOICE_VALUE, label: '手动填写 voice_id', description: '直接使用平台音色 ID' },
        ...voiceOptions.map((option) => ({
            value: option.id,
            label: option.source === 'asset' ? `资产库 · ${option.label}` : option.label,
            description: option.detail,
        })),
    ], [voiceOptions]);
    const languageSelectOptions = useMemo<SelectMenuOption[]>(
        () => LANGUAGE_OPTIONS.map((option) => ({
            value: option.value,
            label: option.label,
        })),
        [],
    );
    const canSubmit = Boolean(text.trim() && voiceId.trim() && !submitting);

    const loadContext = useCallback(async () => {
        setLoadingContext(true);
        setError('');
        try {
            const [settings, voicesResult, subjectsResult] = await Promise.all([
                window.ipcRenderer.getSettings() as Promise<SettingsShape>,
                window.ipcRenderer.voice.list({}).catch((e) => ({ success: false, error: e instanceof Error ? e.message : String(e) })),
                window.ipcRenderer.subjects.list({ limit: 500 }).catch((e) => ({ success: false, error: e instanceof Error ? e.message : String(e), subjects: [] })),
            ]);
            const subjectOptions = Array.isArray(subjectsResult?.subjects)
                ? subjectsResult.subjects
                    .map((subject: SubjectRecord) => {
                        const id = subjectVoiceId(subject);
                        if (!id) return null;
                        return {
                            id,
                            label: subject.name || '角色声音',
                            detail: `资产库 · ${shortId(id)}`,
                            source: 'asset' as const,
                        };
                    })
                    .filter((item): item is VoiceOption => Boolean(item))
                : [];
            const remoteOptions = normalizeVoiceOptions(voicesResult);
            const deduped = new Map<string, VoiceOption>();
            [...subjectOptions, ...remoteOptions].forEach((option) => {
                if (!deduped.has(option.id)) deduped.set(option.id, option);
            });
            const nextOptions = Array.from(deduped.values());
            setVoiceOptions(nextOptions);
            setModel((current) => current || settings?.voice_tts_model || settings?.tts_model || 'speech-2.8-turbo');
            setVoiceId((current) => current || nextOptions[0]?.id || '');
        } catch (e) {
            setError(e instanceof Error ? e.message : '加载声音配置失败');
        } finally {
            setLoadingContext(false);
            loadedOnceRef.current = true;
        }
    }, []);

    useEffect(() => {
        if (!isActive || loadedOnceRef.current) return;
        void loadContext();
    }, [isActive, loadContext]);

    const submit = useCallback(async () => {
        const input = text.trim();
        const selectedVoiceId = voiceId.trim();
        if (!input) {
            setError('请输入要合成的文本');
            return;
        }
        if (!selectedVoiceId) {
            setError('请选择或填写 voice_id');
            return;
        }
        setSubmitting(true);
        setError('');
        try {
            const result = await window.ipcRenderer.generation.submitAudio({
                source: 'audio_studio',
                input,
                title: input.slice(0, 24) || '声音合成',
                voiceId: selectedVoiceId,
                voice_id: selectedVoiceId,
                model: model.trim() || undefined,
                languageBoost: languageBoost || undefined,
                responseFormat,
                returnAudioBinary: true,
            }) as { success?: boolean; error?: string; jobId?: string };
            if (!result?.success || !result.jobId) {
                throw new Error(result?.error || '提交声音合成失败');
            }
            setActiveJobId(result.jobId);
        } catch (e) {
            setError(e instanceof Error ? e.message : '提交声音合成失败');
        } finally {
            setSubmitting(false);
        }
    }, [languageBoost, model, responseFormat, text, voiceId]);

    const retryJob = useCallback(async (jobId: string) => {
        setError('');
        try {
            const result = await window.ipcRenderer.generation.retryJob(jobId);
            if (!result?.success) throw new Error(result?.error || '重试失败');
            setActiveJobId(result.jobId || jobId);
        } catch (e) {
            setError(e instanceof Error ? e.message : '重试失败');
        }
    }, []);

    const cancelJob = useCallback(async (jobId: string) => {
        setError('');
        try {
            const result = await window.ipcRenderer.generation.cancelJob(jobId);
            if (!result?.success) throw new Error(result?.error || '取消失败');
        } catch (e) {
            setError(e instanceof Error ? e.message : '取消失败');
        }
    }, []);

    const handleEditorKeyDown = useCallback((event: KeyboardEvent<HTMLTextAreaElement>) => {
        if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
            event.preventDefault();
            if (canSubmit) void submit();
        }
    }, [canSubmit, submit]);

    return (
        <div className="flex h-full min-h-0 flex-col bg-[#f7f7f4]">
            <header className="shrink-0 border-b border-border/70 bg-surface-primary/95 px-6 py-4">
                <div className="mx-auto flex w-full max-w-[1220px] items-center justify-between gap-4">
                    <div className="flex min-w-0 items-center gap-3">
                        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-[#111827] text-white shadow-sm">
                            <Mic2 className="h-5 w-5" strokeWidth={1.9} />
                        </div>
                        <div className="min-w-0">
                            <h1 className="truncate text-[18px] font-semibold text-text-primary">生音频</h1>
                            <div className="mt-1 flex flex-wrap items-center gap-2 text-[12px] text-text-tertiary">
                                <span className="inline-flex items-center gap-1 rounded-full bg-surface-secondary px-2 py-0.5">
                                    <Sparkles className="h-3 w-3" />
                                    TTS
                                </span>
                                <span>{voiceOptions.length} 个可用音色</span>
                                <span>{audioJobs.length} 个音频任务</span>
                            </div>
                        </div>
                    </div>
                    <div className="flex items-center gap-2">
                        <button
                            type="button"
                            onClick={() => void loadContext()}
                            className="inline-flex h-9 items-center gap-2 rounded-xl border border-border bg-surface-primary px-3 text-[12px] font-semibold text-text-secondary transition hover:bg-surface-secondary hover:text-text-primary"
                        >
                            {loadingContext ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
                            刷新音色
                        </button>
                        {onReturnHome && (
                            <button
                                type="button"
                                onClick={onReturnHome}
                                className="h-9 rounded-xl border border-border bg-surface-primary px-3 text-[12px] font-semibold text-text-secondary transition hover:bg-surface-secondary hover:text-text-primary"
                            >
                                返回
                            </button>
                        )}
                    </div>
                </div>
            </header>

            <main className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
                <div className="mx-auto grid w-full max-w-[1220px] gap-5 xl:grid-cols-[minmax(0,1fr)_360px]">
                    <section className="min-w-0 overflow-hidden rounded-[22px] border border-border bg-surface-primary shadow-[var(--ui-shadow-1)]">
                        <div className="flex items-center justify-between gap-3 border-b border-border/70 px-5 py-4">
                            <div className="min-w-0">
                                <h2 className="text-[15px] font-semibold text-text-primary">脚本</h2>
                                <p className="mt-0.5 text-[12px] text-text-tertiary">写旁白、台词或口播稿</p>
                            </div>
                            {text && (
                                <button
                                    type="button"
                                    onClick={() => setText('')}
                                    className="inline-flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-[12px] font-medium text-text-tertiary transition hover:bg-surface-secondary hover:text-text-primary"
                                >
                                    <X className="h-3.5 w-3.5" />
                                    清空
                                </button>
                            )}
                        </div>
                        <div className="p-4">
                            <textarea
                                value={text}
                                onChange={(event) => setText(event.target.value)}
                                onKeyDown={handleEditorKeyDown}
                                placeholder="输入要合成的旁白、台词或口播文本..."
                                className="min-h-[360px] w-full resize-y rounded-2xl border border-transparent bg-[#fbfaf7] px-5 py-4 text-[15px] leading-8 text-text-primary outline-none transition placeholder:text-text-tertiary focus:border-accent-primary/35 focus:bg-white focus:ring-4 focus:ring-accent-primary/10"
                            />
                        </div>
                        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border/70 bg-surface-secondary/40 px-5 py-3">
                            <div className="flex items-center gap-3 text-[12px] text-text-tertiary">
                                <span>{text.trim().length} 字</span>
                                <span>⌘/Ctrl + Enter 生成</span>
                            </div>
                            {error && (
                                <div className="flex min-w-0 items-center gap-2 rounded-lg border border-red-200 bg-red-50 px-2.5 py-1.5 text-[12px] text-red-700">
                                    <AlertCircle className="h-3.5 w-3.5 shrink-0" />
                                    <span className="truncate">{error}</span>
                                </div>
                            )}
                        </div>
                    </section>

                    <aside className="space-y-4 xl:sticky xl:top-5 xl:self-start">
                        <section className="overflow-hidden rounded-[22px] border border-border bg-surface-primary shadow-[var(--ui-shadow-1)]">
                            <div className="flex items-center justify-between border-b border-border/70 px-4 py-3.5">
                                <div className="flex items-center gap-2">
                                    <UserRound className="h-4 w-4 text-text-tertiary" />
                                    <h2 className="text-[14px] font-semibold text-text-primary">音色</h2>
                                </div>
                                {selectedVoiceOption && (
                                    <span className="rounded-full bg-emerald-500/10 px-2 py-0.5 text-[11px] font-semibold text-emerald-700">
                                        {selectedVoiceOption.source === 'asset' ? '资产库' : '音色库'}
                                    </span>
                                )}
                            </div>
                            <div className="space-y-3 p-4">
                                <div className="rounded-2xl border border-border bg-[#fbfaf7] p-3">
                                    <div className="flex items-center gap-3">
                                        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-amber-500/10 text-amber-700">
                                            <Mic2 className="h-5 w-5" strokeWidth={1.9} />
                                        </div>
                                        <div className="min-w-0 flex-1">
                                            <div className="truncate text-[13px] font-semibold text-text-primary">
                                                {selectedVoiceOption?.label || '手动音色'}
                                            </div>
                                            <div className="mt-0.5 truncate font-mono text-[11px] text-text-tertiary">
                                                {voiceId || 'voice_xxx'}
                                            </div>
                                        </div>
                                    </div>
                                </div>

                                <SelectMenu
                                    value={selectedVoiceOption ? selectedVoiceOption.id : MANUAL_VOICE_VALUE}
                                    onChange={(value) => setVoiceId(value === MANUAL_VOICE_VALUE ? '' : value)}
                                    options={voiceSelectOptions}
                                    placeholder="选择音色"
                                    className="[&>button]:h-10 [&>button]:rounded-xl [&>button]:bg-surface-secondary/60 [&>button]:text-[13px]"
                                    menuClassName="min-w-[320px]"
                                />

                                <label className="block">
                                    <span className="mb-1.5 block text-[12px] font-semibold text-text-secondary">voice_id</span>
                                    <input
                                        value={voiceId}
                                        onChange={(event) => setVoiceId(event.target.value)}
                                        placeholder="voice_xxx"
                                        className="h-10 w-full rounded-xl border border-border bg-surface-secondary/55 px-3 font-mono text-[12px] text-text-primary outline-none transition placeholder:text-text-tertiary focus:border-accent-primary/40 focus:bg-white focus:ring-4 focus:ring-accent-primary/10"
                                    />
                                </label>
                            </div>
                        </section>

                        <section className="overflow-hidden rounded-[22px] border border-border bg-surface-primary shadow-[var(--ui-shadow-1)]">
                            <div className="flex items-center gap-2 border-b border-border/70 px-4 py-3.5">
                                <SlidersHorizontal className="h-4 w-4 text-text-tertiary" />
                                <h2 className="text-[14px] font-semibold text-text-primary">参数</h2>
                            </div>
                            <div className="space-y-3 p-4">
                                <label className="block">
                                    <span className="mb-1.5 block text-[12px] font-semibold text-text-secondary">模型</span>
                                    <input
                                        value={model}
                                        onChange={(event) => setModel(event.target.value)}
                                        placeholder="speech-2.8-turbo"
                                        className="h-10 w-full rounded-xl border border-border bg-surface-secondary/55 px-3 text-[13px] text-text-primary outline-none transition placeholder:text-text-tertiary focus:border-accent-primary/40 focus:bg-white focus:ring-4 focus:ring-accent-primary/10"
                                    />
                                </label>
                                <div className="grid grid-cols-2 gap-3">
                                    <label className="block">
                                        <span className="mb-1.5 block text-[12px] font-semibold text-text-secondary">语言</span>
                                        <SelectMenu
                                            value={languageBoost}
                                            onChange={setLanguageBoost}
                                            options={languageSelectOptions}
                                            className="[&>button]:h-10 [&>button]:rounded-xl [&>button]:bg-surface-secondary/60 [&>button]:text-[13px]"
                                        />
                                    </label>
                                    <label className="block">
                                        <span className="mb-1.5 block text-[12px] font-semibold text-text-secondary">格式</span>
                                        <SelectMenu
                                            value={responseFormat}
                                            onChange={setResponseFormat}
                                            options={FORMAT_OPTIONS}
                                            className="[&>button]:h-10 [&>button]:rounded-xl [&>button]:bg-surface-secondary/60 [&>button]:text-[13px]"
                                        />
                                    </label>
                                </div>
                                <button
                                    type="button"
                                    disabled={!canSubmit}
                                    onClick={() => void submit()}
                                    className={clsx(
                                        'mt-2 inline-flex h-12 w-full items-center justify-center gap-2 rounded-2xl text-[14px] font-semibold text-white shadow-sm transition',
                                        canSubmit
                                            ? 'bg-[#111827] hover:bg-[#0b1220] active:scale-[0.99]'
                                            : 'cursor-not-allowed bg-slate-400',
                                    )}
                                >
                                    {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                                    生成音频
                                </button>
                            </div>
                        </section>

                        {activeJob && (
                            <section className="overflow-hidden rounded-[22px] border border-border bg-surface-primary shadow-[var(--ui-shadow-1)]">
                                <div className="flex items-center gap-2 border-b border-border/70 px-4 py-3.5">
                                    <Clock3 className="h-4 w-4 text-text-tertiary" />
                                    <h2 className="text-[14px] font-semibold text-text-primary">当前任务</h2>
                                </div>
                                <div className="p-3">
                                    <AudioJobCard job={activeJob} onRetry={retryJob} onCancel={cancelJob} featured />
                                </div>
                            </section>
                        )}
                    </aside>

                    <section className="min-w-0 overflow-hidden rounded-[22px] border border-border bg-surface-primary shadow-[var(--ui-shadow-1)] xl:col-span-2">
                        <div className="flex items-center justify-between gap-3 border-b border-border/70 px-5 py-4">
                            <div>
                                <h2 className="text-[15px] font-semibold text-text-primary">音频队列</h2>
                                <p className="mt-0.5 text-[12px] text-text-tertiary">生成结果会进入媒体管线和资产库</p>
                            </div>
                            <span className="rounded-full bg-surface-secondary px-2.5 py-1 text-[12px] font-semibold text-text-secondary">
                                {audioJobs.length}
                            </span>
                        </div>
                        {audioJobs.length === 0 ? (
                            <div className="grid min-h-[180px] place-items-center bg-[#fbfaf7] px-4 py-8 text-center">
                                <div>
                                    <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-surface-primary text-text-tertiary shadow-sm">
                                        <PlayCircle className="h-5 w-5" />
                                    </div>
                                    <div className="mt-3 text-[13px] font-medium text-text-secondary">暂无音频生成任务</div>
                                </div>
                            </div>
                        ) : (
                            <div className="grid gap-3 bg-[#fbfaf7] p-4 md:grid-cols-2">
                                {audioJobs.map((job) => (
                                    <AudioJobCard key={job.jobId} job={job} onRetry={retryJob} onCancel={cancelJob} />
                                ))}
                            </div>
                        )}
                    </section>
                </div>
            </main>
        </div>
    );
}

function AudioJobCard({
    job,
    onRetry,
    onCancel,
    featured = false,
}: {
    job: MediaJobProjection;
    onRetry: (jobId: string) => Promise<void>;
    onCancel: (jobId: string) => Promise<void>;
    featured?: boolean;
}) {
    const audioUrl = audioUrlFromJob(job);
    const failed = isMediaJobTerminal(job.status) && !isMediaJobSuccessful(job.status);
    const running = !isMediaJobTerminal(job.status);

    return (
        <article className={clsx(
            'rounded-2xl border border-border bg-surface-primary p-3 shadow-sm',
            featured && 'bg-[#fbfaf7]',
        )}>
            <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                    <div className="truncate text-[13px] font-semibold text-text-primary">{jobTitle(job)}</div>
                    <div className="mt-1 flex flex-wrap items-center gap-2 text-[12px] text-text-tertiary">
                        {isMediaJobSuccessful(job.status)
                            ? <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" />
                            : failed
                                ? <XCircle className="h-3.5 w-3.5 text-red-600" />
                                : <Loader2 className="h-3.5 w-3.5 animate-spin text-amber-600" />}
                        <span>{jobStatusLabel(job)}</span>
                        <span>{formatDate(job.createdAt)}</span>
                    </div>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                    {failed && (
                        <button
                            type="button"
                            onClick={() => void onRetry(job.jobId)}
                            className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-border bg-surface-primary text-text-secondary hover:bg-surface-secondary hover:text-text-primary"
                            title="重试"
                            aria-label="重试"
                        >
                            <RotateCcw className="h-3.5 w-3.5" />
                        </button>
                    )}
                    {running && (
                        <button
                            type="button"
                            onClick={() => void onCancel(job.jobId)}
                            className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-border bg-surface-primary text-text-secondary hover:bg-surface-secondary hover:text-text-primary"
                            title="取消"
                            aria-label="取消"
                        >
                            <XCircle className="h-3.5 w-3.5" />
                        </button>
                    )}
                </div>
            </div>
            {audioUrl ? (
                <div className="mt-3 flex items-center gap-2">
                    <PlayCircle className="h-4 w-4 shrink-0 text-text-tertiary" />
                    <audio className="h-9 w-full" controls src={audioUrl} />
                </div>
            ) : (
                <div className="mt-3 overflow-hidden rounded-xl border border-dashed border-border bg-surface-secondary/40 px-3 py-2">
                    {failed ? (
                        <div className="text-[12px] text-red-700">{job.attempt?.lastError || '生成失败'}</div>
                    ) : (
                        <div className="flex h-8 items-center gap-1.5">
                            {Array.from({ length: 18 }).map((_, index) => (
                                <span
                                    key={index}
                                    className="w-1 rounded-full bg-text-tertiary/25"
                                    style={{ height: `${8 + (index % 5) * 4}px` }}
                                />
                            ))}
                        </div>
                    )}
                </div>
            )}
        </article>
    );
}
