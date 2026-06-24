import { useState, useEffect, useRef, useCallback, useMemo, type ReactNode } from 'react';
import { RefreshCw, Sparkles, History, X, Trash2, Dices, FileText, Play, MessageSquarePlus, Search, Square, CheckSquare, Shuffle, Check, Eye, EyeOff } from 'lucide-react';
import { clsx } from 'clsx';
import { WanderLoadingDice } from '../components/wander/WanderLoadingDice';
import { resolveAssetUrl } from '../utils/pathManager';
import type { PendingChatMessage } from '../features/app-shell/types';
import {
  AUTHORING_ALLOWED_OPERATE_ACTIONS,
  AUTHORING_ALLOWED_TOOLS,
  buildTaskBriefPromptSection,
} from '../utils/redclawAuthoring';
import type { AuthoringTaskHints, TaskBriefArticleStrategy, TaskBriefSeed } from '../utils/redclawAuthoring';
import { usePageRefresh } from '../hooks/usePageRefresh';
import { uiDebug } from '../utils/uiDebug';
import { APP_BRAND } from '../config/brand';
import { subscribeSettingsUpdated } from '../bridge/appEvents';

interface WanderItem {
  id: string;
  type: 'note' | 'video';
  title: string;
  content: string;
  cover?: string;
  meta?: Record<string, unknown>;
}

interface WanderVisualBlock {
  blockId: string;
  text: string;
  path?: string;
  page?: number;
  visualUnitId?: string;
}

interface KnowledgeCatalogSummary {
  itemId: string;
  kind: 'redbook-note' | 'youtube-video' | 'document-source';
  noteType?: string;
  captureKind?: string;
  title: string;
  author?: string;
  sourceUrl?: string;
  folderPath?: string;
  rootPath?: string;
  coverUrl?: string;
  thumbnailUrl?: string;
  previewText?: string;
  createdAt?: string;
  tags?: string[];
  hasVideo?: boolean;
  hasTranscript?: boolean;
  status?: string;
  sampleFiles?: string[];
  fileCount?: number;
  readyForWander?: boolean;
  wanderIndexStatus?: 'ready' | 'indexing' | 'failed' | 'not_indexed';
  wanderVisualBlocks?: WanderVisualBlock[];
}

interface KnowledgeListPageResponse {
  items: KnowledgeCatalogSummary[];
  nextCursor?: string | null;
  total?: number;
}

interface GuidedWanderItemsResponse {
  items?: WanderItem[];
  warning?: string | null;
  candidateCount?: number;
  query?: string;
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

interface KnowledgeFolderReference {
  folderName: string;
  folderPath: string;
  metaPath: string;
  contentHint: string;
  suggestedReadPaths: string[];
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
  status?: string | null;
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

interface WanderProps {
  isActive?: boolean;
  onExecutionStateChange?: (active: boolean) => void;
  onTitleBarContentChange?: (content: ReactNode | null) => void;
  onNavigateToRedClaw?: (payload: PendingChatMessage) => void;
}

type WanderSelectionMode = 'random' | 'manual' | 'comments';
type WanderLaunchMode = 'random' | 'comments';
type CommentSourceMode = 'random' | 'custom';

export function Wander({ isActive = true, onExecutionStateChange, onTitleBarContentChange, onNavigateToRedClaw }: WanderProps) {
  const [items, setItems] = useState<WanderItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [multiChoiceEnabled, setMultiChoiceEnabled] = useState(false);
  const [isSavingMode, setIsSavingMode] = useState(false);
  const [selectionMode, setSelectionMode] = useState<WanderSelectionMode>('random');
  const [activeSourceMode, setActiveSourceMode] = useState<WanderSelectionMode>('random');
  const [pendingStartMode, setPendingStartMode] = useState<WanderLaunchMode | null>(null);
  const [guidedSourceMode, setGuidedSourceMode] = useState<'topic' | 'anchor'>('topic');
  const [guidedTopic, setGuidedTopic] = useState('');
  const [anchorQuery, setAnchorQuery] = useState('');
  const [anchorResults, setAnchorResults] = useState<WanderItem[]>([]);
  const [selectedAnchor, setSelectedAnchor] = useState<WanderItem | null>(null);
  const [anchorLoading, setAnchorLoading] = useState(false);
  const [commentCandidateQuery, setCommentCandidateQuery] = useState('');
  const [commentCandidates, setCommentCandidates] = useState<WanderItem[]>([]);
  const [selectedCommentItem, setSelectedCommentItem] = useState<WanderItem | null>(null);
  const [commentCandidatesLoading, setCommentCandidatesLoading] = useState(false);
  const [commentSourceMode, setCommentSourceMode] = useState<CommentSourceMode>('random');
  const [guidedWarning, setGuidedWarning] = useState<string | null>(null);
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
  const topicCenterViewedRef = useRef(false);
  const activeOption = parsedResult?.options?.[selectedOptionIndex];
  const activeDirectionFrame = activeOption?.direction_frame || parsedResult?.direction_frame;
  const hasGuidedInput = guidedSourceMode === 'topic'
    ? Boolean(guidedTopic.trim())
    : Boolean(selectedAnchor);

  const trackTopicEvent = useCallback((
    event: Parameters<typeof window.ipcRenderer.analytics.track>[0],
    properties: Record<string, string | number | boolean | null | undefined> = {},
  ) => {
    void window.ipcRenderer.analytics.track(event, {
      surface: 'wander',
      origin: 'renderer',
      properties,
    });
  }, []);

  useEffect(() => {
    if (!isActive || topicCenterViewedRef.current) return;
    topicCenterViewedRef.current = true;
    trackTopicEvent('topic_center_viewed');
  }, [isActive, trackTopicEvent]);

  function catalogSummaryToWanderItem(item: KnowledgeCatalogSummary): WanderItem {
    const isVideo = item.kind === 'youtube-video' || Boolean(item.hasVideo);
    const sourceType = item.kind === 'document-source'
      ? 'document'
      : item.kind === 'youtube-video'
        ? 'youtube'
        : (item.captureKind || item.noteType || 'note');
    return {
      id: item.itemId,
      type: isVideo ? 'video' : 'note',
      title: item.title || '未命名内容',
      content: item.previewText || item.sourceUrl || '',
      cover: item.coverUrl || item.thumbnailUrl || undefined,
      meta: {
        sourceType,
        sourceName: item.title,
        sourceKind: item.kind,
        folderPath: item.folderPath || item.rootPath,
        filePath: item.rootPath,
        relativePath: item.sampleFiles?.[0] || '',
        sampleFiles: item.sampleFiles || [],
        sourceUrl: item.sourceUrl,
        tags: item.tags || [],
        status: item.status,
        readyForWander: item.readyForWander,
        wanderIndexStatus: item.wanderIndexStatus,
        wanderVisualBlocks: item.wanderVisualBlocks || [],
        hasTranscript: Boolean(item.hasTranscript),
      },
    };
  }

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
    });
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

  function getHistoryTitle(record: WanderHistoryRecord): string {
    const parsed = normalizeWanderResultPayload(record.result);
    return parsed?.options?.[resolveSelectedOptionIndex(parsed)]?.topic.title
      || parsed?.topic?.title
      || '未命名选题';
  }

  function isAbandonedHistoryRecord(record: WanderHistoryRecord): boolean {
    return String(record.status || '').trim() === 'abandoned' || Boolean(record.abandonedAt);
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

  const inferSuggestedReadPaths = (
    item: WanderItem,
    folderPath: string,
    folderName: string,
  ): string[] => {
    const meta = (item.meta || {}) as Record<string, unknown>;
    const sampleFiles = Array.isArray(meta.sampleFiles)
      ? meta.sampleFiles.map((value) => String(value || '').trim()).filter(Boolean)
      : [];
    const normalize = (value: unknown): string | null => {
      if (typeof value !== 'string') return null;
      const trimmed = value.trim();
      if (!trimmed) return null;
      if (trimmed.includes('/') || trimmed.includes('\\') || trimmed.startsWith('workspace://') || trimmed.startsWith('knowledge://')) {
        return trimmed;
      }
      return `${folderPath}/${trimmed}`;
    };
    const normalizedSampleFiles = sampleFiles
      .map((value) => normalize(value))
      .filter((value): value is string => Boolean(value));
    const sourceType = String(meta.sourceType || '').trim().toLowerCase();
    const candidates = [
      `${folderPath}/meta.json`,
      ...normalizedSampleFiles,
      normalize(meta.subtitleFile),
      normalize(meta.transcriptFile),
      normalize(meta.contentFile),
    ];
    if (sourceType === 'youtube') {
      const videoId = typeof meta.videoId === 'string' && meta.videoId.trim()
        ? meta.videoId.trim()
        : folderName.replace(/^youtube_/, '').trim();
      if (videoId) {
        candidates.push(`${folderPath}/${videoId}.txt`);
      }
    }
    candidates.push(`${folderPath}/content.md`);
    return Array.from(new Set(candidates.filter((value): value is string => Boolean(value))));
  };

  const buildKnowledgeFolderReference = (item: WanderItem): KnowledgeFolderReference => {
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
        suggestedReadPaths: folderPath ? inferSuggestedReadPaths(item, folderPath, fallbackName) : [],
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
        suggestedReadPaths: filePath ? [filePath] : [],
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
      suggestedReadPaths: inferSuggestedReadPaths(item, fallbackFolderPath, folderName),
    };
  };

