import RSSParser from "rss-parser";
import type { Logger, TradingPair } from "../types/index.js";

const RSS_FEEDS = [
  "https://www.coindesk.com/arc/outboundfeeds/rss/",
  "https://cointelegraph.com/rss",
] as const;

/** TradingPair からニュース検索用のキーワードを導出する */
const PAIR_KEYWORDS: Record<TradingPair, readonly string[]> = {
  "BTC/USDT": ["bitcoin", "btc"],
  "ETH/USDT": ["ethereum", "eth"],
  "XRP/USDT": ["xrp", "ripple"],
  "SOL/USDT": ["solana", "sol"],
};

/** Polymarket のグローバルキーワード（全ペア共通の暗号市場関連マーケット） */
const POLYMARKET_GLOBAL_KEYWORDS = ["crypto", "sec", "regulation", "stablecoin"] as const;

/** 全ペアに共通するキーワード（市場全体に影響するニュース） */
const GLOBAL_KEYWORDS = ["crypto", "sec", "regulation", "fed", "interest rate", "hack", "exploit"] as const;

/** HALTキーワード: 本当の緊急事態のみ（規制ニュースは日常的なので除外） */
const HALT_KEYWORDS = ["hack", "exploit", "hacked", "stolen", "delisting", "delisted", "shutdown", "insolvent", "bankrupt"] as const;

/** Polymarket質問の方向分類用キーワード */
const BULLISH_KEYWORDS = ["above", "rise", "bull", "approve", "rally", "surge", "exceed", "reach", "high"] as const;
const BEARISH_KEYWORDS = ["below", "drop", "crash", "ban", "fall", "decline", "dump", "low"] as const;

/** 質問テキストからbullish/bearish/nullを判定。両方にマッチする場合はnull（曖昧）。 */
function classifyQuestion(questionLower: string): "bullish" | "bearish" | null {
  const isBullish = BULLISH_KEYWORDS.some((kw) => questionLower.includes(kw));
  const isBearish = BEARISH_KEYWORDS.some((kw) => questionLower.includes(kw));
  if (isBullish && isBearish) return null;
  if (isBullish) return "bullish";
  if (isBearish) return "bearish";
  return null;
}

/** ニュースの鮮度（この時間以内の記事のみ対象） */
const MAX_AGE_MS = 6 * 60 * 60 * 1000; // 6時間

export type PolymarketSentiment = "BULLISH" | "NEUTRAL" | "BEARISH" | "HALT";

export interface PolymarketSignal {
  readonly pair: TradingPair;
  readonly question: string;
  readonly direction: "bullish" | "bearish";
  readonly currentPct: number;
  readonly previousPct: number;
  readonly changePct: number;
}

export interface NewsFetcher {
  fetchNews(pair: TradingPair): Promise<string[]>;
  /** Polymarketの確率がシグナル方向と矛盾するか判定（GPT不要のフィルター） */
  isPolymarketContradicting(pair: TradingPair, side: "buy" | "sell"): boolean;
  /** Polymarket確率 + RSSキーワードからセンチメントを判定（GPT不要） */
  getSentiment(pair: TradingPair): PolymarketSentiment;
  /** ニュースキャッシュを更新する（Polymarket + RSS） */
  refresh(): Promise<void>;
  /** 確率が急変したPolymarketマーケットを返す（Polymarket Bot用） */
  getPolymarketSignals(pair: TradingPair, minChangePct: number): PolymarketSignal[];
}

// ── Polymarket Gamma API ──

const POLYMARKET_API = "https://gamma-api.polymarket.com";

interface PolymarketMarket {
  readonly question: string;
  readonly outcomePrices: string;
  readonly outcomes: string;
  readonly volume: string;
  readonly active: boolean;
}

function formatPolymarketSignal(market: PolymarketMarket): string {
  try {
    const prices: number[] = JSON.parse(market.outcomePrices) as number[];
    const outcomes: string[] = JSON.parse(market.outcomes) as string[];
    const parts = outcomes.map((outcome, i) => {
      const pct = ((prices[i] ?? 0) * 100).toFixed(0);
      return `${outcome}: ${pct}%`;
    });
    const vol = Number(market.volume);
    const volStr = vol >= 1_000_000
      ? `$${(vol / 1_000_000).toFixed(1)}M`
      : `$${(vol / 1_000).toFixed(0)}K`;
    return `[Polymarket] ${market.question} (${parts.join(" / ")}, vol: ${volStr})`;
  } catch {
    return `[Polymarket] ${market.question}`;
  }
}

