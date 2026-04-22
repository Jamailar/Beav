export const DEFAULT_CHAT_MAX_TOKENS = 262144;
export const DEFAULT_CHAT_MAX_TOKENS_DEEPSEEK = 131072;
export const MIN_CHAT_MAX_TOKENS = 1024;

export const normalizeChatMaxTokens = (value: unknown, fallback: number): number => {
  const normalized = Number(value);
  if (!Number.isFinite(normalized) || normalized < MIN_CHAT_MAX_TOKENS) {
    return fallback;
  }
  return Math.floor(normalized);
};

export const resolveChatMaxTokens = (
  settings: Record<string, unknown> | undefined,
  isDeepSeekFamily: boolean,
): number => {
  const defaultValue = normalizeChatMaxTokens(
    settings?.chat_max_tokens_default ?? settings?.chatMaxTokensDefault,
    DEFAULT_CHAT_MAX_TOKENS,
  );
  const deepSeekValue = normalizeChatMaxTokens(
    settings?.chat_max_tokens_deepseek ?? settings?.chatMaxTokensDeepseek,
    DEFAULT_CHAT_MAX_TOKENS_DEEPSEEK,
  );
  return isDeepSeekFamily ? deepSeekValue : defaultValue;
};
