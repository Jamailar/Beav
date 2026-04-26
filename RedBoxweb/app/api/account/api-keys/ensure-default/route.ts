import { NextRequest } from 'next/server';
import { proxyAccountRequest } from '@/app/lib/account/redbox-api';

export async function POST(request: NextRequest) {
    const body = await request.json().catch(() => ({}));
    return proxyAccountRequest(request, 'users/me/api-keys/ensure-default', {
        method: 'POST',
        body: JSON.stringify(body || {}),
    });
}
