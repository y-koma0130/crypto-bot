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

/** 全ペアに共通するキーワード（市場全体に影響するニュース） */
const GLOBAL_KEYWORDS = ["crypto", "sec", "regulation", "fed", "interest rate", "hack", "exploit"] as const;

/** ニュースの鮮度（この時間以内の記事のみ対象） */
const MAX_AGE_MS = 6 * 60 * 60 * 1000; // 6時間

export interface NewsFetcher {
  fetchNews(pair: TradingPair): Promise<string[]>;
}

export function createNewsFetcher(logger: Logger): NewsFetcher {
  const parser = new RSSParser({
    timeout: 15_000,
  });

  // フィードのキャッシュ（全ペア共通、tick毎に1回だけフェッチ）
  let cachedArticles: { title: string; pubDate: number }[] = [];
  let lastFetchedAt = 0;
  const CACHE_TTL_MS = 10 * 60 * 1000; // 10分

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

  function filterByPair(pair: TradingPair): string[] {
    const now = Date.now();
    const keywords = PAIR_KEYWORDS[pair];

    const filtered = cachedArticles
      .filter((article) => {
        if (now - article.pubDate > MAX_AGE_MS) return false;

        const titleLower = article.title.toLowerCase();
        const matchesPair = keywords.some((kw) => titleLower.includes(kw));
        const matchesGlobal = GLOBAL_KEYWORDS.some((kw) => titleLower.includes(kw));
        return matchesPair || matchesGlobal;
      })
      .slice(0, 10)
      .map((article) => article.title);

    logger.debug("system", `News filter for ${pair}: ${filtered.length} articles matched`, {
      keywords: [...keywords, ...GLOBAL_KEYWORDS],
    });

    return filtered;
  }

  return {
    async fetchNews(pair: TradingPair): Promise<string[]> {
      try {
        await refreshCache();
        return filterByPair(pair);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        logger.error("system", "News fetch failed", { pair, error: message });
        return [];
      }
    },
  };
}