  const getWanderVisualBlocks = (item: WanderItem): WanderVisualBlock[] => {
    const raw = item.meta?.wanderVisualBlocks;
    if (!Array.isArray(raw)) return [];
    return raw
      .map((block): WanderVisualBlock | null => {
        if (!block || typeof block !== 'object') return null;
        const payload = block as Record<string, unknown>;
        const blockId = typeof payload.blockId === 'string' ? payload.blockId.trim() : '';
        const text = typeof payload.text === 'string' ? payload.text.trim() : '';
        if (!blockId || !text) return null;
        return {
          blockId,
          text,
          path: typeof payload.path === 'string' ? payload.path : undefined,
          page: typeof payload.page === 'number' ? payload.page : undefined,
          visualUnitId: typeof payload.visualUnitId === 'string' ? payload.visualUnitId : undefined,
        };
      })
      .filter((block): block is WanderVisualBlock => Boolean(block));
  };

  const formatWanderVisualBlocksForRedClaw = (item: WanderItem): string => {
    const blocks = getWanderVisualBlocks(item).slice(0, 6);
    if (blocks.length === 0) return '';
    return [
      '图片文字摘录：',
      ...blocks.map((block, index) => {
        const source = [
          block.path || 'image',
          typeof block.page === 'number' ? `page=${block.page}` : '',
          `blockId=${block.blockId}`,
        ].filter(Boolean).join(' ');
        return `${index + 1}. ${source}：${block.text.replace(/\s+/g, ' ').slice(0, 420)}`;
      }),
    ].join('\n');
  };

  const canStartCreate = Boolean(parsedResult && onNavigateToRedClaw && validationIssues.length === 0 && !parseError);

  const startCreateInRedClaw = () => {
    if (!parsedResult || !onNavigateToRedClaw || validationIssues.length > 0 || parseError) return;
    const selectedOption = parsedResult.options?.[selectedOptionIndex];
    const activeTopic = selectedOption?.topic || parsedResult.topic;
    const activeDirection = selectedOption?.content_direction || parsedResult.content_direction;
    const referenceCards = items.map((item, index) => {
      const folderRef = buildKnowledgeFolderReference(item);
      return {
        title: item.title || '(无标题)',
        itemType: item.type,
        tag: '可选灵感素材',
        folderPath: folderRef.folderPath,
        summary: String(item.content || '').replace(/\s+/g, ' ').trim().slice(0, 96),
        cover: resolveAssetUrl(item.cover),
      };
    });
    const materialText = items.map((item, index) => {
      const order = index + 1;
      const folderRef = buildKnowledgeFolderReference(item);
      const visualText = formatWanderVisualBlocksForRedClaw(item);
      return [
        `素材${order}`,
        `类型：${item.type === 'video' ? '视频笔记' : ((item.meta as Record<string, unknown> | undefined)?.sourceType === 'document' ? '文档' : '图文笔记')}`,
        `标题：${item.title || '(无标题)'}`,
        `素材目录：${folderRef.folderPath}`,
        folderRef.suggestedReadPaths.length > 0
          ? `建议读取：${folderRef.suggestedReadPaths.slice(0, 3).join('、')}`
          : `读取方式：先 List 素材目录，再 Read 具体文件`,
        visualText,
      ].filter(Boolean).join('\n');
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
        rootPath: typeof meta.filePath === 'string' ? meta.filePath : folderRef.folderPath,
        tags: Array.isArray(meta.tags) ? meta.tags.filter((tag): tag is string => typeof tag === 'string') : undefined,
        hasTranscript: Boolean(meta.hasTranscript),
      };
    });
    const initialArticleStrategy: TaskBriefArticleStrategy = {
      articleStyle: '待判断',
      readerQuestion: '',
      corePromise: '',
      titleDirection: '',
      openingDirection: '',
      structureDirection: '',
      avoidDirection: [],
    };
    const taskBrief: TaskBriefSeed = {
      taskType: 'wander_manuscript_creation',
      goal: `围绕选题「${activeTopic.title}」创作一篇独立小红书文案，并保存到 wander 稿件工程。`,
      currentStage: 'init',
      todo: [
        { id: 'research_decision', text: '判断是否需要外部调研；需要当前事实时调用 web.search', status: 'todo' },
        { id: 'research_brief', text: '把素材和搜索结果压缩成可写作的事实 brief', status: 'todo' },
        { id: 'article_strategy', text: '根据选题和调研结果判断文章打法，并写入 articleStrategy', status: 'todo' },
        { id: 'title_skill', text: '带着 articleStrategy 调用 xhs-title，生成分风格候选标题并选出最终标题', status: 'todo' },
        { id: 'writing_skill', text: '带着 articleStrategy 和最终标题调用 writing-style 完成正文写作和自检', status: 'todo' },
        { id: 'save', text: '创建稿件工程并用 Write 保存最终文案', status: 'todo' },
      ],
      importantContext: [
        { kind: 'constraint', text: '这是一篇围绕选题独立创作的新内容，不是评论区洞察说明或素材复盘。' },
        { kind: 'constraint', text: '原笔记和评论只可作为后台参考数据来源，正文禁止出现“原文”“原笔记”“评论区”“评论里”“有用户评论”“大家在评论区问”等来源痕迹。' },
        { kind: 'validation', text: '如果任务涉及当下事实、数据、平台规则、产品、价格、政策、人物或案例，必须先用 web.search 调研并把可用事实写入 brief。' },
        { kind: 'validation', text: '标题和正文必须共同服从 articleStrategy；不能标题走悬念、正文走解释，或标题绕开读者最直接的问题。' },
        { kind: 'validation', text: '最终保存前必须检查正文是否使用了 brief 中的关键事实、是否调用了 xhs-title 和 writing-style、是否没有来源痕迹。' },
      ],
      articleStrategy: initialArticleStrategy,
      titleCandidates: [],
      domain: {
        platform: 'xiaohongshu',
        topicTitle: activeTopic.title,
        contentDirection: activeDirection || '',
        referenceSourceMode: activeSourceMode === 'comments' ? 'comment_insight' : 'wander',
        forbiddenFinalPhrases: ['原文', '原笔记', '评论区', '评论里', '有用户评论', '大家在评论区问'],
      },
    };

    const content = [
      '请基于以下“选题中心结果”创作一篇独立的小红书文案。',
      '',
      '站位：这是围绕该选题重新写一篇新的独立内容，不是为“评论区洞察”写说明，也不是复盘素材来源。',
      '选题中心素材只是后台参考数据来源，只能用来校准事实、需求、场景、痛点和表达方向；正文中禁止出现“原文”“原笔记”“评论区”“评论里”“有用户评论”“大家在评论区问”等来源痕迹。',
      '如果参考素材来自评论洞察，也必须把它转化为独立内容里的读者问题、场景或判断，不要把读者带回素材现场。',
      '可按需读取下方素材目录或用户档案；素材目录不是正文文件，如需读取，请优先 Read “建议读取”里的具体文件，或先 List 目录再 Read 具体文件。',
      '本任务必须按五个连续阶段完成，不能跳过，也不能把前一阶段的技能输出当成后一阶段的完整上下文。',
      '开始执行后，先输出一句简短、自然的过程说明，让用户知道你会先初始化工作 brief 并核对是否需要外部调研；不要输出计划列表或整篇正文。',
      '阶段一：调研判断。随后调用 `taskBrief.update` 初始化工作 brief；然后判断这个选题是否涉及当下事实、产品、平台规则、价格、政策、人物、案例、数据或其它容易过期的信息；涉及就必须调用 `Operate(resource="web", operation="search", input={ "query": "<搜索词>" })` 做搜索，并把可用事实、来源和不确定点写回 Task Brief。若不需要外部调研，也要把“不需要外部调研”的判断和理由写回 Task Brief。',
      '阶段二：文章打法定向。根据选题、调研事实和读者真实好奇心，先判断 `articleStrategy`，再调用 `taskBrief.update` 写入：articleStyle、readerQuestion、corePromise、titleDirection、openingDirection、structureDirection、avoidDirection。这个阶段要先回答“读者看到这个选题，脑子里最直接的问题是什么”，并判断标题和正文应该走直接疑问、反常识、数据冲击、故事化、观点型还是其它打法。',
      '阶段三：标题。必须显式调用一次 `Operate(resource="skills", operation="invoke", input={ "name": "xhs-title" })`，让日志可审计；标题必须服从 `articleStrategy`，不要自由套公式。生成至少 4 个分风格候选标题，至少包含“直接疑问”和“悬念表达”两类，并把完整 titleCandidates、selectedTitle、selectedTitleReason 写回 Task Brief。最终选择时优先贴近 readerQuestion；除非悬念标题明显更强，否则商业解释型/反常识型内容优先直接疑问。',
      '阶段四：正文。拿阶段三选出的最终标题作为正文唯一标题，然后必须显式调用一次 `Operate(resource="skills", operation="invoke", input={ "name": "writing-style" })`，让日志可审计；正文阶段由 `writing-style` 主导，但必须同时服从 `articleStrategy`：开头兑现 openingDirection，结构服从 structureDirection，信息密度和语气服从 articleStyle。',
      '阶段五：保存。创建稿件工程并保存最终文案。',
      '如果 `writing-style` 要求读取用户档案或创作者档案，正文动笔前必须先读取；不要因为已经完成标题阶段，就省略写作风格上下文。创建稿件工程后，后续 `Write` 的 content 仍然必须是按 `writing-style` 自检后的完整正文。',
      '完稿前按 `articleStrategy` 和 `writing-style` 双重自检标题、开头、结构、事实边界、语气和禁区；内容质量优先于素材覆盖率。正文不要写成报告式大纲，不要输出孤立分隔线，不要只模仿素材格式。',
      '',
      '## 灵感选题',
      `标题：${activeTopic.title}`,
      `内容方向：${activeDirection || ''}`,
      '',
      buildTaskBriefPromptSection(taskBrief),
      '',
      '## 参考素材（来自选题中心）',
      materialText,
      '',
      '## 输出要求',
      '1. 先完成调研判断；需要当前事实时必须搜索，不需要时不要为了形式搜索。',
      '2. 再完成文章打法定向，并把完整 `articleStrategy` 写入 Task Brief；标题和正文都必须受它约束。',
      '3. 再显式调用 `xhs-title` 完成标题阶段，内部选择 1 个最终标题；必须把完整候选标题、评分和选择理由写入 Task Brief；最终稿件和最终回复都只保留最终标题。',
      '4. 再显式调用 `writing-style` 完成正文阶段；正文必须按该技能规则和 `articleStrategy` 写作、自检，不能只沿用标题阶段的上下文。',
      '5. 正文必须是一篇独立小红书内容，禁止提到参考来源来自原笔记或评论区。',
      '6. 如目标工程不存在，先调用 `Operate(resource="manuscripts", operation="createProject", input={ "kind": "post", "parent": "wander", "title": "<最终标题>" })` 创建 post 文件夹稿件工程。',
      '7. 完成后调用 `Write(path="manuscripts://current", content="<最终标题和按 articleStrategy + writing-style 自检后的完整正文>")` 保存；保存成功后的最终回复只给运行总结和稿件链接，不要重复全文。',
    ].join('\n');

