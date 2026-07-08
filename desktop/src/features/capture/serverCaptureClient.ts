import type {
  ClipboardCaptureCandidate,
  ServerCaptureJob,
  ServerCaptureJobListResponse,
  ServerCaptureJobRequest,
  ServerCaptureJobResponse,
} from './captureTypes';
import { clipboardCaptureDedupeKey } from './clipboardDetector';

interface ServerCaptureOptions {
  includeComments?: boolean;
  limit?: number;
  maxItems?: number;
  collectionMode?: 'recent' | 'top_liked' | string;
  sortBy?: 'published_at' | 'likes' | string;
  clientRequestIdSuffix?: string;
}

const CAPTURE_JOB_POLL_INTERVAL_MS = 1500;
const CAPTURE_JOB_POLL_TIMEOUT_MS = 120_000;

export class ClipboardCaptureError extends Error {
  readonly debugDetails?: string;

  constructor(message: string, debugDetails?: string) {
    super(message);
    this.name = 'ClipboardCaptureError';
    this.debugDetails = debugDetails;
  }
}

export function buildServerCaptureJobRequest(
  candidate: ClipboardCaptureCandidate,
  options: ServerCaptureOptions = {},
): ServerCaptureJobRequest {
  return {
    source: 'clipboard',
    kind: candidate.kind,
    platform: candidate.platform,
    url: candidate.rawUrl,
    canonicalUrl: candidate.canonicalUrl,
    externalId: candidate.externalId,
    includeComments: options.includeComments === true,
    clientRequestId: options.clientRequestIdSuffix
      ? `${clipboardCaptureDedupeKey(candidate)}:${options.clientRequestIdSuffix}`
      : clipboardCaptureDedupeKey(candidate),
    options: {
      downloadMedia: true,
      includeComments: options.includeComments === true,
      limit: options.limit,
      maxItems: options.maxItems,
      collectionMode: options.collectionMode,
      sortBy: options.sortBy,
    },
  };
}

export async function createServerCaptureJob(
  candidate: ClipboardCaptureCandidate,
  options: ServerCaptureOptions = {},
): Promise<ServerCaptureJobResponse> {
  const payload = buildServerCaptureJobRequest(candidate, options);
  const captureBridge = window.ipcRenderer.capture as unknown as {
    createServerJob?: (payload: ServerCaptureJobRequest) => Promise<ServerCaptureJobResponse>;
  };

  if (typeof captureBridge.createServerJob !== 'function') {
    return {
      success: false,
      status: 'unavailable',
      error: '服务端采集 API 尚未接入',
    };
  }

  return captureBridge.createServerJob(payload);
}

export async function getServerCaptureJob(jobId: string): Promise<ServerCaptureJobResponse> {
  const captureBridge = window.ipcRenderer.capture as unknown as {
    getServerJob?: (payload: { jobId: string }) => Promise<ServerCaptureJobResponse>;
  };
  if (typeof captureBridge.getServerJob !== 'function') {
    return { success: false, status: 'unavailable', error: '服务端采集 API 尚未接入' };
  }
  return captureBridge.getServerJob({ jobId });
}

export async function listServerCaptureJobs(limit = 20): Promise<ServerCaptureJobListResponse> {
  const captureBridge = window.ipcRenderer.capture as unknown as {
    listServerJobs?: (payload: { limit: number }) => Promise<ServerCaptureJobListResponse>;
  };
  if (typeof captureBridge.listServerJobs !== 'function') {
    return { success: false, jobs: [], error: '服务端采集 API 尚未接入' };
  }
  return captureBridge.listServerJobs({ limit });
}

export async function pollServerCaptureJob(
  jobId: string,
  onJob?: (job: ServerCaptureJob) => void | Promise<void>,
): Promise<ServerCaptureJob> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < CAPTURE_JOB_POLL_TIMEOUT_MS) {
    const response = await getServerCaptureJob(jobId);
    if (!response.success || !response.job) {
      throw captureResponseError(response, '采集任务状态读取失败');
    }
    await onJob?.(response.job);
    if (response.job.status === 'completed') return response.job;
    if (response.job.status === 'failed') {
      throw new ClipboardCaptureError(
        response.job.error?.message || '采集任务处理失败',
        formatServerJobDebugDetails(response.job),
      );
    }
    await delay(CAPTURE_JOB_POLL_INTERVAL_MS);
  }
  throw new Error('采集任务处理超时');
}

