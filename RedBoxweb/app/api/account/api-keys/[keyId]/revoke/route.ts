import { NextRequest } from 'next/server';
import { proxyAccountRequest } from '@/app/lib/account/redbox-api';

interface RouteContext {
    params: Promise<{
        keyId: string;
    }>;
}

export async function POST(request: NextRequest, context: RouteContext) {
    const { keyId } = await context.params;
    return proxyAccountRequest(request, `users/me/api-keys/${encodeURIComponent(keyId)}/revoke`, {
        method: 'POST',
        body: JSON.stringify({}),
    });
}