    onNavigateToRedClaw({
      content,
      displayContent: `基于选题中心灵感开始创作：${parsedResult.topic.title}`,
      sessionRouting: 'new',
      taskHints: {
        intent: 'manuscript_creation',
        executionProfile: 'artifact-authoring',
        artifactType: 'manuscript',
        writeTarget: 'manuscripts://current',
        requiredSkill: ['writing-style', 'xhs-title'],
        activeSkills: ['writing-style', 'xhs-title'],
        allowedTools: [...AUTHORING_ALLOWED_TOOLS, 'web'],
        allowedOperateActions: [...AUTHORING_ALLOWED_OPERATE_ACTIONS, 'web.search'],
        allowedWriteTargets: ['manuscripts://current'],
        requireSourceRead: false,
        requireProfileRead: false,
        requireSave: true,
        requireTaskBrief: true,
        requireSkillInvocations: ['xhs-title', 'writing-style'],
        taskBrief,
        forbiddenFinalPhrases: ['原文', '原笔记', '评论区', '评论里', '有用户评论', '大家在评论区问'],
        deferredDiscovery: false,
        teamEscalation: 'disabled',
        saveArtifact: 'folder',
        saveSubdir: 'wander',
        platform: 'xiaohongshu',
        taskType: 'direct_write',
        formatTarget: 'markdown',
        sourceMode: 'knowledge',
      },
      attachment: {
        type: 'wander-references',
        title: '选题中心参考素材',
        items: referenceCards,
      },
      knowledgeReferences,
    });
    trackTopicEvent('topic_used_for_task', {
      sourceMode: activeSourceMode,
      hasBrief: true,
      evidenceCount: items.length,
      optionIndex: selectedOptionIndex,
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
    await window.ipcRenderer.saveSettings({
      wander_deep_think_enabled: patch.wander_deep_think_enabled,
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

  const handleSelectionModeChange = (mode: 'random' | 'manual') => {
    if (loading) return;
    trackTopicEvent('topic_source_selected', {
      sourceMode: mode,
    });
    setSelectionMode(mode);
    setParseError(null);
    setValidationIssues([]);
    setGuidedWarning(null);
    if (phase !== 'running') {
      setPhase('idle');
      setShowFinal(false);
      setParsedResult(null);
      setSelectedOptionIndex(0);
      setItems([]);
      setCurrentHistoryId(null);
      setPendingStartMode(null);
      activeRequestIdRef.current = '';
    }
  };

  const handleGuidedSourceModeChange = (mode: 'topic' | 'anchor') => {
    trackTopicEvent('topic_source_selected', {
      sourceMode: 'manual',
      guidedSourceMode: mode,
    });
    setGuidedSourceMode(mode);
    setParseError(null);
    if (mode === 'topic') {
      setSelectedAnchor(null);
      setAnchorQuery('');
      setAnchorResults([]);
    } else {
      setGuidedTopic('');
    }
  };

  // 加载历史记录列表
  const loadHistoryList = useCallback(async (options?: { includeAbandoned?: boolean }) => {
    try {
      const list = await window.ipcRenderer.wander.listHistory({
        includeAbandoned: Boolean(options?.includeAbandoned),
      }) as WanderHistoryRecord[];
      const normalized = Array.isArray(list) ? list : [];
      setHistoryList(normalized);
      return normalized.filter(record => !isAbandonedHistoryRecord(record));
    } catch (error) {
      console.error('Failed to load wander history list:', error);
      return historyListRef.current.filter(record => !isAbandonedHistoryRecord(record));
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
      setPendingStartMode(null);
      setShowHistory(false);
      return;
      }
      setItems(parsedItems);
      setParsedResult(parsedRes);
      setSelectedOptionIndex(resolveSelectedOptionIndex(parsedRes));
      setParseError(null);
      setGuidedWarning(null);
      setPhase('done');
      setShowFinal(true);
      setCurrentHistoryId(record.id);
      setPendingStartMode(null);
      setShowHistory(false);
      trackTopicEvent('topic_selected', {
        source: 'history',
        topicStatus: isAbandonedHistoryRecord(record) ? 'abandoned' : 'active',
        evidenceCount: normalizeWanderItemsPayload(record.items).length,
      });
    } catch (e) {
      console.error('Failed to parse history:', e);
    }
  };

  // 删除历史记录
  const deleteHistory = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    await window.ipcRenderer.wander.deleteHistory(id);
    trackTopicEvent('topic_deleted', {
      source: 'history',
    });
    const newList = historyList.filter(h => h.id !== id);
    const activeList = newList.filter(record => !isAbandonedHistoryRecord(record));
    setHistoryList(newList);
    if (currentHistoryId === id) {
      if (activeList.length > 0) {
        loadHistory(activeList[0]);
      } else {
        setPhase('idle');
        setShowFinal(false);
        setParsedResult(null);
        setItems([]);
        setCurrentHistoryId(null);
        setPendingStartMode(null);
      }
    }
  };

  const clearTopicDetail = () => {
    setPhase('idle');
    setShowFinal(false);
    setParsedResult(null);
    setItems([]);
    setCurrentHistoryId(null);
    setSelectedOptionIndex(0);
    setPendingStartMode(null);
  };

  const abandonSelectedTopic = async () => {
    if (!selectedTopic || selectedTopic.abandoned || loading) return;
    const targetId = selectedTopic.id;
    const isPersistedTopic = targetId !== 'current-topic';

    try {
      let nextList = historyList.filter(record => record.id !== targetId && !isAbandonedHistoryRecord(record));
      if (isPersistedTopic) {
        await window.ipcRenderer.wander.abandonHistory(targetId);
        nextList = await loadHistoryList({ includeAbandoned: showAbandonedTopics });
      }

      if (nextList.length > 0) {
        loadHistory(nextList[0]);
      } else {
        clearTopicDetail();
      }
      trackTopicEvent('topic_abandoned_toggled', {
        source: isPersistedTopic ? 'history' : 'current',
        topicStatus: 'abandoned',
      });
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
      setPendingStartMode(null);
    }
  }, [currentHistoryId, items.length, loadHistoryList, loading, parsedResult, phase, showFinal, syncWanderSettings]);

  usePageRefresh({
    isActive,
    refresh: refreshPage,
  });

  useEffect(() => {
    if (!isActive || !showAbandonedTopics) return;
    void loadHistoryList({ includeAbandoned: true });
  }, [isActive, loadHistoryList, showAbandonedTopics]);

  useEffect(() => {
    if (!isActive) return;
    const handleSettingsUpdated = () => {
      void syncWanderSettings();
    };
    return subscribeSettingsUpdated(handleSettingsUpdated);
  }, [isActive, syncWanderSettings]);

  useEffect(() => {
    if (!isActive || selectionMode !== 'manual' || guidedSourceMode !== 'anchor') return;
    const query = anchorQuery.trim();
    let cancelled = false;
    const timer = window.setTimeout(() => {
      setAnchorLoading(true);
      const request: Record<string, unknown> = {
        kind: 'redbook-note',
        limit: 24,
        sort: 'updated',
        readyForWanderOnly: false,
      };
      if (query) {
        request.query = query;
      }
      window.ipcRenderer.knowledge.listPage<KnowledgeListPageResponse>(request)
        .then((response) => {
          if (cancelled) return;
          const nextItems = Array.isArray(response?.items)
            ? response.items.map(catalogSummaryToWanderItem)
            : [];
          setAnchorResults(nextItems);
        })
        .catch((error) => {
          if (cancelled) return;
          console.error('Failed to search wander anchor items:', error);
          setAnchorResults([]);
        })
        .finally(() => {
          if (!cancelled) {
            setAnchorLoading(false);
          }
        });
    }, 280);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [anchorQuery, guidedSourceMode, isActive, selectionMode]);

  useEffect(() => {
    if (!isActive || pendingStartMode !== 'comments' || commentSourceMode !== 'custom') return;
    let cancelled = false;
    setCommentCandidatesLoading(true);
    window.ipcRenderer.wander.listCommentCandidates<WanderItem[]>()
      .then((items) => {
        if (cancelled) return;
        const nextItems = Array.isArray(items) ? items : [];
        setCommentCandidates(nextItems);
        setSelectedCommentItem((current) => {
          if (!current) return null;
          return nextItems.some((item) => item.id === current.id) ? current : null;
        });
      })
      .catch((error) => {
        if (cancelled) return;
        console.error('Failed to load wander comment candidates:', error);
        setCommentCandidates([]);
      })
      .finally(() => {
        if (!cancelled) {
          setCommentCandidatesLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [commentSourceMode, isActive, pendingStartMode]);

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
      const resultItems = Array.isArray(data.items) ? data.items as WanderItem[] : null;
      if (error) {
        setParsedResult(normalizedResult);
        setParseError(error);
        setValidationIssues(normalizedIssues);
        trackTopicEvent('topic_generation_failed', {
          sourceMode: activeSourceMode,
          reason: normalizedIssues.length > 0 ? 'validation' : 'runtime',
          issueCount: normalizedIssues.length,
        });
        if (resultItems) {
          setItems(resultItems);
          activeItemsRef.current = resultItems;
        }
        if (normalizedResult) {
          setSelectedOptionIndex(resolveSelectedOptionIndex(normalizedResult));
        }
        setLiveStatus(toStableTwoLineText('选题失败'));
      } else {
        if (normalizedResult) {
          const nextItems = resultItems || activeItemsRef.current;
          setParsedResult(normalizedResult);
          setSelectedOptionIndex(resolveSelectedOptionIndex(normalizedResult));
          setValidationIssues([]);
          setItems(nextItems);
          activeItemsRef.current = nextItems;
          setLiveStatus(toStableTwoLineText('选题完成'));
          if (historyId) {
            setCurrentHistoryId(historyId);
            void loadHistoryList();
          }
          trackTopicEvent('topic_generation_completed', {
            sourceMode: activeSourceMode,
            topicCount: normalizedResult.options?.length || 1,
            evidenceCount: nextItems.length,
            hasWarning: Boolean(guidedWarning),
          });
        } else {
          setParsedResult(null);
          setParseError('结果解析失败');
          trackTopicEvent('topic_generation_failed', {
            sourceMode: activeSourceMode,
            reason: 'parse',
          });
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
  }, [loadHistoryList]);

  const startWander = async (modeOverride?: WanderSelectionMode) => {
    const effectiveSelectionMode = modeOverride || selectionMode;
    const requestId = `wander-ui-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    activeRequestIdRef.current = requestId;
    setActiveSourceMode(effectiveSelectionMode);
    setPendingStartMode(null);
    setPhase('running');
    setLoading(true);
    setLiveStatus(toStableTwoLineText(
      effectiveSelectionMode === 'manual'
        ? '正在按方向选择素材...'
        : effectiveSelectionMode === 'comments'
          ? '正在选择评论素材...'
          : '正在初始化选题...'
    ));
    setProgressCards([]);
    setParsedResult(null);
    setSelectedOptionIndex(0);
    setParseError(null);
    setValidationIssues([]);
    setGuidedWarning(null);
    setItems([]);
    setShowFinal(false);
    setCurrentHistoryId(null);
    trackTopicEvent('topic_generation_started', {
      sourceMode: effectiveSelectionMode,
      guidedSourceMode: effectiveSelectionMode === 'manual' ? guidedSourceMode : null,
      commentSourceMode: effectiveSelectionMode === 'comments' ? commentSourceMode : null,
      multiChoice: effectiveSelectionMode === 'comments' ? false : multiChoiceEnabled,
    });
    try {
      await new Promise<void>((resolve) => {
        window.requestAnimationFrame(() => resolve());
      });
      let nextItems: WanderItem[] = [];
      if (effectiveSelectionMode === 'manual') {
        if (!hasGuidedInput) {
          setParseError(guidedSourceMode === 'topic' ? '请先输入主题。' : '请先选择一篇锚点笔记。');
          setPhase('done');
          setShowFinal(true);
          setLoading(false);
          activeRequestIdRef.current = '';
          trackTopicEvent('topic_generation_failed', {
            sourceMode: effectiveSelectionMode,
            reason: 'missing_input',
          });
          return;
        }
        const guided = await window.ipcRenderer.wander.getGuidedItems({
          topic: guidedSourceMode === 'topic' ? guidedTopic.trim() : '',
          seedText: '',
          anchorItem: guidedSourceMode === 'anchor' ? selectedAnchor : null,
          targetCount: 3,
        }) as GuidedWanderItemsResponse;
        nextItems = Array.isArray(guided?.items) ? guided.items : [];
        setGuidedWarning(typeof guided?.warning === 'string' ? guided.warning : null);
        if (nextItems.length < 3) {
          setItems(nextItems);
          activeItemsRef.current = nextItems;
          setParseError(typeof guided?.warning === 'string'
            ? guided.warning
            : '系统没有补齐到 3 篇方向相近的笔记，请换一个主题或选择信息更完整的锚点笔记。');
          setPhase('done');
          setShowFinal(true);
          setLoading(false);
          activeRequestIdRef.current = '';
          trackTopicEvent('topic_generation_failed', {
            sourceMode: effectiveSelectionMode,
            reason: 'insufficient_sources',
            evidenceCount: nextItems.length,
          });
          return;
        }
      } else if (effectiveSelectionMode === 'comments') {
        nextItems = commentSourceMode === 'custom' && selectedCommentItem ? [selectedCommentItem] : [];
      } else {
        nextItems = await window.ipcRenderer.wander.getRandom() as WanderItem[];
      }
      setItems(nextItems);
      activeItemsRef.current = nextItems;
      if (nextItems.length === 0 && effectiveSelectionMode !== 'comments') {
        setParseError(effectiveSelectionMode === 'manual'
          ? '没有找到和当前方向相关的素材，请换一个主题或选择一篇锚点笔记。'
          : '可用于选题的素材不足 3 条，请先采集更多内容。');
        setPhase('done');
        setShowFinal(true);
        setLoading(false);
        activeRequestIdRef.current = '';
        trackTopicEvent('topic_generation_failed', {
          sourceMode: effectiveSelectionMode,
          reason: 'no_sources',
        });
        return;
      }

      window.ipcRenderer.wander.brainstorm({
        items: nextItems,
        options: {
          multiChoice: effectiveSelectionMode === 'comments' ? false : multiChoiceEnabled,
          requestId,
          sourceMode: effectiveSelectionMode === 'manual'
            ? 'guided'
            : effectiveSelectionMode === 'comments'
              ? 'comments'
              : 'random',
        },
      });
    } catch (error) {
      console.error('Brainstorm failed:', error);
      setParsedResult(null);
      setParseError('调用失败，请稍后重试');
      setLiveStatus(toStableTwoLineText('选题失败'));
      setPhase('done');
      setShowFinal(true);
      trackTopicEvent('topic_generation_failed', {
        sourceMode: effectiveSelectionMode,
        reason: 'exception',
      });
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

  const titleBarContent = null;

  useEffect(() => {
    if (!onTitleBarContentChange) return;
    onTitleBarContentChange(isActive ? titleBarContent : null);
    return () => {
      onTitleBarContentChange(null);
    };
  }, [isActive, onTitleBarContentChange, titleBarContent]);

  const activeHistoryList = useMemo(
    () => historyList.filter(record => !isAbandonedHistoryRecord(record)),
    [historyList]
  );

  const topicRows = useMemo(() => {
    const hasPersistedCurrent = Boolean(currentHistoryId && historyList.some(record => record.id === currentHistoryId));
    const generated = parsedResult && !hasPersistedCurrent
      ? [{
          id: currentHistoryId || 'current-topic',
          title: activeOption?.topic.title || parsedResult.topic.title || '未命名选题',
          direction: activeOption?.content_direction || parsedResult.content_direction || '',
          createdAt: Date.now(),
          source: activeSourceMode === 'comments' ? '评论洞察' : '灵感漫步',
          score: validationIssues.length > 0 || parseError ? 62 : 86,
          status: loading ? '生成中' : '待处理',
          evidenceCount: items.length,
          abandoned: false,
          record: null as WanderHistoryRecord | null,
        }]
      : [];
    const topicHistoryList = showAbandonedTopics ? historyList : activeHistoryList;
    const historyRows = topicHistoryList.map((record, index) => {
      const parsed = normalizeWanderResultPayload(record.result);
      const optionIndex = resolveSelectedOptionIndex(parsed);
      const selected = parsed?.options?.[optionIndex];
      const recordItems = normalizeWanderItemsPayload(record.items);
      const abandoned = isAbandonedHistoryRecord(record);
      const isCommentInsight = recordItems.some((item) => {
        const meta = item.meta || {};
        return String(meta.sourceType || '').trim() === 'xhs-comments';
      });
      return {
        id: record.id,
        title: selected?.topic.title || parsed?.topic.title || getHistoryTitle(record),
        direction: selected?.content_direction || parsed?.content_direction || '',
        createdAt: getHistoryCreatedAt(record),
        source: isCommentInsight ? '评论洞察' : '灵感漫步',
        score: Math.max(68, 91 - index * 3),
        status: abandoned ? '已放弃' : currentHistoryId === record.id ? '当前' : '待处理',
        evidenceCount: recordItems.length || 3,
        abandoned,
        record,
      };
    });
    const seen = new Set<string>();
    return [...historyRows, ...generated]
      .filter((row) => {
        if (seen.has(row.id)) return false;
        seen.add(row.id);
        return true;
      })
      .sort((left, right) => right.createdAt - left.createdAt);
  }, [activeHistoryList, activeOption?.content_direction, activeOption?.topic.title, activeSourceMode, currentHistoryId, historyList, items.length, loading, parseError, parsedResult, showAbandonedTopics, validationIssues.length]);

  const isGeneratingTopic = loading || phase === 'running';
  const selectedTopic = isGeneratingTopic
    ? null
    : currentHistoryId
      ? topicRows.find((row) => row.id === currentHistoryId) || topicRows[0] || null
      : topicRows.find((row) => row.id === 'current-topic') || topicRows[0] || null;

  const selectedDetailResult = isGeneratingTopic
    ? null
    : parsedResult
    || (selectedTopic?.record ? normalizeWanderResultPayload(selectedTopic.record.result) : null);
  const selectedDetailOption = selectedDetailResult?.options?.[resolveSelectedOptionIndex(selectedDetailResult)];
  const selectedDetailFrame = selectedDetailOption?.direction_frame || selectedDetailResult?.direction_frame;
  const selectedDetailItems = isGeneratingTopic
    ? []
    : selectedTopic?.record
    ? normalizeWanderItemsPayload(selectedTopic.record.items)
    : items;
  const filteredCommentCandidates = useMemo(() => {
    const query = commentCandidateQuery.trim().toLowerCase();
    if (!query) return commentCandidates;
    return commentCandidates.filter((item) => {
      const fields = [
        item.title,
        item.content,
        String(item.meta?.sourceName || ''),
      ];
      return fields.some((field) => field.toLowerCase().includes(query));
    });
  }, [commentCandidateQuery, commentCandidates]);

  const sourceActions = [
    {
      id: 'wander',
      title: '灵感漫步',
      mode: 'random' as const,
      onClick: () => {
        if (loading) return;
        trackTopicEvent('topic_source_selected', {
          sourceMode: 'random',
        });
        setSelectionMode('random');
        setPendingStartMode('random');
        setParseError(null);
        setValidationIssues([]);
        setGuidedWarning(null);
      },
    },
    {
      id: 'comments',
      title: '评论区洞察',
      mode: 'comments' as const,
      onClick: () => {
        if (loading) return;
        trackTopicEvent('topic_source_selected', {
          sourceMode: 'comments',
          commentSourceMode: 'random',
        });
        setSelectionMode('comments');
        setCommentSourceMode('random');
        setSelectedCommentItem(null);
        setCommentCandidateQuery('');
        setCommentCandidatesLoading(false);
        setPendingStartMode('comments');
        setParseError(null);
        setValidationIssues([]);
        setGuidedWarning(null);
      },
    },
  ];

  const renderTopicDetail = () => {
    if (isGeneratingTopic) {
      const loadingTitle = activeSourceMode === 'comments' ? '评论区洞察中' : '灵感漫步中';
      return (
        <aside className="flex min-h-0 flex-1 flex-col bg-surface-primary">
          <div className="relative flex min-h-[250px] items-center justify-center border-b border-border px-8 py-16">
            <div className="flex flex-col items-center text-center">
              <WanderLoadingDice size={96} />
              <div className="mt-2 text-[11px] font-semibold text-accent-primary">正在生成选题</div>
              <h3 className="mt-3 text-[30px] font-extrabold leading-tight tracking-normal text-text-primary">
                {loadingTitle}
              </h3>
            </div>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5 custom-scrollbar">
            <div className="mx-auto max-w-3xl rounded-lg border border-accent-primary/20 bg-accent-primary/5 p-4">
              <div className="flex items-center gap-2 text-xs font-semibold text-accent-primary">
                <RefreshCw className="h-3.5 w-3.5 animate-spin" />
                {liveStatus || '正在准备素材...'}
              </div>
              {progressCards.length > 0 && (
                <div className="mt-4 space-y-2">
                  {progressCards.slice(0, 4).map((card) => (
                    <div key={card.phase} className="flex items-center justify-between gap-3 rounded-md bg-surface-primary px-3 py-2 text-xs">
                      <span className="truncate font-medium text-text-secondary">{card.title}</span>
                      <span className="shrink-0 text-text-tertiary">{card.status === 'completed' ? '完成' : '进行中'}</span>
                    </div>
                  ))}
                </div>
              )}
              <div className="mt-5 space-y-3">
                <div className="h-3 w-2/3 rounded-full bg-border/70" />
                <div className="h-3 w-full rounded-full bg-border/60" />
                <div className="h-3 w-5/6 rounded-full bg-border/50" />
              </div>
            </div>
          </div>
        </aside>
      );
    }

    if (pendingStartMode) {
      const isCommentMode = pendingStartMode === 'comments';
      const StartIcon = isCommentMode ? MessageSquarePlus : Dices;
      const title = isCommentMode ? '评论区洞察' : '灵感漫步';
      const actionLabel = isCommentMode ? '开始评论区洞察' : '开始漫步';
      const customCommentSelection = isCommentMode && commentSourceMode === 'custom';
      const startDisabled = loading || (customCommentSelection && !selectedCommentItem);

      return (
        <aside className="flex min-h-0 flex-1 flex-col bg-surface-primary">
          <div className="flex min-h-0 flex-1 items-center justify-center px-8 py-10">
            <div className="flex w-full max-w-xl flex-col items-center text-center">
              {customCommentSelection && (
                <div className="mb-8 w-full rounded-lg border border-border bg-surface-secondary/40 p-3 text-left">
                  <div className="relative">
                    <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-text-tertiary" />
                    <input
                      value={commentCandidateQuery}
                      onChange={(event) => setCommentCandidateQuery(event.target.value)}
                      placeholder="搜索评论笔记"
                      className="h-9 w-full rounded-md border border-border bg-surface-primary pl-9 pr-3 text-sm text-text-primary outline-none transition-colors placeholder:text-text-tertiary focus:border-accent-primary"
                    />
                  </div>
                  <div className="mt-3 max-h-52 space-y-1 overflow-y-auto custom-scrollbar">
                    {commentCandidatesLoading ? (
                      <div className="rounded-md px-3 py-6 text-center text-xs text-text-tertiary">加载中</div>
                    ) : filteredCommentCandidates.length === 0 ? (
                      <div className="rounded-md px-3 py-6 text-center text-xs text-text-tertiary">暂无评论笔记</div>
                    ) : (
                      filteredCommentCandidates.slice(0, 5).map((item) => {
                        const selected = selectedCommentItem?.id === item.id;
                        const commentCount = Number(item.meta?.commentCount || 0);
                        return (
                          <button
                            key={item.id}
                            type="button"
                            onClick={() => setSelectedCommentItem(selected ? null : item)}
                            className={clsx(
                              'flex w-full items-center gap-3 rounded-md border px-3 py-2 text-left transition-colors',
                              selected
                                ? 'border-accent-primary/40 bg-accent-primary/10'
                                : 'border-transparent hover:border-border hover:bg-surface-primary'
                            )}
                          >
                            <div className={clsx(
                              'flex h-7 w-7 shrink-0 items-center justify-center rounded-md',
                              selected ? 'bg-accent-primary text-white' : 'bg-surface-tertiary text-text-secondary'
                            )}>
                              {selected ? <Check className="h-3.5 w-3.5" /> : <MessageSquarePlus className="h-3.5 w-3.5" />}
                            </div>
                            <div className="min-w-0 flex-1">
                              <div className="truncate text-xs font-semibold text-text-primary">{item.title || '未命名笔记'}</div>
                              <div className="mt-0.5 truncate text-[11px] text-text-tertiary">
                                {commentCount > 0 ? `${commentCount} 条评论` : '评论素材'}
                              </div>
                            </div>
                          </button>
                        );
                      })
                    )}
                  </div>
                </div>
              )}
              <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-accent-primary/10 text-accent-primary">
                <StartIcon className="h-7 w-7" />
              </div>
              <h3 className="mt-5 text-[30px] font-extrabold leading-tight tracking-normal text-text-primary">
                {title}
              </h3>
              <button
                type="button"
                onClick={() => void startWander(pendingStartMode)}
                disabled={startDisabled}
                className="mt-8 inline-flex h-10 items-center justify-center gap-2 rounded-md bg-accent-primary px-4 text-sm font-semibold text-white transition-colors hover:bg-accent-hover disabled:opacity-40"
              >
                <StartIcon className="h-4 w-4" />
                {actionLabel}
              </button>
              {isCommentMode && (
                <button
                  type="button"
                  onClick={() => {
                    const nextMode: CommentSourceMode = customCommentSelection ? 'random' : 'custom';
                    setCommentSourceMode(nextMode);
                    if (nextMode === 'random') {
                      setSelectedCommentItem(null);
                      setCommentCandidateQuery('');
                      setCommentCandidatesLoading(false);
                    }
                  }}
                  aria-pressed={customCommentSelection}
                  className={clsx(
                    'mt-3 inline-flex h-8 items-center justify-center gap-1.5 rounded-md border px-2.5 text-xs font-semibold transition-colors',
                    customCommentSelection
                      ? 'border-accent-primary/30 bg-accent-primary/10 text-accent-primary hover:bg-accent-primary/15'
                      : 'border-border bg-surface-primary text-text-secondary hover:bg-surface-secondary hover:text-text-primary'
                  )}
                >
                  {customCommentSelection ? <Shuffle className="h-3.5 w-3.5" /> : <MessageSquarePlus className="h-3.5 w-3.5" />}
                  {customCommentSelection ? '随机选择' : '指定笔记'}
                </button>
              )}
            </div>
          </div>
        </aside>
      );
    }

    return (
      <aside className="flex min-h-0 flex-1 flex-col bg-surface-primary">
      <div className="relative flex min-h-[250px] items-center border-b border-border px-8 py-16">
        <button
          type="button"
          onClick={abandonSelectedTopic}
          disabled={!selectedTopic || selectedTopic.abandoned || loading}
          className="absolute left-5 top-6 inline-flex h-9 shrink-0 items-center gap-1.5 rounded-md border border-border bg-surface-primary px-3 text-xs font-semibold text-text-secondary transition-colors hover:border-red-200 hover:bg-red-50 hover:text-red-600 disabled:cursor-default disabled:opacity-40"
        >
          <X className="h-3.5 w-3.5" />
          放弃
        </button>
        <div className="mx-auto max-w-3xl text-center">
          <div className="text-[11px] font-semibold text-accent-primary">选题详情</div>
          <h3 className="mt-3 text-[30px] font-extrabold leading-tight tracking-normal text-text-primary">
            {selectedTopic?.title || '暂无选题'}
          </h3>
        </div>
        <button
          type="button"
          onClick={startCreateInRedClaw}
          disabled={!canStartCreate}
          className="absolute right-5 top-6 inline-flex h-9 shrink-0 items-center gap-1.5 rounded-md bg-accent-primary px-3 text-xs font-semibold text-white transition-colors hover:bg-accent-hover disabled:opacity-40"
        >
          <MessageSquarePlus className="h-3.5 w-3.5" />
          AI创作
        </button>
      </div>
      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-5 py-4 custom-scrollbar">
        {loading && (
          <div className="rounded-lg border border-accent-primary/20 bg-accent-primary/5 p-3">
            <div className="flex items-center gap-2 text-xs font-semibold text-accent-primary">
              <RefreshCw className="h-3.5 w-3.5 animate-spin" />
              正在生成选题
            </div>
            <div className="mt-2 text-xs leading-relaxed text-text-secondary">{liveStatus || '正在准备素材...'}</div>
            {progressCards.length > 0 && (
              <div className="mt-3 space-y-1.5">
                {progressCards.slice(0, 4).map((card) => (
                  <div key={card.phase} className="flex items-center justify-between gap-2 rounded-md bg-surface-primary px-2 py-1.5 text-[11px]">
                    <span className="truncate text-text-secondary">{card.title}</span>
                    <span className="shrink-0 text-text-tertiary">{card.status === 'completed' ? '完成' : '进行中'}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {parseError && (
          <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs font-medium text-red-600">
            {parseError}
          </div>
        )}

        <section>
          <div className="mb-2 text-[11px] font-semibold text-text-tertiary">内容方向</div>
          <p className="text-[15px] leading-relaxed text-text-secondary">
            {selectedDetailOption?.content_direction || selectedDetailResult?.content_direction || '选择或生成一个选题后，这里会显示内容方向。'}
          </p>
        </section>

        <section className="grid grid-cols-2 gap-x-8 gap-y-3">
          {[
            ['热度', selectedTopic?.score || 0],
            ['新鲜度', selectedTopic ? Math.min(96, selectedTopic.score + 5) : 0],
            ['可写性', selectedTopic ? Math.max(65, selectedTopic.score - 4) : 0],
            ['匹配度', selectedTopic ? Math.max(60, selectedTopic.score - 8) : 0],
          ].map(([label, score]) => (
            <div key={label} className="min-w-0">
              <div className="text-[10px] font-semibold text-text-tertiary">{label}</div>
              <div className="mt-1 flex items-center gap-2">
                <div className="h-1 flex-1 overflow-hidden rounded-full bg-border">
                  <div className="h-full rounded-full bg-accent-primary" style={{ width: `${Number(score)}%` }} />
                </div>
                <span className="w-6 text-right text-[11px] font-semibold text-text-primary">{score}</span>
              </div>
            </div>
          ))}
        </section>

        {selectedDetailFrame && (
          <section className="grid grid-cols-2 gap-x-8 gap-y-3">
            {[
              ['目标读者', selectedDetailFrame.target_reader],
              ['核心矛盾', selectedDetailFrame.core_tension],
              ['叙事角度', selectedDetailFrame.angle],
              ['素材切口', selectedDetailFrame.material_entry],
            ].map(([label, value]) => (
              <div key={label} className="min-w-0">
                <div className="text-[10px] font-semibold text-text-tertiary">{label}</div>
                <div className="mt-0.5 line-clamp-2 text-xs leading-relaxed text-text-primary">{value || '待补充'}</div>
              </div>
            ))}
          </section>
        )}

        <section>
          <div className="mb-2 text-[11px] font-semibold text-text-tertiary">证据素材</div>
          <div className="grid grid-cols-3 gap-2">
            {selectedDetailItems.slice(0, 4).map((item) => (
              <div key={item.id} className="min-w-0 overflow-hidden rounded-md border border-border bg-surface-primary shadow-sm">
                <div className="relative aspect-[4/5] w-full overflow-hidden bg-surface-secondary">
                  {item.cover ? (
                    <img
                      src={resolveAssetUrl(item.cover)}
                      alt={item.title}
                      className="h-full w-full object-cover"
                      loading="lazy"
                    />
                  ) : (
                    <div className="flex h-full w-full items-center justify-center text-text-tertiary">
                      {item.type === 'video' ? <Play className="h-4 w-4" /> : <FileText className="h-4 w-4" />}
                    </div>
                  )}
                </div>
                <div className="min-w-0 px-2.5 py-2">
                  <div className="line-clamp-1 text-[11px] font-semibold text-text-primary">{item.title}</div>
                  <div className="mt-0.5 line-clamp-2 text-[10px] leading-relaxed text-text-tertiary">{item.content || '暂无摘要'}</div>
                </div>
              </div>
            ))}
            {selectedDetailItems.length === 0 && (
              <div className="col-span-3 rounded-lg border border-dashed border-border px-3 py-6 text-center text-xs text-text-tertiary">
                暂无素材
              </div>
            )}
          </div>
        </section>
      </div>
    </aside>
    );
  };

  const renderTopicList = () => (
    <div className="flex min-h-0 w-[430px] shrink-0 flex-col border-r border-border">
      <div className="border-b border-border bg-surface-primary px-5 py-4">
        <div className="flex items-center justify-between gap-4">
          <div>
            <h2 className="text-base font-semibold text-text-primary">选题池</h2>
            <div className="mt-1 text-xs text-text-tertiary">统一管理灵感漫步和评论洞察生成的选题</div>
          </div>
          <button
            type="button"
            onClick={() => setShowAbandonedTopics((value) => !value)}
            aria-pressed={showAbandonedTopics}
            className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md border border-border bg-surface-primary px-2.5 text-xs font-semibold text-text-secondary transition-colors hover:bg-surface-secondary hover:text-text-primary"
          >
            {showAbandonedTopics ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
            {showAbandonedTopics ? '隐藏已放弃' : '展示已放弃'}
          </button>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 border-b border-border bg-surface-primary px-5 py-3">
        {sourceActions.map((action) => {
          const isPrimary = action.id === 'wander';
          const isPending = pendingStartMode === action.mode;
          const ActionIcon = isPrimary ? Sparkles : MessageSquarePlus;

          return (
            <button
              key={action.id}
              type="button"
              onClick={action.onClick}
              disabled={loading}
              className={clsx(
                'group flex h-14 min-w-0 items-center justify-between gap-3 rounded-xl border px-4 text-left shadow-sm transition-all active:scale-[0.99] disabled:cursor-default',
                isPending
                  ? 'border-accent-primary/36 bg-accent-primary/12 text-accent-primary shadow-[0_12px_28px_-22px_rgb(var(--color-accent-primary)/0.75)]'
                  : isPrimary
                  ? 'border-accent-primary/24 bg-accent-primary/10 text-accent-primary shadow-[0_12px_28px_-22px_rgb(var(--color-accent-primary)/0.75)] hover:border-accent-primary/36 hover:bg-accent-primary/14 disabled:bg-accent-primary/5'
                  : 'border-border bg-surface-secondary/70 text-text-primary hover:border-accent-primary/24 hover:bg-surface-tertiary'
              )}
            >
              <div className="flex min-w-0 items-center gap-3">
                <span
                  className={clsx(
                    'flex h-8 w-8 shrink-0 items-center justify-center rounded-lg',
                    isPending || isPrimary ? 'bg-accent-primary/14 text-accent-primary' : 'bg-surface-tertiary text-text-secondary'
                  )}
                >
                  <ActionIcon className="h-4 w-4" />
                </span>
                <div className="min-w-0">
                  <span className="truncate text-sm font-extrabold">{action.title}</span>
                </div>
              </div>
            </button>
          );
        })}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto bg-surface-secondary/25 custom-scrollbar">
        {topicRows.length === 0 ? (
          <div className="flex h-full min-h-[360px] flex-col items-center justify-center px-8 text-center">
            <div className="flex h-12 w-12 items-center justify-center rounded-lg bg-accent-primary/10 text-accent-primary">
              <Sparkles className="h-5 w-5" />
            </div>
            <div className="mt-4 text-sm font-semibold text-text-primary">暂无选题</div>
            <div className="mt-1 max-w-sm text-xs leading-relaxed text-text-tertiary">点击上方“灵感漫步”生成第一组选题，后续评论洞察也会汇入这里。</div>
          </div>
        ) : (
          <div className="divide-y divide-border">
            {topicRows.map((row) => {
              const selected = selectedTopic?.id === row.id;
              return (
                <button
                  key={row.id}
                  type="button"
                  onClick={() => {
                    if (row.record) {
                      loadHistory(row.record);
                    } else {
                      trackTopicEvent('topic_selected', {
                        source: 'current',
                        topicStatus: row.abandoned ? 'abandoned' : 'active',
                        evidenceCount: row.evidenceCount,
                      });
                    }
                  }}
                  className={clsx(
                    'relative w-full px-5 py-3 text-left transition-colors',
                    selected
                      ? 'bg-accent-primary/12 shadow-[inset_0_0_0_1px_rgba(167,116,73,0.18)]'
                      : row.abandoned
                      ? 'bg-surface-secondary/45 hover:bg-surface-secondary/65'
                      : 'bg-surface-primary hover:bg-surface-secondary/55'
                  )}
                >
                  {selected && (
                    <span className="absolute bottom-2 left-0 top-2 w-1 rounded-r-full bg-accent-primary" />
                  )}
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className={clsx(
                        'truncate text-sm font-semibold',
                        selected ? 'text-accent-primary' : row.abandoned ? 'text-text-secondary' : 'text-text-primary'
                      )}>{row.title}</span>
                      {selected && <Check className="h-3.5 w-3.5 shrink-0 text-accent-primary" />}
                    </div>
                    <div className={clsx(
                      'mt-1 line-clamp-1 text-xs',
                      selected ? 'text-text-secondary' : 'text-text-tertiary'
                    )}>{row.direction || '暂无方向摘要'}</div>
                  </div>
                  <div className="mt-2 flex min-w-0 items-center gap-2 text-xs">
                    <span className={clsx(
                      'rounded-md px-2 py-1 text-[11px] font-semibold',
                      selected ? 'bg-accent-primary text-white' : row.abandoned ? 'bg-surface-tertiary text-text-tertiary' : 'bg-accent-primary/10 text-accent-primary'
                    )}>{row.source}</span>
                    <span className={clsx('shrink-0', selected ? 'font-semibold text-accent-primary' : row.abandoned ? 'text-text-tertiary' : 'text-text-secondary')}>{row.status}</span>
                    <span className="text-text-tertiary">{formatDate(row.createdAt)}</span>
                    <div className="ml-auto flex w-20 items-center gap-2">
                      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-border">
                        <div className={clsx('h-full rounded-full', selected ? 'bg-accent-primary' : 'bg-accent-primary/80')} style={{ width: `${row.score}%` }} />
                      </div>
                      <span className={clsx('w-6 text-right text-[11px] font-semibold', selected ? 'text-accent-primary' : 'text-text-secondary')}>{row.score}</span>
                    </div>
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-surface-primary">
      <div className="flex min-h-0 flex-1">
        {renderTopicList()}
        {renderTopicDetail()}
      </div>

      {showHistory && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/40 px-6 py-6" onClick={() => setShowHistory(false)}>
          <div className="flex max-h-[75vh] w-full max-w-lg flex-col overflow-hidden rounded-lg border border-border bg-surface-primary shadow-2xl" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between border-b border-border px-5 py-4">
              <div>
                <h3 className="text-base font-semibold text-text-primary">选题历史</h3>
                <p className="mt-0.5 text-xs text-text-tertiary">本地保存的灵感漫步记录</p>
              </div>
              <button type="button" onClick={() => setShowHistory(false)} className="flex h-8 w-8 items-center justify-center rounded-md text-text-tertiary hover:bg-surface-secondary hover:text-text-primary">
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto p-2 custom-scrollbar">
              {activeHistoryList.length === 0 ? (
                <div className="px-4 py-10 text-center text-xs text-text-tertiary">暂无选题历史记录</div>
              ) : (
                activeHistoryList.map(record => (
                  <button
                    key={record.id}
                    type="button"
                    onClick={() => loadHistory(record)}
                    className="group flex w-full items-center justify-between gap-3 rounded-md px-3 py-2.5 text-left hover:bg-surface-secondary"
                  >
                    <div className="min-w-0">
                      <div className="truncate text-sm font-semibold text-text-primary">{getHistoryTitle(record)}</div>
                      <div className="mt-0.5 text-xs text-text-tertiary">{formatDate(getHistoryCreatedAt(record))}</div>
                    </div>
                    <span
                      role="button"
                      tabIndex={0}
                      onClick={(e) => deleteHistory(record.id, e as unknown as React.MouseEvent)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' || event.key === ' ') {
                          event.preventDefault();
                          void deleteHistory(record.id, event as unknown as React.MouseEvent);
                        }
                      }}
                      className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-text-tertiary opacity-0 transition-opacity hover:bg-red-50 hover:text-red-500 group-hover:opacity-100"
                    >
                      <Trash2 className="h-4 w-4" />
                    </span>
                  </button>
                ))
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );

  const renderSourceNode = (item: WanderItem | undefined, index: number, position: string) => {
    if (!item) {
      return (
        <div className="flex flex-col items-center justify-center p-3 rounded-2xl border border-dashed border-black/[0.08] dark:border-white/[0.08] bg-white/40 dark:bg-black/20 backdrop-blur-md h-[76px] text-center animate-pulse shadow-sm">
          <div className="w-5 h-5 rounded-full bg-black/[0.05] dark:bg-white/[0.05] flex items-center justify-center mb-1">
            <span className="text-[9px] font-bold text-text-tertiary/40">?</span>
          </div>
          <div className="text-[9px] font-bold text-text-tertiary/40">等候素材...</div>
        </div>
      );
    }

    const isDocItem = (item.meta as Record<string, unknown> | undefined)?.sourceType === 'document';
    const icon = item.type === 'video'
      ? <Play className="w-3.5 h-3.5 text-red-500" />
      : isDocItem
        ? <FileText className="w-3.5 h-3.5 text-violet-500" />
        : <FileText className="w-3.5 h-3.5 text-blue-500" />;

    return (
      <div className="animate-wander-node-glow flex flex-col rounded-2xl border border-black/[0.05] dark:border-white/[0.05] bg-white/85 dark:bg-surface-primary/85 backdrop-blur-md p-3 shadow-md hover:scale-[1.03] transition-transform select-none max-w-full">
        <div className="flex items-center gap-1.5 mb-1 min-w-0">
          <div className="p-1 rounded-lg bg-black/[0.03] dark:bg-white/[0.03] shrink-0">
            {icon}
          </div>
          <span className="text-[9px] px-1.5 py-0.5 rounded bg-accent-primary/10 text-accent-primary font-black tracking-wider uppercase shrink-0">
            Node {index + 1}
          </span>
        </div>
        <div className="text-[11px] font-extrabold text-text-primary truncate" title={item.title}>
          {item.title}
        </div>
        <div className="text-[9px] text-text-tertiary truncate mt-0.5">
          {item.content || "暂无摘要"}
        </div>
      </div>
    );
  };

  return (
    <div className="h-full flex flex-col overflow-hidden">
      {phase === 'idle' ? (
        <div className="flex-1 flex flex-col items-center justify-center p-8 relative">
            {/* 饰品背景 */}
            <div className="absolute inset-0 pointer-events-none overflow-hidden opacity-30">
                <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[600px] h-[600px] bg-accent-primary/5 rounded-full blur-[120px]" />
                <div className="absolute top-1/4 left-1/3 w-32 h-32 bg-blue-500/5 rounded-full blur-[60px]" />
            </div>

            <div className="relative flex flex-col items-center w-full max-w-3xl text-center animate-in fade-in zoom-in-95 duration-700">
                <div className="relative mb-10">
                    <div className="absolute inset-0 bg-accent-primary/10 rounded-[32px] blur-2xl animate-pulse" />
                    <div className="relative flex h-24 w-24 items-center justify-center rounded-[32px] bg-white shadow-[0_24px_48px_-12px_rgba(0,0,0,0.12)] border border-white/60">
                        {selectionMode === 'manual' ? <Shuffle className="w-10 h-10 text-accent-primary" /> : <Dices className="w-10 h-10 text-accent-primary" />}
                    </div>
                </div>

                <h2 className="text-2xl font-extrabold tracking-tight text-text-primary mb-4">
                  {selectionMode === 'manual' ? '按方向选题' : '开启一次随机选题'}
                </h2>
                {selectionMode === 'manual' ? (
                  <div className="w-full max-w-2xl mb-8 space-y-4 text-left">
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
                  <p className="text-[15px] leading-relaxed text-text-tertiary font-medium mb-10 px-8 max-w-lg">
                      系统将从您的知识库中随机抽取内容，
                      寻找它们之间的隐秘关联，激发前所未有的创作灵感。
                  </p>
                )}

                <button
                    onClick={() => { void startWander(); }}
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
                <div className="flex flex-col items-center justify-center min-h-[60vh] py-4 animate-in fade-in zoom-in-[0.98] duration-1000">

                  {/* The Quantum Synaptic Network Map (Expanded & Transparent) */}
                  <div className="relative w-full max-w-3xl aspect-[1.8] flex items-center justify-center mb-8 select-none">
                    {/* Background Grid Accent */}
                    <div className="absolute inset-0 opacity-[0.015] dark:opacity-[0.03] bg-[linear-gradient(rgba(0,0,0,0.1)_1px,transparent_1px),linear-gradient(90deg,rgba(0,0,0,0.1)_1px,transparent_1px)] bg-[size:24px_24px] pointer-events-none" />

                    {/* SVG Connections with Animated Particles */}
                    <svg className="absolute inset-0 w-full h-full pointer-events-none" viewBox="0 0 720 400">
                      <defs>
                        <filter id="glow-effect" x="-20%" y="-20%" width="140%" height="140%">
                          <feGaussianBlur stdDeviation="3.5" result="blur" />
                          <feComposite in="SourceGraphic" in2="blur" operator="over" />
                        </filter>
                      </defs>

                      {/* Concentric Rotating Quantum Orbits */}
                      <circle cx="360" cy="200" r="75" fill="none" stroke="rgb(var(--color-accent-primary) / 0.15)" strokeWidth="1" strokeDasharray="4, 12" style={{ transformOrigin: '360px 200px', animation: 'spin 35s linear infinite' }} />
                      <circle cx="360" cy="200" r="135" fill="none" stroke="rgb(var(--color-accent-primary) / 0.1)" strokeWidth="1.2" strokeDasharray="6, 18" style={{ transformOrigin: '360px 200px', animation: 'spin 25s linear infinite reverse' }} />
                      <circle cx="360" cy="200" r="190" fill="none" stroke="rgb(var(--color-accent-primary) / 0.05)" strokeWidth="1.5" strokeDasharray="8, 24" style={{ transformOrigin: '360px 200px', animation: 'spin 45s linear infinite' }} />

                      {/* Twinkling Quantum Particles */}
                      <circle cx="160" cy="90" r="1.5" className="fill-accent-primary animate-pulse" style={{ animationDelay: '0.2s', animationDuration: '3s' }} />
                      <circle cx="560" cy="80" r="2" className="fill-accent-primary/60 animate-pulse" style={{ animationDelay: '1.4s', animationDuration: '4s' }} />
                      <circle cx="240" cy="280" r="1.2" className="fill-accent-primary/80 animate-pulse" style={{ animationDelay: '0.7s', animationDuration: '2.5s' }} />
                      <circle cx="480" cy="290" r="1.8" className="fill-accent-primary animate-pulse" style={{ animationDelay: '2.1s', animationDuration: '3.5s' }} />
                      <circle cx="90" cy="180" r="1" className="fill-accent-primary/50 animate-pulse" style={{ animationDelay: '1.1s', animationDuration: '5s' }} />
                      <circle cx="630" cy="170" r="1.5" className="fill-accent-primary/70 animate-pulse" style={{ animationDelay: '0.5s', animationDuration: '3.2s' }} />

                      {/* Connections from three orbits to center (360, 200) */}
                      {/* Node 1: Top Center */}
                      <line x1="360" y1="64" x2="360" y2="150" stroke="rgb(var(--color-accent-primary) / 0.18)" strokeWidth="2.5" />
                      <line x1="360" y1="64" x2="360" y2="150" stroke="rgb(var(--color-accent-primary) / 0.8)" strokeWidth="1.5" className="animate-wander-dash" filter="url(#glow-effect)" />

                      {/* Node 2: Bottom Left */}
                      <line x1="110" y1="310" x2="310" y2="230" stroke="rgb(var(--color-accent-primary) / 0.18)" strokeWidth="2.5" />
                      <line x1="110" y1="310" x2="310" y2="230" stroke="rgb(var(--color-accent-primary) / 0.8)" strokeWidth="1.5" className="animate-wander-dash" filter="url(#glow-effect)" />

                      {/* Node 3: Bottom Right */}
                      <line x1="610" y1="310" x2="410" y2="230" stroke="rgb(var(--color-accent-primary) / 0.18)" strokeWidth="2.5" />
                      <line x1="610" y1="310" x2="410" y2="230" stroke="rgb(var(--color-accent-primary) / 0.8)" strokeWidth="1.5" className="animate-wander-dash" filter="url(#glow-effect)" />
                    </svg>

                    {/* Central Glowing Pulses */}
                    <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-64 h-64 bg-accent-primary/10 rounded-full blur-3xl pointer-events-none animate-pulse" />
                    <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-40 h-40 bg-accent-primary/5 rounded-full blur-2xl pointer-events-none animate-pulse" style={{ animationDelay: '1s' }} />

                    {/* Central Quantum Dice */}
                    <div className="relative z-10 flex flex-col items-center select-none scale-[0.92] transition-transform duration-500">
                      <WanderLoadingDice size={82} />
                      <div className="mt-2.5 text-[9px] font-black tracking-[0.25em] text-accent-primary/80 uppercase animate-pulse">
                        Brain Nucleus
                      </div>
                    </div>

                    {/* Orbiting Source Nodes with Float Animations */}
                    {/* Node 1: Top Center */}
                    <div className="absolute top-2 left-1/2 -translate-x-1/2 z-20 w-[170px]">
                      <div className="animate-float-1">
                        {renderSourceNode(items[0], 0, "Top")}
                      </div>
                    </div>

                    {/* Node 2: Bottom Left */}
                    <div className="absolute bottom-2 left-4 z-20 w-[170px]">
                      <div className="animate-float-2">
                        {renderSourceNode(items[1], 1, "Left")}
                      </div>
                    </div>

                    {/* Node 3: Bottom Right */}
                    <div className="absolute bottom-2 right-4 z-20 w-[170px]">
                      <div className="animate-float-3">
                        {renderSourceNode(items[2], 2, "Right")}
                      </div>
                    </div>
                  </div>

                  <div className="w-full max-w-lg space-y-4">
                    <div className="text-center space-y-0.5">
                        <h3 className="text-sm font-black tracking-[0.2em] text-text-primary uppercase">Deep Thinking</h3>
                        <p className="text-[10px] font-bold text-text-tertiary/60 uppercase tracking-wider">Searching for Hidden Connections</p>
                    </div>

                    {/* High-tech Live Status Console (Smaller & Sleeker) */}
                    <div className="relative rounded-2xl border border-white/30 dark:border-white/5 bg-white/30 dark:bg-black/10 p-0.5 shadow-sm backdrop-blur-lg overflow-hidden">
                      <div className="absolute inset-0 opacity-[0.015] dark:opacity-[0.03] bg-[linear-gradient(rgba(0,0,0,0.1)_1px,transparent_1px),linear-gradient(90deg,rgba(0,0,0,0.1)_1px,transparent_1px)] bg-[size:12px_12px]" />

                      <div className="relative bg-white/50 dark:bg-surface-primary/50 rounded-[14px] px-4 py-2.5 border border-black/[0.01]">
                        <div className="flex items-center justify-between mb-1.5">
                          <div className="text-[9px] font-black text-accent-primary uppercase tracking-[0.12em]">
                            Live Brainstorm Stream
                          </div>
                          <div className="flex items-center gap-1">
                            <span className="relative flex h-1.5 w-1.5">
                              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
                              <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-emerald-500"></span>
                            </span>
                            <span className="text-[8px] font-black uppercase text-emerald-500/80 tracking-wider">ACTIVE</span>
                          </div>
                        </div>
                        <div
                            className="text-[12px] font-mono font-bold text-text-primary leading-relaxed h-9"
                            style={{
                            display: '-webkit-box',
                            WebkitLineClamp: 2,
                            WebkitBoxOrient: 'vertical',
                            overflow: 'hidden',
                            }}
                        >
                            {liveStatus || '正在初始化量子灵感引擎...'}
                            <span className="inline-block w-1.5 h-3 ml-1 bg-accent-primary animate-terminal-cursor" />
                        </div>
                      </div>
                    </div>

                    {/* Checklist Steps (Smaller & Sleeker) */}
                    {progressCards.length > 0 && (
                      <div className="grid gap-1.5">
                        {progressCards.map((card) => {
                          const isRunning = card.status === 'running';
                          const isCompleted = card.status === 'completed';
                          return (
                            <div
                              key={card.phase}
                              className={clsx(
                                "relative overflow-hidden rounded-xl border px-3.5 py-2.5 transition-all duration-500 flex items-center justify-between gap-3",
                                isRunning
                                  ? "bg-white dark:bg-surface-primary border-accent-primary/20 dark:border-accent-primary/30 shadow-[0_4px_20px_rgb(var(--color-accent-primary)/0.06)] ring-1 ring-accent-primary/5"
                                  : "bg-black/[0.01] dark:bg-white/[0.005] border-black/[0.02] dark:border-white/[0.02]"
                              )}
                            >
                              {isRunning && (
                                <div className="absolute inset-0 pointer-events-none animate-step-shimmer opacity-30" />
                              )}

                              <div className="relative z-10 min-w-0 flex items-center gap-3">
                                <div className={clsx(
                                    "w-6 h-6 rounded-lg flex items-center justify-center shrink-0 transition-all duration-300 shadow-sm",
                                    isCompleted
                                      ? "bg-emerald-500 dark:bg-emerald-600 text-white shadow-emerald-500/10"
                                      : isRunning
                                        ? "bg-accent-primary text-white shadow-accent-primary/15 scale-102"
                                        : "bg-black/[0.03] dark:bg-white/[0.03] text-text-tertiary"
                                )}>
                                    {isCompleted ? (
                                      <Check className="w-3.5 h-3.5 stroke-[2.5]" />
                                    ) : (
                                      <span className="text-[10px] font-black">{card.stepIndex || '•'}</span>
                                    )}
                                </div>
                                <div className="min-w-0">
                                    <div className={clsx(
                                      "text-[11.5px] font-extrabold tracking-tight transition-colors",
                                      isRunning ? "text-text-primary" : "text-text-tertiary/60"
                                    )}>
                                        {card.title}
                                    </div>
                                    {isRunning && (
                                        <div className="mt-0.5 text-[9.5px] font-bold text-text-tertiary truncate max-w-[280px] animate-pulse">
                                            {card.detail}
                                        </div>
                                    )}
                                </div>
                              </div>
                              {isRunning && (
                                  <div className="relative z-10 flex gap-0.5 bg-accent-primary/5 px-1.5 py-1 rounded border border-accent-primary/10 shrink-0">
                                      <div className="w-1 h-1 rounded-full bg-accent-primary animate-bounce [animation-delay:-0.3s]" />
                                      <div className="w-1 h-1 rounded-full bg-accent-primary animate-bounce [animation-delay:-0.15s]" />
                                      <div className="w-1 h-1 rounded-full bg-accent-primary animate-bounce" />
                                  </div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                </div>
              )}

              {showFinal && parsedResult && (
                <div className="space-y-12 animate-in fade-in slide-in-from-bottom-4 duration-700">
                  {guidedWarning && (
                    <div className="rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-[12px] font-bold text-amber-700">
                      {guidedWarning}
                    </div>
                  )}
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
                              onClick={() => {
                                setSelectedOptionIndex(index);
                                trackTopicEvent('topic_option_selected', {
                                  sourceMode: activeSourceMode,
                                  optionIndex: index,
                                  optionCount: parsedResult.options?.length || 0,
                                });
                              }}
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
                    <p className="text-[13px] font-bold text-text-tertiary/60">暂无选题历史记录</p>
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
