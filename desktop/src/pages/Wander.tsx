import { useState, useEffect, useRef } from 'react';
import { RefreshCw, Sparkles, History, X, Trash2, PenLine, Dices, Lightbulb, FileText, Play } from 'lucide-react';
import { clsx } from 'clsx';
import { resolveAssetUrl } from '../utils/pathManager';
import type { AuthoringTaskHints } from '../utils/redclawAuthoring';

interface WanderItem {
  id: string;
  type: 'note' | 'video';
  title: string;
  content: string;
  cover?: string;
  meta?: Record<string, unknown>;
}

interface WanderResult {
  content_direction: string;
  thinking_process: string[];
  topic: { title: string; connections: number[] };
  options?: Array<{
    content_direction: string;
    topic: { title: string; connections: number[] };
  }>;
  selected_index?: number;
}

interface WanderHistoryRecord {
  id: string;
  items: string;
  result: string;
  created_at: number;
}

interface WanderProps {
  onNavigateToManuscript?: (filePath: string) => void;
  onNavigateToRedClaw?: (payload: {
    content: string;
    displayContent?: string;
    taskHints?: AuthoringTaskHints;
    attachment?: {
      type: 'wander-references';
      title?: string;
      items: Array<{
        title: string;
        itemType: 'note' | 'video';
        tag?: string;
        folderPath?: string;
        summary?: string;
        cover?: string;
      }>;
    };
  }) => void;
}

