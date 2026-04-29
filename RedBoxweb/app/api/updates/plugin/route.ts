import { NextRequest, NextResponse } from 'next/server';
import { getLatestManifest } from '../../../lib/downloads';
import { buildPluginUpdateResponse } from '../../../lib/updates';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
    const currentVersion = request.nextUrl.searchParams.get('currentVersion');

    try {
        const manifest = await getLatestManifest();
        const result = buildPluginUpdateResponse(manifest, request.nextUrl.origin, currentVersion);
        return NextResponse.json(result.body, { status: result.status });
    } catch (error) {
        return NextResponse.json({
            ready: false,
            updateAvailable: false,
            message: error instanceof Error ? error.message : 'Failed to load update manifest',
        }, { status: 500 });
    }
}
