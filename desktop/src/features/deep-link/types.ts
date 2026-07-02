export type DeepLinkIntentType = 'open' | 'chat.new' | 'import.url' | 'knowledge.save' | 'skills.open';

export type DeepLinkIntent = {
  type: DeepLinkIntentType;
  text?: string;
  url?: string;
  title?: string;
  packageId?: string;
  id?: string;
  marketId?: string;
  query?: string;
};

export type DeepLinkErrorPayload = {
  code?: string;
  message?: string;
};

export type DeepLinkEventPayload = {
  success?: boolean;
  source?: string;
  rawUrl?: string;
  receivedAt?: string;
  intent?: DeepLinkIntent | null;
  error?: DeepLinkErrorPayload | null;
};

export type DeepLinkPendingResponse = {
  success?: boolean;
  items?: DeepLinkEventPayload[];
};