export async function ingestServerCaptureJobResult(job: ServerCaptureJob): Promise<{ success: boolean; count?: number; error?: string }> {
  return ingestServerCaptureJobEntries(job);
}

export function serverCaptureEntryCount(job?: ServerCaptureJob | null): number {
  const entries = job?.result?.entries;
  return Array.isArray(entries) ? entries.length : 0;
}

export function serverCaptureEntryKey(job: ServerCaptureJob, rawEntry: unknown, index: number): string {
  const entry = normalizeServerCaptureEntry(rawEntry);
  if (!isObject(entry)) return `${job.id || job.canonicalUrl || job.url}:entry:${index}`;
  const source = isObject(entry.source) ? entry.source : {};
  const content = isObject(entry.content) ? entry.content : {};
  const candidates = [
    source.externalId,
    source.sourceLink,
    source.sourceUrl,
    content.platformPostId,
    content.noteId,
    content.id,
    content.url,
  ].map(stringValue).filter(Boolean);
  return candidates[0] || `${job.id || job.canonicalUrl || job.url}:entry:${index}`;
}

export function collectNewServerCaptureEntries(
  job: ServerCaptureJob,
  seenEntryKeys?: Set<string>,
): Array<{ key: string; entry: unknown }> {
  const entries = Array.isArray(job.result?.entries) ? job.result.entries : [];
  const collected: Array<{ key: string; entry: unknown }> = [];
  entries.forEach((rawEntry, index) => {
    const key = serverCaptureEntryKey(job, rawEntry, index);
    if (seenEntryKeys?.has(key)) return;
    collected.push({ key, entry: normalizeServerCaptureEntry(rawEntry) });
  });
  return collected;
}

export async function ingestServerCaptureJobEntries(
  job: ServerCaptureJob,
  options: { seenEntryKeys?: Set<string> } = {},
): Promise<{ success: boolean; count?: number; totalEntries?: number; importedEntryKeys?: string[]; error?: string }> {
  const collected = collectNewServerCaptureEntries(job, options.seenEntryKeys);
  const entries = collected.map((item) => item.entry);
  if (entries.length === 0) {
    return { success: true, count: 0, totalEntries: serverCaptureEntryCount(job), importedEntryKeys: [] };
  }
  const result = await window.ipcRenderer.knowledge.batchIngest({
    entries,
    documentSources: [],
    mediaAssets: [],
  }) as { success?: boolean; count?: number; error?: string } | null;
  if (!result?.success) {
    throw new Error(result?.error || '采集结果入库失败');
  }
  const importedEntryKeys = collected.map((item) => item.key);
  importedEntryKeys.forEach((key) => options.seenEntryKeys?.add(key));
  return {
    success: true,
    count: result.count || entries.length,
    totalEntries: serverCaptureEntryCount(job),
    importedEntryKeys,
  };
}

type CaptureObject = Record<string, unknown>;

