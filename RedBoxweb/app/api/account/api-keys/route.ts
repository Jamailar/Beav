import { NextRequest } from 'next/server';
import { proxyAccountRequest } from '@/app/lib/account/redbox-api';

export async function GET(request: NextRequest) {
    return proxyAccountRequest(request, 'users/me/api-keys');
}

export async function POST(request: NextRequest) {
    const body = await request.json().catch(() => ({}));
    return proxyAccountRequest(request, 'users/me/api-keys', {
        method: 'POST',
        body: JSON.stringify(body || {}),
    });
}
