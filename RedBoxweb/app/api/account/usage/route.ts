import { NextRequest } from 'next/server';
import { proxyAccountRequest } from '@/app/lib/account/redbox-api';

export async function GET(request: NextRequest) {
    const upstreamQuery = new URLSearchParams();
    const page = request.nextUrl.searchParams.get('page');
    const limit = request.nextUrl.searchParams.get('limit');
    if (page) upstreamQuery.set('page', page);
    if (limit) upstreamQuery.set('limit', limit);

    const query = upstreamQuery.toString();
    return proxyAccountRequest(request, `users/me/ai-usage-logs${query ? `?${query}` : ''}`);
}