export function normalizeServerCaptureEntry(entry: unknown): unknown {
  if (!isObject(entry)) return entry;
  const kind = stringValue(entry.kind);
  const source = isObject(entry.source) ? { ...entry.source } : {};
  const content = isObject(entry.content) ? { ...entry.content } : {};
  const assets = normalizeServerCaptureAssets(entry.assets);
  const metadata = isObject(content.metadata) ? { ...content.metadata } : {};
  const rawDetail = isObject(metadata.rawDetail) ? metadata.rawDetail : null;
  const rawItem = isObject(metadata.rawItem) ? metadata.rawItem : null;
  const note = rawDetail ? findXhsNotePayload(rawDetail) : rawItem;

  if (note && (kind === 'xhs-note' || kind === 'xhs-video')) {
    const title = firstString(note, ['title', 'display_title', 'share_info.title', 'mini_program_info.title']);
    const description = firstString(note, ['desc', 'description', 'content', 'share_info.content', 'share_info.desc']);
    const author = firstString(note, ['user.nickname', 'user.name', 'user_info.nickname', 'author.nickname']);
    const authorId = firstString(note, ['user.userid', 'user.id', 'user.user_id', 'user_info.user_id']);
    const authorAvatarUrl = firstString(note, ['user.image', 'user.images', 'user.avatar', 'user_info.image']);
    const imageUrls = collectXhsNoteImageUrls(note);
    const videoUrl = collectXhsNoteVideoUrls(note)[0];
    if (shouldReplaceGenericTitle(content.title, source.externalId) && title) content.title = title;
    if (!nonEmptyString(content.description) && description) content.description = description;
    if (!nonEmptyString(content.text) && description) content.text = description;
    if (!nonEmptyString(content.excerpt) && description) content.excerpt = description;
    if (!nonEmptyString(content.author) && author) content.author = author;
    if (!nonEmptyString(content.authorId) && authorId) content.authorId = authorId;
    if (!nonEmptyString(content.authorAvatarUrl) && authorAvatarUrl) content.authorAvatarUrl = authorAvatarUrl;
    if (!Array.isArray(content.tags) || content.tags.length === 0) {
      const tags = collectXhsTags(note);
      if (tags.length > 0) content.tags = tags;
    }
    content.stats = {
      ...(isObject(content.stats) ? content.stats : {}),
      likes: firstNumber(note, ['liked_count', 'likes', 'interact_info.liked_count']) ?? getNumber((content.stats as CaptureObject)?.likes),
      collects: firstNumber(note, ['collected_count', 'collect_count', 'interact_info.collected_count']) ?? getNumber((content.stats as CaptureObject)?.collects),
      comments: firstNumber(note, ['comments_count', 'comment_count', 'interact_info.comment_count']) ?? getNumber((content.stats as CaptureObject)?.comments),
    };
    if (imageUrls.length > 0) {
      assets.imageUrls = imageUrls;
      assets.coverUrl = imageUrls[0];
    }
    if (videoUrl) {
      assets.videoUrl = videoUrl;
    }
  }

  if (kind === 'douyin-video' && rawDetail) {
    const video = findDouyinVideoPayload(rawDetail) || rawDetail;
    const title = firstString(video, ['desc', 'title', 'share_info.share_title']);
    const author = firstString(video, ['author.nickname', 'author.name', 'author.short_id', 'author.unique_id']);
    const authorId = firstString(video, ['author.uid', 'author.sec_uid', 'author.short_id', 'author.unique_id']);
    const authorAvatarUrl = firstUrlFromPaths(video, [
      'author.avatar_larger.url_list',
      'author.avatar_medium.url_list',
      'author.avatar_thumb.url_list',
    ]);
    const videoUrl = collectDouyinVideoUrls(video)[0];
    const imageUrls = collectDouyinCoverUrls(video);
    if (shouldReplaceGenericTitle(content.title, source.externalId, '抖音视频') && title) content.title = title;
    if (!nonEmptyString(content.description) && title) content.description = title;
    if (!nonEmptyString(content.text) && title) content.text = title;
    if (!nonEmptyString(content.excerpt) && title) content.excerpt = title;
    if (!nonEmptyString(content.author) && author) content.author = author;
    if (!nonEmptyString(content.authorId) && authorId) content.authorId = authorId;
    if (!nonEmptyString(content.authorAvatarUrl) && authorAvatarUrl) content.authorAvatarUrl = authorAvatarUrl;
    const tags = collectDouyinTags(video);
    if ((!Array.isArray(content.tags) || content.tags.length === 0) && tags.length > 0) content.tags = tags;
    content.stats = {
      ...(isObject(content.stats) ? content.stats : {}),
      likes: firstNumber(video, ['statistics.digg_count', 'statistics.like_count']) ?? getNumber((content.stats as CaptureObject)?.likes),
      collects: firstNumber(video, ['statistics.collect_count']) ?? getNumber((content.stats as CaptureObject)?.collects),
      comments: firstNumber(video, ['statistics.comment_count']) ?? getNumber((content.stats as CaptureObject)?.comments),
    };
    if (imageUrls.length > 0) {
      assets.imageUrls = imageUrls;
      assets.coverUrl = imageUrls[0];
      assets.thumbnailUrl = imageUrls[0];
    }
    if (videoUrl) {
      assets.videoUrl = videoUrl;
    }
  }

  const xhsComments = normalizeXhsCommentsSnapshot(metadata.xhsComments, {
    noteId: stringValue(source.externalId),
    entrySourceLink: stringValue(source.sourceLink || source.sourceUrl),
  });
  if (xhsComments) {
    metadata.xhsComments = xhsComments;
    content.stats = {
      ...(isObject(content.stats) ? content.stats : {}),
      comments: xhsComments.total ?? xhsComments.visibleCount ?? getNumber((content.stats as CaptureObject)?.comments),
    };
  }
  content.metadata = metadata;
  return {
    ...entry,
    source,
    content,
    assets,
  };
}

