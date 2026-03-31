import OpenAI from "openai";
import type {
  EnvConfig,
  GPTClient,
  Logger,
  MarketRegime,
  MarketRegimeResult,
  NewsFilterResult,
  OHLCV,
  SentimentLevel,
  SentimentResult,
  TradingPair,
} from "../types/index.js";

// ── Prompt versions (centralized for version management) ──

const PROMPT_VERSION = "v1.2";

const SENTIMENT_SYSTEM_PROMPT = `You are a crypto market sentiment analyst (prompt ${PROMPT_VERSION}).
Analyze the provided data for the given trading pairs and determine overall market sentiment for EACH pair.

You will receive two types of data:
1. **[Polymarket] prediction market data** — These show real-money bets on future outcomes with probabilities and volume. HEAVILY weight these signals as they represent aggregated market intelligence.
2. **News headlines** — Traditional crypto news for context.

You MUST respond with a JSON object where keys are trading pair symbols and values are objects with:
- "level": one of "BULLISH", "NEUTRAL", "BEARISH", or "HALT"
- "reasoning": a brief explanation (1 sentence, reference Polymarket data when relevant)

Rules:
- "HALT" means extreme risk events (exchange hacks, regulatory bans, black swan events) where all trading should stop.
- "BEARISH" means predominantly negative signals that suggest downward pressure.
- "BULLISH" means predominantly positive signals that suggest upward pressure.
- "NEUTRAL" means mixed or insignificant signals with no clear directional bias.
- Polymarket probabilities above 65% for bullish outcomes (price increases, ETF approvals, etc.) should strongly bias toward BULLISH.
- Polymarket probabilities above 65% for bearish outcomes (price drops, bans, etc.) should strongly bias toward BEARISH.
- If no relevant data exists for a pair, set it to "NEUTRAL".

Example response format:
{"BTC/USDT":{"level":"BULLISH","reasoning":"Polymarket shows 72% probability of BTC above $100K, reinforced by positive ETF inflow news"},"ETH/USDT":{"level":"NEUTRAL","reasoning":"..."}}

Respond ONLY with valid JSON.`;

const MARKET_REGIME_SYSTEM_PROMPT = `You are a crypto market structure analyst (prompt ${PROMPT_VERSION}).
Analyze the provided market summary statistics and classify whether the market is trending or ranging.

You MUST respond with a JSON object containing exactly these fields:
- "regime": one of "TRENDING" or "RANGING"
- "confidence": a number between 0 and 1 indicating your confidence
- "reasoning": a brief explanation (1 sentence)

Analysis guidelines:
- Consistent price direction with expanding range suggests TRENDING.
- Price oscillating within a tight range with no clear direction suggests RANGING.
- If uncertain, lean toward RANGING with lower confidence.

Respond ONLY with valid JSON.`;

const NEWS_FILTER_SYSTEM_PROMPT = `You are a crypto trading signal filter (prompt ${PROMPT_VERSION}).
Given a trading signal and recent data (news headlines and Polymarket prediction markets), determine whether it is safe to act on the signal.

You MUST respond with a JSON object containing exactly these fields:
- "safe": boolean (true if the signal is safe to act on, false if recent data contradicts or undermines it)
- "reasoning": a brief explanation (1 sentence)

Filter rules:
- [Polymarket] entries show real-money prediction market probabilities. If a Polymarket outcome strongly contradicts the signal direction (>60% against), mark as unsafe.
- If major news directly contradicts the signal direction, mark as unsafe (safe=false).
- If there is a significant event (hack, delisting, regulatory action) affecting the pair, mark as unsafe.
- If data is irrelevant or mildly supportive, mark as safe (safe=true).
- When in doubt, err on the side of caution (safe=false).

Respond ONLY with valid JSON.`;

// ── Validation helpers ──

const VALID_SENTIMENTS = new Set<SentimentLevel>(["BULLISH", "NEUTRAL", "BEARISH", "HALT"]);
const VALID_REGIMES = new Set<MarketRegime>(["TRENDING", "RANGING"]);

function isValidSentimentLevel(value: unknown): value is SentimentLevel {
  return typeof value === "string" && VALID_SENTIMENTS.has(value as SentimentLevel);
}

function isValidMarketRegime(value: unknown): value is MarketRegime {
  return typeof value === "string" && VALID_REGIMES.has(value as MarketRegime);
}

