import { NextRequest, NextResponse } from 'next/server';
import { getLatestManifest } from '../../../lib/downloads';
import { buildAppUpdateResponse, isSupportedArch, isSupportedPlatform } from '../../../lib/updates';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
    const platform = request.nextUrl.searchParams.get('platform');
    const arch = request.nextUrl.searchParams.get('arch');
    const currentVersion = request.nextUrl.searchParams.get('currentVersion');

    if (!isSupportedPlatform(platform)) {
        return NextResponse.json({
            ready: false,
            updateAvailable: false,
            message: 'platform must be windows or macos',
        }, { status: 400 });
    }

    if (!isSupportedArch(arch)) {
        return NextResponse.json({
            ready: false,
            updateAvailable: false,
            message: 'arch must be x64, x86, or arm64',
        }, { status: 400 });
    }

    try {
        const manifest = await getLatestManifest();
        const result = buildAppUpdateResponse(manifest, request.nextUrl.origin, platform, arch, currentVersion);
        return NextResponse.json(result.body, { status: result.status });
    } catch (error) {
        return NextResponse.json({
            ready: false,
            updateAvailable: false,
            message: error instanceof Error ? error.message : 'Failed to load update manifest',
        }, { status: 500 });
    }
}
