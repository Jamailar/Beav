import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertCircle, ArrowLeft, CheckCircle2, Loader2, Send, UserRound, Video, Volume2, Wand2 } from 'lucide-react';

type DigitalHumanStage = 'idle' | 'uploading-video' | 'tts' | 'uploading-audio' | 'retalk' | 'completed' | 'failed';

interface DigitalHumanChatProps {
  isActive?: boolean;
  onReturnHome?: () => void;
  onOpenAssets?: () => void;
}

interface SubjectCategoryRecord {
  id: string;
  name: string;
}

interface DigitalHumanMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  stage?: DigitalHumanStage;
  audioUrl?: string;
  videoUrl?: string;
  jobId?: string;
  error?: string;
}

interface RoleReadiness {
  ok: boolean;
  voiceId?: string;
  videoPath?: string;
  issues: string[];
}

function createId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function firstString(...values: unknown[]): string {
  for (const value of values) {
    const normalized = asString(value);
    if (normalized) return normalized;
  }
  return '';
}

function isHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value.trim());
}

function fileUrlToPath(value: string): string {
  if (!value.startsWith('file://')) return value;
  try {
    return decodeURIComponent(new URL(value).pathname);
  } catch {
    return value.replace(/^file:\/\//, '');
  }
}

function extractVoiceId(subject: SubjectRecord | null): string {
  if (!subject) return '';
  const voice = asRecord(subject.voice);
  const attributes = Array.isArray(subject.attributes) ? subject.attributes : [];
  const attributeVoice = attributes.find((item) => {
    const key = String(item?.key || '').trim().toLowerCase();
    return key === 'voice_id' || key === 'voiceid' || key === '声音id';
  });
  return firstString(
    voice.voiceId,
    voice.voice_id,
    voice.id,
    attributeVoice?.value,
  );
}

function extractVideoPath(subject: SubjectRecord | null): string {
  if (!subject) return '';
  return firstString(
    subject.absoluteVideoPath,
    subject.videoPath,
    fileUrlToPath(asString(subject.videoPreviewUrl)),
  );
}

function roleReadiness(subject: SubjectRecord | null): RoleReadiness {
  if (!subject) {
    return { ok: false, issues: ['请选择角色'] };
  }
  const voiceId = extractVoiceId(subject);
  const videoPath = extractVideoPath(subject);
  const issues: string[] = [];
  if (!voiceId) issues.push('角色缺少声音 ID');
  if (!videoPath) issues.push('角色缺少参考视频');
  return {
    ok: issues.length === 0,
    voiceId,
    videoPath,
    issues,
  };
}

function extractFinalAudio(value: Record<string, unknown>): Record<string, unknown> {
  return asRecord(value.finalAudio);
}

function extractVideoUrl(value: unknown): string {
  const root = asRecord(value);
  const direct = firstString(root.videoUrl, root.previewUrl, root.url, root.outputUrl, root.output_url);
  if (isHttpUrl(direct) || direct.startsWith('redbox-asset://')) return direct;
  const artifacts = Array.isArray(root.artifacts) ? root.artifacts : [];
  for (let index = artifacts.length - 1; index >= 0; index -= 1) {
    const artifact = asRecord(artifacts[index]);
    const kind = String(artifact.kind || '').toLowerCase();
    if (kind && kind !== 'video') continue;
    const metadata = asRecord(artifact.metadata);
    const asset = asRecord(metadata.asset || metadata);
    const candidate = firstString(artifact.previewUrl, artifact.absolutePath, asset.previewUrl, asset.absolutePath);
    if (candidate) return candidate;
  }
  return '';
}

function stageLabel(stage?: DigitalHumanStage): string {
  switch (stage) {
    case 'uploading-video':
      return '上传参考视频';
    case 'tts':
      return '生成声音';
    case 'uploading-audio':
      return '上传声音';
    case 'retalk':
      return '生成视频';
    case 'completed':
      return '已完成';
    case 'failed':
      return '失败';
    default:
      return '';
  }
}

export function DigitalHumanChat({ isActive = true, onReturnHome, onOpenAssets }: DigitalHumanChatProps) {
  const [subjects, setSubjects] = useState<SubjectRecord[]>([]);
  const [categories, setCategories] = useState<SubjectCategoryRecord[]>([]);
  const [selectedRoleId, setSelectedRoleId] = useState('');
  const [draft, setDraft] = useState('');
  const [messages, setMessages] = useState<DigitalHumanMessage[]>([]);
  const [loadingRoles, setLoadingRoles] = useState(false);
  const [roleError, setRoleError] = useState('');
  const [busy, setBusy] = useState(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const uploadCacheRef = useRef(new Map<string, string>());

  const loadRoles = useCallback(async () => {
    setLoadingRoles(true);
    setRoleError('');
    try {
      const [subjectResult, categoryResult] = await Promise.all([
        window.ipcRenderer.subjects.list({ limit: 500 }),
        window.ipcRenderer.subjects.categories.list(),
      ]);
      if (subjectResult?.success === false) throw new Error(subjectResult.error || '加载角色失败');
      if (categoryResult?.success === false) throw new Error(categoryResult.error || '加载角色分类失败');
      const nextSubjects = Array.isArray(subjectResult?.subjects) ? subjectResult.subjects : [];
      const nextCategories = Array.isArray(categoryResult?.categories) ? categoryResult.categories as SubjectCategoryRecord[] : [];
      setSubjects(nextSubjects);
      setCategories(nextCategories);
      setSelectedRoleId((current) => current || nextSubjects[0]?.id || '');
    } catch (error) {
      setRoleError(error instanceof Error ? error.message : String(error));
    } finally {
      setLoadingRoles(false);
    }
  }, []);

  useEffect(() => {
    if (!isActive) return;
    void loadRoles();
  }, [isActive, loadRoles]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages]);

  const roleCategoryIds = useMemo(() => {
    return new Set(categories
      .filter((category) => /角色|人物|数字人|role|character|avatar/i.test(category.name || ''))
      .map((category) => category.id));
  }, [categories]);

  const roles = useMemo(() => {
    const categorized = roleCategoryIds.size > 0
      ? subjects.filter((subject) => subject.categoryId && roleCategoryIds.has(subject.categoryId))
      : subjects;
    return categorized.filter((subject) => {
      const readiness = roleReadiness(subject);
      return readiness.voiceId || readiness.videoPath || roleCategoryIds.size > 0;
    });
  }, [roleCategoryIds, subjects]);

  const selectedRole = useMemo(
    () => roles.find((role) => role.id === selectedRoleId) || roles[0] || null,
    [roles, selectedRoleId],
  );
  const readiness = useMemo(() => roleReadiness(selectedRole), [selectedRole]);
  const canSend = Boolean(draft.trim()) && readiness.ok && !busy;

  const updateMessage = useCallback((id: string, patch: Partial<DigitalHumanMessage>) => {
    setMessages((items) => items.map((item) => item.id === id ? { ...item, ...patch } : item));
  }, []);

  const uploadMedia = useCallback(async (path: string, contentType: string, keyPrefix: string) => {
    if (isHttpUrl(path)) return path;
    const normalizedPath = fileUrlToPath(path);
    const cacheKey = `${keyPrefix}:${normalizedPath}`;
    const cached = uploadCacheRef.current.get(cacheKey);
    if (cached) return cached;
    const result = await window.ipcRenderer.generation.uploadTempFile({
      path: normalizedPath,
      contentType,
      keyPrefix,
    });
    if (result?.success === false || !result?.fileUrl) {
      throw new Error(result?.error || '上传媒体失败');
    }
    uploadCacheRef.current.set(cacheKey, result.fileUrl);
    return result.fileUrl;
  }, []);

  const submit = useCallback(async () => {
    const text = draft.trim();
    if (!text || !selectedRole || busy) return;
    const currentReadiness = roleReadiness(selectedRole);
    if (!currentReadiness.ok) return;

    const userMessage: DigitalHumanMessage = {
      id: createId('dh-user'),
      role: 'user',
      text,
    };
    const assistantId = createId('dh-assistant');
    const assistantMessage: DigitalHumanMessage = {
      id: assistantId,
      role: 'assistant',
      text: `${selectedRole.name} 正在准备数字人口播`,
      stage: 'uploading-video',
    };
    setMessages((items) => [...items, userMessage, assistantMessage]);
    setDraft('');
    setBusy(true);

    try {
      const preparedVideo = await window.ipcRenderer.generation.prepareVideoRetalkSource({
        path: currentReadiness.videoPath,
      });
      if (preparedVideo?.success === false || !preparedVideo?.path) {
        throw new Error(preparedVideo?.error || '参考视频不符合数字人生成要求');
      }
      const preparedVideoPath = String(preparedVideo.path);
      if (preparedVideo.normalized) {
        updateMessage(assistantId, { text: '已调整参考视频尺寸，正在上传' });
      }
      const videoUrl = await uploadMedia(preparedVideoPath, 'video/mp4', 'ai/digital-human/video');
      updateMessage(assistantId, { stage: 'tts', text: '正在生成角色声音' });
      const voiceResult = await window.ipcRenderer.voice.speech({
        input: text,
        text,
        voiceId: currentReadiness.voiceId,
        waitForCompletion: true,
        title: `${selectedRole.name} 数字人口播声音`,
        metadata: {
          surface: 'digital-human',
          subjectId: selectedRole.id,
        },
      });
      if (voiceResult?.success === false) {
        throw new Error(asString(voiceResult.error) || '声音生成失败');
      }
      const finalAudio = extractFinalAudio(voiceResult);
      const audioPath = firstString(finalAudio.path, asRecord(finalAudio.asset).absolutePath, finalAudio.previewUrl);
      if (!audioPath) {
        throw new Error('声音生成完成，但没有返回可上传的音频文件');
      }

      updateMessage(assistantId, {
        stage: 'uploading-audio',
        text: '正在上传角色声音',
        audioUrl: firstString(finalAudio.previewUrl, finalAudio.path),
      });
      const audioUrl = await uploadMedia(audioPath, firstString(finalAudio.mimeType) || 'audio/wav', 'ai/digital-human/audio');

      updateMessage(assistantId, { stage: 'retalk', text: '正在生成数字人视频' });
      const submitResult = await window.ipcRenderer.generation.submitVideo({
        model: 'videoretalk',
        generationMode: 'video-retalk',
        title: `${selectedRole.name} 数字人口播`,
        prompt: text,
        input: {
          video_url: videoUrl,
          audio_url: audioUrl,
        },
        parameters: {
          video_extension: false,
        },
        durationSeconds: 8,
        resolution: '720p',
        metadata: {
          surface: 'digital-human',
          subjectId: selectedRole.id,
        },
      });
      if (submitResult?.success === false || !submitResult?.jobId) {
        throw new Error(submitResult?.error || 'VideoRetalk 任务提交失败');
      }
      updateMessage(assistantId, {
        jobId: submitResult.jobId,
        text: '正在等待数字人视频生成',
      });
      const completed = await window.ipcRenderer.generation.awaitJob({
        jobId: submitResult.jobId,
        timeoutMs: 30 * 60 * 1000,
      });
      const status = String(completed?.status || '').toLowerCase();
      if (status !== 'completed' && status !== 'succeeded' && status !== 'success') {
        throw new Error(firstString(asRecord(completed).error, asRecord(completed).message) || '数字人视频生成失败');
      }
      updateMessage(assistantId, {
        stage: 'completed',
        text: '数字人视频已生成',
        audioUrl: firstString(finalAudio.previewUrl, finalAudio.path),
        videoUrl: extractVideoUrl(completed),
      });
    } catch (error) {
      updateMessage(assistantId, {
        stage: 'failed',
        text: '数字人生成失败',
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setBusy(false);
    }
  }, [busy, draft, selectedRole, updateMessage, uploadMedia]);

  return (
    <main className="flex h-full min-h-0 flex-col bg-surface-secondary">
      <header className="flex shrink-0 items-center justify-between border-b border-border bg-surface-primary px-5 py-3">
        <div className="flex min-w-0 items-center gap-3">
          <button
            type="button"
            onClick={onReturnHome}
            className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-border text-text-secondary hover:bg-surface-secondary hover:text-text-primary"
            title="返回首页"
            aria-label="返回首页"
          >
            <ArrowLeft className="h-4 w-4" strokeWidth={1.8} />
          </button>
          <div className="min-w-0">
            <h1 className="truncate text-[16px] font-semibold text-text-primary">数字人</h1>
            <p className="mt-0.5 truncate text-[12px] text-text-tertiary">选择角色后输入文案</p>
          </div>
        </div>
        <button
          type="button"
          onClick={onOpenAssets}
          className="inline-flex h-9 items-center gap-2 rounded-lg border border-border px-3 text-[13px] text-text-secondary hover:bg-surface-secondary hover:text-text-primary"
        >
          <UserRound className="h-4 w-4" strokeWidth={1.8} />
          资产库
        </button>
      </header>

      <div className="grid min-h-0 flex-1 grid-cols-[300px_minmax(0,1fr)]">
        <aside className="min-h-0 border-r border-border bg-surface-primary p-4">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-[13px] font-semibold text-text-primary">角色</h2>
            {loadingRoles && <Loader2 className="h-4 w-4 animate-spin text-text-tertiary" />}
          </div>
          {roleError && (
            <div className="mb-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-[12px] leading-5 text-red-700">
              {roleError}
            </div>
          )}
          <div className="space-y-2 overflow-y-auto">
            {roles.map((role) => {
              const itemReadiness = roleReadiness(role);
              const active = selectedRole?.id === role.id;
              return (
                <button
                  key={role.id}
                  type="button"
                  onClick={() => setSelectedRoleId(role.id)}
                  className={`w-full rounded-lg border px-3 py-3 text-left transition ${
                    active
                      ? 'border-accent-primary bg-accent-primary/5'
                      : 'border-border bg-surface-primary hover:bg-surface-secondary'
                  }`}
                >
                  <div className="flex items-center gap-3">
                    <div className="h-10 w-10 overflow-hidden rounded-lg bg-surface-secondary">
                      {role.primaryPreviewUrl ? (
                        <img src={role.primaryPreviewUrl} alt="" className="h-full w-full object-cover" />
                      ) : (
                        <div className="flex h-full w-full items-center justify-center text-text-tertiary">
                          <UserRound className="h-5 w-5" strokeWidth={1.8} />
                        </div>
                      )}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[13px] font-semibold text-text-primary">{role.name}</div>
                      <div className={`mt-1 flex items-center gap-1.5 text-[11px] ${itemReadiness.ok ? 'text-emerald-700' : 'text-amber-700'}`}>
                        {itemReadiness.ok ? <CheckCircle2 className="h-3.5 w-3.5" /> : <AlertCircle className="h-3.5 w-3.5" />}
                        <span className="truncate">{itemReadiness.ok ? '可用' : itemReadiness.issues.join('、')}</span>
                      </div>
                    </div>
                  </div>
                </button>
              );
            })}
            {!loadingRoles && roles.length === 0 && (
              <div className="rounded-lg border border-dashed border-border px-3 py-4 text-center text-[12px] leading-5 text-text-tertiary">
                还没有可用角色
              </div>
            )}
          </div>
        </aside>

        <section className="flex min-h-0 flex-col">
          <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
            {messages.length === 0 ? (
              <div className="flex h-full items-center justify-center">
                <div className="max-w-[420px] text-center">
                  <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-xl bg-accent-primary/10 text-accent-primary">
                    <Wand2 className="h-6 w-6" strokeWidth={1.8} />
                  </div>
                  <div className="mt-4 text-[15px] font-semibold text-text-primary">输入文案，生成角色口播视频</div>
                  <div className="mt-2 text-[13px] leading-6 text-text-tertiary">角色需要同时具备声音 ID 和参考视频。</div>
                </div>
              </div>
            ) : (
              <div className="mx-auto flex max-w-[820px] flex-col gap-4">
                {messages.map((message) => {
                  const assistant = message.role === 'assistant';
                  return (
                    <div key={message.id} className={`flex ${assistant ? 'justify-start' : 'justify-end'}`}>
                      <div className={`max-w-[78%] rounded-2xl px-4 py-3 shadow-sm ${
                        assistant ? 'border border-border bg-surface-primary' : 'bg-accent-primary text-white'
                      }`}>
                        <div className={`whitespace-pre-wrap text-[14px] leading-6 ${assistant ? 'text-text-primary' : 'text-white'}`}>
                          {message.text}
                        </div>
                        {assistant && message.stage && message.stage !== 'completed' && message.stage !== 'failed' && (
                          <div className="mt-2 inline-flex items-center gap-2 text-[12px] text-text-tertiary">
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            {stageLabel(message.stage)}
                          </div>
                        )}
                        {message.error && (
                          <div className="mt-2 rounded-lg bg-red-50 px-3 py-2 text-[12px] leading-5 text-red-700">
                            {message.error}
                          </div>
                        )}
                        {message.audioUrl && (
                          <div className="mt-3">
                            <div className="mb-1 flex items-center gap-1.5 text-[12px] text-text-tertiary">
                              <Volume2 className="h-3.5 w-3.5" />
                              声音
                            </div>
                            <audio src={message.audioUrl} controls className="h-9 w-full" />
                          </div>
                        )}
                        {message.videoUrl && (
                          <div className="mt-3">
                            <div className="mb-1 flex items-center gap-1.5 text-[12px] text-text-tertiary">
                              <Video className="h-3.5 w-3.5" />
                              视频
                            </div>
                            <video src={message.videoUrl} controls className="max-h-[360px] w-full rounded-lg bg-black" />
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          <footer className="shrink-0 border-t border-border bg-surface-primary px-6 py-4">
            <div className="mx-auto max-w-[820px]">
              {selectedRole && !readiness.ok && (
                <div className="mb-3 inline-flex max-w-full items-center gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[12px] text-amber-800">
                  <AlertCircle className="h-4 w-4 shrink-0" />
                  <span className="truncate">{readiness.issues.join('、')}</span>
                </div>
              )}
              <div className="flex items-end gap-3">
                <textarea
                  value={draft}
                  onChange={(event) => setDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                      event.preventDefault();
                      void submit();
                    }
                  }}
                  placeholder={selectedRole ? `让 ${selectedRole.name} 说点什么` : '先选择角色'}
                  className="min-h-[48px] flex-1 resize-none rounded-xl border border-border bg-surface-secondary px-4 py-3 text-[14px] leading-6 text-text-primary outline-none transition focus:border-accent-primary focus:bg-surface-primary"
                  rows={2}
                  disabled={!selectedRole || busy}
                />
                <button
                  type="button"
                  onClick={() => void submit()}
                  disabled={!canSend}
                  className="inline-flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-accent-primary text-white shadow-sm transition hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-45"
                  title="发送"
                  aria-label="发送"
                >
                  {busy ? <Loader2 className="h-5 w-5 animate-spin" /> : <Send className="h-5 w-5" strokeWidth={1.8} />}
                </button>
              </div>
            </div>
          </footer>
        </section>
      </div>
    </main>
  );
}