function normalizeServerCaptureAssets(value: unknown): CaptureObject {
  const assets = isObject(value) ? { ...value } : {};
  const imageUrls = mergeStrings(
    Array.isArray(assets.imageUrls) ? assets.imageUrls.map(stringValue).filter(Boolean) : [],
    collectAssetUrls(assets.images),
  );
  const videoUrls = mergeStrings(
    nonEmptyString(assets.videoUrl) ? [stringValue(assets.videoUrl)] : [],
    collectAssetUrls(assets.videos),
  );
  if (imageUrls.length > 0) {
    assets.imageUrls = imageUrls;
    assets.coverUrl = nonEmptyString(assets.coverUrl) ? assets.coverUrl : imageUrls[0];
  }
  if (videoUrls.length > 0) {
    assets.videoUrl = nonEmptyString(assets.videoUrl) ? assets.videoUrl : videoUrls[0];
  }
  return assets;
}

function collectAssetUrls(value: unknown): string[] {
  const values = Array.isArray(value) ? value : [];
  return values.flatMap((item) => {
    if (typeof item === 'string') return [item];
    if (!isObject(item)) return [];
    return [
      item.url,
      item.original,
      item.originUrl,
      item.origin_url,
      item.urlSizeLarge,
      item.url_size_large,
    ].map(stringValue).filter(Boolean);
  });
}

function findXhsNotePayload(raw: CaptureObject): CaptureObject | null {
  for (const path of [
    'data.data.0.note_list.0',
    'data.data.note_list.0',
    'data.note_list.0',
    'data.items.0.note_card',
    'data.note_card',
    'note_card',
    'note',
  ]) {
    const value = getPath(raw, path);
    if (isObject(value)) return value;
  }
  return null;
}

function collectXhsNoteImageUrls(note: CaptureObject): string[] {
  const images = Array.isArray(note.images_list)
    ? note.images_list
    : Array.isArray(note.image_list)
      ? note.image_list
      : [];
  const urls = images.map((image) => {
    if (!isObject(image)) return '';
    return firstAvailableString([
      image.original,
      image.url_size_large,
      image.urlSizeLarge,
      image.url,
      getPath(image, 'url_multi_level.high'),
      getPath(image, 'url_multi_level.medium'),
    ]);
  }).filter(Boolean);
  return mergeStrings(urls, [
    firstString(note, ['share_info.image', 'mini_program_info.thumb', 'qq_mini_program_info.thumb']),
  ].filter(Boolean));
}

function collectXhsNoteVideoUrls(note: CaptureObject): string[] {
  return mergeStrings(
    stringsFromPath(note, 'video_info.media.stream.h264.0.master_url'),
    stringsFromPath(note, 'video_info.media.stream.h264.0.backup_urls'),
    stringsFromPath(note, 'video_info.media.stream.h265.0.master_url'),
    stringsFromPath(note, 'video_info.media.stream.h265.0.backup_urls'),
    stringsFromPath(note, 'video_info.media.video_url'),
    stringsFromPath(note, 'video_info.url'),
  );
}

function collectXhsTags(note: CaptureObject): string[] {
  const tagItems = [
    ...(Array.isArray(note.hash_tag) ? note.hash_tag : []),
    ...(Array.isArray(note.topics) ? note.topics : []),
  ];
  return mergeStrings(tagItems.map((item) => isObject(item) ? stringValue(item.name) : '').filter(Boolean), []);
}

function findDouyinVideoPayload(raw: CaptureObject): CaptureObject | null {
  for (const path of [
    'data.aweme_detail',
    'data.aweme',
    'data.item',
    'data',
    'aweme_detail',
    'aweme',
    'item',
  ]) {
    const value = getPath(raw, path);
    if (isObject(value)) return value;
  }
  return null;
}

function collectDouyinVideoUrls(video: CaptureObject): string[] {
  return mergeStrings(
    stringsFromPath(video, 'video.play_addr.url_list'),
    stringsFromPath(video, 'video.play_addr_h264.url_list'),
    stringsFromPath(video, 'video.download_addr.url_list'),
    stringsFromPath(video, 'video.bit_rate.0.play_addr.url_list'),
    stringsFromPath(video, 'video.bit_rate.0.play_addr.url_list_265'),
    stringsFromPath(video, 'video.bit_rate.1.play_addr.url_list'),
  );
}

