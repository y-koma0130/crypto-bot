import type {
  GPTClient,
  MarketRegimeResult,
  NewsFilterResult,
  SentimentResult,
  TradingPair,
  OHLCV,
} from "../types/index.js";

/**
 * Create a mock GPTClient that returns neutral/safe defaults.
 *
 * This lets us test pure technical signals without GPT interference:
 * - analyzeSentiment → NEUTRAL
 * - analyzeSentimentBatch → all NEUTRAL
 * - classifyMarketRegime → TRENDING (so momentum entries are not blocked)
 * - filterNewsSignal → safe: true (so range entries are not blocked)
 */
export function createMockGPTClient(): GPTClient {
  return {
    async analyzeSentiment(
      _pair: TradingPair,
      _newsTexts: string[],
    ): Promise<SentimentResult> {
      return {
        level: "NEUTRAL",
        reasoning: "Mock GPT: always NEUTRAL",
        timestamp: Date.now(),
      };
    },

    async analyzeSentimentBatch(
      pairNewsMap: ReadonlyMap<TradingPair, string[]>,
    ): Promise<Map<TradingPair, SentimentResult>> {
      const results = new Map<TradingPair, SentimentResult>();
      for (const [pair] of pairNewsMap) {
        results.set(pair, {
          level: "NEUTRAL",
          reasoning: "Mock GPT: always NEUTRAL",
          timestamp: Date.now(),
        });
      }
      return results;
    },

    async classifyMarketRegime(
      _pair: TradingPair,
      _candles: OHLCV[],
    ): Promise<MarketRegimeResult> {
      return {
        regime: "TRENDING",
        confidence: 1.0,
        reasoning: "Mock GPT: always TRENDING",
      };
    },

    async filterNewsSignal(
      _pair: TradingPair,
      _signal: string,
      _recentNews: string[],
    ): Promise<NewsFilterResult> {
      return {
        safe: true,
        reasoning: "Mock GPT: always safe",
      };
    },
  };
}
