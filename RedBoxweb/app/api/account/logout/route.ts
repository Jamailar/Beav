import { NextRequest } from 'next/server';
import { logoutAccount } from '@/app/lib/account/redbox-api';

export async function POST(request: NextRequest) {
    return logoutAccount(request);
}