function collectDouyinCoverUrls(video: CaptureObject): string[] {
  return mergeStrings(
    stringsFromPath(video, 'video.cover.url_list'),
    stringsFromPath(video, 'video.origin_cover.url_list'),
    stringsFromPath(video, 'video.dynamic_cover.url_list'),
    stringsFromPath(video, 'video.animated_cover.url_list'),
    stringsFromPath(video, 'cover.url_list'),
  ).slice(0, 1);
}

function collectDouyinTags(video: CaptureObject): string[] {
  const textExtra = getPath(video, 'text_extra');
  if (!Array.isArray(textExtra)) return [];
  return mergeStrings(textExtra.map((item) => isObject(item) ? firstString(item, ['hashtag_name']) : '').filter(Boolean));
}

function normalizeXhsCommentsSnapshot(value: unknown, context: { noteId?: string; entrySourceLink?: string }) {
  const rawResponses = Array.isArray(value) ? value : value ? [value] : [];
  const comments: CaptureObject[] = [];
  let total: number | undefined;
  let hasMore = false;
  for (const response of rawResponses) {
    const payload = isObject(response) ? response : {};
    const data = getFirstObject(payload, ['data.data', 'data']);
    total = total ?? firstNumber(data || {}, ['comment_count', 'total', 'count']);
    hasMore = booleanValue(getPath(data || {}, 'has_more'), false);
    const items = Array.isArray(getPath(data || {}, 'comments')) ? getPath(data || {}, 'comments') as unknown[] : [];
    for (const item of items) {
      appendNormalizedComment(comments, item, 0);
      const replies = isObject(item) && Array.isArray(item.sub_comments) ? item.sub_comments : [];
      for (const reply of replies) appendNormalizedComment(comments, reply, 1, stringValue((item as CaptureObject).id));
    }
  }
  if (comments.length === 0) return null;
  return {
    schemaVersion: 1,
    platform: 'xiaohongshu',
    noteId: context.noteId,
    sourceLink: context.entrySourceLink,
    total: total ?? comments.length,
    visibleCount: comments.length,
    hasMore,
    capturedAt: new Date().toISOString(),
    comments,
  };
}

function appendNormalizedComment(output: CaptureObject[], item: unknown, level: number, parentCommentId?: string) {
  if (!isObject(item)) return;
  const user = isObject(item.user) ? item.user : {};
  const text = firstString(item, ['content', 'text']);
  if (!text) return;
  output.push({
    id: stringValue(item.id),
    platformCommentId: stringValue(item.id),
    noteId: stringValue(item.note_id),
    parentCommentId: parentCommentId || stringValue(item.parent_comment_id) || null,
    rootCommentId: parentCommentId || stringValue(item.root_comment_id) || null,
    level,
    author: {
      userId: stringValue(user.userid || user.user_id || user.id),
      nickname: stringValue(user.nickname || user.name),
      avatarUrl: stringValue(user.images || user.image || user.avatar),
    },
    content: { text },
    metrics: {
      likes: getNumber(item.like_count) ?? 0,
      replies: getNumber(item.sub_comment_count) ?? 0,
    },
    time: {
      display: stringValue(item.time_display || item.create_time_display || item.time),
      normalizedAt: typeof item.time === 'number' ? new Date(item.time * 1000).toISOString() : null,
    },
    location: stringValue(item.ip_location || item.location) || null,
    capturedAt: new Date().toISOString(),
  });
}

function shouldReplaceGenericTitle(value: unknown, externalId: unknown, label = '小红书笔记'): boolean {
  const title = stringValue(value);
  const id = stringValue(externalId);
  return !title || (!!id && title === `${label} ${id}`);
}

function getFirstObject(source: CaptureObject, paths: string[]): CaptureObject | null {
  for (const path of paths) {
    const value = getPath(source, path);
    if (isObject(value)) return value;
  }
  return null;
}

function firstString(source: CaptureObject, paths: string[]): string {
  for (const path of paths) {
    const value = getPath(source, path);
    const normalized = stringValue(value);
    if (normalized) return normalized;
  }
  return '';
}

