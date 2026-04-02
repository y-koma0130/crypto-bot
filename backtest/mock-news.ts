import type { TradingPair } from "../types/index.js";
import type { NewsFetcher, PolymarketSentiment, PolymarketSignal } from "../core/news.js";

export function createMockNewsFetcher(): NewsFetcher {
  return {
    async refresh(): Promise<void> {},
    async fetchNews(_pair: TradingPair): Promise<string[]> {
      return [];
    },
    isPolymarketContradicting(): boolean {
      return false;
    },
    getSentiment(): PolymarketSentiment {
      return "NEUTRAL";
    },
    getPolymarketSignals(): PolymarketSignal[] {
      return [];
    },
  };
}
