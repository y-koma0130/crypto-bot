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

/** ニュースの鮮度（この時間以内の記事のみ対象） */
const MAX_AGE_MS = 6 * 60 * 60 * 1000; // 6時間

export interface NewsFetcher {
  fetchNews(pair: TradingPair): Promise<string[]>;
  /** Polymarketの確率がシグナル方向と矛盾するか判定（GPT不要のフィルター） */
  isPolymarketContradicting(pair: TradingPair, side: "buy" | "sell"): boolean;
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
      cachedPolymarkets = (data as PolymarketMarket[]).filter((m) => m.active && m.question);
      polymarketLastFetchedAt = now;
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
          const q = market.question.toLowerCase();
          const isBullishQuestion = q.includes("above") || q.includes("rise") || q.includes("bull") || q.includes("approve") || q.includes("rally") || q.includes("surge") || q.includes("exceed") || q.includes("reach") || q.includes("high");
          const isBearishQuestion = q.includes("below") || q.includes("drop") || q.includes("crash") || q.includes("ban") || q.includes("fall") || q.includes("decline") || q.includes("dump") || q.includes("low");

          // 強気の質問で60%超Yesなのにsellしようとしている → 矛盾
          if (isBullishQuestion && yesPct > 0.6 && side === "sell") return true;
          // 弱気の質問で60%超Yesなのにbuyしようとしている → 矛盾
          if (isBearishQuestion && yesPct > 0.6 && side === "buy") return true;
          // 強気の質問で60%超Noなのにbuyしようとしている → 矛盾
          if (isBullishQuestion && yesPct < 0.4 && side === "buy") return true;
          // 弱気の質問で60%超Noなのにsellしようとしている → 矛盾
          if (isBearishQuestion && yesPct < 0.4 && side === "sell") return true;
        } catch {
          continue;
        }
      }
      return false;
    },
  };
}
