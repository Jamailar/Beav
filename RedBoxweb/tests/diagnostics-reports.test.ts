import { promises as fs } from 'node:fs';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
    buildDiagnosticsDedupeKey,
    persistDiagnosticsReport,
    pruneExpiredDiagnosticsReports,
} from '../app/lib/diagnostics/reports';

const createdRoots = new Set<string>();

function testRoot(name: string) {
    const root = path.join(process.cwd(), '.tmp-tests', `${name}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    createdRoots.add(root);
    return root;
}

afterEach(async () => {
    await Promise.all(Array.from(createdRoots).map(async (root) => {
        await fs.rm(root, { recursive: true, force: true });
    }));
    createdRoots.clear();
});

describe('diagnostics reports helpers', () => {
    it('builds a stable dedupe key for equivalent metadata', () => {
        const metadata = {
            app: 'RedBox',
            version: '1.9.3',
            platform: 'macos',
            channel: 'release',
            buildType: 'tauri',
            trigger: 'panic',
            summary: 'Renderer crashed',
        };

        expect(buildDiagnosticsDedupeKey(metadata)).toBe(buildDiagnosticsDedupeKey({ ...metadata }));
    });

    it('persists metadata and bundle under a sanitized report directory', async () => {
        const storageRoot = testRoot('persist-report');
        const result = await persistDiagnosticsReport({
            storageRoot,
            metadata: {
                reportId: 'report:/panic?renderer',
                app: 'RedBox',
                version: '1.9.3',
                platform: 'macos',
                channel: 'release',
                buildType: 'tauri',
                summary: 'panic',
            },
            bundle: new File([Buffer.from('zip-bytes')], 'bundle.zip', { type: 'application/zip' }),
        });

        const reportDir = path.join(storageRoot, result.reportId);
        const metadataRaw = await fs.readFile(path.join(reportDir, 'metadata.json'), 'utf8');
        const metadata = JSON.parse(metadataRaw) as { bundle: { storedAs: string; size: number } };
        const bundleBuffer = await fs.readFile(path.join(reportDir, 'bundle.zip'));

        expect(result.reportId).toBe('report--panic-renderer');
        expect(metadata.bundle.storedAs).toBe('bundle.zip');
        expect(metadata.bundle.size).toBe(9);
        expect(bundleBuffer.toString()).toBe('zip-bytes');
    });

    it('prunes expired diagnostics report directories', async () => {
        const storageRoot = testRoot('prune-report');
        const staleDir = path.join(storageRoot, 'stale-report');
        const freshDir = path.join(storageRoot, 'fresh-report');

        await fs.mkdir(staleDir, { recursive: true });
        await fs.mkdir(freshDir, { recursive: true });

        const staleDate = new Date('2020-01-01T00:00:00.000Z');
        await fs.utimes(staleDir, staleDate, staleDate);

        await pruneExpiredDiagnosticsReports(storageRoot);

        await expect(fs.stat(staleDir)).rejects.toThrow();
        await expect(fs.stat(freshDir)).resolves.toBeTruthy();
    });
});