function isValidConfidence(value: unknown): value is number {
  return typeof value === "number" && value >= 0 && value <= 1;
}

// ── Response parsing ──

interface RawSentimentResponse {
  level: unknown;
  reasoning: unknown;
}

interface RawMarketRegimeResponse {
  regime: unknown;
  confidence: unknown;
  reasoning: unknown;
}

interface RawNewsFilterResponse {
  safe: unknown;
  reasoning: unknown;
}

function parseSentimentResponse(raw: string, logger: Logger): SentimentResult {
  try {
    const parsed = JSON.parse(raw) as RawSentimentResponse;

    if (!isValidSentimentLevel(parsed.level)) {
      logger.warn("system", "GPT returned invalid sentiment level, defaulting to NEUTRAL", {
        rawLevel: String(parsed.level),
      });
      return {
        level: "NEUTRAL",
        reasoning: typeof parsed.reasoning === "string" ? parsed.reasoning : "Parse error: invalid level",
        timestamp: Date.now(),
      };
    }

    return {
      level: parsed.level,
      reasoning: typeof parsed.reasoning === "string" ? parsed.reasoning : "No reasoning provided",
      timestamp: Date.now(),
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error("system", "Failed to parse GPT sentiment response", { error: message, raw });
    return { level: "NEUTRAL", reasoning: "Parse error: returning safe default", timestamp: Date.now() };
  }
}

function parseBatchSentimentResponse(
  raw: string,
  pairs: readonly TradingPair[],
  logger: Logger,
): Map<TradingPair, SentimentResult> {
  const results = new Map<TradingPair, SentimentResult>();

  try {
    const parsed = JSON.parse(raw) as Record<string, RawSentimentResponse>;

    for (const pair of pairs) {
      const entry = parsed[pair];
      if (!entry || !isValidSentimentLevel(entry.level)) {
        results.set(pair, {
          level: "NEUTRAL",
          reasoning: "No valid response for this pair",
          timestamp: Date.now(),
        });
        continue;
      }
      results.set(pair, {
        level: entry.level,
        reasoning: typeof entry.reasoning === "string" ? entry.reasoning : "No reasoning provided",
        timestamp: Date.now(),
      });
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error("system", "Failed to parse batch sentiment response", { error: message, raw });
    for (const pair of pairs) {
      results.set(pair, { level: "NEUTRAL", reasoning: "Parse error", timestamp: Date.now() });
    }
  }

  return results;
}

function parseMarketRegimeResponse(raw: string, logger: Logger): MarketRegimeResult {
  try {
    const parsed = JSON.parse(raw) as RawMarketRegimeResponse;

    if (!isValidMarketRegime(parsed.regime)) {
      logger.warn("system", "GPT returned invalid market regime, defaulting to RANGING", {
        rawRegime: String(parsed.regime),
      });
      return {
        regime: "RANGING",
        confidence: isValidConfidence(parsed.confidence) ? parsed.confidence : 0.5,
        reasoning: typeof parsed.reasoning === "string" ? parsed.reasoning : "Parse error: invalid regime",
      };
    }

    return {
      regime: parsed.regime,
      confidence: isValidConfidence(parsed.confidence) ? parsed.confidence : 0.5,
      reasoning: typeof parsed.reasoning === "string" ? parsed.reasoning : "No reasoning provided",
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error("system", "Failed to parse GPT market regime response", { error: message, raw });
    return { regime: "RANGING", confidence: 0.5, reasoning: "Parse error: returning safe default" };
  }
}

function parseNewsFilterResponse(raw: string, logger: Logger): NewsFilterResult {
  try {
    const parsed = JSON.parse(raw) as RawNewsFilterResponse;

    if (typeof parsed.safe !== "boolean") {
      logger.warn("system", "GPT returned invalid news filter safe field, defaulting to false", {
        rawSafe: String(parsed.safe),
      });
      return {
        safe: false,
        reasoning: typeof parsed.reasoning === "string" ? parsed.reasoning : "Parse error: invalid safe field",
      };
    }

    return {
      safe: parsed.safe,
      reasoning: typeof parsed.reasoning === "string" ? parsed.reasoning : "No reasoning provided",
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error("system", "Failed to parse GPT news filter response", { error: message, raw });
    return { safe: false, reasoning: "Parse error: returning safe default (block signal)" };
  }
}

// ── Candle data summarization (token-efficient) ──

function summarizeCandles(candles: OHLCV[]): string {
  if (candles.length === 0) return "No data";

  const first = candles[0]!;
  const last = candles[candles.length - 1]!;
  const closes = candles.map((c) => c.close);
  const volumes = candles.map((c) => c.volume);

  const high = Math.max(...candles.map((c) => c.high));
  const low = Math.min(...candles.map((c) => c.low));
  const avgVolume = volumes.reduce((a, b) => a + b, 0) / volumes.length;
  const priceChange = ((last.close - first.close) / first.close * 100).toFixed(2);

  // 簡易トレンド判定用: 前半と後半の平均価格
  const mid = Math.floor(closes.length / 2);
  const firstHalfAvg = closes.slice(0, mid).reduce((a, b) => a + b, 0) / mid;
  const secondHalfAvg = closes.slice(mid).reduce((a, b) => a + b, 0) / (closes.length - mid);

  return [
    `Period: ${candles.length} candles`,
    `Open: ${first.open} → Close: ${last.close} (${priceChange}%)`,
    `High: ${high}, Low: ${low}, Range: ${((high - low) / low * 100).toFixed(2)}%`,
    `Avg volume: ${avgVolume.toFixed(0)}`,
    `1st half avg: ${firstHalfAvg.toFixed(2)}, 2nd half avg: ${secondHalfAvg.toFixed(2)}`,
  ].join("\n");
}

// ── Cache ──

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

function createCache<T>(ttlMs: number, maxSize = 50) {
  const store = new Map<string, CacheEntry<T>>();

  return {
    get(key: string): T | undefined {
      const entry = store.get(key);
      if (!entry) return undefined;
      if (Date.now() > entry.expiresAt) {
        store.delete(key);
        return undefined;
      }
      return entry.value;
    },
    set(key: string, value: T): void {
      if (store.size >= maxSize) {
        // 最も古いエントリを削除（Map は挿入順を保持）
        const oldest = store.keys().next().value;
        if (oldest !== undefined) store.delete(oldest);
      }
      store.set(key, { value, expiresAt: Date.now() + ttlMs });
    },
  };
}

// ── Factory ──

export function createGPTClient(config: EnvConfig, logger: Logger): GPTClient {
  const openai = new OpenAI({ apiKey: config.openaiApiKey });
  const model = config.openaiModel;

  // レジーム分類: 1時間キャッシュ（1h足ベースなので頻繁に変わらない）
  const regimeCache = createCache<MarketRegimeResult>(60 * 60 * 1000);
  // ニュースフィルター: 15分キャッシュ（Range botのtick間隔）
  const newsFilterCache = createCache<NewsFilterResult>(15 * 60 * 1000);

  async function chatCompletion(systemPrompt: string, userMessage: string): Promise<string> {
    const response = await openai.chat.completions.create({
      model,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userMessage },
      ],
      temperature: 0.3,
      max_tokens: 500,
    });

    const content = response.choices[0]?.message?.content;
    if (!content) {
      throw new Error("GPT returned empty response");
    }
    return content;
  }

  return {
    async analyzeSentiment(pair: TradingPair, newsTexts: string[]): Promise<SentimentResult> {
      if (newsTexts.length === 0) {
        logger.debug("system", "No news provided for sentiment analysis, returning NEUTRAL", { pair });
        return { level: "NEUTRAL", reasoning: "No news available for analysis", timestamp: Date.now() };
      }

      const userMessage = [
        `Trading pair: ${pair}`,
        "",
        "News headlines:",
        ...newsTexts.map((text, i) => `${i + 1}. ${text}`),
      ].join("\n");

      try {
        logger.debug("system", "Requesting GPT sentiment analysis", { pair, newsCount: newsTexts.length });
        const raw = await chatCompletion(SENTIMENT_SYSTEM_PROMPT, userMessage);
        const result = parseSentimentResponse(raw, logger);
        logger.info("system", `Sentiment analysis complete: ${result.level}`, { pair, level: result.level });
        return result;
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        logger.error("system", "GPT sentiment analysis failed", { pair, error: message });
        return { level: "NEUTRAL", reasoning: `API error: ${message}`, timestamp: Date.now() };
      }
    },

    async analyzeSentimentBatch(
      pairNewsMap: ReadonlyMap<TradingPair, string[]>,
    ): Promise<Map<TradingPair, SentimentResult>> {
      const pairs = [...pairNewsMap.keys()];

      // 全ペアでニュースが空なら全NEUTRAL
      const allEmpty = pairs.every((p) => (pairNewsMap.get(p)?.length ?? 0) === 0);
      if (allEmpty) {
        const results = new Map<TradingPair, SentimentResult>();
        for (const pair of pairs) {
          results.set(pair, { level: "NEUTRAL", reasoning: "No news available", timestamp: Date.now() });
        }
        return results;
      }

      const newsSection = pairs.map((pair) => {
        const news = pairNewsMap.get(pair) ?? [];
        if (news.length === 0) return `${pair}: (no relevant news)`;
        return `${pair}:\n${news.map((t, i) => `  ${i + 1}. ${t}`).join("\n")}`;
      }).join("\n\n");

      const userMessage = [
        `Analyze sentiment for these trading pairs:`,
        "",
        newsSection,
      ].join("\n");

      try {
        logger.debug("system", "Requesting batch GPT sentiment analysis", { pairCount: pairs.length });
        const raw = await chatCompletion(SENTIMENT_SYSTEM_PROMPT, userMessage);
        const results = parseBatchSentimentResponse(raw, pairs, logger);
        for (const [pair, result] of results) {
          logger.info("system", `Sentiment: ${pair} = ${result.level}`, { reasoning: result.reasoning });
        }
        return results;
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        logger.error("system", "Batch GPT sentiment analysis failed", { error: message });
        const results = new Map<TradingPair, SentimentResult>();
        for (const pair of pairs) {
          results.set(pair, { level: "NEUTRAL", reasoning: `API error: ${message}`, timestamp: Date.now() });
        }
        return results;
      }
    },

    async classifyMarketRegime(pair: TradingPair, candles: OHLCV[]): Promise<MarketRegimeResult> {
      if (candles.length === 0) {
        logger.warn("system", "No candle data provided for market regime classification", { pair });
        return { regime: "RANGING", confidence: 0.5, reasoning: "No candle data available" };
      }

      // キャッシュ確認
      const cached = regimeCache.get(pair);
      if (cached) {
        logger.debug("system", `Market regime cache hit for ${pair}: ${cached.regime}`);
        return cached;
      }

      const userMessage = [
        `Trading pair: ${pair}`,
        "",
        "Market summary:",
        summarizeCandles(candles),
      ].join("\n");

      try {
        logger.debug("system", "Requesting GPT market regime classification", { pair });
        const raw = await chatCompletion(MARKET_REGIME_SYSTEM_PROMPT, userMessage);
        const result = parseMarketRegimeResponse(raw, logger);
        regimeCache.set(pair, result);
        logger.info("system", `Market regime classification: ${result.regime} (${result.confidence})`, {
          pair,
          regime: result.regime,
          confidence: result.confidence,
        });
        return result;
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        logger.error("system", "GPT market regime classification failed", { pair, error: message });
        return { regime: "RANGING", confidence: 0.5, reasoning: `API error: ${message}` };
      }
    },

    async filterNewsSignal(pair: TradingPair, signal: string, recentNews: string[]): Promise<NewsFilterResult> {
      if (recentNews.length === 0) {
        logger.debug("system", "No recent news for signal filtering, marking as safe", { pair, signal });
        return { safe: true, reasoning: "No recent news to contradict the signal" };
      }

      // キャッシュ確認
      const cacheKey = `${pair}:${signal}`;
      const cached = newsFilterCache.get(cacheKey);
      if (cached) {
        logger.debug("system", `News filter cache hit for ${pair}:${signal}: safe=${cached.safe}`);
        return cached;
      }

      const userMessage = [
        `Trading pair: ${pair}`,
        `Signal: ${signal}`,
        "",
        "Recent news headlines:",
        ...recentNews.map((text, i) => `${i + 1}. ${text}`),
      ].join("\n");

      try {
        logger.debug("system", "Requesting GPT news signal filter", { pair, signal, newsCount: recentNews.length });
        const raw = await chatCompletion(NEWS_FILTER_SYSTEM_PROMPT, userMessage);
        const result = parseNewsFilterResponse(raw, logger);
        newsFilterCache.set(cacheKey, result);
        logger.info("system", `News signal filter: safe=${result.safe}`, { pair, signal, safe: result.safe });
        return result;
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        logger.error("system", "GPT news signal filter failed", { pair, signal, error: message });
        return { safe: false, reasoning: `API error: ${message}` };
      }
    },
  };
}
