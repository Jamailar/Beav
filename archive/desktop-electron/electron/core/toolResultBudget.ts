import { ToolKind, type ToolRegistry, type ToolResult } from './toolRegistry';

const DEFAULT_TOTAL_BUDGET_CHARS = 24_000;
const DEFAULT_MIN_RESULT_CHARS = 1_200;

const normalizeResultText = (result: ToolResult): string => {
  const candidate = result.llmContent || result.display || result.error?.message || '';
  return String(candidate || '').trim();
};

const formatBudgetedText = (text: string, budgetChars: number): string => {
  if (text.length <= budgetChars) {
    return text;
  }

  const safeBudget = Math.max(DEFAULT_MIN_RESULT_CHARS, budgetChars);
  const head = Math.max(400, Math.floor(safeBudget * 0.72));
  const tail = Math.max(200, safeBudget - head - 64);
  const omitted = Math.max(0, text.length - head - tail);

  if (tail <= 0 || head + tail >= text.length) {
    return `${text.slice(0, safeBudget)}\n\n[tool result truncated: original ${text.length} chars]`;
  }

  return [
    text.slice(0, head),
    '',
    `[tool result truncated: omitted ${omitted} chars of ${text.length}]`,
    '',
    text.slice(-tail),
  ].join('\n');
};

const getPerToolBudget = (registry: ToolRegistry, toolName: string): number => {
  const tool = registry.getTool(toolName);
  if (!tool) return 8_000;

  if (tool.kind === ToolKind.Read) return 8_000;
  if (tool.kind === ToolKind.Search) return 7_000;
  if (tool.kind === ToolKind.Fetch) return 7_000;
  if (tool.kind === ToolKind.Execute) return 10_000;
  if (tool.kind === ToolKind.Edit) return 5_000;
  return 6_000;
};

export type BudgetedToolResult = {
  toolName: string;
  originalText: string;
  promptText: string;
  originalChars: number;
  promptChars: number;
  truncated: boolean;
};

export const applyToolResultBudget = (
  registry: ToolRegistry,
  inputs: Array<{ toolName: string; result: ToolResult }>,
  totalBudgetChars = DEFAULT_TOTAL_BUDGET_CHARS,
): BudgetedToolResult[] => {
  let remaining = Math.max(DEFAULT_MIN_RESULT_CHARS, totalBudgetChars);

  return inputs.map(({ toolName, result }, index) => {
    const originalText = normalizeResultText(result);
    const remainingSlots = Math.max(1, inputs.length - index);
    const defaultToolBudget = getPerToolBudget(registry, toolName);
    const dynamicBudget = Math.max(
      DEFAULT_MIN_RESULT_CHARS,
      Math.floor(remaining / remainingSlots),
    );
    const budgetChars = Math.min(defaultToolBudget, dynamicBudget);
    const promptText = formatBudgetedText(originalText, budgetChars);
    const consumed = Math.max(0, promptText.length);
    remaining = Math.max(DEFAULT_MIN_RESULT_CHARS, remaining - consumed);

    return {
      toolName,
      originalText,
      promptText,
      originalChars: originalText.length,
      promptChars: promptText.length,
      truncated: promptText.length < originalText.length,
    };
  });
};
