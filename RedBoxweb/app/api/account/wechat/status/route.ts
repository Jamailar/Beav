import { NextRequest, NextResponse } from 'next/server';
import {
    accountApiUnavailableResponse,
    configuredAccountApi,
    normalizeWechatStatusPayload,
    pollWechatLogin,
    setWechatAuthCookies,
} from '@/app/lib/account/redbox-api';

export async function GET(request: NextRequest) {
    if (!configuredAccountApi()) {
        return accountApiUnavailableResponse();
    }

    const sessionId = String(
        request.nextUrl.searchParams.get('session_id') || request.nextUrl.searchParams.get('sessionId') || '',
    ).trim();

    if (!sessionId) {
        return NextResponse.json({ error: 'Missing session_id' }, { status: 400 });
    }

    const result = await pollWechatLogin(sessionId);
    const payload = result.status >= 200 && result.status < 300
        ? normalizeWechatStatusPayload(result.data)
        : result.data;
    const response = NextResponse.json(payload, { status: result.status });

    if (result.status >= 200 && result.status < 300 && normalizeWechatStatusPayload(result.data).status === 'CONFIRMED') {
        setWechatAuthCookies(response, result.data);
    }

    return response;
}
