import { app } from 'electron';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { buildVideoEditorV2RemotionComposition, VIDEO_EDITOR_V2_REMOTION_COMPOSITION_ID } from '../../../shared/videoAutoEditRemotion';
import type { RenderOutputRecord, SrtSegment, VideoEditorV2Project } from '../../../shared/videoAutoEdit';
import { serializeSegmentsToSrt } from '../video-auto-edit/srtParser';
import { getVideoEditorV2Project, saveVideoEditorV2Project } from './videoEditorV2ProjectStore';

type RenderProgressPayload = {
  projectId: string;
  stage: string;
  percent: number;
  status: 'running' | 'completed' | 'failed';
  outputPath?: string;
  error?: string;
};

export type VideoEditorV2RenderProgress = (payload: RenderProgressPayload) => void;

export type RenderVideoEditorV2ProjectInput = {
  projectId: string;
  outputPath?: string;
  renderVideo?: boolean;
  onProgress?: VideoEditorV2RenderProgress;
};

function nowIso(): string {
  return new Date().toISOString();
}

function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  return fs.mkdir(path.dirname(filePath), { recursive: true })
    .then(async () => {
      const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
      await fs.writeFile(tempPath, JSON.stringify(value, null, 2), 'utf-8');
      await fs.rename(tempPath, filePath);
    });
}

function sanitizeFileBaseName(value: string): string {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[^\w\-.一-龥]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .trim()
    || 'video-edit';
}

function timestampForFileName(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function getDefaultOutputPath(project: VideoEditorV2Project): string {
  return path.join(
    project.projectDir,
    'renders',
    `${sanitizeFileBaseName(project.title)}-${timestampForFileName()}.mp4`,
  );
}

function ensureMp4OutputPath(rawPath: string): string {
  const normalized = path.resolve(path.normalize(rawPath));
  return path.extname(normalized) ? normalized : `${normalized}.mp4`;
}

function buildTimelineSrtSegments(project: VideoEditorV2Project): SrtSegment[] {
  const subtitleTrack = project.timeline.tracks.find((track) => track.kind === 'subtitle');
  if (!subtitleTrack) return [];
  return subtitleTrack.clips
    .filter((clip) => String(clip.text || '').trim())
    .sort((left, right) => left.timelineStartMs - right.timelineStartMs)
    .map((clip, index) => ({
      id: `render_subtitle_${index + 1}`,
      index: index + 1,
      assetId: String(clip.assetId || ''),
      startMs: Math.max(0, Math.round(clip.timelineStartMs)),
      endMs: Math.max(0, Math.round(clip.timelineEndMs)),
      text: String(clip.text || '').trim(),
      tags: [],
    }));
}

async function writeTimelineSrt(project: VideoEditorV2Project): Promise<string | null> {
  const segments = buildTimelineSrtSegments(project);
  if (segments.length === 0) return null;
  const srtPath = path.join(
    project.projectDir,
    'renders',
    `${sanitizeFileBaseName(project.title)}-${timestampForFileName()}.edited.srt`,
  );
  await fs.mkdir(path.dirname(srtPath), { recursive: true });
  await fs.writeFile(srtPath, serializeSegmentsToSrt(segments), 'utf-8');
  return srtPath;
}

function findDesktopRoot(): string | null {
  const candidates = [
    app.getAppPath(),
    process.cwd(),
    path.resolve(__dirname, '..'),
    path.resolve(__dirname, '../..'),
    path.resolve(__dirname, '../../..'),
  ];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    const root = path.resolve(candidate);
    if (seen.has(root)) continue;
    seen.add(root);
    if (
      fsSync.existsSync(path.join(root, 'package.json'))
      && fsSync.existsSync(path.join(root, 'src', 'remotion', 'index.ts'))
    ) {
      return root;
    }
  }
  return null;
}

function resolveRemotionEntryPoint(): { desktopRoot: string; entryPoint: string } {
  const desktopRoot = findDesktopRoot();
  if (!desktopRoot) {
    throw new Error('无法找到 Remotion 渲染入口 src/remotion/index.ts。请确认桌面端源码已随运行环境可用。');
  }
  return {
    desktopRoot,
    entryPoint: path.join(desktopRoot, 'src', 'remotion', 'index.ts'),
  };
}

