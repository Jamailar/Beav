import { NextRequest, NextResponse } from 'next/server';
import {
    accountApiUnavailableResponse,
    configuredAccountApi,
    normalizeWechatStartPayload,
    startWechatLogin,
} from '@/app/lib/account/redbox-api';

export async function POST(request: NextRequest) {
    if (!configuredAccountApi()) {
        return accountApiUnavailableResponse();
    }

    const body = await request.json().catch(() => ({}));
    const state = typeof body?.state === 'string' && body.state.trim() ? body.state.trim() : 'redboxweb';
    const result = await startWechatLogin(state);
    const payload = result.status >= 200 && result.status < 300
        ? normalizeWechatStartPayload(result.data)
        : result.data;

    return NextResponse.json(payload, { status: result.status });
}