export function createNewsFetcher(logger: Logger): NewsFetcher {
  const parser = new RSSParser({
    timeout: 15_000,
  });

  // RSSフィードのキャッシュ（全ペア共通、tick毎に1回だけフェッチ）
  let cachedArticles: { title: string; pubDate: number }[] = [];
  let lastFetchedAt = 0;
  const CACHE_TTL_MS = 10 * 60 * 1000; // 10分

  // Polymarket キャッシュ
  let cachedPolymarkets: PolymarketMarket[] = [];
  let polymarketLastFetchedAt = 0;
  // 前回の確率スナップショット（question → yesPct）
  const previousPrices = new Map<string, number>();

  async function refreshCache(): Promise<void> {
    const now = Date.now();
    if (now - lastFetchedAt < CACHE_TTL_MS && cachedArticles.length > 0) {
      return;
    }

    const articles: { title: string; pubDate: number }[] = [];

    const results = await Promise.allSettled(
      RSS_FEEDS.map(async (url) => {
        const feed = await parser.parseURL(url);
        return feed.items;
      }),
    );

    for (const result of results) {
      if (result.status === "rejected") {
        const reason = result.reason instanceof Error ? result.reason.message : String(result.reason);
        logger.warn("system", "RSS feed fetch failed", { error: reason });
        continue;
      }

      for (const item of result.value) {
        const pubDate = item.pubDate ? new Date(item.pubDate).getTime() : 0;
        const title = item.title ?? "";
        if (title && pubDate > 0) {
          articles.push({ title, pubDate });
        }
      }
    }

    cachedArticles = articles;
    lastFetchedAt = now;
    logger.info("system", `RSS cache refreshed: ${articles.length} articles from ${RSS_FEEDS.length} feeds`);
  }

  async function refreshPolymarketCache(): Promise<void> {
    const now = Date.now();
    if (now - polymarketLastFetchedAt < CACHE_TTL_MS && cachedPolymarkets.length > 0) {
      return;
    }

    try {
      const url = `${POLYMARKET_API}/markets?active=true&closed=false&limit=100&order=volume&ascending=false`;
      const response = await fetch(url, {
        headers: { "Accept": "application/json" },
        signal: AbortSignal.timeout(5_000),
      });

      if (!response.ok) {
        logger.warn("system", `Polymarket API returned ${String(response.status)}`);
        return;
      }

      const data = await response.json() as unknown;
      if (!Array.isArray(data)) {
        logger.warn("system", "Polymarket API returned unexpected format");
        return;
      }
      // 前回スナップショットを保存してから更新
      for (const m of cachedPolymarkets) {
        try {
          const prices: number[] = JSON.parse(m.outcomePrices) as number[];
          const outcomes: string[] = JSON.parse(m.outcomes) as string[];
          const yesIdx = outcomes.findIndex((o) => o.toLowerCase() === "yes");
          if (yesIdx !== -1 && prices[yesIdx] !== undefined) {
            previousPrices.set(m.question, prices[yesIdx]);
          }
        } catch { /* skip */ }
      }

      cachedPolymarkets = (data as PolymarketMarket[]).filter((m) => m.active && m.question);
      polymarketLastFetchedAt = now;

      // 消えたマーケットのスナップショットをクリーンアップ
      const activeQuestions = new Set(cachedPolymarkets.map((m) => m.question));
      for (const key of previousPrices.keys()) {
        if (!activeQuestions.has(key)) previousPrices.delete(key);
      }

      logger.info("system", `Polymarket cache refreshed: ${String(cachedPolymarkets.length)} active markets`);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn("system", "Polymarket fetch failed (non-critical)", { error: message });
    }
  }

  function filterPolymarketByPair(pair: TradingPair): string[] {
    const pairKeywords = PAIR_KEYWORDS[pair];
    const allKeywords = [...pairKeywords, ...POLYMARKET_GLOBAL_KEYWORDS];

    return cachedPolymarkets
      .filter((market) => {
        const questionLower = market.question.toLowerCase();
        return allKeywords.some((kw) => questionLower.includes(kw));
      })
      .slice(0, 5)
      .map((market) => formatPolymarketSignal(market));
  }

  function filterByPair(pair: TradingPair): string[] {
    const now = Date.now();
    const keywords = PAIR_KEYWORDS[pair];

    const newsArticles = cachedArticles
      .filter((article) => {
        if (now - article.pubDate > MAX_AGE_MS) return false;

        const titleLower = article.title.toLowerCase();
        const matchesPair = keywords.some((kw) => titleLower.includes(kw));
        const matchesGlobal = GLOBAL_KEYWORDS.some((kw) => titleLower.includes(kw));
        return matchesPair || matchesGlobal;
      })
      .slice(0, 10)
      .map((article) => article.title);

    // Polymarket の予測市場データを先頭に追加（GPTに重視させるため）
    const polymarketSignals = filterPolymarketByPair(pair);

    const combined = [...polymarketSignals, ...newsArticles];

    logger.debug("system", `News filter for ${pair}: ${String(newsArticles.length)} articles + ${String(polymarketSignals.length)} Polymarket signals`, {
      keywords: [...keywords, ...GLOBAL_KEYWORDS],
    });

    return combined;
  }

  return {
    async refresh(): Promise<void> {
      await Promise.allSettled([refreshCache(), refreshPolymarketCache()]);
    },

    async fetchNews(pair: TradingPair): Promise<string[]> {
      try {
        await Promise.allSettled([refreshCache(), refreshPolymarketCache()]);
        return filterByPair(pair);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        logger.error("system", "News fetch failed", { pair, error: message });
        return [];
      }
    },

    getSentiment(pair: TradingPair): PolymarketSentiment {
      const now = Date.now();
      const pairKeywords = PAIR_KEYWORDS[pair];

      // 1. HALTチェック: 直近ニュースにHALTキーワードがあれば即HALT
      for (const article of cachedArticles) {
        if (now - article.pubDate > MAX_AGE_MS) continue;
        const titleLower = article.title.toLowerCase();
        const matchesPair = pairKeywords.some((kw) => titleLower.includes(kw)) ||
          GLOBAL_KEYWORDS.some((kw) => titleLower.includes(kw));
        if (matchesPair && HALT_KEYWORDS.some((kw) => titleLower.includes(kw))) {
          logger.warn("system", `HALT keyword detected in news: "${article.title}"`, { pair });
          return "HALT";
        }
      }

      // 2. Polymarket確率ベースのセンチメント判定
      let bullishScore = 0;
      let bearishScore = 0;

      const relevant = cachedPolymarkets.filter((m) => {
        const q = m.question.toLowerCase();
        return pairKeywords.some((kw) => q.includes(kw));
      });

      for (const market of relevant) {
        try {
          const prices: number[] = JSON.parse(market.outcomePrices) as number[];
          const outcomes: string[] = JSON.parse(market.outcomes) as string[];
          const yesIdx = outcomes.findIndex((o) => o.toLowerCase() === "yes");
          if (yesIdx === -1 || prices[yesIdx] === undefined) continue;

          const yesPct = prices[yesIdx];
          const direction = classifyQuestion(market.question.toLowerCase());
          if (direction === "bullish") {
            bullishScore += yesPct;
            bearishScore += 1 - yesPct;
          } else if (direction === "bearish") {
            bearishScore += yesPct;
            bullishScore += 1 - yesPct;
          }
        } catch {
          continue;
        }
      }

      // 関連マーケットがなければNEUTRAL
      if (relevant.length === 0) return "NEUTRAL";

      const avgBullish = bullishScore / relevant.length;
      const avgBearish = bearishScore / relevant.length;

      if (avgBullish >= 0.55) return "BULLISH";
      if (avgBearish >= 0.55) return "BEARISH";
      return "NEUTRAL";
    },

    isPolymarketContradicting(pair: TradingPair, side: "buy" | "sell"): boolean {
      const pairKeywords = PAIR_KEYWORDS[pair];
      const relevant = cachedPolymarkets.filter((m) => {
        const q = m.question.toLowerCase();
        return pairKeywords.some((kw) => q.includes(kw));
      });

      for (const market of relevant) {
        try {
          const prices: number[] = JSON.parse(market.outcomePrices) as number[];
          const outcomes: string[] = JSON.parse(market.outcomes) as string[];
          const yesIdx = outcomes.findIndex((o) => o.toLowerCase() === "yes");
          if (yesIdx === -1 || prices[yesIdx] === undefined) continue;

          const yesPct = prices[yesIdx];
          const direction = classifyQuestion(market.question.toLowerCase());
          if (!direction) continue;

          if (direction === "bullish" && yesPct > 0.6 && side === "sell") return true;
          if (direction === "bearish" && yesPct > 0.6 && side === "buy") return true;
          if (direction === "bullish" && yesPct < 0.4 && side === "buy") return true;
          if (direction === "bearish" && yesPct < 0.4 && side === "sell") return true;
        } catch {
          continue;
        }
      }
      return false;
    },

    getPolymarketSignals(pair: TradingPair, minChangePct: number): PolymarketSignal[] {
      const pairKeywords = PAIR_KEYWORDS[pair];
      const signals: PolymarketSignal[] = [];

      const relevant = cachedPolymarkets.filter((m) => {
        const q = m.question.toLowerCase();
        return pairKeywords.some((kw) => q.includes(kw));
      });

      for (const market of relevant) {
        try {
          const prices: number[] = JSON.parse(market.outcomePrices) as number[];
          const outcomes: string[] = JSON.parse(market.outcomes) as string[];
          const yesIdx = outcomes.findIndex((o) => o.toLowerCase() === "yes");
          if (yesIdx === -1 || prices[yesIdx] === undefined) continue;

          const currentPct = prices[yesIdx];
          const prevPct = previousPrices.get(market.question);
          if (prevPct === undefined) continue;

          const changePct = currentPct - prevPct;
          if (Math.abs(changePct) < minChangePct) continue;

          const qDirection = classifyQuestion(market.question.toLowerCase());
          if (!qDirection) continue;

          let direction: "bullish" | "bearish";
          if (qDirection === "bullish") {
            direction = changePct > 0 ? "bullish" : "bearish";
          } else {
            direction = changePct > 0 ? "bearish" : "bullish";
          }

          signals.push({
            pair,
            question: market.question,
            direction,
            currentPct,
            previousPct: prevPct,
            changePct,
          });
        } catch {
          continue;
        }
      }

      return signals;
    },
  };
}