async function renderRemotionComposition(input: {
  project: VideoEditorV2Project;
  composition: Record<string, unknown>;
  outputPath: string;
  onProgress?: VideoEditorV2RenderProgress;
}): Promise<void> {
  const { desktopRoot, entryPoint } = resolveRemotionEntryPoint();
  const [{ bundle }, { renderMedia, selectComposition }] = await Promise.all([
    import('@remotion/bundler') as Promise<any>,
    import('@remotion/renderer') as Promise<any>,
  ]);
  const inputProps = {
    composition: input.composition,
    runtime: 'render',
  };

  input.onProgress?.({
    projectId: input.project.id,
    stage: '打包 Remotion 渲染入口',
    percent: 10,
    status: 'running',
  });

  const serveUrl = await bundle({
    entryPoint,
    rootDir: desktopRoot,
    publicDir: path.join(desktopRoot, 'public'),
    ignoreRegisterRootWarning: true,
    onProgress: (progress: number) => {
      input.onProgress?.({
        projectId: input.project.id,
        stage: '打包 Remotion 渲染入口',
        percent: Math.round(10 + Math.max(0, Math.min(1, progress)) * 25),
        status: 'running',
      });
    },
    webpackOverride: (config: any) => {
      config.resolve = config.resolve || {};
      config.resolve.alias = {
        ...(config.resolve.alias || {}),
        '@tauri-apps/api/core': path.join(desktopRoot, 'src', 'compat', 'tauri-core.ts'),
        '@tauri-apps/api/event': path.join(desktopRoot, 'src', 'compat', 'tauri-event.ts'),
      };
      return config;
    },
  });

  input.onProgress?.({
    projectId: input.project.id,
    stage: '读取 Remotion composition',
    percent: 40,
    status: 'running',
  });
  const composition = await selectComposition({
    serveUrl,
    id: VIDEO_EDITOR_V2_REMOTION_COMPOSITION_ID,
    inputProps,
  });

  await renderMedia({
    composition,
    serveUrl,
    codec: 'h264',
    imageFormat: 'jpeg',
    outputLocation: input.outputPath,
    inputProps,
    overwrite: true,
    logLevel: 'warn',
    onProgress: (progress: { progress?: number }) => {
      input.onProgress?.({
        projectId: input.project.id,
        stage: '渲染 MP4',
        percent: Math.round(45 + Math.max(0, Math.min(1, Number(progress.progress) || 0)) * 50),
        status: 'running',
      });
    },
  });
}

export async function renderVideoEditorV2Project(input: RenderVideoEditorV2ProjectInput): Promise<{
  project: VideoEditorV2Project;
  outputPath?: string;
  compositionPath: string;
  subtitlePath?: string | null;
}> {
  const project = await getVideoEditorV2Project(input.projectId);
  if (!project) {
    throw new Error('Video editor V2 project not found');
  }
  const composition = buildVideoEditorV2RemotionComposition(project);
  if (!composition) {
    throw new Error('生成 Remotion 快照前需要先生成自动粗剪 timeline');
  }

  const renderId = `render_${Date.now()}_${randomUUID().slice(0, 8)}`;
  const compositionPath = path.join(project.projectDir, 'remotion', 'composition.latest.json');
  await writeJsonAtomic(compositionPath, composition);
  const subtitlePath = await writeTimelineSrt(project);
  let updatedProject = await saveVideoEditorV2Project({
    ...project,
    status: input.renderVideo === false ? project.status : 'rendering',
    remotionSnapshot: {
      compositionPath,
      updatedAt: nowIso(),
    },
    lastError: null,
  });

  if (input.renderVideo === false) {
    return {
      project: updatedProject,
      compositionPath,
      subtitlePath,
    };
  }

  const outputPath = ensureMp4OutputPath(String(input.outputPath || '').trim() || getDefaultOutputPath(updatedProject));
  try {
    input.onProgress?.({
      projectId: project.id,
      stage: '准备渲染',
      percent: 5,
      status: 'running',
      outputPath,
    });
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await renderRemotionComposition({
      project: updatedProject,
      composition: {
        ...composition,
        render: {
          outputPath,
          renderedAt: Date.now(),
          durationInFrames: composition.durationInFrames,
          renderMode: 'full',
          compositionId: VIDEO_EDITOR_V2_REMOTION_COMPOSITION_ID,
          codec: 'h264',
          imageFormat: 'jpeg',
        },
      },
      outputPath,
      onProgress: input.onProgress,
    });

    const renderOutput: RenderOutputRecord = {
      id: renderId,
      path: outputPath,
      createdAt: nowIso(),
      durationMs: updatedProject.timeline.durationMs,
    };
    updatedProject = await saveVideoEditorV2Project({
      ...updatedProject,
      status: 'exported',
      renderOutputs: [renderOutput, ...(updatedProject.renderOutputs || [])].slice(0, 20),
      lastError: null,
    });
    input.onProgress?.({
      projectId: project.id,
      stage: '导出完成',
      percent: 100,
      status: 'completed',
      outputPath,
    });
    return {
      project: updatedProject,
      outputPath,
      compositionPath,
      subtitlePath,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    updatedProject = await saveVideoEditorV2Project({
      ...updatedProject,
      status: 'failed',
      lastError: message,
    });
    input.onProgress?.({
      projectId: project.id,
      stage: '导出失败',
      percent: 100,
      status: 'failed',
      outputPath,
      error: message,
    });
    throw error;
  }
}
