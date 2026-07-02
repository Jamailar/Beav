import { useState, useEffect, useRef, useCallback } from 'react';
import { RefreshCw, Sparkles, History, X, Trash2, Dices, Lightbulb, FileText, Play, MessageSquarePlus, Heart, ChevronLeft, ChevronRight, Shuffle, Eye, EyeOff, Search, CheckSquare, Square } from 'lucide-react';
import { clsx } from 'clsx';
import { WanderLoadingDice } from '../components/wander/WanderLoadingDice';
import { resolveAssetUrl } from '../utils/pathManager';
import type { PendingChatMessage } from '../features/app-shell/types';
import { subscribeSettingsUpdated } from '../bridge/appEvents';
import {
  AUTHORING_ALLOWED_APP_CLI_ACTIONS,
  AUTHORING_ALLOWED_OPERATE_ACTIONS,
  AUTHORING_ALLOWED_TOOLS,
  buildTaskBriefPromptSection,
} from '../utils/redclawAuthoring';
import type { AuthoringTaskHints, TaskBriefArticleStrategy, TaskBriefSeed } from '../utils/redclawAuthoring';
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

interface WanderMaterialRef {
  kind?: string;
  sourceType?: string;
  storageRoot?: string;
  folderPath?: string;
  workspacePath?: string;
  explorationHint?: string;
  namingRules?: string[];
  displayTitle?: string;
  sourceUrl?: string;
  exists?: boolean;
}

interface WanderResult {
  content_direction: string;
  thinking_process: string[];
  direction_frame: {
    target_reader: string;
    core_tension: string;
    angle: string;
    material_entry: string;
  };
  topic: { title: string; connections: number[] };
  options?: Array<{
    content_direction: string;
    direction_frame: {
      target_reader: string;
      core_tension: string;
      angle: string;
      material_entry: string;
    };
    topic: { title: string; connections: number[] };
  }>;
  selected_index?: number;
  method?: string;
  created_by?: string;
  createdBy?: string;
}

interface WanderValidationIssue {
  path: string;
  code: string;
  message: string;
}

interface WanderHistoryRecord {
  id: string;
  items: string | WanderItem[] | unknown;
  result: string | WanderResult | Record<string, unknown> | unknown;
  created_at?: number;
  createdAt?: number;
  status?: string;
  abandoned_at?: number | null;
  abandonedAt?: number | null;
}

interface WanderProgressCard {
  phase: string;
  title: string;
  detail: string;
  status: 'pending' | 'running' | 'completed' | 'error';
  stepIndex?: number;
  totalSteps?: number;
}

type WanderSelectionMode = 'random' | 'manual';
type WanderGuidedSourceMode = 'topic' | 'anchor';

interface WanderKnowledgeCatalogItem {
  itemId?: string;
  kind?: string;
  title?: string;
  previewText?: string;
  author?: string;
  siteName?: string;
  coverUrl?: string;
  thumbnailUrl?: string;
  sourceUrl?: string;
  folderPath?: string;
}

interface WanderProps {
  isActive?: boolean;
  onExecutionStateChange?: (active: boolean) => void;
  onNavigateToManuscript?: (filePath: string) => void;
  onNavigateToRedClaw?: (payload: PendingChatMessage) => void;
}

