import fs from 'node:fs/promises';
import path from 'node:path';
import { app, shell } from 'electron';
import {
  getDebugLogDirectory,
  getRecentDebugLogs,
  isDebugLoggingEnabled,
  logDebugEvent,
} from './debugLogger';

export interface DiagnosticsPendingReport {
  id: string;
  trigger: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  summary: string;
  includeAdvancedContext: boolean;
  lastError?: string | null;
  uploadedAt?: string | null;
  lastAttemptAt?: string | null;
  dedupeKey?: string | null;
  bundleFileName?: string | null;
  metadata?: unknown;
}

type FeedbackReportPayload = {
  title?: string;
  content?: string;
  category?: string;
  priority?: 'low' | 'medium' | 'high' | 'urgent';
  source?: string;
  contact?: string;
  includeAdvancedContext?: boolean;
  uploadNow?: boolean;
  context?: Record<string, unknown>;
};

type AutoReportPayload = {
  level?: 'trace' | 'debug' | 'info' | 'warn' | 'error';
  category?: string;
  event?: string;
  message?: string;
  fields?: unknown;
  trigger?: string;
};

function reportsRoot(): string {
  return path.join(app.getPath('userData'), 'diagnostic-reports');
}

function pendingDir(): string {
  return path.join(reportsRoot(), 'pending');
}

function exportDir(): string {
  return path.join(reportsRoot(), 'exports');
}

function slug(value: string): string {
  return String(value || '')
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 96) || 'report';
}

function reportPath(reportId: string): string {
  return path.join(pendingDir(), `${slug(reportId)}.json`);
}

async function ensureReportDirs(): Promise<void> {
  await fs.mkdir(pendingDir(), { recursive: true });
  await fs.mkdir(exportDir(), { recursive: true });
}

function nowIso(): string {
  return new Date().toISOString();
}

function summarize(value: string, fallback: string): string {
  const text = String(value || '').trim().replace(/\s+/g, ' ');
  if (!text) return fallback;
  return text.length > 80 ? `${text.slice(0, 80)}...` : text;
}

async function readReport(filePath: string): Promise<DiagnosticsPendingReport | null> {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw) as DiagnosticsPendingReport;
    return parsed && typeof parsed.id === 'string' ? parsed : null;
  } catch {
    return null;
  }
}

async function writeReport(report: DiagnosticsPendingReport): Promise<DiagnosticsPendingReport> {
  await ensureReportDirs();
  await fs.writeFile(reportPath(report.id), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  return report;
}

export async function getDiagnosticsLogStatus() {
  await ensureReportDirs();
  const pending = await listPendingDiagnosticReports();
  return {
    enabled: true,
    logDirectory: getDebugLogDirectory(),
    reportDirectory: reportsRoot(),
    retentionDays: 7,
    maxFileMb: 10,
    recentPreviewLimit: 200,
    uploadConfigured: false,
    uploadEndpoint: null,
    pendingCount: pending.length,
    debugVerboseEnabled: isDebugLoggingEnabled(),
    previousUncleanShutdown: false,
  };
}

export function getRecentDiagnosticsLogs(limit = 200) {
  return {
    lines: getRecentDebugLogs(Number.isFinite(limit) ? Math.max(1, Math.min(limit, 1000)) : 200),
  };
}

export async function openDiagnosticsReportDirectory(): Promise<{ success: boolean; error?: string; path: string }> {
  await ensureReportDirs();
  const targetDir = reportsRoot();
  try {
    const result = await shell.openPath(targetDir);
    if (result) return { success: false, error: result, path: targetDir };
    return { success: true, path: targetDir };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
      path: targetDir,
    };
  }
}

export async function listPendingDiagnosticReports(): Promise<DiagnosticsPendingReport[]> {
  await ensureReportDirs();
  const entries = await fs.readdir(pendingDir(), { withFileTypes: true }).catch(() => []);
  const reports = await Promise.all(
    entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
      .map((entry) => readReport(path.join(pendingDir(), entry.name))),
  );
  return reports
    .filter((report): report is DiagnosticsPendingReport => Boolean(report))
    .sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)));
}

