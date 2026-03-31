import type { TradingPair } from "../types/index.js";
import type { NewsFetcher } from "../core/news.js";

/**
 * Create a mock NewsFetcher that always returns an empty news list.
 * This ensures the range bot's GPT news filter receives no articles,
 * and the mock GPT will mark the signal as safe anyway.
 */
export function createMockNewsFetcher(): NewsFetcher {
  return {
    async fetchNews(_pair: TradingPair): Promise<string[]> {
      return [];
    },
  };
}
