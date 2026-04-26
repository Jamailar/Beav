import { NextRequest, NextResponse } from 'next/server';

const accessCookieName = 'redbox_access_token';
const refreshCookieName = 'redbox_refresh_token';

const cookieOptions = {
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: process.env.NODE_ENV === 'production',
    path: '/',
};

type JsonBody = Record<string, unknown> | Array<unknown> | string | number | boolean | null;

interface UpstreamResult {
    data: unknown;
    status: number;
}

interface AuthTokens {
    access_token?: unknown;
    refresh_token?: unknown;
}

function getAccountApiBaseUrl() {
    return String(process.env.REDBOX_API_BASE_URL || '').trim().replace(/\/+$/, '');
}

function getAccountAppSlug() {
    return String(process.env.REDBOX_APP_SLUG || 'redbox').trim().replace(/^\/+|\/+$/g, '');
}

function buildAccountUrl(pathname: string) {
    const baseUrl = getAccountApiBaseUrl();
    if (!baseUrl) {
        throw new Error('Missing required environment variable: REDBOX_API_BASE_URL');
    }

    const appSlug = getAccountAppSlug();
    const normalizedPath = pathname.replace(/^\/+/, '');
    const prefix = appSlug ? `/${encodeURIComponent(appSlug)}/v1` : '/api/v1';
    return `${baseUrl}${prefix}/${normalizedPath}`;
}

function buildHeaders(token?: string, headers?: HeadersInit) {
    const nextHeaders = new Headers(headers);
    nextHeaders.set('Accept', 'application/json');
    if (!nextHeaders.has('Content-Type')) {
        nextHeaders.set('Content-Type', 'application/json');
    }
    if (token) {
        nextHeaders.set('Authorization', `Bearer ${token}`);
    }
    return nextHeaders;
}

async function parseUpstreamResponse(response: Response): Promise<UpstreamResult> {
    const text = await response.text();
    if (!text) {
        return { data: null, status: response.status };
    }
    try {
        return { data: JSON.parse(text), status: response.status };
    } catch {
        return { data: { error: text }, status: response.status };
    }
}

async function fetchAccountApi(pathname: string, init: RequestInit = {}, token?: string): Promise<UpstreamResult> {
    const response = await fetch(buildAccountUrl(pathname), {
        ...init,
        headers: buildHeaders(token, init.headers),
        cache: 'no-store',
    });
    return parseUpstreamResponse(response);
}

function stringToken(value: unknown) {
    const token = String(value || '').trim();
    return token || null;
}

export function configuredAccountApi() {
    return Boolean(getAccountApiBaseUrl());
}

export function accountApiUnavailableResponse() {
    return NextResponse.json(
        {
            error: 'RedBox account API is not configured',
            required_env: ['REDBOX_API_BASE_URL'],
        },
        { status: 503 },
    );
}

export function setAuthCookies(response: NextResponse, tokens: AuthTokens) {
    const accessToken = stringToken(tokens.access_token);
    const refreshToken = stringToken(tokens.refresh_token);
    if (accessToken) {
        response.cookies.set(accessCookieName, accessToken, {
            ...cookieOptions,
            maxAge: 60 * 60 * 8,
        });
    }
    if (refreshToken) {
        response.cookies.set(refreshCookieName, refreshToken, {
            ...cookieOptions,
            maxAge: 60 * 60 * 24 * 30,
        });
    }
}

export function clearAuthCookies(response: NextResponse) {
    response.cookies.set(accessCookieName, '', {
        ...cookieOptions,
        maxAge: 0,
    });
    response.cookies.set(refreshCookieName, '', {
        ...cookieOptions,
        maxAge: 0,
    });
}

export function sanitizeAuthPayload(data: unknown) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
        return data;
    }
    const { access_token: _accessToken, refresh_token: _refreshToken, ...rest } = data as Record<string, unknown>;
    return rest;
}

export async function loginAccount(body: JsonBody) {
    return fetchAccountApi('auth/login', {
        method: 'POST',
        body: JSON.stringify(body),
    });
}

async function refreshAccessToken(request: NextRequest) {
    const refreshToken = stringToken(request.cookies.get(refreshCookieName)?.value);
    if (!refreshToken) {
        return null;
    }

    const refreshResult = await fetchAccountApi('auth/refresh', {
        method: 'POST',
        body: JSON.stringify({ refresh_token: refreshToken }),
    });
    if (refreshResult.status < 200 || refreshResult.status >= 300) {
        return null;
    }

    const payload = refreshResult.data as AuthTokens;
    const accessToken = stringToken(payload.access_token);
    return accessToken ? payload : null;
}

export async function proxyAccountRequest(request: NextRequest, pathname: string, init: RequestInit = {}) {
    if (!configuredAccountApi()) {
        return accountApiUnavailableResponse();
    }

    const accessToken = stringToken(request.cookies.get(accessCookieName)?.value);
    if (!accessToken) {
        return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
    }

    let result = await fetchAccountApi(pathname, init, accessToken);
    let refreshedTokens: AuthTokens | null = null;
    if (result.status === 401) {
        refreshedTokens = await refreshAccessToken(request);
        const refreshedAccessToken = stringToken(refreshedTokens?.access_token);
        if (refreshedAccessToken) {
            result = await fetchAccountApi(pathname, init, refreshedAccessToken);
        }
    }

    const response = NextResponse.json(result.data, { status: result.status });
    if (refreshedTokens && result.status !== 401) {
        setAuthCookies(response, refreshedTokens);
    }
    if (result.status === 401) {
        clearAuthCookies(response);
    }
    return response;
}

export async function logoutAccount(request: NextRequest) {
    const accessToken = stringToken(request.cookies.get(accessCookieName)?.value);
    if (configuredAccountApi() && accessToken) {
        await fetchAccountApi('auth/logout', { method: 'POST' }, accessToken).catch(() => null);
    }
    const response = NextResponse.json({ ok: true });
    clearAuthCookies(response);
    return response;
}
