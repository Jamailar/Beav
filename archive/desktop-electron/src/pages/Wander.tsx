import { useState, useEffect, useRef, useCallback } from 'react';
import { RefreshCw, Sparkles, History, X, Trash2, Dices, Lightbulb, FileText, Play, MessageSquarePlus, Heart, ChevronLeft, ChevronRight } from 'lucide-react';
import { clsx } from 'clsx';
import { WanderLoadingDice } from '../components/wander/WanderLoadingDice';
import { resolveAssetUrl } from '../utils/pathManager';
import type { AuthoringTaskHints } from '../utils/redclawAuthoring';
import { usePageRefresh } from '../hooks/usePageRefresh';
import { uiDebug } from '../utils/uiDebug';

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
  items: string | WanderItem[] | unknown;
  result: string | WanderResult | Record<string, unknown> | unknown;
  created_at?: number;
  createdAt?: number;
}

interface WanderProgressCard {
  phase: string;
  title: string;
  detail: string;
  status: 'pending' | 'running' | 'completed' | 'error';
  stepIndex?: number;
  totalSteps?: number;
}

interface WanderProps {
  isActive?: boolean;
  onExecutionStateChange?: (active: boolean) => void;
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

export function Wander({ isActive = true, onExecutionStateChange, onNavigateToManuscript, onNavigateToRedClaw }: WanderProps) {
  const [items, setItems] = useState<WanderItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [multiChoiceEnabled, setMultiChoiceEnabled] = useState(false);
  const [isSavingMode, setIsSavingMode] = useState(false);
  const [skillLoadingEnabled, setSkillLoadingEnabled] = useState(true);
  const [isSavingSkillLoading, setIsSavingSkillLoading] = useState(false);
  const [parsedResult, setParsedResult] = useState<WanderResult | null>(null);
  const [selectedOptionIndex, setSelectedOptionIndex] = useState(0);
  const [parseError, setParseError] = useState<string | null>(null);
  const [phase, setPhase] = useState<'idle' | 'running' | 'done'>('idle');
  const [showFinal, setShowFinal] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [historyList, setHistoryList] = useState<WanderHistoryRecord[]>([]);
  const [currentHistoryId, setCurrentHistoryId] = useState<string | null>(null);
  const [liveStatus, setLiveStatus] = useState('');
  const [progressCards, setProgressCards] = useState<WanderProgressCard[]>([]);
  const activeRequestIdRef = useRef('');
  const historyListRef = useRef<WanderHistoryRecord[]>([]);
  const activeItemsRef = useRef<WanderItem[]>([]);

  useEffect(() => {
    if (!import.meta.env.DEV) return;
    uiDebug('wander', isActive ? 'view_activate' : 'view_deactivate', {
      loading,
      phase,
      itemCount: items.length,
    });
  }, [isActive, items.length, loading, phase]);

  useEffect(() => {
    if (!import.meta.env.DEV) return;
    uiDebug('wander', 'view_mount');
    return () => {
      uiDebug('wander', 'view_unmount');
    };
  }, []);

  useEffect(() => {
    historyListRef.current = historyList;
  }, [historyList]);

  useEffect(() => {
    activeItemsRef.current = items;
  }, [items]);

  useEffect(() => {
    onExecutionStateChange?.(loading || phase === 'running');
    return () => {
      onExecutionStateChange?.(false);
    };
  }, [loading, onExecutionStateChange, phase]);

  const upsertProgressCard = useCallback((next: WanderProgressCard) => {
    setProgressCards((prev) => {
      const index = prev.findIndex((item) => item.phase === next.phase);
      const merged = index === -1
        ? [...prev, next]
        : (() => {
            const cloned = [...prev];
            cloned[index] = { ...cloned[index], ...next };
            return cloned;
          })();
      const normalized = merged.map((item) => {
        if (
          next.stepIndex &&
          item.phase !== next.phase &&
          item.status === 'running' &&
          (item.stepIndex || 0) < next.stepIndex
        ) {
          return { ...item, status: 'completed' as const };
        }
        return item;
      });
      return normalized.sort((a, b) => {
        const aStep = a.stepIndex ?? Number.MAX_SAFE_INTEGER;
        const bStep = b.stepIndex ?? Number.MAX_SAFE_INTEGER;
        return aStep - bStep;
      });
    });
  }, []);

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

  function normalizeWanderConnections(raw: unknown): number[] {
    if (!Array.isArray(raw)) {
      return [1];
    }
    const normalized = raw
      .map((item) => Number(item))
      .filter((item) => Number.isFinite(item))
      .map((item) => Math.max(1, Math.min(3, item)));
    const deduped = Array.from(new Set(normalized));
    return deduped.length > 0 ? deduped : [1];
  }

  function normalizeWanderOption(raw: unknown) {
    const payload = raw && typeof raw === 'object'
      ? raw as Record<string, unknown>
      : {};
    const topicPayload = payload.topic && typeof payload.topic === 'object'
      ? payload.topic as Record<string, unknown>
      : {};
    const title = String(
      topicPayload.title
      || payload.title
      || '未命名选题'
    ).trim() || '未命名选题';
    const contentDirection = String(
      payload.content_direction
      || payload.direction
      || payload.contentDirection
      || ''
    ).trim();
    return {
      content_direction: contentDirection,
      topic: {
        title,
        connections: normalizeWanderConnections(topicPayload.connections ?? payload.connections),
      },
    };
  }

  function normalizeWanderItemsPayload(raw: unknown): WanderItem[] {
    const parsed = Array.isArray(raw)
      ? raw
      : (typeof raw === 'string' ? parseJsonPayload<unknown>(raw) : null);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed
      .map((item): WanderItem | null => {
        const payload = item && typeof item === 'object'
          ? item as Record<string, unknown>
          : null;
        if (!payload) return null;
        const type = payload.type === 'video' ? 'video' : 'note';
        return {
          id: String(payload.id || ''),
          type,
          title: String(payload.title || '').trim(),
          content: String(payload.content || '').trim(),
          cover: typeof payload.cover === 'string' ? payload.cover : undefined,
          meta: payload.meta && typeof payload.meta === 'object'
            ? payload.meta as Record<string, unknown>
            : undefined,
        };
      })
      .filter((item): item is WanderItem => Boolean(item?.id));
  }

  function normalizeWanderResultPayload(raw: unknown): WanderResult | null {
    const parsed = typeof raw === 'string'
      ? parseJsonPayload<unknown>(raw)
      : raw;
    if (!parsed || typeof parsed !== 'object') {
      return null;
    }

    const payload = parsed as Record<string, unknown>;
    const rawOptions = Array.isArray(payload.options)
      ? payload.options
      : (Array.isArray(payload.choices) ? payload.choices : []);
    const normalizedOptions = rawOptions.map((option) => normalizeWanderOption(option));
    const primary = (payload.topic || payload.content_direction || payload.direction || payload.contentDirection || payload.title)
      ? normalizeWanderOption(payload)
      : (normalizedOptions[0] || null);
    if (!primary) {
      return null;
    }

    const thinkingProcessRaw = Array.isArray(payload.thinking_process)
      ? payload.thinking_process
      : (Array.isArray(payload.thinkingProcess) ? payload.thinkingProcess : []);
    return repairWanderResult({
      content_direction: primary.content_direction,
      thinking_process: thinkingProcessRaw.map((item) => String(item || '').trim()).filter(Boolean),
      topic: primary.topic,
      options: normalizedOptions.length > 0 ? normalizedOptions : undefined,
      selected_index: Number.isFinite(Number(payload.selected_index ?? payload.selectedIndex))
        ? Math.max(0, Number(payload.selected_index ?? payload.selectedIndex))
        : 0,
    });
  }

  function resolveSelectedOptionIndex(result: WanderResult | null): number {
    const rawIndex = Number(result?.selected_index);
    const normalizedIndex = Number.isFinite(rawIndex) ? Math.max(0, rawIndex) : 0;
    const maxIndex = Math.max(0, (result?.options?.length || 1) - 1);
    return Math.min(normalizedIndex, maxIndex);
  }

  function getHistoryCreatedAt(record: WanderHistoryRecord): number {
    const timestamp = Number(record.createdAt ?? record.created_at);
    return Number.isFinite(timestamp) ? timestamp : 0;
  }

  function getHistoryTitle(record: WanderHistoryRecord): string {
    const parsed = normalizeWanderResultPayload(record.result);
    return parsed?.options?.[resolveSelectedOptionIndex(parsed)]?.topic.title
      || parsed?.topic?.title
      || '未命名选题';
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
    return `wander/${safeName}.redpost`;
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
      '注意：不要只依赖我在消息里给的摘要。开始写作前，请先读取下方素材文件夹中的文件，理解哪些内容值得借鉴、哪些内容不该硬塞进正文。',
      '请优先读取每个素材目录下的 meta.json，并按需要继续读取正文/转录文件；重点学习其中可复用的 hook、情绪触发点、叙事结构、反差和细节，而不是逐条照搬素材。',
      skillLoadingEnabled
        ? '开始写作前，请先加载 writing-style 技能，再按这份写作风格技能完成标题候选、正文、标签建议和封面文案，不要写成模板化的 AI 文案。'
        : '本次不要额外加载 writing-style 技能。请直接基于素材完成标题候选、正文、标签建议和封面文案，但仍然避免模板化表达。',
      '这不是命题作文。内容质量、传播性和完成度优先，不要求把所有目标素材都直接写进最终正文。',
      '如果某个素材只提供了切口启发、结构方法、情绪张力或表达方式，可以只吸收其方法；如果某个素材会拖累成稿质量，可以舍弃。',
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
      '2. 给出一篇完整正文（可直接发布，结构清晰，优先保证成稿质量而不是素材覆盖率）。',
      '3. 给出标签建议（8-12个）。',
      '4. 给出封面文案建议（2-3个）。',
      '5. 这是小红书图文任务，必须保存成 `.redpost` 工程，不要保存成单个 `.md` 文件。',
      `6. 如目标工程不存在，先调用 app_cli 创建 \`.redpost\` 工程，再写入正文；也可以直接写入该工程路径，让宿主自动建包。推荐路径：${suggestedManuscriptPath}。`,
      `7. 完成后必须调用 app_cli 将完整稿件保存到 manuscripts。优先使用：app_cli(command="manuscripts write --path \\"${suggestedManuscriptPath}\\"", payload={ content: "...完整 markdown..." })。`,
      '8. 未收到工具成功返回前，禁止告诉我“已经保存”。如果保存失败，必须明确说“内容已生成但尚未保存”。',
      `9. 最终回复里只有在工具成功后才能回显保存路径，并且必须使用工具返回的真实路径；不要只复述建议路径 ${suggestedManuscriptPath}。`,
    ].join('\n');

    onNavigateToRedClaw({
      content,
      displayContent: `基于漫步灵感开始创作：${parsedResult.topic.title}`,
      taskHints: {
        intent: 'manuscript_creation',
        activeSkills: skillLoadingEnabled ? ['writing-style'] : [],
      },
      attachment: {
        type: 'wander-references',
        title: '漫步参考素材',
        items: referenceCards,
      },
    });
  };