export async function createFeedbackReport(payload: FeedbackReportPayload) {
  const content = String(payload?.content || payload?.title || '').trim();
  if (!content) {
    return { success: false, error: 'content is required' };
  }

  const createdAt = nowIso();
  const id = `feedback-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const includeAdvancedContext = Boolean(payload.includeAdvancedContext);
  const report: DiagnosticsPendingReport = {
    id,
    trigger: 'manual-feedback',
    status: 'pending',
    createdAt,
    updatedAt: createdAt,
    summary: summarize(payload.title || content, '用户反馈'),
    includeAdvancedContext,
    lastError: null,
    uploadedAt: null,
    lastAttemptAt: null,
    dedupeKey: null,
    bundleFileName: null,
    metadata: {
      kind: 'feedback',
      title: String(payload.title || '').trim(),
      content,
      category: payload.category || 'desktop_bug',
      priority: payload.priority || 'medium',
      source: payload.source || 'desktop',
      contact: String(payload.contact || '').trim(),
      context: payload.context || {},
      recentLogs: getRecentDebugLogs(includeAdvancedContext ? 300 : 120),
    },
  };
  await writeReport(report);
  logDebugEvent('diagnostics', 'info', 'feedback report created', { reportId: id, summary: report.summary });
  return { success: true, uploaded: false, report };
}

export async function createAutoDiagnosticReport(payload?: AutoReportPayload) {
  const message = String(payload?.message || payload?.event || '').trim();
  if (!message) {
    return { success: false, error: 'message is required' };
  }

  const trigger = String(payload?.trigger || 'renderer_error').trim() || 'renderer_error';
  const category = String(payload?.category || 'renderer').trim() || 'renderer';
  const event = String(payload?.event || 'renderer.error').trim() || 'renderer.error';
  const level = String(payload?.level || 'error').trim() || 'error';
  const title = `${event}: ${summarize(message, 'Renderer error')}`;
  return createFeedbackReport({
    title,
    content: message,
    category: 'desktop_bug',
    priority: level === 'error' ? 'high' : 'medium',
    source: 'renderer-auto',
    includeAdvancedContext: false,
    uploadNow: false,
    context: {
      kind: 'auto-renderer-report',
      trigger,
      category,
      event,
      level,
      fields: payload?.fields ?? null,
    },
  });
}

export async function exportDiagnosticBundle(reportId?: string, payload?: { includeAdvancedContext?: boolean }) {
  await ensureReportDirs();
  const targetId = String(reportId || '').trim();
  const includeAdvancedContext = Boolean(payload?.includeAdvancedContext);
  let report: DiagnosticsPendingReport | null = null;

  if (targetId) {
    report = await readReport(reportPath(targetId));
    if (!report) return { success: false, reportId: targetId, path: '', error: 'Report not found' };
  }

  const exportedAt = nowIso();
  const exportId = targetId || `manual-${Date.now()}`;
  const exportPath = path.join(exportDir(), `${slug(exportId)}.json`);
  const bundle = {
    exportedAt,
    reportId: exportId,
    report,
    includeAdvancedContext,
    logDirectory: getDebugLogDirectory(),
    recentLogs: getRecentDebugLogs(includeAdvancedContext ? 500 : 200),
  };
  await fs.writeFile(exportPath, `${JSON.stringify(bundle, null, 2)}\n`, 'utf8');

  if (report) {
    report.bundleFileName = path.basename(exportPath);
    report.updatedAt = exportedAt;
    await writeReport(report);
  }

  return { success: true, reportId: exportId, path: exportPath };
}

export async function uploadDiagnosticReport(reportId: string) {
  const targetId = String(reportId || '').trim();
  if (!targetId) return { success: false, error: 'reportId is required' };
  const report = await readReport(reportPath(targetId));
  if (!report) return { success: false, error: 'Report not found' };
  report.lastAttemptAt = nowIso();
  report.lastError = '开源 Electron 版未配置诊断上传服务，请导出诊断包后手动发送。';
  report.updatedAt = report.lastAttemptAt;
  await writeReport(report);
  return { success: false, report, error: report.lastError };
}

export async function dismissDiagnosticReport(reportId: string) {
  const targetId = String(reportId || '').trim();
  if (!targetId) return { success: false, reportId: '', error: 'reportId is required' };
  await fs.rm(reportPath(targetId), { force: true });
  return { success: true, reportId: targetId };
}

export function appendRendererDiagnosticLog(payload?: {
  level?: 'trace' | 'debug' | 'info' | 'warn' | 'error';
  category?: string;
  event?: string;
  message?: string;
  fields?: unknown;
}) {
  const level = payload?.level === 'error' ? 'error' : payload?.level === 'warn' ? 'warn' : 'info';
  const category = String(payload?.category || 'renderer').trim() || 'renderer';
  const event = String(payload?.event || 'event').trim() || 'event';
  const message = String(payload?.message || event);
  logDebugEvent(category, level, message, payload?.fields);
  return { success: true };
}
