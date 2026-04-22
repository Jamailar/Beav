import { createCompressionService } from './compressionService';
import type { CompactSummary, RuntimeMessage } from './runtimeTypes';

const estimateTokens = (messages: RuntimeMessage[]): number => {
  return messages.reduce((total, message) => total + Math.ceil(String(message.content || '').length / 4), 0);
};

export class CompactManager {
  constructor(private readonly config: {
    apiKey: string;
    baseURL: string;
    model: string;
    threshold?: number;
  }) {}

  async maybeCompact(messages: RuntimeMessage[]): Promise<CompactSummary | null> {
    const threshold = this.config.threshold || 180_000;
    const tokenEstimate = estimateTokens(messages);

    if (tokenEstimate < threshold * 0.72) {
      return null;
    }

    if (tokenEstimate < threshold) {
      const summary = this.microCompact(messages);
      return {
        strategy: 'micro',
        summary,
        compactedMessages: [
          messages[0],
          { role: 'system', content: `Micro compact summary:\n${summary}` },
          ...messages.slice(-8),
        ].filter(Boolean) as RuntimeMessage[],
      };
    }

    const compression = createCompressionService({
      apiKey: this.config.apiKey,
      baseURL: this.config.baseURL,
      model: this.config.model,
      threshold,
    });
    const compressed = await compression.compress(messages);
    if (compressed.wasCompressed && compressed.summary) {
      return {
        strategy: 'normal',
        summary: compressed.summary,
        compactedMessages: compressed.compressedMessages as RuntimeMessage[],
      };
    }

    if (tokenEstimate >= threshold) {
      const summary = this.microCompact(messages);
      return {
        strategy: 'reactive',
        summary,
        compactedMessages: [
          messages[0],
          { role: 'system', content: `Reactive compact summary:\n${summary}` },
          ...messages.slice(-6),
        ].filter(Boolean) as RuntimeMessage[],
      };
    }

    return null;
  }

  private microCompact(messages: RuntimeMessage[]): string {
    const body = messages
      .filter((message) => message.role !== 'system')
      .slice(-24)
      .map((message, index) => `[${index + 1}] ${message.role}: ${String(message.content || '').replace(/\s+/g, ' ').trim()}`)
      .join('\n');
    return body.slice(0, 12_000);
  }
}
