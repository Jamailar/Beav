import { getSettings } from '../db';
import { normalizeApiBaseUrl, safeUrlJoin } from './urlUtils';

export interface SearchResult {
    title: string;
    snippet: string;
    url: string;
}

export type SearchProvider = 'duckduckgo' | 'tavily' | 'searxng';

type SearchProviderSettings = {
    provider: SearchProvider;
    endpoint: string;
    apiKey: string;
};

const DEFAULT_SEARCH_PROVIDER: SearchProvider = 'duckduckgo';
const DEFAULT_TAVILY_ENDPOINT = 'https://api.tavily.com';

const SEARCH_PROVIDERS = new Set<SearchProvider>(['duckduckgo', 'tavily', 'searxng']);

const normalizeSearchProvider = (value: unknown): SearchProvider => {
    const normalized = String(value || '').trim().toLowerCase();
    return SEARCH_PROVIDERS.has(normalized as SearchProvider)
        ? normalized as SearchProvider
        : DEFAULT_SEARCH_PROVIDER;
};

const parseDuckDuckGoResults = (html: string, count: number): SearchResult[] => {
    const results: SearchResult[] = [];
    const resultRegex = /<a class="result__a"[^>]*href="([^"]*)"[^>]*>(.*?)<\/a>[\s\S]*?<a class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;

    let match: RegExpExecArray | null;
    while ((match = resultRegex.exec(html)) !== null && results.length < count) {
        const url = String(match[1] || '').trim();
        const title = String(match[2] || '').replace(/<[^>]+>/g, '').trim();
        const snippet = String(match[3] || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
        if (!title || !url || url.includes('duckduckgo.com')) continue;
        results.push({ title, snippet, url });
    }

    if (results.length > 0) return results;

    const simpleLinkRegex = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]*)"[^>]*>(.*?)<\/a>/g;
    const simpleSnippetRegex = /<a[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/g;
    const links: Array<{ title: string; url: string }> = [];
    const snippets: string[] = [];

    while ((match = simpleLinkRegex.exec(html)) !== null && links.length < count) {
        const url = String(match[1] || '').trim();
        const title = String(match[2] || '').replace(/<[^>]+>/g, '').trim();
        if (!title || !url || url.includes('duckduckgo.com')) continue;
        links.push({ title, url });
    }

    while ((match = simpleSnippetRegex.exec(html)) !== null && snippets.length < count) {
        const snippet = String(match[1] || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
        snippets.push(snippet);
    }

    return links.slice(0, count).map((item, index) => ({
        title: item.title,
        url: item.url,
        snippet: snippets[index] || '',
    }));
};

const resolveSearchSettings = (): SearchProviderSettings => {
    const settings = (getSettings() || {}) as {
        search_provider?: string;
        search_endpoint?: string;
        search_api_key?: string;
    };

    return {
        provider: normalizeSearchProvider(settings.search_provider),
        endpoint: normalizeApiBaseUrl(String(settings.search_endpoint || '').trim()),
        apiKey: String(settings.search_api_key || '').trim(),
    };
};

const searchDuckDuckGo = async (query: string, count: number, signal?: AbortSignal): Promise<SearchResult[]> => {
    const encodedQuery = encodeURIComponent(query);
    const response = await fetch(`https://html.duckduckgo.com/html/?q=${encodedQuery}`, {
        headers: {
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        },
        signal,
    });

    if (!response.ok) {
        throw new Error(`DuckDuckGo search failed: HTTP ${response.status}`);
    }

    return parseDuckDuckGoResults(await response.text(), count);
};

const searchTavily = async (
    query: string,
    count: number,
    config: SearchProviderSettings,
    signal?: AbortSignal,
): Promise<SearchResult[]> => {
    if (!config.apiKey) {
        throw new Error('Tavily 搜索需要先在设置中填写 API Key。');
    }

    const endpoint = safeUrlJoin(config.endpoint || DEFAULT_TAVILY_ENDPOINT, '/search');
    const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            api_key: config.apiKey,
            query,
            max_results: count,
            search_depth: 'basic',
            include_answer: false,
            include_images: false,
        }),
        signal,
    });

    if (!response.ok) {
        const message = await response.text().catch(() => '');
        throw new Error(`Tavily search failed: HTTP ${response.status}${message ? ` ${message}` : ''}`);
    }

    const data = await response.json() as {
        results?: Array<{ title?: string; url?: string; content?: string }>;
    };

    return Array.isArray(data.results)
        ? data.results
            .slice(0, count)
            .map((item) => ({
                title: String(item.title || '').trim(),
                url: String(item.url || '').trim(),
                snippet: String(item.content || '').replace(/\s+/g, ' ').trim(),
            }))
            .filter((item) => item.title || item.snippet || item.url)
        : [];
};

const searchSearXNG = async (
    query: string,
    count: number,
    config: SearchProviderSettings,
    signal?: AbortSignal,
): Promise<SearchResult[]> => {
    if (!config.endpoint) {
        throw new Error('SearXNG 搜索需要先在设置中填写搜索服务地址。');
    }

    const endpoint = safeUrlJoin(config.endpoint, '/search');
    const url = new URL(endpoint);
    url.searchParams.set('q', query);
    url.searchParams.set('format', 'json');
    url.searchParams.set('language', 'zh-CN');

    const headers: Record<string, string> = {};
    if (config.apiKey) {
        headers.Authorization = `Bearer ${config.apiKey}`;
    }

    const response = await fetch(url.toString(), {
        headers,
        signal,
    });

    if (!response.ok) {
        const message = await response.text().catch(() => '');
        throw new Error(`SearXNG search failed: HTTP ${response.status}${message ? ` ${message}` : ''}`);
    }

    const data = await response.json() as {
        results?: Array<{ title?: string; url?: string; content?: string }>;
    };

    return Array.isArray(data.results)
        ? data.results
            .slice(0, count)
            .map((item) => ({
                title: String(item.title || '').trim(),
                url: String(item.url || '').trim(),
                snippet: String(item.content || '').replace(/\s+/g, ' ').trim(),
            }))
            .filter((item) => item.title || item.snippet || item.url)
        : [];
};

export const searchWeb = async (
    query: string,
    count = 5,
    options?: {
        signal?: AbortSignal;
    },
): Promise<SearchResult[]> => {
    const normalizedQuery = String(query || '').trim();
    if (!normalizedQuery) return [];

    const normalizedCount = Number.isFinite(count) ? Math.max(1, Math.min(10, Math.floor(count))) : 5;
    const config = resolveSearchSettings();

    switch (config.provider) {
        case 'tavily':
            return searchTavily(normalizedQuery, normalizedCount, config, options?.signal);
        case 'searxng':
            return searchSearXNG(normalizedQuery, normalizedCount, config, options?.signal);
        case 'duckduckgo':
        default:
            return searchDuckDuckGo(normalizedQuery, normalizedCount, options?.signal);
    }
};

