import { NextResponse } from 'next/server';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

import { getOptionalDiagnosticsEnv } from '@/app/lib/env';
import {
    DIAGNOSTICS_ALLOWED_MIME_TYPES,
    DIAGNOSTICS_MAX_BUNDLE_BYTES,
    persistDiagnosticsReport,
    pruneExpiredDiagnosticsReports,
    type DiagnosticsMetadata,
} from '@/app/lib/diagnostics/reports';

export const runtime = 'nodejs';

function badRequest(message: string, status = 400) {
    return NextResponse.json({ error: message }, { status });
}

function parseMetadata(raw: FormDataEntryValue | null) {
    if (typeof raw !== 'string' || !raw.trim()) {
        throw new Error('metadata is required');
    }
    return JSON.parse(raw) as DiagnosticsMetadata;
}

function resolveStorageDir() {
    const env = getOptionalDiagnosticsEnv();
    if (env) {
        return env.DIAGNOSTICS_STORAGE_DIR;
    }
    return path.join(process.cwd(), '.diagnostics-reports');
}

export async function POST(request: Request) {
    try {
        const form = await request.formData();
        const metadata = parseMetadata(form.get('metadata'));
        const bundle = form.get('bundle');

        if (!(bundle instanceof File)) {
            return badRequest('bundle file is required');
        }
        if (bundle.size <= 0) {
            return badRequest('bundle file is empty');
        }
        if (bundle.size > DIAGNOSTICS_MAX_BUNDLE_BYTES) {
            return badRequest(`bundle file exceeds ${DIAGNOSTICS_MAX_BUNDLE_BYTES} bytes`, 413);
        }
        if (bundle.type && !DIAGNOSTICS_ALLOWED_MIME_TYPES.has(bundle.type)) {
            return badRequest(`unsupported bundle content type: ${bundle.type}`);
        }
        if (!String(metadata.app || '').trim()) {
            return badRequest('metadata.app is required');
        }
        if (!String(metadata.version || '').trim()) {
            return badRequest('metadata.version is required');
        }
        if (!String(metadata.platform || '').trim()) {
            return badRequest('metadata.platform is required');
        }
        if (!String(metadata.channel || '').trim()) {
            return badRequest('metadata.channel is required');
        }

        const storageRoot = resolveStorageDir();
        await mkdir(storageRoot, { recursive: true });
        await pruneExpiredDiagnosticsReports(storageRoot);

        const response = await persistDiagnosticsReport({
            storageRoot,
            metadata,
            bundle,
        });

        return NextResponse.json(response, { status: 201 });
    } catch (error) {
        if (error instanceof SyntaxError) {
            return badRequest('metadata must be valid JSON');
        }
        const message = error instanceof Error ? error.message : 'diagnostics report ingest failed';
        return NextResponse.json({ error: message }, { status: 500 });
    }
}
