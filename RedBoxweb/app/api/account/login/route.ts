import { NextRequest, NextResponse } from 'next/server';
import {
    accountApiUnavailableResponse,
    configuredAccountApi,
    loginAccount,
    sanitizeAuthPayload,
    setAuthCookies,
} from '@/app/lib/account/redbox-api';

export async function POST(request: NextRequest) {
    if (!configuredAccountApi()) {
        return accountApiUnavailableResponse();
    }

    const body = await request.json().catch(() => null);
    const result = await loginAccount(body);
    const response = NextResponse.json(sanitizeAuthPayload(result.data), { status: result.status });
    if (result.status >= 200 && result.status < 300) {
        setAuthCookies(response, result.data as Record<string, unknown>);
    }
    return response;
}