  const syncWanderSettings = useCallback(async () => {
    try {
      const settings = await window.ipcRenderer.getSettings();
      setMultiChoiceEnabled(Boolean(settings?.wander_deep_think_enabled));
      setSkillLoadingEnabled(settings?.wander_skill_loading_enabled !== false);
    } catch (error) {
      console.error('Failed to load wander settings:', error);
    }
  }, []);

  const persistWanderSettings = useCallback(async (patch: {
    wander_deep_think_enabled?: boolean;
    wander_skill_loading_enabled?: boolean;
  }) => {
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
      wander_deep_think_enabled: patch.wander_deep_think_enabled ?? settings?.wander_deep_think_enabled,
      wander_skill_loading_enabled: patch.wander_skill_loading_enabled ?? settings?.wander_skill_loading_enabled,
    });
  }, []);

  const handleToggleMultiChoice = async () => {
    if (isSavingMode || loading) return;
    const nextValue = !multiChoiceEnabled;
    setMultiChoiceEnabled(nextValue);
    setIsSavingMode(true);

    try {
      await persistWanderSettings({
        wander_deep_think_enabled: nextValue,
      });
    } catch (error) {
      console.error('Failed to persist wander mode setting:', error);
      setMultiChoiceEnabled(!nextValue);
    } finally {
      setIsSavingMode(false);
    }
  };

  const handleToggleSkillLoading = async () => {
    if (isSavingSkillLoading || loading) return;
    const nextValue = !skillLoadingEnabled;
    setSkillLoadingEnabled(nextValue);
    setIsSavingSkillLoading(true);

    try {
      await persistWanderSettings({
        wander_skill_loading_enabled: nextValue,
      });
    } catch (error) {
      console.error('Failed to persist wander skill loading setting:', error);
      setSkillLoadingEnabled(!nextValue);
    } finally {
      setIsSavingSkillLoading(false);
    }
  };

  // 加载历史记录列表
  const loadHistoryList = useCallback(async () => {
    try {
      const list = await window.ipcRenderer.invoke('wander:list-history') as WanderHistoryRecord[];
      const normalized = Array.isArray(list) ? list : [];
      setHistoryList(normalized);
      return normalized;
    } catch (error) {
      console.error('Failed to load wander history list:', error);
      return historyListRef.current;
    }
  }, []);

  // 加载单条历史记录
  const loadHistory = (record: WanderHistoryRecord) => {
    try {
      const parsedItems = normalizeWanderItemsPayload(record.items);
      const parsedRes = normalizeWanderResultPayload(record.result);
      if (!parsedRes) {
        setParsedResult(null);
        setParseError('历史结果解析失败');
        setPhase('done');
        setShowFinal(true);
        setCurrentHistoryId(record.id);
        setShowHistory(false);
        return;
      }
      setItems(parsedItems);
      setParsedResult(parsedRes);
      setSelectedOptionIndex(resolveSelectedOptionIndex(parsedRes));
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

  const refreshPage = useCallback(async () => {
    if (phase === 'running' || loading) {
      return;
    }
    const [, list] = await Promise.all([
      syncWanderSettings(),
      loadHistoryList(),
    ]);
    if (list.length > 0 && currentHistoryId) {
      const currentRecord = list.find((item) => item.id === currentHistoryId);
      if (currentRecord) {
        loadHistory(currentRecord);
        return;
      }
    }
    if (list.length > 0 && parsedResult) {
      return;
    }
    if (list.length > 0) {
      loadHistory(list[0]);
    } else {
      if (parsedResult || items.length > 0 || currentHistoryId || showFinal || phase !== 'idle') {
        return;
      }
      setPhase('idle');
      setShowFinal(false);
      setParsedResult(null);
      setParseError(null);
      setItems([]);
      setCurrentHistoryId(null);
    }
  }, [currentHistoryId, items.length, loadHistoryList, loading, parsedResult, phase, showFinal, syncWanderSettings]);

  usePageRefresh({
    isActive,
    refresh: refreshPage,
  });

  useEffect(() => {
    if (!isActive) return;
    const handleSettingsUpdated = () => {
      void syncWanderSettings();
    };
    window.ipcRenderer.on('settings:updated', handleSettingsUpdated);
    return () => {
      window.ipcRenderer.off('settings:updated', handleSettingsUpdated);
    };
  }, [isActive, syncWanderSettings]);

  useEffect(() => {
    const handleWanderProgress = (_event: unknown, payload?: unknown) => {
      const data = (payload || {}) as Record<string, unknown>;
      const requestId = String(data.requestId || '').trim();
      if (activeRequestIdRef.current && requestId && requestId !== activeRequestIdRef.current) {
        return;
      }
      const detail = String(data.detail || data.status || '').trim();
      if (detail) {
        setLiveStatus(toStableTwoLineText(detail));
      }
      const phase = String(data.phase || '').trim();
      const title = String(data.title || '').trim();
      if (!phase || !title) {
        return;
      }
      upsertProgressCard({
        phase,
        title,
        detail: detail || title,
        status: String(data.status || '').trim() === 'completed'
          ? 'completed'
          : String(data.status || '').trim() === 'error'
            ? 'error'
            : 'running',
        stepIndex: Number.isFinite(Number(data.stepIndex)) ? Number(data.stepIndex) : undefined,
        totalSteps: Number.isFinite(Number(data.totalSteps)) ? Number(data.totalSteps) : undefined,
      });
    };
    window.ipcRenderer.on('wander:progress', handleWanderProgress as (...args: unknown[]) => void);
    return () => {
      window.ipcRenderer.off('wander:progress', handleWanderProgress as (...args: unknown[]) => void);
    };
  }, [upsertProgressCard]);

  useEffect(() => {
    const handleWanderResult = (_event: unknown, payload?: unknown) => {
      const data = (payload || {}) as Record<string, unknown>;
      const requestId = String(data.requestId || '').trim();
      if (!activeRequestIdRef.current || requestId !== activeRequestIdRef.current) {
        return;
      }

      const error = String(data.error || '').trim();
      if (error) {
        setParsedResult(null);
        setParseError(error);
        setLiveStatus(toStableTwoLineText('漫步失败'));
      } else {
        const resultText = typeof data.result === 'string'
          ? data.result.trim()
          : '';
        const historyId = String(data.historyId || '').trim();
        const normalizedResult = normalizeWanderResultPayload(resultText);
        if (normalizedResult) {
          setParsedResult(normalizedResult);
          setSelectedOptionIndex(resolveSelectedOptionIndex(normalizedResult));
          setItems(activeItemsRef.current);
          setLiveStatus(toStableTwoLineText('漫步完成'));
          if (historyId) {
            setCurrentHistoryId(historyId);
            void loadHistoryList();
          }
        } else {
          setParsedResult(null);
          setParseError('结果解析失败');
        }
      }

      setPhase('done');
      setShowFinal(true);
      setLoading(false);
      activeRequestIdRef.current = '';
    };

    window.ipcRenderer.on('wander:result', handleWanderResult as (...args: unknown[]) => void);
    return () => {
      window.ipcRenderer.off('wander:result', handleWanderResult as (...args: unknown[]) => void);
    };
  }, [loadHistoryList]);

  const startWander = async () => {
    const requestId = `wander-ui-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    activeRequestIdRef.current = requestId;
    setPhase('running');
    setLoading(true);
    setLiveStatus(toStableTwoLineText('正在初始化漫步...'));
    setProgressCards([]);
    setParsedResult(null);
    setSelectedOptionIndex(0);
    setParseError(null);
    setItems([]);
    setShowFinal(false);
    setCurrentHistoryId(null);
    try {
      await new Promise<void>((resolve) => {
        window.requestAnimationFrame(() => resolve());
      });
      const randomItems = await window.ipcRenderer.invoke('wander:get-random') as WanderItem[];
      setItems(randomItems);
      activeItemsRef.current = randomItems;
      if (randomItems.length === 0) {
        setParseError('暂无足够内容，请先收集一些笔记、视频或文档。');
        setPhase('done');
        setShowFinal(true);
        setLoading(false);
        activeRequestIdRef.current = '';
        return;
      }

      window.ipcRenderer.send('wander:brainstorm', {
        items: randomItems,
        options: {
          multiChoice: multiChoiceEnabled,
          loadWritingStyleSkill: skillLoadingEnabled,
          requestId,
        },
      });
    } catch (error) {
      console.error('Brainstorm failed:', error);
      setParsedResult(null);
      setParseError('调用失败，请稍后重试');
      setLiveStatus(toStableTwoLineText('漫步失败'));
      setPhase('done');
      setShowFinal(true);
    } finally {
      if (!activeRequestIdRef.current) {
        setLoading(false);
      }
    }
  };

  const formatDate = (timestamp: number) => {
    if (!Number.isFinite(timestamp) || timestamp <= 0) {
      return '最近';
    }
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
      <div className="px-6 py-3 border-b border-black/[0.03] bg-white/80 backdrop-blur-[32px] flex items-center justify-between gap-4 shrink-0 z-30">
        <div className="min-w-0 flex items-center gap-3">
          <h1 className="min-w-0 text-[14px] font-extrabold text-text-primary flex items-center gap-2 truncate tracking-tight">
            <Dices className="w-4 h-4 text-accent-primary shrink-0" />
            <span className="truncate">灵感漫步</span>
          </h1>
          <div className="w-[1px] h-3.5 bg-black/[0.06] hidden md:block" />
          <span className="hidden md:block text-[11px] font-bold text-text-tertiary/60 uppercase tracking-widest truncate">
            Random Inspiration Collision
          </span>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {phase !== 'idle' && (
            <>
              <button
                onClick={() => { void loadHistoryList(); setShowHistory(true); }}
                className="flex items-center gap-2 px-3.5 py-1.5 text-[12px] font-bold text-text-tertiary hover:text-text-primary hover:bg-black/[0.04] rounded-xl transition-all active:scale-95"
              >
                <History className="w-3.5 h-3.5" />
                历史
              </button>
              <button
                onClick={startWander}
                disabled={loading}
                className="flex items-center gap-2 px-3.5 py-1.5 bg-black/[0.03] hover:bg-black/[0.06] text-text-primary text-[12px] font-bold rounded-xl transition-all disabled:opacity-40 active:scale-95"
              >
                <RefreshCw className={clsx('w-3.5 h-3.5', loading && 'animate-spin')} />
                再次漫步
              </button>

            </>
          )}
          <div className={clsx('flex items-center gap-3', phase !== 'idle' && 'ml-1 pl-4 border-l border-black/[0.06]')}>
            <div className="text-[11px] font-bold text-text-tertiary/60 uppercase tracking-tight">
              技能加载
            </div>
            <button
              type="button"
              onClick={() => void handleToggleSkillLoading()}
              disabled={isSavingSkillLoading || loading}
              className="ui-switch-track shrink-0 disabled:opacity-50"
              data-size="sm"
              data-state={skillLoadingEnabled ? 'on' : 'off'}
            >
              <div className="ui-switch-thumb" />
            </button>
          </div>
          <div className="w-[1px] h-4 bg-black/[0.06]" />
          <div className="flex items-center gap-3">
            <div className="text-[11px] font-bold text-text-tertiary/60 uppercase tracking-tight">
              多选题
            </div>
            <button
              type="button"
              onClick={() => void handleToggleMultiChoice()}
              disabled={isSavingMode || loading}
              className="ui-switch-track shrink-0 disabled:opacity-50"
              data-size="sm"
              data-state={multiChoiceEnabled ? 'on' : 'off'}
            >
              <div className="ui-switch-thumb" />
            </button>
          </div>
        </div>
      </div>

      {phase === 'idle' ? (
        <div className="flex-1 flex flex-col items-center justify-center p-8 relative">
            {/* 饰品背景 */}
            <div className="absolute inset-0 pointer-events-none overflow-hidden opacity-30">
                <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[600px] h-[600px] bg-accent-primary/5 rounded-full blur-[120px]" />
                <div className="absolute top-1/4 left-1/3 w-32 h-32 bg-blue-500/5 rounded-full blur-[60px]" />
            </div>

            <div className="relative flex flex-col items-center max-w-lg text-center animate-in fade-in zoom-in-95 duration-700">
                <div className="relative mb-10">
                    <div className="absolute inset-0 bg-accent-primary/10 rounded-[32px] blur-2xl animate-pulse" />
                    <div className="relative flex h-24 w-24 items-center justify-center rounded-[32px] bg-white shadow-[0_24px_48px_-12px_rgba(0,0,0,0.12)] border border-white/60">
                        <Dices className="w-10 h-10 text-accent-primary" />
                    </div>
                </div>
                
                <h2 className="text-2xl font-extrabold tracking-tight text-text-primary mb-4">开启一次随机漫步</h2>
                <p className="text-[15px] leading-relaxed text-text-tertiary font-medium mb-10 px-8">
                    系统将从您的知识库中随机抽取内容，
                    寻找它们之间的隐秘关联，激发前所未有的创作灵感。
                </p>

                <button
                    onClick={startWander}
                    className="group px-8 py-3 bg-text-primary hover:bg-text-primary/90 text-white rounded-[20px] text-[15px] font-extrabold transition-all flex items-center gap-3 shadow-[0_20px_40px_-10px_rgba(0,0,0,0.2)] active:scale-95"
                >
                    <Sparkles className="w-5 h-5 text-accent-primary group-hover:animate-pulse" />
                    <span>开始灵感碰撞</span>
                </button>
            </div>
        </div>
      ) : (
        <>
          <div className="flex-1 overflow-y-auto px-6 py-10 custom-scrollbar">
            <div className="max-w-4xl mx-auto space-y-10">
              {loading && (
                <div className="flex flex-col items-center justify-center min-h-[60vh] py-10 animate-in fade-in zoom-in-[0.98] duration-1000">
                  <WanderLoadingDice className="mb-10" size={76} />
                  
                  <div className="w-full max-w-xl space-y-6">
                    <div className="text-center space-y-2">
                        <h3 className="text-lg font-extrabold tracking-tight text-text-primary uppercase tracking-[0.2em]">Deep Thinking</h3>
                        <p className="text-[13px] font-bold text-text-tertiary/60 uppercase">Searching for Hidden Connections</p>
                    </div>

                    <div className="rounded-3xl border border-white/60 bg-white/40 p-1 shadow-[0_20px_40px_-12px_rgba(0,0,0,0.08)] backdrop-blur-xl">
                      <div className="bg-white/80 rounded-[22px] px-6 py-5 border border-black/[0.02]">
                        <div className="text-[10px] font-black text-accent-primary/60 uppercase tracking-widest mb-2">Live Status</div>
                        <div
                            className="text-[15px] font-bold text-text-primary leading-relaxed h-12"
                            style={{
                            display: '-webkit-box',
                            WebkitLineClamp: 2,
                            WebkitBoxOrient: 'vertical',
                            overflow: 'hidden',
                            }}
                        >
                            {liveStatus || '正在初始化量子灵感引擎...'}
                        </div>
                      </div>
                    </div>

                    {progressCards.length > 0 && (
                      <div className="grid gap-2.5">
                        {progressCards.map((card) => (
                          <div key={card.phase} className={clsx(
                            "rounded-2xl border px-5 py-4 transition-all duration-500 flex items-center justify-between gap-4",
                            card.status === 'running' ? "bg-white border-accent-primary/20 shadow-lg ring-1 ring-accent-primary/5" : "bg-black/[0.02] border-transparent"
                          )}>
                            <div className="min-w-0 flex items-center gap-4">
                                <div className={clsx(
                                    "w-8 h-8 rounded-lg flex items-center justify-center shrink-0 transition-colors",
                                    card.status === 'completed' ? "bg-emerald-500 text-white" : card.status === 'running' ? "bg-accent-primary text-white" : "bg-black/[0.05] text-text-tertiary"
                                )}>
                                    {card.status === 'completed' ? <X className="w-4 h-4 rotate-45" /> : <div className="text-[11px] font-black">{card.stepIndex || '•'}</div>}
                                </div>
                                <div className="min-w-0">
                                    <div className={clsx("text-[13px] font-extrabold tracking-tight", card.status === 'running' ? "text-text-primary" : "text-text-tertiary")}>
                                        {card.title}
                                    </div>
                                    {card.status === 'running' && (
                                        <div className="mt-0.5 text-[11px] font-bold text-text-tertiary truncate max-w-[300px]">
                                            {card.detail}
                                        </div>
                                    )}
                                </div>
                            </div>
                            {card.status === 'running' && (
                                <div className="flex gap-1">
                                    <div className="w-1.5 h-1.5 rounded-full bg-accent-primary animate-bounce [animation-delay:-0.3s]" />
                                    <div className="w-1.5 h-1.5 rounded-full bg-accent-primary animate-bounce [animation-delay:-0.15s]" />
                                    <div className="w-1.5 h-1.5 rounded-full bg-accent-primary animate-bounce" />
                                </div>
                            )}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              )}

              {showFinal && parsedResult && (
                <div className="space-y-12 animate-in fade-in slide-in-from-bottom-4 duration-700">
                  {Array.isArray(parsedResult.options) && parsedResult.options.length > 1 && (
                    <div className="space-y-4">
                      <div className="text-[12px] font-black text-text-tertiary uppercase tracking-widest px-1">灵感候选方案 ({parsedResult.options.length})</div>
                      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                        {parsedResult.options.slice(0, 3).map((option, index) => {
                          const selected = index === selectedOptionIndex;
                          return (
                            <button
                              key={`${option.topic.title}-${index}`}
                              type="button"
                              onClick={() => setSelectedOptionIndex(index)}
                              className={clsx(
                                'text-left rounded-2xl border p-4 transition-all duration-300 relative group active:scale-[0.98]',
                                selected
                                  ? 'border-accent-primary bg-white shadow-[0_12px_32px_-8px_rgba(var(--color-accent-primary),0.15)] ring-1 ring-accent-primary/10'
                                  : 'border-black/[0.04] bg-black/[0.01] hover:bg-white hover:border-black/[0.1] hover:shadow-md'
                              )}
                            >
                              <div className={clsx("text-[9px] font-black uppercase tracking-tighter mb-2", selected ? "text-accent-primary" : "text-text-tertiary/60")}>Option {index + 1}</div>
                              <div className={clsx("text-[13px] font-extrabold tracking-tight line-clamp-2 mb-2 transition-colors", selected ? "text-text-primary" : "text-text-secondary")}>
                                {option.topic.title}
                              </div>
                              <div className="text-[11px] font-bold text-text-tertiary/80 line-clamp-2 leading-relaxed">
                                {option.content_direction}
                              </div>
                              {selected && (
                                <div className="absolute top-4 right-4">
                                    <div className="w-2 h-2 rounded-full bg-accent-primary shadow-[0_0_8px_rgba(var(--color-accent-primary),0.6)] animate-pulse" />
                                </div>
                              )}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  )}

                  {/* 核心选题卡片 */}
                  <div className="space-y-8">
                        <div className="flex flex-wrap items-center justify-between gap-4">
                            <div className="flex items-center gap-2.5">
                                <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-accent-primary text-white shadow-lg shadow-accent-primary/20">
                                    <Sparkles className="w-4.5 h-4.5" />
                                </div>
                                <div>
                                    <div className="text-[15px] font-black text-text-primary tracking-tight">灵感选题</div>
                                    <div className="text-[10px] font-bold text-text-tertiary uppercase tracking-widest">Selected Inspiration Result</div>
                                </div>
                            </div>
                            <div className="flex items-center gap-2">
                                <button
                                    onClick={startCreateInRedClaw}
                                    disabled={!onNavigateToRedClaw}
                                    className="flex h-10 items-center gap-2 px-5 bg-accent-primary text-white text-[13px] font-extrabold rounded-xl shadow-lg shadow-accent-primary/20 hover:bg-accent-hover transition-all active:scale-95 disabled:opacity-40"
                                >
                                    <MessageSquarePlus className="w-4 h-4" />
                                    AI创作
                                </button>
                            </div>
                        </div>

                        <div className="space-y-6">
                            <h2 className="text-3xl font-black text-text-primary leading-[1.15] tracking-tight">
                                {(parsedResult.options?.[selectedOptionIndex]?.topic.title || parsedResult.topic.title)}
                            </h2>

                            <div className="flex items-start gap-3">
                                <div className="mt-1.5 w-1.5 h-1.5 rounded-full bg-accent-primary shrink-0" />
                                <div className="text-[15px] font-bold text-text-secondary leading-relaxed">
                                    {(parsedResult.options?.[selectedOptionIndex]?.content_direction || parsedResult.content_direction)}
                                </div>
                            </div>
                        </div>

                        {parseError && (
                            <div className="mt-6 flex items-center gap-2 text-[12px] font-bold text-red-500 bg-red-50 border border-red-100 rounded-xl px-4 py-3">
                                <X className="w-4 h-4 shrink-0" />
                                {parseError}
                            </div>
                        )}
                  </div>

                  {/* 关联素材展示 */}
                  <div className="space-y-6">
                    <div className="flex items-center justify-between px-1">
                        <div className="text-[12px] font-black text-text-tertiary uppercase tracking-widest">灵感来源素材 (Wander Sources)</div>
                        <div className="h-[1px] flex-1 bg-black/[0.04] ml-6" />
                    </div>
                    
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
                      {items.map((item, index) => {
                        const activeConnections = parsedResult.options?.[selectedOptionIndex]?.topic.connections || parsedResult.topic.connections || [];
                        const isConnected = activeConnections.includes(index + 1);
                        const isDocItem = (item.meta as Record<string, unknown> | undefined)?.sourceType === 'document';
                        const itemBadge = item.type === 'video' ? 'VIDEO' : (isDocItem ? 'DOCUMENT' : 'NOTE');
                        
                        return (
                          <div
                            key={item.id}
                            className={clsx(
                              "group relative flex flex-col rounded-2xl overflow-hidden border transition-all duration-500 bg-white",
                              isConnected
                                ? "border-accent-primary/30 shadow-[0_16px_40px_-12px_rgba(var(--color-accent-primary),0.1)] ring-1 ring-accent-primary/5"
                                : "border-black/[0.04] opacity-70 grayscale-[0.3] hover:opacity-100 hover:grayscale-0 hover:border-black/[0.1]"
                            )}
                          >
                            {/* 封面图 */}
                            <div className="aspect-[16/10] bg-black/[0.02] relative overflow-hidden">
                              {item.cover ? (
                                <img
                                  src={resolveAssetUrl(item.cover)}
                                  alt={item.title}
                                  className="w-full h-full object-cover transition-transform duration-700 group-hover:scale-105"
                                />
                              ) : (
                                <div className="w-full h-full flex items-center justify-center text-text-tertiary/20">
                                  {item.type === 'video' ? <Play className="w-10 h-10" /> : <FileText className="w-10 h-10" />}
                                </div>
                              )}

                              <div className="absolute top-3 left-3 flex gap-2">
                                <span className={clsx(
                                    "text-[9px] px-2 py-1 rounded-lg font-black tracking-widest backdrop-blur-md border border-white/20 shadow-sm",
                                    item.type === 'video' ? "bg-red-500/80 text-white" : isDocItem ? 'bg-violet-500/80 text-white' : "bg-blue-500/80 text-white"
                                )}>
                                    {itemBadge}
                                </span>
                              </div>

                              {isConnected && (
                                <div className="absolute top-3 right-3 bg-accent-primary text-white text-[9px] px-2 py-1 rounded-lg shadow-lg font-black uppercase tracking-widest animate-in zoom-in duration-300">
                                  CORE REF
                                </div>
                              )}
                              
                              <div className="absolute inset-0 bg-gradient-to-t from-black/40 via-transparent to-transparent opacity-0 group-hover:opacity-100 transition-opacity" />
                            </div>

                            {/* 内容区域 */}
                            <div className="p-4 flex-1 flex flex-col">
                              <h4 className={clsx(
                                  "text-[13px] font-extrabold leading-tight tracking-tight line-clamp-2 mb-2.5 transition-colors",
                                  isConnected ? "text-text-primary" : "text-text-secondary"
                              )}>
                                {item.title}
                              </h4>

                              <p className="text-[11px] font-bold text-text-tertiary/70 line-clamp-3 leading-relaxed mt-auto">
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
        <div className="fixed inset-0 bg-black/40 backdrop-blur-[6px] flex items-center justify-center z-[100] animate-in fade-in duration-300" onClick={() => setShowHistory(false)}>
          <div className="bg-white rounded-[28px] border border-white/20 shadow-[0_48px_120px_-20px_rgba(0,0,0,0.3)] w-full max-w-lg max-h-[75vh] overflow-hidden flex flex-col" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between px-7 py-6 border-b border-black/[0.04] shrink-0">
                <div>
                    <h3 className="text-[17px] font-black text-text-primary tracking-tight">灵感历史</h3>
                    <p className="text-[10px] font-bold text-text-tertiary uppercase tracking-widest mt-0.5">Wander Inspiration Vault</p>
                </div>
                <button onClick={() => setShowHistory(false)} className="flex h-9 w-9 items-center justify-center rounded-xl bg-black/[0.04] text-text-tertiary hover:bg-black/[0.08] hover:text-text-primary transition-all active:scale-90">
                    <X className="w-4.5 h-4.5" />
                </button>
            </div>
            <div className="overflow-y-auto flex-1 p-3 space-y-1.5 custom-scrollbar">
              {historyList.length === 0 ? (
                <div className="p-12 text-center">
                    <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-black/[0.02] text-text-tertiary/20 mx-auto mb-4">
                        <History className="w-8 h-8" />
                    </div>
                    <p className="text-[13px] font-bold text-text-tertiary/60">暂无漫步历史记录</p>
                </div>
              ) : (
                historyList.map(record => {
                  const title = getHistoryTitle(record);
                  const isActive = currentHistoryId === record.id;
                  return (
                    <div
                      key={record.id}
                      role="button"
                      tabIndex={0}
                      onClick={() => loadHistory(record)}
                      className={clsx(
                        "px-5 py-4 cursor-pointer rounded-2xl transition-all flex items-center justify-between group relative overflow-hidden",
                        isActive 
                            ? "bg-accent-primary/5 ring-1 ring-accent-primary/10" 
                            : "hover:bg-black/[0.02] border border-transparent"
                      )}
                    >
                      <div className="flex-1 min-w-0">
                        <div className={clsx("text-[14px] font-extrabold truncate mb-1 tracking-tight", isActive ? "text-accent-primary" : "text-text-primary")}>
                          {title}
                        </div>
                        <div className="text-[10px] font-bold text-text-tertiary/60 uppercase tracking-tighter flex items-center gap-2">
                          <span>{formatDate(getHistoryCreatedAt(record))}</span>
                          {isActive && <span className="w-1 h-1 rounded-full bg-accent-primary" />}
                          {isActive && <span className="text-accent-primary font-black">CURRENT</span>}
                        </div>
                      </div>
                      <button
                        onClick={(e) => deleteHistory(record.id, e)}
                        className="opacity-0 group-hover:opacity-100 p-2 text-text-tertiary hover:text-red-500 hover:bg-red-50 rounded-xl transition-all active:scale-90"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  );
                })
              )}
            </div>
            <div className="px-7 py-5 border-t border-black/[0.03] bg-black/[0.01]">
                <p className="text-[9px] text-center font-bold text-text-tertiary/40 uppercase tracking-[0.2em]">Stored Locally in your Workspace</p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