function firstAvailableString(values: unknown[]): string {
  for (const value of values) {
    const normalized = stringValue(value);
    if (normalized) return normalized;
  }
  return '';
}

function firstNumber(source: CaptureObject, paths: string[]): number | undefined {
  for (const path of paths) {
    const value = getNumber(getPath(source, path));
    if (typeof value === 'number') return value;
  }
  return undefined;
}

function firstUrlFromPaths(source: CaptureObject, paths: string[]): string {
  for (const path of paths) {
    const value = stringsFromPath(source, path).find((item) => /^https?:\/\//i.test(item));
    if (value) return value;
  }
  return '';
}

function stringsFromPath(source: CaptureObject, path: string): string[] {
  const value = getPath(source, path);
  if (typeof value === 'string' || typeof value === 'number') {
    const normalized = String(value).trim();
    return normalized ? [normalized] : [];
  }
  if (Array.isArray(value)) {
    return value.flatMap((item) => {
      if (typeof item === 'string' || typeof item === 'number') {
        const normalized = String(item).trim();
        return normalized ? [normalized] : [];
      }
      return [];
    });
  }
  return [];
}

function getPath(source: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((current, key) => {
    if (current === undefined || current === null) return undefined;
    if (/^\d+$/.test(key)) return Array.isArray(current) ? current[Number(key)] : undefined;
    return isObject(current) ? current[key] : undefined;
  }, source);
}

function mergeStrings(...groups: string[][]): string[] {
  const seen = new Set<string>();
  const output: string[] = [];
  for (const value of groups.flat()) {
    const normalized = stringValue(value);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    output.push(normalized);
  }
  return output;
}

function isObject(value: unknown): value is CaptureObject {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : typeof value === 'number' ? String(value) : '';
}

function nonEmptyString(value: unknown): string {
  return stringValue(value);
}

function getNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return undefined;
}

function booleanValue(value: unknown, fallback: boolean): boolean {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  const normalized = String(value).trim().toLowerCase();
  return normalized === 'true' || normalized === '1' || normalized === 'yes';
}

export function captureResponseError(response: ServerCaptureJobResponse, fallback: string): ClipboardCaptureError {
  const statusPrefix = typeof response.httpStatus === 'number' ? `HTTP ${response.httpStatus} · ` : '';
  return new ClipboardCaptureError(
    response.error ? `${statusPrefix}${response.error}` : `${statusPrefix}${fallback}`,
    formatServerCaptureResponseDebugDetails(response),
  );
}

export function formatServerCaptureResponseDebugDetails(response: ServerCaptureJobResponse): string {
  const lines: string[] = [];
  if (typeof response.httpStatus === 'number') lines.push(`HTTP: ${response.httpStatus}`);
  if (response.status) lines.push(`状态: ${response.status}`);
  if (response.error) lines.push(`错误: ${response.error}`);
  if (response.details !== undefined) lines.push(`详情: ${stringifyDebugValue(response.details)}`);
  if (response.raw !== undefined) lines.push(`原始响应: ${stringifyDebugValue(response.raw)}`);
  if (response.job) {
    const jobDetails = formatServerJobDebugDetails(response.job);
    if (jobDetails) lines.push(jobDetails);
  }
  return lines.join('\n');
}

export function formatServerJobDebugDetails(job: ServerCaptureJob): string {
  const lines = [
    `Job: ${job.id}`,
    `Job 状态: ${job.status}`,
  ];
  if (job.progress?.message) lines.push(`进度: ${job.progress.message}`);
  if (job.error?.code) lines.push(`错误码: ${job.error.code}`);
  if (job.error?.message) lines.push(`错误: ${job.error.message}`);
  if (job.error?.details !== undefined) lines.push(`详情: ${stringifyDebugValue(job.error.details)}`);
  if (Array.isArray(job.logs) && job.logs.length > 0) {
    lines.push('服务端日志:');
    for (const line of job.logs.slice(-8)) {
      lines.push(`- ${formatServerLogLine(line)}`);
    }
  }
  return lines.join('\n');
}

function formatServerLogLine(log: string | { message?: string | null; level?: string | null; timestamp?: string | null }): string {
  if (typeof log === 'string') return log;
  return [log.timestamp, log.level, log.message].filter(Boolean).join(' · ');
}

function stringifyDebugValue(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}
