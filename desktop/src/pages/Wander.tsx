import { useState, useEffect, useRef, useCallback, useMemo, type ReactNode } from 'react';
import { RefreshCw, Sparkles, History, X, Trash2, Dices, FileText, Play, MessageSquarePlus, Search, Square, CheckSquare, Shuffle, Check } from 'lucide-react';
import { clsx } from 'clsx';
import { WanderLoadingDice } from '../components/wander/WanderLoadingDice';
import { resolveAssetUrl } from '../utils/pathManager';
import type { PendingChatMessage } from '../App';
import {
  AUTHORING_ALLOWED_OPERATE_ACTIONS,
  AUTHORING_ALLOWED_TOOLS,
} from '../utils/redclawAuthoring';
import type { AuthoringTaskHints } from '../utils/redclawAuthoring';
import { usePageRefresh } from '../hooks/usePageRefresh';
import { uiDebug } from '../utils/uiDebug';
import { APP_BRAND } from '../config/brand';

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

export function Wander({ isActive = true, onExecutionStateChange, onTitleBarContentChange, onNavigateToRedClaw }: WanderProps) {
  const [items, setItems] = useState<WanderItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [multiChoiceEnabled, setMultiChoiceEnabled] = useState(false);
  const [isSavingMode, setIsSavingMode] = useState(false);
  const [selectionMode, setSelectionMode] = useState<'random' | 'manual'>('random');
  const [guidedSourceMode, setGuidedSourceMode] = useState<'topic' | 'anchor'>('topic');
  const [guidedTopic, setGuidedTopic] = useState('');
  const [anchorQuery, setAnchorQuery] = useState('');
  const [anchorResults, setAnchorResults] = useState<WanderItem[]>([]);
  const [selectedAnchor, setSelectedAnchor] = useState<WanderItem | null>(null);
  const [anchorLoading, setAnchorLoading] = useState(false);
  const [guidedWarning, setGuidedWarning] = useState<string | null>(null);
  const [parsedResult, setParsedResult] = useState<WanderResult | null>(null);
  const [selectedOptionIndex, setSelectedOptionIndex] = useState(0);
  const [parseError, setParseError] = useState<string | null>(null);
  const [validationIssues, setValidationIssues] = useState<WanderValidationIssue[]>([]);
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
  const activeOption = parsedResult?.options?.[selectedOptionIndex];
  const activeDirectionFrame = activeOption?.direction_frame || parsedResult?.direction_frame;
  const hasGuidedInput = guidedSourceMode === 'topic'
    ? Boolean(guidedTopic.trim())
    : Boolean(selectedAnchor);

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

    const content = [
      '请基于以下“漫步选题”创作一篇完整的小红书文案。',
      '',
      '核心目标是写出一篇好文章，不是证明三条素材都被使用了。',
      '漫步素材只是灵感池：优先继承高互动母版的表达公式；另外素材只在能提高成稿质量时借一个细节、场景、反差或词感。可以完全舍弃无助于成稿的素材。',
      '不要把三篇内容强行关联成一个大主题；如果漫步选题仍然偏大，请继续缩小到一个具体人群、具体状态、具体动作或具体瞬间再写。',
      '可按需读取下方素材目录或用户档案；素材目录不是正文文件，如需读取，请优先 Read “建议读取”里的具体文件，或先 List 目录再 Read 具体文件。',
      '本任务必须按两个连续阶段完成，不能跳过，也不能把前一阶段的技能输出当成后一阶段的完整上下文。',
      '阶段一：标题。先确保 `xhs-title` 已激活；如果上下文里没有该技能规则，只调用一次 `Operate(resource="skills", operation="invoke", input={ "name": "xhs-title" })`。用它为当前选题生成 3 个候选标题，并基于点击欲望、准确性和不模板化程度选出 1 个最终标题。候选标题和分析只是内部中间产物，不要写入稿件或最终回复。',
      '阶段二：正文。拿阶段一选出的最终标题作为正文唯一标题，然后确保 `writing-style` 已激活；如果上下文里没有该技能规则，只调用一次 `Operate(resource="skills", operation="invoke", input={ "name": "writing-style" })`。正文阶段由 `writing-style` 主导，必须服从它的用户档案读取、语言节奏、结构禁区和自检要求。',
      '如果 `writing-style` 要求读取用户档案或创作者档案，正文动笔前必须先读取；不要因为已经完成标题阶段，就省略写作风格上下文。创建稿件工程后，后续 `Write` 的 content 仍然必须是按 `writing-style` 自检后的完整正文。',
      '完稿前按 `writing-style` 自检标题、开头、结构、事实边界、语气和禁区；内容质量优先于素材覆盖率。正文不要写成报告式大纲，不要输出孤立分隔线，不要只模仿素材格式。',
      '',
      '## 灵感选题',
      `标题：${activeTopic.title}`,
      `内容方向：${activeDirection || ''}`,
      '',
      '## 参考素材（来自漫步）',
      materialText,
      '',
      '## 输出要求',
      '1. 先用 `xhs-title` 完成标题阶段，内部选择 1 个最终标题；最终稿件和最终回复都只保留这个最终标题。',
      '2. 再用 `writing-style` 完成正文阶段；正文必须按该技能规则写作和自检，不能只沿用标题阶段的上下文。',
      '3. 如目标工程不存在，先调用 `Operate(resource="manuscripts", operation="createProject", input={ "kind": "post", "parent": "wander", "title": "<最终标题>" })` 创建 post 文件夹稿件工程。',
      '4. 完成后调用 `Write(path="manuscripts://current", content="<最终标题和按 writing-style 自检后的完整正文>")` 保存；保存成功后的最终回复只给运行总结和稿件链接，不要重复全文。',
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
        allowedOperateActions: AUTHORING_ALLOWED_OPERATE_ACTIONS,
        allowedWriteTargets: ['manuscripts://current'],
        requireSourceRead: false,
        requireProfileRead: false,
        requireSave: true,
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
      activeRequestIdRef.current = '';
    }
  };

  const handleGuidedSourceModeChange = (mode: 'topic' | 'anchor') => {
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
      setGuidedWarning(null);
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
    setLiveStatus(toStableTwoLineText(selectionMode === 'manual' ? '正在按方向选择素材...' : '正在初始化漫步...'));
    setProgressCards([]);
    setParsedResult(null);
    setSelectedOptionIndex(0);
    setParseError(null);
    setValidationIssues([]);
    setGuidedWarning(null);
    setItems([]);
    setShowFinal(false);
    setCurrentHistoryId(null);
    try {
      await new Promise<void>((resolve) => {
        window.requestAnimationFrame(() => resolve());
      });
      let nextItems: WanderItem[] = [];
      if (selectionMode === 'manual') {
        if (!hasGuidedInput) {
          setParseError(guidedSourceMode === 'topic' ? '请先输入主题。' : '请先选择一篇锚点笔记。');
          setPhase('done');
          setShowFinal(true);
          setLoading(false);
          activeRequestIdRef.current = '';
          return;
        }
        const guided = await window.ipcRenderer.invoke('wander:get-guided-items', {
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
          return;
        }
      } else {
        nextItems = await window.ipcRenderer.invoke('wander:get-random') as WanderItem[];
      }
      setItems(nextItems);
      activeItemsRef.current = nextItems;
      if (nextItems.length === 0) {
        setParseError(selectionMode === 'manual'
          ? '没有找到和当前方向相关的素材，请换一个主题或选择一篇锚点笔记。'
          : '可用于漫步的素材不足 3 条，请先采集更多内容。');
        setPhase('done');
        setShowFinal(true);
        setLoading(false);
        activeRequestIdRef.current = '';
        return;
      }

      window.ipcRenderer.send('wander:brainstorm', {
        items: nextItems,
        options: {
          multiChoice: multiChoiceEnabled,
          requestId,
          sourceMode: selectionMode === 'manual' ? 'guided' : 'random',
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

  const titleBarContent = useMemo(() => (
    <div className="flex w-full min-w-0 items-center justify-end gap-2 pr-2" data-no-window-drag>
      {phase !== 'idle' && (
        <>
          <button
            type="button"
            onClick={() => { void loadHistoryList(); setShowHistory(true); }}
            className="flex h-7 items-center gap-1.5 rounded-lg px-2.5 text-[11px] font-bold text-text-tertiary transition-colors hover:bg-surface-secondary hover:text-text-primary"
          >
            <History className="h-3.5 w-3.5" />
            历史
          </button>
          <button
            type="button"
            onClick={startWander}
            disabled={loading}
            className="flex h-7 items-center gap-1.5 rounded-lg bg-surface-secondary px-2.5 text-[11px] font-bold text-text-primary transition-colors hover:bg-surface-tertiary disabled:opacity-40"
          >
            <RefreshCw className={clsx('h-3.5 w-3.5', loading && 'animate-spin')} />
            再次漫步
          </button>
        </>
      )}
      <div className="flex h-7 items-center rounded-lg bg-surface-secondary p-0.5">
        {[
          ['random', '随机'] as const,
          ['manual', '手工'] as const,
        ].map(([mode, label]) => (
          <button
            key={mode}
            type="button"
            onClick={() => handleSelectionModeChange(mode)}
            disabled={loading}
            className={clsx(
              'h-6 rounded-md px-2.5 text-[11px] font-black transition-all disabled:opacity-50',
              selectionMode === mode
                ? 'bg-surface-primary text-text-primary shadow-sm'
                : 'text-text-tertiary hover:text-text-primary'
            )}
          >
            {label}
          </button>
        ))}
      </div>
      <div className="flex items-center gap-2">
        <div className="text-[11px] font-bold text-text-tertiary/70">
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
  ), [handleSelectionModeChange, handleToggleMultiChoice, isSavingMode, loadHistoryList, loading, multiChoiceEnabled, phase, selectionMode, startWander]);

  useEffect(() => {
    if (!onTitleBarContentChange) return;
    onTitleBarContentChange(isActive ? titleBarContent : null);
    return () => {
      onTitleBarContentChange(null);
    };
  }, [isActive, onTitleBarContentChange, titleBarContent]);

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
                  {selectionMode === 'manual' ? '按方向漫步' : '开启一次随机漫步'}
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
                    onClick={startWander}
                    disabled={selectionMode === 'manual' && !hasGuidedInput}
                    className="group px-8 py-3 bg-text-primary hover:bg-text-primary/90 text-white rounded-[20px] text-[15px] font-extrabold transition-all flex items-center gap-3 shadow-[0_20px_40px_-10px_rgba(0,0,0,0.2)] active:scale-95 disabled:opacity-40"
                >
                    <Sparkles className="w-5 h-5 text-accent-primary group-hover:animate-pulse" />
                    <span>{selectionMode === 'manual' ? '按方向漫步' : '开始灵感碰撞'}</span>
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
