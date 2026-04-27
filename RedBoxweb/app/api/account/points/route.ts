import { NextRequest } from 'next/server';
import { proxyAccountRequest } from '@/app/lib/account/redbox-api';

export async function GET(request: NextRequest) {
    return proxyAccountRequest(request, 'users/me/points');
}
