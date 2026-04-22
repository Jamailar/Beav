/**
 * Web Search Tool - Web 搜索工具
 *
 * 使用原生 fetch 进行 DuckDuckGo 搜索
 * 不再依赖 LangChain
 */

import { z } from 'zod';
import {
    DeclarativeTool,
    ToolKind,
    type ToolResult,
    createSuccessResult,
    createErrorResult,
    ToolErrorType,
} from '../toolRegistry';
import { searchWeb } from '../webSearchService';

// 参数 Schema
const SearchParamsSchema = z.object({
    query: z.string().describe('The search query to look up on the web'),
    maxResults: z.number().optional().describe('Maximum number of results (default: 5)'),
});

type SearchParams = z.infer<typeof SearchParamsSchema>;

/**
 * Web 搜索工具
 */
export class WebSearchTool extends DeclarativeTool<typeof SearchParamsSchema> {
    readonly name = 'web_search';
    readonly displayName = 'Web Search';
    readonly description = 'Search the web for information. REQUIRED: query (string, core keywords only; no filler like "帮我/一下"). Example: web_search({ "query": "dan koe" }). Use this when you need current info, facts, or resources from the internet.';
    readonly kind = ToolKind.Search;
    readonly parameterSchema = SearchParamsSchema;
    readonly requiresConfirmation = false;

    getDescription(params: SearchParams): string {
        return `Search the web for: "${params.query}"`;
    }

    isConcurrencySafe(_params: SearchParams): boolean {
        return true;
    }

    async execute(params: SearchParams, signal: AbortSignal): Promise<ToolResult> {
        if (signal.aborted) {
            return createErrorResult('Search cancelled', ToolErrorType.CANCELLED);
        }

        try {
            const maxResults = params.maxResults || 5;
            const results = await searchWeb(params.query, maxResults, { signal });

            if (results.length === 0) {
                return createSuccessResult('No results found for the search query.');
            }

            // 格式化结果
            const formattedResults = results.map((result, idx) => {
                return `[${idx + 1}] ${result.title}
URL: ${result.url}
${result.snippet}
`;
            }).join('\n');

            return createSuccessResult(
                `Search results for "${params.query}":\n\n${formattedResults}`,
                `🔍 Found ${results.length} results for: ${params.query}`
            );
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return createErrorResult(`Search failed: ${message}`);
        }
    }
}
