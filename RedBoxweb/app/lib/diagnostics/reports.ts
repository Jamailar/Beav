import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

export const DIAGNOSTICS_RETENTION_DAYS = 30;
export const DIAGNOSTICS_MAX_BUNDLE_BYTES = 8 * 1024 * 1024;
export const DIAGNOSTICS_ALLOWED_MIME_TYPES = new Set([
    'application/zip',
    'application/zstd',
    'application/octet-stream',
]);

export type DiagnosticsMetadata = {
    reportId?: string;
    trigger?: string;
    createdAt?: string;
    summary?: string;
    metadata?: Record<string, unknown> | null;
    app?: string;
    version?: string;
    platform?: string;
    channel?: string;
    buildType?: string;
};

export type PersistDiagnosticsReportInput = {
    storageRoot: string;
    metadata: DiagnosticsMetadata;
    bundle: File;
};

function sanitizeSegment(value: string) {
    return value.replace(/[^a-zA-Z0-9._-]/g, '-').slice(0, 120) || randomUUID();
}

function stableDedupePayload(metadata: DiagnosticsMetadata) {
    return JSON.stringify({
        app: metadata.app || 'unknown',
        version: metadata.version || 'unknown',
        platform: metadata.platform || 'unknown',
        channel: metadata.channel || 'unknown',
        buildType: metadata.buildType || 'unknown',
        trigger: metadata.trigger || 'manual',
        summary: metadata.summary || '',
    });
}

export function buildDiagnosticsDedupeKey(metadata: DiagnosticsMetadata) {
    return createHash('sha256').update(stableDedupePayload(metadata)).digest('hex').slice(0, 24);
}

export async function pruneExpiredDiagnosticsReports(storageRoot: string) {
    const entries = await fs.readdir(storageRoot, { withFileTypes: true }).catch(() => []);
    const expireBefore = Date.now() - DIAGNOSTICS_RETENTION_DAYS * 24 * 60 * 60 * 1000;
    await Promise.all(entries.map(async (entry) => {
        if (!entry.isDirectory()) {
            return;
        }
        const entryPath = path.join(storageRoot, entry.name);
        const stat = await fs.stat(entryPath).catch(() => null);
        if (stat && stat.mtimeMs < expireBefore) {
            await fs.rm(entryPath, { recursive: true, force: true });
        }
    }));
}

export async function persistDiagnosticsReport(input: PersistDiagnosticsReportInput) {
    const reportId = sanitizeSegment(input.metadata.reportId || `report-${randomUUID()}`);
    const receivedAt = new Date().toISOString();
    const dedupeKey = buildDiagnosticsDedupeKey(input.metadata);
    const reportDir = path.join(input.storageRoot, reportId);
    const bundleExtension = input.bundle.type === 'application/zstd' ? '.zst' : '.zip';
    const bundleFileName = `bundle${bundleExtension}`;
    const metadataPayload = {
        reportId,
        receivedAt,
        retentionDays: DIAGNOSTICS_RETENTION_DAYS,
        dedupeKey,
        metadata: input.metadata,
        bundle: {
            name: input.bundle.name || bundleFileName,
            type: input.bundle.type || 'application/octet-stream',
            size: input.bundle.size,
            storedAs: bundleFileName,
        },
    };

    await fs.mkdir(reportDir, { recursive: true });
    const bundleBuffer = Buffer.from(await input.bundle.arrayBuffer());
    await fs.writeFile(path.join(reportDir, bundleFileName), bundleBuffer);
    await fs.writeFile(
        path.join(reportDir, 'metadata.json'),
        JSON.stringify(metadataPayload, null, 2),
        'utf8',
    );

    return {
        reportId,
        receivedAt,
        retentionDays: DIAGNOSTICS_RETENTION_DAYS,
        dedupeKey,
    };
}