export function Wander({ onNavigateToManuscript, onNavigateToRedClaw }: WanderProps) {
  const [items, setItems] = useState<WanderItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [multiChoiceEnabled, setMultiChoiceEnabled] = useState(false);
  const [isSavingMode, setIsSavingMode] = useState(false);
  const [parsedResult, setParsedResult] = useState<WanderResult | null>(null);
  const [selectedOptionIndex, setSelectedOptionIndex] = useState(0);
  const [parseError, setParseError] = useState<string | null>(null);
  const [phase, setPhase] = useState<'idle' | 'running' | 'done'>('idle');
  const [showFinal, setShowFinal] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [historyList, setHistoryList] = useState<WanderHistoryRecord[]>([]);
  const [currentHistoryId, setCurrentHistoryId] = useState<string | null>(null);
  const [liveStatus, setLiveStatus] = useState('');
  const activeRequestIdRef = useRef('');

  const toStableTwoLineText = (raw: string) => {
    const normalized = String(raw || '')
      .replace(/\r\n/g, '\n')
      .replace(/\r/g, '\n')
      .trim();
    if (!normalized) return '';
    const lines = normalized
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    if (!lines.length) return '';
    const picked = lines.slice(0, 2).map((line) => line.length > 120 ? `${line.slice(0, 120)}…` : line);
    const hasMore = lines.length > 2 || normalized.length > picked.join('\n').length;
    const joined = picked.join('\n');
    return hasMore && !joined.endsWith('…') ? `${joined}…` : joined;
  };

  function parseJsonPayload<T>(payload?: string | null): T | null {
    if (!payload) return null;
    const trimmed = payload.trim();
    const stripCodeFence = (text: string) => text
      .replace(/^```json\s*/i, '')
      .replace(/^```\s*/i, '')
      .replace(/```$/i, '')
      .trim();
    const tryParse = (text: string) => {
      try {
        return JSON.parse(text) as T;
      } catch {
        return null;
      }
    };
    const direct = tryParse(trimmed);
    if (direct) return direct;
    const noFence = tryParse(stripCodeFence(trimmed));
    if (noFence) return noFence;
    const normalized = stripCodeFence(trimmed);
    const firstBrace = normalized.indexOf('{');
    const lastBrace = normalized.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
      return tryParse(normalized.slice(firstBrace, lastBrace + 1));
    }
    return null;
  }

  function repairWanderResult(result: WanderResult): WanderResult {
    const embedded = parseJsonPayload<Partial<WanderResult>>(result.content_direction);
    if (!embedded || typeof embedded !== 'object' || !embedded.topic) {
      return result;
    }
    return {
      content_direction: String(embedded.content_direction || result.content_direction || '').trim(),
      thinking_process: Array.isArray(result.thinking_process) && result.thinking_process.length > 0
        ? result.thinking_process
        : (Array.isArray(embedded.thinking_process) ? embedded.thinking_process.map((item) => String(item || '').trim()).filter(Boolean) : []),
      topic: {
        title: String(embedded.topic?.title || result.topic?.title || '未命名选题').trim() || '未命名选题',
        connections: Array.isArray(embedded.topic?.connections)
          ? embedded.topic.connections.map((item) => Number(item)).filter((item) => Number.isFinite(item))
          : (result.topic?.connections || []),
      },
      options: Array.isArray(result.options) && result.options.length > 0
        ? result.options
        : (Array.isArray(embedded.options)
          ? embedded.options.map((option) => ({
              content_direction: String(option?.content_direction || '').trim(),
              topic: {
                title: String(option?.topic?.title || '未命名选题').trim() || '未命名选题',
                connections: Array.isArray(option?.topic?.connections)
                  ? option.topic.connections.map((item) => Number(item)).filter((item) => Number.isFinite(item))
                  : [],
              },
            }))
          : undefined),
      selected_index: Number.isFinite(Number(result.selected_index))
        ? Math.max(0, Number(result.selected_index))
        : (Number.isFinite(Number(embedded.selected_index)) ? Math.max(0, Number(embedded.selected_index)) : 0),
    };
  }

  const buildKnowledgeFolderReference = (item: WanderItem) => {
    const meta = (item.meta || {}) as Record<string, unknown>;
    if (meta.sourceType === 'document') {
      const filePath = String(meta.filePath || '').trim();
      const relativePath = String(meta.relativePath || '').trim();
      const sourceName = String(meta.sourceName || '').trim();
      const sourceKind = String(meta.sourceKind || '').trim();
      return {
        folderName: relativePath || item.id,
        folderPath: filePath || `document://${item.id}`,
        metaPath: filePath || `document://${item.id}`,
        contentHint: `这是文档知识源（${sourceName || sourceKind || 'document'}），请直接读取该文件内容并结合上下文创作。`,
      };
    }

    const sourceRoot = item.type === 'video' ? 'knowledge/youtube' : 'knowledge/redbook';
    const folderName = item.id;
    const folderPath = `${sourceRoot}/${folderName}`;
    return {
      folderName,
      folderPath,
      metaPath: `${folderPath}/meta.json`,
      contentHint: item.type === 'video'
        ? '先读 meta.json，若有 transcriptFile 字段，再读取对应转录文件；否则读取 description'
        : '先读 meta.json，若有 content.md 则继续读取 content.md',
    };
  };

  const buildSuggestedManuscriptPath = (title: string) => {
    const safeName = String(title || 'wander-draft')
      .replace(/[\\/:*?"<>|]+/g, '-')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 80) || 'wander-draft';
    return `wander/${safeName}.md`;
  };

  // 去创作：创建稿件并跳转
  const goCreate = async () => {
    if (!parsedResult || !onNavigateToManuscript) return;
    const selectedOption = parsedResult.options?.[selectedOptionIndex];
    const activeTopic = selectedOption?.topic || parsedResult.topic;
    const activeDirection = selectedOption?.content_direction || parsedResult.content_direction;
    const title = activeTopic.title;
    // 兼容旧字段名 connections 和新字段名 content_direction
    const direction = activeDirection || (parsedResult as any).connections || '';
    const content = `# ${title}\n\n## 内容方向\n\n${direction}\n\n## 正文\n\n`;

    const result = await window.ipcRenderer.invoke('manuscripts:create-file', {
      parentPath: '',
      name: title,
      content
    }) as { success: boolean; path?: string; error?: string };

    if (result.success && result.path) {
      onNavigateToManuscript(result.path);
    } else {
      console.error('Failed to create manuscript:', result.error);
    }
  };

  const startCreateInRedClaw = () => {
    if (!parsedResult || !onNavigateToRedClaw) return;
    const selectedOption = parsedResult.options?.[selectedOptionIndex];
    const activeTopic = selectedOption?.topic || parsedResult.topic;
    const activeDirection = selectedOption?.content_direction || parsedResult.content_direction;
    const suggestedManuscriptPath = buildSuggestedManuscriptPath(activeTopic.title);

    const connectedSet = new Set(activeTopic.connections || []);
    const referenceCards = items.map((item, index) => {
      const folderRef = buildKnowledgeFolderReference(item);
      return {
        title: item.title || '(无标题)',
        itemType: item.type,
        tag: connectedSet.has(index + 1) ? '核心关联素材' : '辅助素材',
        folderPath: folderRef.folderPath,
        summary: String(item.content || '').replace(/\s+/g, ' ').trim().slice(0, 96),
        cover: resolveAssetUrl(item.cover),
      };
    });
    const materialText = items.map((item, index) => {
      const order = index + 1;
      const connectedTag = connectedSet.has(order) ? '核心关联素材' : '辅助素材';
      const folderRef = buildKnowledgeFolderReference(item);
      return [
        `素材${order}（${connectedTag}）`,
        `类型：${item.type === 'video' ? '视频笔记' : ((item.meta as Record<string, unknown> | undefined)?.sourceType === 'document' ? '文档' : '图文笔记')}`,
        `标题：${item.title || '(无标题)'}`,
        `文件夹名：${folderRef.folderName}`,
        `文件夹路径：${folderRef.folderPath}`,
        `必读文件：${folderRef.metaPath}`,
        `读取提示：${folderRef.contentHint}`,
      ].join('\n');
    }).join('\n\n---\n\n');

    const folderListText = items.map((item, index) => {
      const folderRef = buildKnowledgeFolderReference(item);
      return `${index + 1}. ${folderRef.folderPath}`;
    }).join('\n');

    const content = [
      '请基于以下“漫步结果”开始创作一篇完整的小红书文案。',
      '',
      '注意：不要只依赖我在消息里给的摘要。你必须先读取下方3个素材文件夹中的文件，再开始写作。',
      '请优先读取每个素材目录下的 meta.json，并按需要继续读取正文/转录文件。',
      '',
      '## 灵感选题',
      `标题：${activeTopic.title}`,
      `内容方向：${activeDirection || ''}`,
      `建议保存稿件路径：${suggestedManuscriptPath}`,
      '',
      '## 需要先读取的素材文件夹（当前工作空间下）',
      folderListText,
      '',
      '## 参考素材（来自漫步）',
      materialText,
      '',
      '## 输出要求',
      '1. 先给出标题候选（至少5个，含强钩子）。',
      '2. 给出一篇完整正文（可直接发布，结构清晰）。',
      '3. 给出标签建议（8-12个）。',
      '4. 给出封面文案建议（2-3个）。',
      `5. 完成后必须调用 app_cli 将完整稿件保存到 manuscripts。优先使用：app_cli(command="manuscripts write --path \\"${suggestedManuscriptPath}\\"", payload={ content: "...完整 markdown..." })。`,
      '6. 未收到工具成功返回前，禁止告诉我“已经保存”。如果保存失败，必须明确说“内容已生成但尚未保存”。',
      `7. 最终回复里只有在工具成功后才能回显保存路径，并且必须使用工具返回的真实路径；不要只复述建议路径 ${suggestedManuscriptPath}。`,
    ].join('\n');

    onNavigateToRedClaw({
      content,
      displayContent: `基于漫步灵感开始创作：${parsedResult.topic.title}`,
      taskHints: {
        intent: 'manuscript_creation',
      },
      attachment: {
        type: 'wander-references',
        title: '漫步参考素材',
        items: referenceCards,
      },
    });
  };

  // 加载历史记录列表
  const loadHistoryList = async () => {
    const list = await window.ipcRenderer.invoke('wander:list-history') as WanderHistoryRecord[];
    setHistoryList(list);
    return list;
  };

  // 加载单条历史记录
  const loadHistory = (record: WanderHistoryRecord) => {
    try {
      const parsedItems = JSON.parse(record.items) as WanderItem[];
      const parsedRes = repairWanderResult(JSON.parse(record.result) as WanderResult);
      setItems(parsedItems);
      setParsedResult(parsedRes);
      setSelectedOptionIndex(
        Number.isFinite(Number(parsedRes.selected_index)) ? Math.max(0, Number(parsedRes.selected_index)) : 0
      );
      setParseError(null);
      setPhase('done');
      setShowFinal(true);
      setCurrentHistoryId(record.id);
      setShowHistory(false);
    } catch (e) {
      console.error('Failed to parse history:', e);
    }
  };

  // 删除历史记录
  const deleteHistory = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    await window.ipcRenderer.invoke('wander:delete-history', id);
    const newList = historyList.filter(h => h.id !== id);
    setHistoryList(newList);
    if (currentHistoryId === id) {
      if (newList.length > 0) {
        loadHistory(newList[0]);
      } else {
        setPhase('idle');
        setShowFinal(false);
        setParsedResult(null);
        setItems([]);
        setCurrentHistoryId(null);
      }
    }
  };

  // 初始化：加载最新的历史记录
  useEffect(() => {
    (async () => {
      try {
        const settings = await window.ipcRenderer.getSettings();
        setMultiChoiceEnabled(Boolean(settings?.wander_deep_think_enabled));
      } catch (error) {
        console.error('Failed to load wander mode setting:', error);
      }

      const list = await loadHistoryList();
      if (list.length > 0) {
        loadHistory(list[0]);
      } else {
        // 没有历史时强制回到初始态，避免状态残留导致无法开始第一次漫步
        setPhase('idle');
        setShowFinal(false);
        setParsedResult(null);
        setParseError(null);
        setItems([]);
        setCurrentHistoryId(null);
      }
    })();
  }, []);

  useEffect(() => {
    const handleWanderProgress = (_event: unknown, payload?: unknown) => {
      const data = (payload || {}) as Record<string, unknown>;
      const requestId = String(data.requestId || '').trim();
      if (activeRequestIdRef.current && requestId && requestId !== activeRequestIdRef.current) {
        return;
      }
      const status = String(data.status || '').trim();
      if (status) {
        setLiveStatus(toStableTwoLineText(status));
      }
    };
    window.ipcRenderer.on('wander:progress', handleWanderProgress as (...args: unknown[]) => void);
    return () => {
      window.ipcRenderer.off('wander:progress', handleWanderProgress as (...args: unknown[]) => void);
    };
  }, []);

  const handleToggleMultiChoice = async () => {
    if (isSavingMode || loading) return;
    const nextValue = !multiChoiceEnabled;
    setMultiChoiceEnabled(nextValue);
    setIsSavingMode(true);

    try {
      const settings = await window.ipcRenderer.getSettings();
      await window.ipcRenderer.saveSettings({
        api_endpoint: settings?.api_endpoint || '',
        api_key: settings?.api_key || '',
        model_name: settings?.model_name || '',
        workspace_dir: settings?.workspace_dir,
        active_space_id: settings?.active_space_id,
        role_mapping: settings?.role_mapping || '{}',
        transcription_model: settings?.transcription_model,
        transcription_endpoint: settings?.transcription_endpoint,
        transcription_key: settings?.transcription_key,
        embedding_endpoint: settings?.embedding_endpoint,
        embedding_key: settings?.embedding_key,
        embedding_model: settings?.embedding_model,
        ai_sources_json: settings?.ai_sources_json,
        default_ai_source_id: settings?.default_ai_source_id,
        image_provider: settings?.image_provider,
        image_endpoint: settings?.image_endpoint,
        image_api_key: settings?.image_api_key,
        image_model: settings?.image_model,
        image_provider_template: settings?.image_provider_template,
        image_aspect_ratio: settings?.image_aspect_ratio,
        image_size: settings?.image_size,
        image_quality: settings?.image_quality,
        mcp_servers_json: settings?.mcp_servers_json,
        redclaw_compact_target_tokens: settings?.redclaw_compact_target_tokens,
        wander_deep_think_enabled: nextValue,
      });
    } catch (error) {
      console.error('Failed to persist wander mode setting:', error);
      setMultiChoiceEnabled(!nextValue);
    } finally {
      setIsSavingMode(false);
    }
  };

  const startWander = async () => {
    const requestId = `wander-ui-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    activeRequestIdRef.current = requestId;
    setPhase('running');
    setLoading(true);
      setLiveStatus(toStableTwoLineText('正在初始化漫步...'));
    setParsedResult(null);
    setSelectedOptionIndex(0);
    setParseError(null);
    setItems([]);
    setShowFinal(false);
    setCurrentHistoryId(null);
    try {
      const randomItems = await window.ipcRenderer.invoke('wander:get-random') as WanderItem[];
      setItems(randomItems);
      if (randomItems.length === 0) {
        setParseError('暂无足够内容，请先收集一些笔记或视频。');
        setPhase('done');
        setShowFinal(true);
        return;
      }
      const response = await window.ipcRenderer.invoke('wander:brainstorm', randomItems, {
        multiChoice: multiChoiceEnabled,
        requestId,
      }) as { result: string; historyId?: string; error?: string };
      if (response.error) {
        setParsedResult(null);
        setParseError(response.error);
        setLiveStatus(toStableTwoLineText('漫步失败'));
      } else {
        const parsed = parseJsonPayload<WanderResult>(response.result);
        if (parsed && parsed.topic) {
          const repaired = repairWanderResult(parsed);
          setParsedResult(repaired);
          setSelectedOptionIndex(
            Number.isFinite(Number(repaired.selected_index)) ? Math.max(0, Number(repaired.selected_index)) : 0
          );
          setLiveStatus(toStableTwoLineText('漫步完成'));
          if (response.historyId) {
            setCurrentHistoryId(response.historyId);
            loadHistoryList();
          }
        } else {
          setParsedResult(null);
          setParseError('结果解析失败');
        }
      }
      setPhase('done');
      setShowFinal(true);
    } catch (error) {
      console.error('Brainstorm failed:', error);
      setParsedResult(null);
      setParseError('调用失败，请稍后重试');
      setLiveStatus(toStableTwoLineText('漫步失败'));
      setPhase('done');
      setShowFinal(true);
    } finally {
      setLoading(false);
      activeRequestIdRef.current = '';
    }
  };

  const formatDate = (timestamp: number) => {
    const date = new Date(timestamp);
    const now = new Date();
    const isToday = date.toDateString() === now.toDateString();
    if (isToday) {
      return `今天 ${date.getHours().toString().padStart(2, '0')}:${date.getMinutes().toString().padStart(2, '0')}`;
    }
    return `${date.getMonth() + 1}/${date.getDate()} ${date.getHours().toString().padStart(2, '0')}:${date.getMinutes().toString().padStart(2, '0')}`;
  };

  return (
    <div className="h-full flex flex-col bg-surface-primary overflow-hidden">
      <div className="px-6 py-2.5 border-b border-border bg-surface-primary flex items-center justify-between gap-4 shrink-0">
        <div className="min-w-0 flex items-center gap-2.5">
          <h1 className="min-w-0 text-sm font-semibold text-text-primary flex items-center gap-2 truncate">
            <Dices className="w-4 h-4 text-brand-red shrink-0" />
            <span className="truncate">漫步模式</span>
          </h1>
          <span className="hidden md:block text-[11px] text-text-tertiary truncate">
            随机抽取知识库内容，快速碰撞新选题
          </span>
        </div>
        <div className="flex items-center gap-2.5 shrink-0">
          {phase !== 'idle' && (
            <>
              <button
                onClick={() => { loadHistoryList(); setShowHistory(true); }}
                className="flex items-center gap-2 px-3 py-2 text-xs text-text-secondary hover:bg-surface-secondary rounded-lg transition-colors"
              >
                <History className="w-4 h-4" />
                历史记录
              </button>
              <button
                onClick={startWander}
                disabled={loading}
                className="flex items-center gap-2 px-3 py-2 bg-surface-secondary hover:bg-surface-hover text-text-primary text-xs font-medium rounded-lg transition-colors disabled:opacity-50"
              >
                <RefreshCw className={clsx('w-3.5 h-3.5', loading && 'animate-spin')} />
                再次漫步
              </button>
            </>
          )}
          <div className={clsx('flex items-center gap-2.5', phase !== 'idle' && 'ml-1 pl-3 border-l border-border')}>
            <div className="text-[11px] text-text-tertiary whitespace-nowrap">
              多选题模式
            </div>
            <button
              type="button"
              onClick={() => void handleToggleMultiChoice()}
              disabled={isSavingMode || loading}
              className="ui-switch-track w-11 h-6 shrink-0 disabled:opacity-50"
              data-state={multiChoiceEnabled ? 'on' : 'off'}
              title={multiChoiceEnabled ? '已开启：一次生成 3 个方向' : '已关闭：一次生成 1 个方向'}
            >
              <div
                className={clsx(
                  'ui-switch-thumb top-1 w-4 h-4',
                  multiChoiceEnabled ? 'translate-x-6' : 'translate-x-1'
                )}
              />
            </button>
          </div>
        </div>
      </div>

      {phase === 'idle' ? (
        <div className="flex-1 flex flex-col items-center justify-center space-y-6">
          <div className="p-4 bg-accent-primary/10 rounded-full">
            <Dices className="w-12 h-12 text-accent-primary opacity-80" />
          </div>
          <div className="text-center space-y-2 max-w-md">
            <h2 className="text-lg font-semibold text-text-primary">开启一次随机漫步</h2>
            <p className="text-sm text-text-tertiary">
              系统将从您的知识库中随机抽取内容，
              <br />
              寻找它们之间的隐秘关联，激发新的创作灵感。
            </p>
          </div>
          <button
            onClick={startWander}
            className="group px-6 py-2.5 bg-accent-primary hover:bg-accent-hover text-white rounded-lg font-medium transition-all flex items-center gap-2 shadow-sm"
          >
            <Sparkles className="w-4 h-4" />
            <span>开始漫步</span>
          </button>
        </div>
      ) : (
        <>
          <div className="flex-1 overflow-y-auto p-8">
            <div className="max-w-4xl mx-auto space-y-8">
              {loading && (
                <div className="flex flex-col items-center justify-center gap-4 py-20 animate-in fade-in duration-500">
                  <div className="relative">
                    <div className="w-12 h-12 rounded-full border-2 border-surface-secondary"></div>
                    <div className="absolute top-0 left-0 w-12 h-12 rounded-full border-2 border-brand-red border-t-transparent animate-spin"></div>
                  </div>
                  <div className="w-full max-w-2xl">
                    <div className="rounded-xl border border-border bg-surface-primary px-4 py-3 shadow-sm">
                      <div className="text-[11px] text-text-tertiary mb-1">当前进度</div>
                      <div
                        className="text-sm text-text-primary whitespace-pre-line"
                        style={{
                          display: '-webkit-box',
                          WebkitLineClamp: 2,
                          WebkitBoxOrient: 'vertical',
                          overflow: 'hidden',
                        }}
                      >
                        {liveStatus || '正在漫步并寻找灵感...'}
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {showFinal && parsedResult && (
                <div className="space-y-8 animate-in fade-in slide-in-from-bottom-2 duration-500">
                  {Array.isArray(parsedResult.options) && parsedResult.options.length > 1 && (
                    <div className="bg-surface-primary border border-border rounded-xl p-5 shadow-sm">
                      <div className="text-sm font-medium text-text-primary mb-3">请选择一个选题方向</div>
                      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                        {parsedResult.options.slice(0, 3).map((option, index) => {
                          const selected = index === selectedOptionIndex;
                          return (
                            <button
                              key={`${option.topic.title}-${index}`}
                              type="button"
                              onClick={() => setSelectedOptionIndex(index)}
                              className={clsx(
                                'text-left rounded-lg border p-3 transition-colors',
                                selected
                                  ? 'border-accent-primary bg-accent-primary/5'
                                  : 'border-border hover:bg-surface-secondary/40'
                              )}
                            >
                              <div className="text-xs text-text-tertiary mb-1">方向 {index + 1}</div>
                              <div className="text-sm font-medium text-text-primary line-clamp-2 mb-1.5">
                                {option.topic.title}
                              </div>
                              <div className="text-xs text-text-secondary line-clamp-3">
                                {option.content_direction}
                              </div>
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  )}

                  {/* 选题结果 */}
                  <div className="bg-surface-primary border border-border rounded-xl p-6 shadow-sm">
                    <div className="flex items-start justify-between mb-4">
                      <div className="flex items-center gap-2 text-brand-red mb-2">
                        <Lightbulb className="w-5 h-5" />
                        <span className="text-sm font-medium">灵感生成</span>
                      </div>
                      <div className="flex items-center gap-2">
                        <button
                          onClick={startCreateInRedClaw}
                          disabled={!onNavigateToRedClaw}
                          className="flex items-center gap-1.5 px-3 py-1.5 bg-accent-primary hover:bg-accent-primary/90 text-white text-xs font-medium rounded-md transition-colors disabled:opacity-50"
                        >
                          <Sparkles className="w-3.5 h-3.5" />
                          开始创作
                        </button>
                        <button
                          onClick={goCreate}
                          className="flex items-center gap-1.5 px-3 py-1.5 bg-brand-red hover:bg-brand-red-text text-white text-xs font-medium rounded-md transition-colors"
                        >
                          <PenLine className="w-3.5 h-3.5" />
                          去创作
                        </button>
                      </div>
                    </div>

                    <h2 className="text-xl font-bold text-text-primary mb-4 leading-tight">
                      {(parsedResult.options?.[selectedOptionIndex]?.topic.title || parsedResult.topic.title)}
                    </h2>

                    <div className="bg-surface-secondary/50 rounded-lg p-4 border border-border/50">
                      <div className="text-sm text-text-secondary leading-relaxed">
                        <span className="text-text-primary font-medium mr-2">内容方向:</span>
                        {(parsedResult.options?.[selectedOptionIndex]?.content_direction || parsedResult.content_direction)}
                      </div>
                    </div>

                    {parseError && (
                      <div className="text-xs text-red-500 bg-red-50 border border-red-100 rounded-lg px-3 py-2 mt-4">
                        {parseError}
                      </div>
                    )}
                  </div>

                  {/* 知识库卡片 */}
                  <div>
                    <h3 className="text-sm font-medium text-text-tertiary uppercase tracking-wider mb-4 flex items-center gap-2">
                      <Dices className="w-4 h-4" /> 参考素材
                    </h3>
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                      {items.map((item, index) => {
                        const activeConnections = parsedResult.options?.[selectedOptionIndex]?.topic.connections || parsedResult.topic.connections || [];
                        const isConnected = activeConnections.includes(index + 1);
                        const isDocItem = (item.meta as Record<string, unknown> | undefined)?.sourceType === 'document';
                        const itemBadge = item.type === 'video' ? '视频' : (isDocItem ? '文档' : '笔记');
                        return (
                          <div
                            key={item.id}
                            className={clsx(
                              "group relative flex flex-col rounded-lg overflow-hidden border transition-all duration-300 bg-surface-primary",
                              isConnected
                                ? "border-brand-red/40 ring-1 ring-brand-red/10 shadow-sm"
                                : "border-border hover:border-border/80"
                            )}
                          >
                            {/* 封面图 */}
                            <div className="aspect-video bg-surface-secondary relative overflow-hidden">
                              {item.cover ? (
                                <img
                                  src={resolveAssetUrl(item.cover)}
                                  alt={item.title}
                                  className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-500"
                                />
                              ) : (
                                <div className="w-full h-full flex items-center justify-center text-text-tertiary/30">
                                  {item.type === 'video' ? <Play className="w-8 h-8" /> : <FileText className="w-8 h-8" />}
                                </div>
                              )}

                              {/* 关联标记 */}
                              {isConnected && (
                                <div className="absolute top-2 right-2 bg-brand-red text-white text-[10px] px-2 py-0.5 rounded shadow-sm font-medium">
                                  关联
                                </div>
                              )}
                            </div>

                            {/* 内容区域 */}
                            <div className="p-3 flex-1 flex flex-col">
                              <div className="flex items-center gap-2 mb-2">
                                <span className={clsx(
                                  "text-[10px] px-1.5 py-0.5 rounded font-medium",
                                  item.type === 'video'
                                    ? "bg-red-50 text-red-600"
                                    : isDocItem
                                      ? 'bg-violet-50 text-violet-700'
                                      : "bg-blue-50 text-blue-600"
                                )}>
                                  {itemBadge}
                                </span>
                              </div>

                              <h4 className="text-sm font-medium text-text-primary line-clamp-2 mb-2 group-hover:text-brand-red transition-colors">
                                {item.title}
                              </h4>

                              <p className="text-xs text-text-tertiary line-clamp-3 leading-relaxed mt-auto">
                                {item.content}
                              </p>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                </div>
              )}

              {showFinal && !parsedResult && parseError && (
                <div className="text-sm text-text-secondary bg-surface-secondary border border-border rounded-lg p-6 text-center">
                  {parseError}
                </div>
              )}
            </div>
          </div>
        </>
      )}

      {/* 历史记录弹窗 */}
      {showHistory && (
        <div className="fixed inset-0 bg-black/40 backdrop-blur-sm flex items-center justify-center z-50" onClick={() => setShowHistory(false)}>
          <div className="bg-surface-primary rounded-xl border border-border shadow-2xl w-full max-w-md max-h-[70vh] overflow-hidden flex flex-col" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between px-5 py-4 border-b border-border shrink-0">
              <h3 className="font-semibold text-text-primary text-sm">灵感历史</h3>
              <button onClick={() => setShowHistory(false)} className="text-text-tertiary hover:text-text-primary transition-colors">
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="overflow-y-auto flex-1 p-2 space-y-1">
              {historyList.length === 0 ? (
                <div className="p-8 text-center text-text-tertiary text-xs">
                  暂无历史记录
                </div>
              ) : (
                historyList.map(record => {
                  let title = '未知选题';
                  try {
                    const parsed = JSON.parse(record.result);
                    title = parsed.topic?.title || title;
                  } catch {}
                  const isActive = currentHistoryId === record.id;
                  return (
                    <div
                      key={record.id}
                      onClick={() => loadHistory(record)}
                      className={clsx(
                        "px-4 py-3 cursor-pointer rounded-lg transition-all flex items-center justify-between group",
                        isActive ? "bg-brand-red/5" : "hover:bg-surface-secondary"
                      )}
                    >
                      <div className="flex-1 min-w-0">
                        <div className={clsx("text-sm font-medium truncate mb-0.5", isActive ? "text-brand-red" : "text-text-primary")}>
                          {title}
                        </div>
                        <div className="text-[10px] text-text-tertiary">
                          {formatDate(record.created_at)}
                        </div>
                      </div>
                      <button
                        onClick={(e) => deleteHistory(record.id, e)}
                        className="opacity-0 group-hover:opacity-100 p-1.5 text-text-tertiary hover:text-red-500 hover:bg-red-50 rounded transition-all"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  );
                })
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