export function Wander({ isActive = true, onExecutionStateChange, onNavigateToManuscript, onNavigateToRedClaw }: WanderProps) {
  const [items, setItems] = useState<WanderItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [multiChoiceEnabled, setMultiChoiceEnabled] = useState(false);
  const [isSavingMode, setIsSavingMode] = useState(false);
  const [selectionMode, setSelectionMode] = useState<WanderSelectionMode>('random');
  const [guidedSourceMode, setGuidedSourceMode] = useState<WanderGuidedSourceMode>('topic');
  const [guidedTopic, setGuidedTopic] = useState('');
  const [anchorQuery, setAnchorQuery] = useState('');
  const [anchorResults, setAnchorResults] = useState<WanderItem[]>([]);
  const [selectedAnchor, setSelectedAnchor] = useState<WanderItem | null>(null);
  const [anchorLoading, setAnchorLoading] = useState(false);
  const [parsedResult, setParsedResult] = useState<WanderResult | null>(null);
  const [selectedOptionIndex, setSelectedOptionIndex] = useState(0);
  const [parseError, setParseError] = useState<string | null>(null);
  const [validationIssues, setValidationIssues] = useState<WanderValidationIssue[]>([]);
  const [phase, setPhase] = useState<'idle' | 'running' | 'done'>('idle');
  const [showFinal, setShowFinal] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [showAbandonedTopics, setShowAbandonedTopics] = useState(false);
  const [historyList, setHistoryList] = useState<WanderHistoryRecord[]>([]);
  const [currentHistoryId, setCurrentHistoryId] = useState<string | null>(null);
  const [liveStatus, setLiveStatus] = useState('');
  const [progressCards, setProgressCards] = useState<WanderProgressCard[]>([]);
  const activeRequestIdRef = useRef('');
  const historyListRef = useRef<WanderHistoryRecord[]>([]);
  const activeItemsRef = useRef<WanderItem[]>([]);
  const activeOption = parsedResult?.options?.[selectedOptionIndex];
  const activeDirectionFrame = activeOption?.direction_frame || parsedResult?.direction_frame;
  const hasGuidedInput = guidedSourceMode === 'topic'
    ? guidedTopic.trim().length > 0
    : Boolean(selectedAnchor);

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

  useEffect(() => {
    if (!isActive || selectionMode !== 'manual' || guidedSourceMode !== 'anchor') return;
    let cancelled = false;
    setAnchorLoading(true);
    const timer = window.setTimeout(async () => {
      try {
        const response = await window.ipcRenderer.knowledge.listPage<{ items?: WanderKnowledgeCatalogItem[] }>({
          query: anchorQuery.trim(),
          limit: 20,
          sort: 'updated-desc',
        });
        if (cancelled) return;
        const normalizedItems = (Array.isArray(response?.items) ? response.items : [])
          .map((item) => {
            const title = String(item.title || '').trim();
            if (!title) return null;
            const kind = String(item.kind || '').trim();
            return {
              id: String(item.itemId || `${kind}:${title}`),
              type: kind === 'youtube-video' ? 'video' as const : 'note' as const,
              title,
              content: String(item.previewText || item.author || item.siteName || '').trim(),
              cover: String(item.coverUrl || item.thumbnailUrl || ''),
              meta: {
                kind,
                author: item.author,
                siteName: item.siteName,
                sourceUrl: item.sourceUrl,
                folderPath: item.folderPath,
              },
            };
          })
          .filter((item): item is WanderItem => Boolean(item));
        setAnchorResults(normalizedItems);
      } catch (error) {
        console.error('Failed to load wander anchor items:', error);
        if (!cancelled) {
          setAnchorResults([]);
        }
      } finally {
        if (!cancelled) {
          setAnchorLoading(false);
        }
      }
    }, 180);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [anchorQuery, guidedSourceMode, isActive, selectionMode]);

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
    const embeddedFrame = embedded.direction_frame && typeof embedded.direction_frame === 'object'
      ? embedded.direction_frame
      : undefined;
    return {
      content_direction: String(embedded.content_direction || result.content_direction || '').trim(),
      thinking_process: Array.isArray(result.thinking_process) && result.thinking_process.length > 0
        ? result.thinking_process
        : (Array.isArray(embedded.thinking_process) ? embedded.thinking_process.map((item) => String(item || '').trim()).filter(Boolean) : []),
      direction_frame: {
        target_reader: String(embeddedFrame?.target_reader || result.direction_frame?.target_reader || '').trim(),
        core_tension: String(embeddedFrame?.core_tension || result.direction_frame?.core_tension || '').trim(),
        angle: String(embeddedFrame?.angle || result.direction_frame?.angle || '').trim(),
        material_entry: String(embeddedFrame?.material_entry || result.direction_frame?.material_entry || '').trim(),
      },
      topic: {
        title: String(embedded.topic?.title || result.topic?.title || '').trim(),
        connections: Array.isArray(embedded.topic?.connections)
          ? embedded.topic.connections.map((item) => Number(item)).filter((item) => Number.isFinite(item))
          : (result.topic?.connections || []),
      },
      options: Array.isArray(result.options) && result.options.length > 0
        ? result.options
        : (Array.isArray(embedded.options)
          ? embedded.options.map((option) => ({
              content_direction: String(option?.content_direction || '').trim(),
              direction_frame: {
                target_reader: String(option?.direction_frame?.target_reader || '').trim(),
                core_tension: String(option?.direction_frame?.core_tension || '').trim(),
                angle: String(option?.direction_frame?.angle || '').trim(),
                material_entry: String(option?.direction_frame?.material_entry || '').trim(),
              },
              topic: {
                title: String(option?.topic?.title || '').trim(),
                connections: Array.isArray(option?.topic?.connections)
                  ? option.topic.connections.map((item) => Number(item)).filter((item) => Number.isFinite(item))
                  : [],
              },
            }))
          : undefined),
      selected_index: Number.isFinite(Number(result.selected_index))
        ? Math.max(0, Number(result.selected_index))
        : (Number.isFinite(Number(embedded.selected_index)) ? Math.max(0, Number(embedded.selected_index)) : 0),
      method: result.method || embedded.method,
      created_by: result.created_by || embedded.created_by,
      createdBy: result.createdBy || embedded.createdBy,
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
    const directionFramePayload = payload.direction_frame && typeof payload.direction_frame === 'object'
      ? payload.direction_frame as Record<string, unknown>
      : (payload.directionFrame && typeof payload.directionFrame === 'object'
        ? payload.directionFrame as Record<string, unknown>
        : {});
    const title = String(
      topicPayload.title
      || payload.title
      || ''
    ).trim();
    const contentDirection = String(
      payload.content_direction
      || payload.direction
      || payload.contentDirection
      || ''
    ).trim();
    return {
      content_direction: contentDirection,
      direction_frame: {
        target_reader: String(directionFramePayload.target_reader || directionFramePayload.targetReader || '').trim(),
        core_tension: String(directionFramePayload.core_tension || directionFramePayload.coreTension || '').trim(),
        angle: String(directionFramePayload.angle || '').trim(),
        material_entry: String(directionFramePayload.material_entry || directionFramePayload.materialEntry || '').trim(),
      },
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
      direction_frame: primary.direction_frame,
      topic: primary.topic,
      options: normalizedOptions.length > 0 ? normalizedOptions : undefined,
      selected_index: Number.isFinite(Number(payload.selected_index ?? payload.selectedIndex))
        ? Math.max(0, Number(payload.selected_index ?? payload.selectedIndex))
        : 0,
      method: String(payload.method || payload.sourceMethod || payload.source_mode || payload.sourceMode || '').trim() || undefined,
      created_by: String(payload.created_by || payload.createdBy || '').trim() || undefined,
      createdBy: String(payload.createdBy || payload.created_by || '').trim() || undefined,
    });
  }

  function normalizedTopicMethod(value: unknown): string {
    return String(value || '').trim().toLowerCase().replace(/[-\s]+/g, '_');
  }

  function topicSourceLabel(result: WanderResult | null, recordItems: WanderItem[]): string {
    const createdBy = String(result?.created_by || result?.createdBy || '').trim().toLowerCase();
    const method = normalizedTopicMethod(result?.method);
    if (['agent', 'ai', 'ai_agent', 'redclaw', 'content_topic_miner'].includes(createdBy)) {
      return 'AI创作';
    }
    if ([
      'ai_creation',
      'content_topic_miner',
      'knowledge_mining',
      'knowledge_similar_mining',
      'history_mining',
      'trend_mining',
    ].includes(method)) {
      return 'AI创作';
    }
    if (method === 'comment_insight' || method === 'comment_demand_insight' || method.includes('comment')) {
      return '评论洞察';
    }
    const isCommentInsight = recordItems.some((item) => {
      const meta = item.meta || {};
      return String(meta.sourceType || meta.source_type || '').trim() === 'xhs-comments';
    });
    return isCommentInsight ? '评论洞察' : '灵感漫步';
  }

  function normalizeWanderValidationIssues(raw: unknown): WanderValidationIssue[] {
    if (!Array.isArray(raw)) {
      return [];
    }
    return raw
      .map((item) => {
        const payload = item && typeof item === 'object'
          ? item as Record<string, unknown>
          : null;
        if (!payload) return null;
        const message = String(payload.message || '').trim();
        if (!message) return null;
        return {
          path: String(payload.path || '').trim(),
          code: String(payload.code || '').trim(),
          message,
        };
      })
      .filter((item): item is WanderValidationIssue => Boolean(item));
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

  function isAbandonedHistoryRecord(record: WanderHistoryRecord): boolean {
    return String(record.status || '').trim() === 'abandoned' || Boolean(record.abandoned_at || record.abandonedAt);
  }

  function getHistoryTitle(record: WanderHistoryRecord): string {
    const parsed = normalizeWanderResultPayload(record.result);
    return parsed?.options?.[resolveSelectedOptionIndex(parsed)]?.topic.title
      || parsed?.topic?.title
      || '未命名选题';
  }

  const resolveWanderMaterialRef = (item: WanderItem): WanderMaterialRef | null => {
    const meta = (item.meta || {}) as Record<string, unknown>;
    const materialRef = meta.materialRef;
    if (!materialRef || typeof materialRef !== 'object') {
      return null;
    }
    const payload = materialRef as Record<string, unknown>;
    return {
      kind: typeof payload.kind === 'string' ? payload.kind : undefined,
      sourceType: typeof payload.sourceType === 'string' ? payload.sourceType : undefined,
      storageRoot: typeof payload.storageRoot === 'string' ? payload.storageRoot : undefined,
      folderPath: typeof payload.folderPath === 'string' ? payload.folderPath : undefined,
      workspacePath: typeof payload.workspacePath === 'string' ? payload.workspacePath : undefined,
      explorationHint: typeof payload.explorationHint === 'string' ? payload.explorationHint : undefined,
      namingRules: Array.isArray(payload.namingRules)
        ? payload.namingRules.map((value) => String(value || '').trim()).filter(Boolean)
        : undefined,
      displayTitle: typeof payload.displayTitle === 'string' ? payload.displayTitle : undefined,
      sourceUrl: typeof payload.sourceUrl === 'string' ? payload.sourceUrl : undefined,
      exists: typeof payload.exists === 'boolean' ? payload.exists : undefined,
    };
  };

  const buildKnowledgeFolderReference = (item: WanderItem) => {
    const meta = (item.meta || {}) as Record<string, unknown>;
    const materialRef = resolveWanderMaterialRef(item);
    if (materialRef) {
      const workspacePath = String(materialRef.workspacePath || '').trim();
      const folderPath = workspacePath || String(materialRef.folderPath || '').trim();
      const fallbackName = folderPath.split(/[\\/]/).filter(Boolean).pop() || item.id;
      const namingRulesHint = (materialRef.namingRules || []).length > 0
        ? `识别规则：${(materialRef.namingRules || []).join('；')}`
        : '';
      return {
        folderName: fallbackName,
        folderPath: folderPath || `material://${item.id}`,
        metaPath: folderPath || `material://${item.id}`,
        contentHint: [materialRef.explorationHint, namingRulesHint].filter(Boolean).join(' '),
      };
    }
    if (meta.sourceType === 'document') {
      const filePath = String(meta.filePath || '').trim();
      const relativePath = String(meta.relativePath || '').trim();
      const sourceName = String(meta.sourceName || '').trim();
      const sourceKind = String(meta.sourceKind || '').trim();
      return {
        folderName: relativePath || item.id,
        folderPath: filePath || `document://${item.id}`,
        metaPath: filePath || `document://${item.id}`,
        contentHint: `这是文档知识源（${sourceName || sourceKind || 'document'}），先列目录，再根据文件名和样例文件自行判断该读什么正文。`,
      };
    }

    const fallbackFolderPath = typeof meta.folderPath === 'string' && meta.folderPath.trim()
      ? meta.folderPath.trim()
      : `${item.type === 'video' ? 'knowledge/youtube' : 'knowledge/redbook'}/${item.id}`;
    const folderName = fallbackFolderPath.split(/[\\/]/).filter(Boolean).pop() || item.id;
    return {
      folderName,
      folderPath: fallbackFolderPath,
      metaPath: fallbackFolderPath,
      contentHint: item.type === 'video'
        ? '先列目录，再优先读 meta.json，然后根据 transcript / subtitle / content / description 等命名线索自行寻找相关文件。'
        : '先列目录，再优先读 meta.json，然后根据 content / body / article / note 等命名线索自行寻找正文文件。',
    };
  };

  const canStartCreate = Boolean(parsedResult && onNavigateToRedClaw && validationIssues.length === 0 && !parseError);

  const startCreateInRedClaw = () => {
    if (!parsedResult || !onNavigateToRedClaw || validationIssues.length > 0 || parseError) return;
    const selectedOption = parsedResult.options?.[selectedOptionIndex];
    const activeTopic = selectedOption?.topic || parsedResult.topic;
    const activeDirection = selectedOption?.content_direction || parsedResult.content_direction;
    const connectedSet = new Set(activeTopic.connections || []);
    const initialArticleStrategy: TaskBriefArticleStrategy = {
      articleStyle: '待根据选题和素材判断',
      readerQuestion: activeTopic.title || '读者看到这个选题后最直接的问题是什么',
      corePromise: activeDirection || '帮读者获得一个可发布、可理解、可转发的清晰判断',
      titleDirection: '先判断读者问题，再生成直接疑问、反常识、悬念表达等候选',
      openingDirection: '开头直接回应读者问题，不复盘素材来源',
      structureDirection: '围绕一个明确观点推进，素材只作为事实、场景或表达参考',
      avoidDirection: ['不要提到原文', '不要提到原笔记', '不要提到评论区', '不要把素材复盘写进正文'],
    };
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
      const folderRef = buildKnowledgeFolderReference(item);
      return [
        `素材${order}`,
        `类型：${item.type === 'video' ? '视频笔记' : ((item.meta as Record<string, unknown> | undefined)?.sourceType === 'document' ? '文档' : '图文笔记')}`,
        `标题：${item.title || '(无标题)'}`,
        `素材路径：${folderRef.folderPath}`,
      ].join('\n');
    }).join('\n\n');
    const knowledgeReferences = items.map((item) => {
      const folderRef = buildKnowledgeFolderReference(item);
      const meta = (item.meta || {}) as Record<string, unknown>;
      return {
        id: item.id,
        title: item.title || '未命名内容',
        sourceKind: typeof meta.sourceKind === 'string' ? meta.sourceKind : (item.type === 'video' ? 'youtube-video' : 'redbook-note'),
        summary: String(item.content || '').replace(/\s+/g, ' ').trim().slice(0, 180),
        cover: resolveAssetUrl(item.cover),
        sourceUrl: typeof meta.sourceUrl === 'string' ? meta.sourceUrl : undefined,
        folderPath: folderRef.folderPath,
        rootPath: folderRef.folderPath,
        updatedAt: typeof meta.updatedAt === 'string' ? meta.updatedAt : undefined,
      };
    });
    const taskBrief: TaskBriefSeed = {
      taskType: 'wander_xhs_creation',
      goal: `基于漫步选题《${activeTopic.title}》创作一篇独立小红书文案，并保存到稿件工程。`,
      currentStage: 'research',
      todo: [
        { id: 'research', text: '判断是否需要外部调研，并读取必要素材', status: 'todo' },
        { id: 'strategy', text: '确定文章打法、读者问题和结构方向', status: 'todo' },
        { id: 'title', text: '调用 xhs-title 产出候选并选择最终标题', status: 'todo' },
        { id: 'draft', text: '调用 writing-style 写正文并自检', status: 'todo' },
        { id: 'save', text: '创建 wander 稿件工程并保存最终稿', status: 'todo' },
      ],
      importantContext: [
        { kind: 'constraint', text: '正文必须是一篇独立小红书内容，不得提到原文、原笔记、评论区或素材来源痕迹。' },
        { kind: 'source', text: `参考素材数量：${items.length}。素材目录只作为后台参考，写作前按需读取。` },
        { kind: 'decision', text: 'Electron 开源版保存路径使用 app_cli manuscripts.createProject / manuscripts.writeCurrent。' },
      ],
      articleStrategy: initialArticleStrategy,
      titleCandidates: [],
      domain: {
        platform: 'xiaohongshu',
        topicTitle: activeTopic.title,
        contentDirection: activeDirection || '',
        referenceSourceMode: 'wander',
        forbiddenFinalPhrases: ['原文', '原笔记', '评论区', '评论里', '有用户评论', '大家在评论区问'],
      },
    };

    const content = [
      '请基于以下“漫步结果”开始创作一篇完整的小红书文案。',
      '',
      '注意：不要只依赖我在消息里给的摘要。开始写作前，请先读取下方素材目录中的真实文件，理解哪些内容值得借鉴、哪些内容不该硬塞进正文。',
      '优先使用 `redbox_fs(action="workspace.list" | "workspace.read", payload={ ... })` 读取这些 workspace 相对路径；只有当 `redbox_fs` 无法表达该读取动作时，才回退到 `bash`。不要再尝试历史兼容别名或自造的 `fs read` / `app_cli fs ...`。',
      '',
      '请先进入每条素材目录，自行列出文件，再优先读取 meta.json，并根据目录中的命名规则判断还需要读哪些正文/转录/字幕文件；重点学习其中可复用的 hook、情绪触发点、叙事结构、反差和细节，而不是逐条照搬素材。',
      '',
      '开始写作前必须先激活 `writing-style` 技能；不要假定它已经预加载。先调用 `app_cli(action="skills.invoke", payload={ "name": "writing-style" })`，然后再继续读取素材、读取档案和写正文。',
      '再次强调：这是写作任务，不要跳过 `writing-style`。开始写作前必须先调用 `app_cli(action="skills.invoke", payload={ "name": "writing-style" })`。',
      '最后再强调一次：先激活 `writing-style`，再写作；先激活 `writing-style`，再写作；先调用 `app_cli(action="skills.invoke", payload={ "name": "writing-style" })`，再继续后续步骤。',
      '需要参考用户的档案来进行创作 CreatorProfile.md 和 user.md，再基于素材完成最终标题和正文，避免模板化表达。',
      '这不是命题作文。内容质量、传播性和完成度优先，不要求把所有目标素材都直接写进最终正文。',
      '如果某个素材只提供了切口启发、结构方法、情绪张力或表达方式，可以只吸收其方法；如果某个素材会拖累成稿质量，可以舍弃。',
      '写正文时不要插入控制字符、占位分隔线或额外格式标记；正文只保留正常段落结构。',
      '完稿前自行做一次风格与事实自检，再保存。',
      '',
      '## 灵感选题',
      `标题：${activeTopic.title}`,
      `内容方向：${activeDirection || ''}`,
      '',
      buildTaskBriefPromptSection(taskBrief),
      '',
      '## 参考素材（来自漫步）',
      materialText,
      '',
      '## 输出要求',
      '1. 只输出一个最终标题，不要再输出标题候选、备选标题或标题列表。',
      '2. 只输出一篇完整正文（可直接发布，结构清晰，优先保证成稿质量而不是素材覆盖率）。不要额外输出推荐 tag、标签建议、封面文案或其它附加栏目。',
      '3. 这是小红书图文任务，必须保存成 `.redpost` 工程。',
      '4. 如目标工程不存在，先调用 `app_cli(action="manuscripts.createProject", payload={ "kind": "redpost", "parent": "wander", "title": "<最终标题>" })` 获取规范工程路径。不要把标题直接当成工程文件名。',
      '5. 创建成功后，宿主会把该工程绑定为当前写稿目标；你只需要生成最终标题和完整正文，不要展开描述工程内部文件结构，也不要自己管理其他工程文件。',
      '6. 完成后必须调用 `app_cli(action="manuscripts.writeCurrent", payload={ "content": "<完整正文>" })` 保存完整稿件；不要重新创建工程，也不要再重复传 path。',
      '7. 未收到工具成功返回前，禁止告诉我“已经保存”。如果保存失败，必须明确说“内容已生成但尚未保存”。',
    ].join('\n');

    onNavigateToRedClaw({
      content,
      displayContent: `基于漫步灵感开始创作：${parsedResult.topic.title}`,
      sessionRouting: 'new',
      taskHints: {
        intent: 'manuscript_creation',
        executionProfile: 'artifact-authoring',
        artifactType: 'manuscript',
        writeTarget: 'manuscripts://current',
        requiredSkill: ['writing-style', 'xhs-title'],
        activeSkills: ['writing-style', 'xhs-title'],
        allowedTools: AUTHORING_ALLOWED_TOOLS,
        allowedAppCliActions: AUTHORING_ALLOWED_APP_CLI_ACTIONS,
        allowedOperateActions: [...AUTHORING_ALLOWED_OPERATE_ACTIONS, 'web.search'],
        allowedWriteTargets: ['manuscripts://current'],
        requireSourceRead: true,
        requireProfileRead: true,
        requireSave: true,
        requireTaskBrief: true,
        requireSkillInvocations: ['xhs-title', 'writing-style'],
        taskBrief,
        forbiddenFinalPhrases: ['原文', '原笔记', '评论区', '评论里', '有用户评论', '大家在评论区问'],
        deferredDiscovery: false,
        teamEscalation: 'disabled',
        saveArtifact: 'redpost',
        saveSubdir: 'wander',
        platform: 'xiaohongshu',
        taskType: 'direct_write',
        formatTarget: 'markdown',
        sourceMode: 'knowledge',
      },
      attachment: {
        type: 'wander-references',
        title: '漫步参考素材',
        items: referenceCards,
      },
      knowledgeReferences,
    });
  };

  const syncWanderSettings = useCallback(async () => {
    try {
      const settings = await window.ipcRenderer.getSettings();
      setMultiChoiceEnabled(Boolean(settings?.wander_deep_think_enabled));
    } catch (error) {
      console.error('Failed to load wander settings:', error);
    }
  }, []);

  const persistWanderSettings = useCallback(async (patch: {
    wander_deep_think_enabled?: boolean;
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
      wander_skill_loading_enabled: settings?.wander_skill_loading_enabled,
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

  // 加载历史记录列表
  const loadHistoryList = useCallback(async (options?: { includeAbandoned?: boolean }) => {
    try {
      const list = await window.ipcRenderer.wander.listHistory<WanderHistoryRecord[]>({
        includeAbandoned: Boolean(options?.includeAbandoned),
      });
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

  const resetToIdleTopicState = () => {
    setPhase('idle');
    setShowFinal(false);
    setParsedResult(null);
    setItems([]);
    setCurrentHistoryId(null);
  };

  // 删除历史记录
  const deleteHistory = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    await window.ipcRenderer.wander.deleteHistory(id);
    const newList = historyList.filter(h => h.id !== id);
    setHistoryList(newList);
    if (currentHistoryId === id) {
      const activeList = newList.filter(record => !isAbandonedHistoryRecord(record));
      if (activeList.length > 0) {
        loadHistory(activeList[0]);
      } else {
        resetToIdleTopicState();
      }
    }
  };

  const abandonCurrentTopic = async () => {
    if (!currentHistoryId || loading) return;
    try {
      await window.ipcRenderer.wander.abandonHistory(currentHistoryId);
      const nextList = await loadHistoryList({ includeAbandoned: showAbandonedTopics });
      const activeList = nextList.filter(record => !isAbandonedHistoryRecord(record));
      if (activeList.length > 0) {
        loadHistory(activeList[0]);
      } else {
        resetToIdleTopicState();
      }
    } catch (error) {
      console.error('Failed to abandon wander topic:', error);
      setParseError('放弃失败，请稍后重试');
    }
  };

  const refreshPage = useCallback(async () => {
    if (phase === 'running' || loading) {
      return;
    }
    const [, list] = await Promise.all([
      syncWanderSettings(),
      loadHistoryList({ includeAbandoned: showAbandonedTopics }),
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
  }, [currentHistoryId, items.length, loadHistoryList, loading, parsedResult, phase, showAbandonedTopics, showFinal, syncWanderSettings]);

  const visibleHistoryList = showAbandonedTopics
    ? historyList
    : historyList.filter(record => !isAbandonedHistoryRecord(record));
  const currentTopicSourceLabel = topicSourceLabel(parsedResult, items);

  const handleGuidedSourceModeChange = (mode: WanderGuidedSourceMode) => {
    setGuidedSourceMode(mode);
    if (mode === 'topic') {
      setSelectedAnchor(null);
      return;
    }
    setGuidedTopic('');
  };

  const buildGuidedTopicConstraint = () => {
    if (guidedSourceMode === 'topic') {
      return guidedTopic.trim();
    }
    if (!selectedAnchor) {
      return '';
    }
    const summary = selectedAnchor.content.trim();
    return [
      `围绕锚点素材「${selectedAnchor.title}」延展选题。`,
      summary ? `素材摘要：${summary}` : '',
    ].filter(Boolean).join('\n');
  };

  usePageRefresh({
    isActive,
    refresh: refreshPage,
  });

  useEffect(() => {
    if (!isActive) return;
    const handleSettingsUpdated = () => {
      void syncWanderSettings();
    };
    return subscribeSettingsUpdated(handleSettingsUpdated);
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
    window.ipcRenderer.wander.onProgress(handleWanderProgress as (...args: unknown[]) => void);
    return () => {
      window.ipcRenderer.wander.offProgress(handleWanderProgress as (...args: unknown[]) => void);
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
      const resultText = typeof data.result === 'string'
        ? data.result.trim()
        : '';
      const historyId = String(data.historyId || '').trim();
      const normalizedResult = normalizeWanderResultPayload(resultText);
      const normalizedIssues = normalizeWanderValidationIssues(data.validationIssues);
      if (error) {
        setParsedResult(normalizedResult);
        setParseError(error);
        setValidationIssues(normalizedIssues);
        if (normalizedResult) {
          setSelectedOptionIndex(resolveSelectedOptionIndex(normalizedResult));
        }
        setLiveStatus(toStableTwoLineText('漫步失败'));
      } else {
        if (normalizedResult) {
          setParsedResult(normalizedResult);
          setSelectedOptionIndex(resolveSelectedOptionIndex(normalizedResult));
          setValidationIssues([]);
          setItems(activeItemsRef.current);
          setLiveStatus(toStableTwoLineText('漫步完成'));
          if (historyId) {
            setCurrentHistoryId(historyId);
            void loadHistoryList({ includeAbandoned: showAbandonedTopics });
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

    window.ipcRenderer.wander.onResult(handleWanderResult as (...args: unknown[]) => void);
    return () => {
      window.ipcRenderer.wander.offResult(handleWanderResult as (...args: unknown[]) => void);
    };
  }, [loadHistoryList, showAbandonedTopics]);

  const startWander = async () => {
    const effectiveSelectionMode = selectionMode;
    const normalizedGuidedTopic = buildGuidedTopicConstraint();
    if (effectiveSelectionMode === 'manual' && !normalizedGuidedTopic) {
      setParseError(guidedSourceMode === 'topic' ? '请先输入选题方向。' : '请先选择一篇锚点笔记。');
      setPhase('done');
      setShowFinal(true);
      return;
    }
    const requestId = `wander-ui-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    activeRequestIdRef.current = requestId;
    setPhase('running');
    setLoading(true);
    setLiveStatus(toStableTwoLineText(effectiveSelectionMode === 'manual' ? '正在按方向选择素材...' : '正在初始化漫步...'));
    setProgressCards([]);
    setParsedResult(null);
    setSelectedOptionIndex(0);
    setParseError(null);
    setValidationIssues([]);
    setItems([]);
    setShowFinal(false);
    setCurrentHistoryId(null);
    try {
      await new Promise<void>((resolve) => {
        window.requestAnimationFrame(() => resolve());
      });
      const randomItems = await window.ipcRenderer.wander.getRandom<WanderItem[]>();
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

      window.ipcRenderer.wander.brainstorm({
        items: randomItems,
        options: {
          multiChoice: multiChoiceEnabled,
          requestId,
          sourceMode: effectiveSelectionMode === 'manual' ? 'guided' : 'random',
          guidedTopic: effectiveSelectionMode === 'manual' ? normalizedGuidedTopic : '',
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
                onClick={() => { void loadHistoryList({ includeAbandoned: showAbandonedTopics }); setShowHistory(true); }}
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
                        {selectionMode === 'manual'
                            ? <Shuffle className="w-10 h-10 text-accent-primary" />
                            : <Dices className="w-10 h-10 text-accent-primary" />}
                    </div>
                </div>

                <div className="mb-6 inline-flex rounded-xl bg-black/[0.04] p-0.5">
                  {[
                    ['random', '随机选题'] as const,
                    ['manual', '按方向选题'] as const,
                  ].map(([mode, label]) => (
                    <button
                      key={mode}
                      type="button"
                      onClick={() => setSelectionMode(mode)}
                      className={clsx(
                        'h-8 rounded-lg px-4 text-[12px] font-black transition-all',
                        selectionMode === mode
                          ? 'bg-white text-text-primary shadow-sm'
                          : 'text-text-tertiary hover:text-text-primary'
                      )}
                    >
                      {label}
                    </button>
                  ))}
                </div>

                <h2 className="text-2xl font-extrabold tracking-tight text-text-primary mb-4">
                    {selectionMode === 'manual' ? '按方向选题' : '开启一次随机选题'}
                </h2>
                {selectionMode === 'manual' ? (
                  <div className="mb-8 w-full max-w-2xl space-y-4 text-left">
                    <div className="mx-auto flex w-fit rounded-xl bg-black/[0.04] p-0.5">
                      {[
                        ['topic', '输入主题'] as const,
                        ['anchor', '选择锚点'] as const,
                      ].map(([mode, label]) => (
                        <button
                          key={mode}
                          type="button"
                          onClick={() => handleGuidedSourceModeChange(mode)}
                          className={clsx(
                            'h-8 rounded-lg px-4 text-[12px] font-black transition-all',
                            guidedSourceMode === mode
                              ? 'bg-white text-text-primary shadow-sm'
                              : 'text-text-tertiary hover:text-text-primary'
                          )}
                        >
                          {label}
                        </button>
                      ))}
                    </div>

                    {guidedSourceMode === 'topic' ? (
                      <label className="block">
                        <span className="mb-1.5 block text-[11px] font-black uppercase tracking-widest text-text-tertiary">主题</span>
                        <input
                          value={guidedTopic}
                          onFocus={() => {
                            if (guidedSourceMode !== 'topic') handleGuidedSourceModeChange('topic');
                          }}
                          onChange={(event) => {
                            setGuidedSourceMode('topic');
                            setSelectedAnchor(null);
                            setAnchorQuery('');
                            setAnchorResults([]);
                            setGuidedTopic(event.target.value);
                          }}
                          placeholder="比如：轻断食反弹"
                          className="h-11 w-full rounded-xl border border-black/[0.06] bg-white px-3 text-[14px] font-bold text-text-primary outline-none transition focus:border-accent-primary/40 focus:ring-2 focus:ring-accent-primary/10"
                        />
                      </label>
                    ) : (
                      <div className="space-y-3">
                        <label className="block">
                          <span className="mb-1.5 block text-[11px] font-black uppercase tracking-widest text-text-tertiary">锚点笔记</span>
                          <div className="relative">
                            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-text-tertiary/60" />
                            <input
                              value={anchorQuery}
                              onFocus={() => {
                                if (guidedSourceMode !== 'anchor') handleGuidedSourceModeChange('anchor');
                              }}
                              onChange={(event) => {
                                setGuidedSourceMode('anchor');
                                setGuidedTopic('');
                                setAnchorQuery(event.target.value);
                              }}
                              placeholder="搜索知识库"
                              className="h-11 w-full rounded-xl border border-black/[0.06] bg-white pl-9 pr-3 text-[14px] font-bold text-text-primary outline-none transition focus:border-accent-primary/40 focus:ring-2 focus:ring-accent-primary/10"
                            />
                          </div>
                        </label>

                        <div className="rounded-2xl border border-black/[0.05] bg-white/80 p-2 shadow-sm">
                          {selectedAnchor && (
                            <div className="mb-2 flex items-center justify-between gap-3 rounded-xl bg-accent-primary/5 px-3 py-2">
                              <div className="min-w-0">
                                <div className="text-[11px] font-black uppercase tracking-widest text-accent-primary">已选锚点</div>
                                <div className="truncate text-[13px] font-extrabold text-text-primary">{selectedAnchor.title}</div>
                              </div>
                              <button
                                type="button"
                                onClick={() => setSelectedAnchor(null)}
                                className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-text-tertiary hover:bg-black/[0.05] hover:text-text-primary"
                                aria-label="移除锚点"
                              >
                                <X className="h-4 w-4" />
                              </button>
                            </div>
                          )}
                          <div className="max-h-72 overflow-y-auto custom-scrollbar">
                            {anchorLoading ? (
                              <div className="px-3 py-8 text-center text-[12px] font-bold text-text-tertiary">加载知识库...</div>
                            ) : anchorResults.length > 0 ? (
                              anchorResults.map((item) => {
                                const selected = selectedAnchor?.id === item.id;
                                return (
                                  <button
                                    key={item.id}
                                    type="button"
                                    onClick={() => setSelectedAnchor(selected ? null : item)}
                                    className={clsx(
                                      'flex w-full items-start gap-3 rounded-xl px-3 py-2.5 text-left transition',
                                      selected ? 'bg-accent-primary/5' : 'hover:bg-black/[0.03]'
                                    )}
                                  >
                                    <div className="mt-0.5 shrink-0 text-accent-primary">
                                      {selected ? <CheckSquare className="h-4 w-4" /> : <Square className="h-4 w-4 text-text-tertiary/60" />}
                                    </div>
                                    <div className="min-w-0 flex-1">
                                      <div className="truncate text-[13px] font-extrabold text-text-primary">{item.title}</div>
                                      <div className="mt-0.5 line-clamp-2 text-[11px] font-bold leading-relaxed text-text-tertiary">{item.content || '暂无摘要'}</div>
                                    </div>
                                  </button>
                                );
                              })
                            ) : (
                              <div className="px-3 py-8 text-center text-[12px] font-bold text-text-tertiary">
                                {anchorQuery.trim() ? '没有匹配的笔记' : '暂无可选知识库内容'}
                              </div>
                            )}
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                ) : (
                  <p className="text-[15px] leading-relaxed text-text-tertiary font-medium mb-10 px-8">
                      系统将从您的知识库中随机抽取内容，
                      寻找它们之间的隐秘关联，激发前所未有的创作灵感。
                  </p>
                )}

                <button
                    onClick={startWander}
                    disabled={selectionMode === 'manual' && !hasGuidedInput}
                    className="group px-8 py-3 bg-text-primary hover:bg-text-primary/90 text-white rounded-[20px] text-[15px] font-extrabold transition-all flex items-center gap-3 shadow-[0_20px_40px_-10px_rgba(0,0,0,0.2)] active:scale-95 disabled:opacity-40"
                >
                    <Sparkles className="w-5 h-5 text-accent-primary group-hover:animate-pulse" />
                    <span>{selectionMode === 'manual' ? '按方向选题' : '开始灵感碰撞'}</span>
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
                                <span className="rounded-lg border border-border bg-surface-secondary px-2 py-1 text-[10px] font-black text-text-tertiary">
                                    {currentTopicSourceLabel}
                                </span>
                            </div>
                            <div className="flex items-center gap-2">
                                <button
                                    type="button"
                                    onClick={() => void abandonCurrentTopic()}
                                    disabled={!currentHistoryId || loading}
                                    className="flex h-10 items-center gap-2 px-4 border border-border text-text-secondary text-[13px] font-extrabold rounded-xl hover:bg-red-50 hover:border-red-100 hover:text-red-600 transition-all active:scale-95 disabled:opacity-40"
                                >
                                    <X className="w-4 h-4" />
                                    放弃
                                </button>
                                <button
                                    onClick={startCreateInRedClaw}
                                    disabled={!canStartCreate}
                                    className="flex h-10 items-center gap-2 px-5 bg-accent-primary text-white text-[13px] font-extrabold rounded-xl shadow-lg shadow-accent-primary/20 hover:bg-accent-hover transition-all active:scale-95 disabled:opacity-40"
                                >
                                    <MessageSquarePlus className="w-4 h-4" />
                                    AI创作
                                </button>
                            </div>
                        </div>

                        <div className="space-y-6">
                            <h2 className="text-3xl font-black text-text-primary leading-[1.15] tracking-tight">
                                {(activeOption?.topic.title || parsedResult.topic.title || '未命名选题')}
                            </h2>

                            <div className="flex items-start gap-3">
                                <div className="mt-1.5 w-1.5 h-1.5 rounded-full bg-accent-primary shrink-0" />
                                <div className="text-[15px] font-bold text-text-secondary leading-relaxed">
                                    {(activeOption?.content_direction || parsedResult.content_direction)}
                                </div>
                            </div>

                            {activeDirectionFrame && (
                                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                                    {[
                                      ['目标读者', activeDirectionFrame.target_reader],
                                      ['核心矛盾', activeDirectionFrame.core_tension],
                                      ['叙事角度', activeDirectionFrame.angle],
                                      ['素材切口', activeDirectionFrame.material_entry],
                                    ].map(([label, value]) => (
                                      <div key={label} className="rounded-2xl border border-black/[0.05] bg-black/[0.015] px-4 py-3">
                                        <div className="text-[10px] font-black uppercase tracking-widest text-text-tertiary">{label}</div>
                                        <div className="mt-1 text-[13px] font-bold leading-relaxed text-text-primary">{value || '待补充'}</div>
                                      </div>
                                    ))}
                                </div>
                            )}
                        </div>

                        {parseError && (
                            <div className="mt-6 space-y-3">
                                <div className="flex items-center gap-2 text-[12px] font-bold text-red-500 bg-red-50 border border-red-100 rounded-xl px-4 py-3">
                                    <X className="w-4 h-4 shrink-0" />
                                    {parseError}
                                </div>
                                {validationIssues.length > 0 && (
                                    <div className="rounded-2xl border border-red-100 bg-red-50/60 px-4 py-4">
                                        <div className="text-[11px] font-black uppercase tracking-widest text-red-500">需要补强</div>
                                        <div className="mt-2 space-y-2">
                                            {validationIssues.slice(0, 6).map((issue) => (
                                                <div key={`${issue.path}-${issue.code}`} className="flex items-start gap-2 text-[12px] font-bold text-red-500">
                                                    <div className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-red-400" />
                                                    <span>{issue.message}</span>
                                                </div>
                                            ))}
                                        </div>
                                    </div>
                                )}
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
                <div className="space-y-3 rounded-lg border border-border bg-surface-secondary p-6">
                  <div className="text-sm text-center text-text-secondary">{parseError}</div>
                  {validationIssues.length > 0 && (
                    <div className="space-y-2">
                      {validationIssues.slice(0, 6).map((issue) => (
                        <div key={`${issue.path}-${issue.code}`} className="text-[12px] font-bold text-red-500">
                          {issue.message}
                        </div>
                      ))}
                    </div>
                  )}
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
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      const nextValue = !showAbandonedTopics;
                      setShowAbandonedTopics(nextValue);
                      void loadHistoryList({ includeAbandoned: nextValue });
                    }}
                    className="flex h-9 items-center gap-1.5 rounded-xl bg-black/[0.04] px-3 text-[11px] font-bold text-text-tertiary hover:bg-black/[0.08] hover:text-text-primary transition-all active:scale-95"
                  >
                    {showAbandonedTopics ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                    {showAbandonedTopics ? '隐藏已放弃' : '展示已放弃'}
                  </button>
                  <button onClick={() => setShowHistory(false)} className="flex h-9 w-9 items-center justify-center rounded-xl bg-black/[0.04] text-text-tertiary hover:bg-black/[0.08] hover:text-text-primary transition-all active:scale-90">
                    <X className="w-4.5 h-4.5" />
                  </button>
                </div>
            </div>
            <div className="overflow-y-auto flex-1 p-3 space-y-1.5 custom-scrollbar">
              {visibleHistoryList.length === 0 ? (
                <div className="p-12 text-center">
                    <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-black/[0.02] text-text-tertiary/20 mx-auto mb-4">
                        <History className="w-8 h-8" />
                    </div>
                    <p className="text-[13px] font-bold text-text-tertiary/60">{showAbandonedTopics ? '暂无漫步历史记录' : '暂无待处理选题'}</p>
                </div>
              ) : (
                visibleHistoryList.map(record => {
                  const parsedHistoryResult = normalizeWanderResultPayload(record.result);
                  const recordItems = normalizeWanderItemsPayload(record.items);
                  const title = parsedHistoryResult?.options?.[resolveSelectedOptionIndex(parsedHistoryResult)]?.topic.title
                    || parsedHistoryResult?.topic.title
                    || getHistoryTitle(record);
                  const sourceLabel = topicSourceLabel(parsedHistoryResult, recordItems);
                  const isActive = currentHistoryId === record.id;
                  const abandoned = isAbandonedHistoryRecord(record);
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
                            : abandoned
                              ? "opacity-60 hover:bg-black/[0.02] border border-transparent"
                              : "hover:bg-black/[0.02] border border-transparent"
                      )}
                    >
                      <div className="flex-1 min-w-0">
                        <div className={clsx("text-[14px] font-extrabold truncate mb-1 tracking-tight", isActive ? "text-accent-primary" : abandoned ? "text-text-secondary" : "text-text-primary")}>
                          {title}
                        </div>
                        <div className="text-[10px] font-bold text-text-tertiary/60 uppercase tracking-tighter flex items-center gap-2">
                          <span>{formatDate(getHistoryCreatedAt(record))}</span>
                          <span className="text-text-tertiary font-black">{sourceLabel}</span>
                          {isActive && <span className="w-1 h-1 rounded-full bg-accent-primary" />}
                          {isActive && <span className="text-accent-primary font-black">CURRENT</span>}
                          {abandoned && <span className="text-text-tertiary font-black">已放弃</span>}
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
