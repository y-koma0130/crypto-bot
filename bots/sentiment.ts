import type {
  Exchange, GPTClient, Logger, Position, SentimentResult, TradingPair, Repository, TradeRecord,
} from "../types/index.js";
import type { NewsFetcher } from "../core/news.js";
import { SENTIMENT_CONFIG } from "../config/settings.js";
import {
  calculatePositionSize,
  calculatePnl,
  shouldStopLoss,
  canOpenPosition,
} from "../core/risk.js";

// ── Public Interface ──

export interface SentimentBot {
  tick(allPositions: readonly Position[]): Promise<void>;
  getPositions(): readonly Position[];
  restorePositions(trades: readonly TradeRecord[]): void;
  isHalted(): boolean;
  getLatestSentiment(): ReadonlyMap<TradingPair, SentimentResult>;
}

// ── Dependencies ──

interface SentimentBotDeps {
  readonly exchange: Exchange;
  readonly gpt: GPTClient;
  readonly logger: Logger;
  readonly capitalUsd: number;
  readonly repo: Repository;
  readonly newsFetcher: NewsFetcher;
}

// ── Factory ──

export function createSentimentBot(deps: SentimentBotDeps): SentimentBot {
  const { exchange, gpt, logger, capitalUsd, repo, newsFetcher } = deps;
  const BOT_NAME = SENTIMENT_CONFIG.name;

  let positions: Position[] = [];
  const sentimentMap = new Map<TradingPair, SentimentResult>();
  const tradeIds = new Map<TradingPair, string>();

  function isHalted(): boolean {
    for (const result of sentimentMap.values()) {
      if (result.level === "HALT") return true;
    }
    return false;
  }

  // ── Core tick logic ──

  async function tick(allPositions: readonly Position[]): Promise<void> {
    logger.info(BOT_NAME, "Sentiment tick started");

    // Phase 1: Fetch news for all pairs, then batch-analyze in 1 GPT call
    const newsResults = await Promise.all(
      SENTIMENT_CONFIG.pairs.map((pair) => newsFetcher.fetchNews(pair)),
    );
    const pairNewsMap = new Map<TradingPair, string[]>(
      SENTIMENT_CONFIG.pairs.map((pair, i) => [pair, newsResults[i] ?? []]),
    );

    try {
      const results = await gpt.analyzeSentimentBatch(pairNewsMap);
      for (const [pair, result] of results) {
        sentimentMap.set(pair, result);

        logger.info(BOT_NAME, `Sentiment for ${pair}: ${result.level}`, {
          reasoning: result.reasoning,
        });

        void repo.insertSignal({
          bot_name: BOT_NAME,
          symbol: pair,
          signal: result.level,
          reasoning: result.reasoning,
        }).catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          logger.error(BOT_NAME, "Failed to record signal", { error: msg });
        });

        if (result.level === "HALT") {
          logger.warn(BOT_NAME, `HALT detected on ${pair} — blocking new entries for all bots`, {
            reasoning: result.reasoning,
          });
        }
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error(BOT_NAME, "Batch sentiment analysis failed", { error: message });
    }

    // Phase 2: Manage existing positions (stop-loss check)
    await checkStopLosses();

    // Phase 3: Consider new entries based on sentiment
    if (!isHalted()) {
      await evaluateEntries(allPositions);
    } else {
      logger.info(BOT_NAME, "Halted — skipping new entry evaluation");
    }

    logger.info(BOT_NAME, "Sentiment tick completed", {
      halted: isHalted(),
      positionCount: positions.length,
    });
  }

  // ── Stop-loss management ──

  async function checkStopLosses(): Promise<void> {
    const remaining: Position[] = [];

    for (const position of positions) {
      try {
        const ticker = await exchange.fetchTicker(position.pair);
        const currentPrice = ticker.last;

        if (shouldStopLoss(position, currentPrice)) {
          logger.warn(BOT_NAME, `Stop-loss triggered for ${position.pair}`, {
            entryPrice: position.entryPrice,
            currentPrice,
            side: position.side,
          });

          await closePosition(position);
        } else {
          remaining.push(position);
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        logger.error(BOT_NAME, `Error checking stop-loss for ${position.pair}`, {
          error: message,
        });
        // Keep position if we can't check — don't silently drop it
        remaining.push(position);
      }
    }

    positions = remaining;
  }

  // ── Entry evaluation ──

  async function evaluateEntries(allPositions: readonly Position[]): Promise<void> {
    for (const pair of SENTIMENT_CONFIG.pairs) {
      const sentiment = sentimentMap.get(pair);
      if (!sentiment) {
        continue;
      }

      const existingPosition = positions.find((p) => p.pair === pair);

      // BULLISH: consider opening a buy position
      if (sentiment.level === "BULLISH" && !existingPosition) {
        if (!canOpenPosition(positions, BOT_NAME, allPositions)) {
          logger.debug(BOT_NAME, `Cannot open position for ${pair} — limit reached`);
          continue;
        }

        try {
          const ticker = await exchange.fetchTicker(pair);
          const price = ticker.ask;
          const amount = calculatePositionSize({
            capitalUsd: capitalUsd,
            capitalRatio: SENTIMENT_CONFIG.capitalRatio,
            price,
          });

          if (amount <= 0) {
            logger.debug(BOT_NAME, `Calculated position size is 0 for ${pair}`);
            continue;
          }

          await openPosition(pair, amount);
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          logger.error(BOT_NAME, `Failed to open position for ${pair}`, {
            error: message,
          });
        }
      }

      // BEARISH: consider closing existing buy position
      if (sentiment.level === "BEARISH" && existingPosition) {
        try {
          await closePosition(existingPosition);
          positions = positions.filter((p) => p.pair !== pair);
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          logger.error(BOT_NAME, `Failed to close position for ${pair}`, {
            error: message,
          });
        }
      }
    }
  }

  // ── Order helpers ──

  async function openPosition(
    pair: TradingPair,
    amount: number,
  ): Promise<void> {
    const result = await exchange.createOrder({
      pair,
      side: "buy",
      amount,
    });
    logger.info(BOT_NAME, `Opened BUY position on ${pair}`, {
      orderId: result.id,
      amount: result.amount,
      price: result.price,
    });

    positions.push({
      pair,
      side: "buy",
      entryPrice: result.price,
      amount: result.amount,
      openedAt: Date.now(),
    });

    // Record trade in DB
    void repo.insertTrade({
      bot_name: BOT_NAME,
      symbol: pair,
      side: "buy",
      amount: result.amount,
      entry_price: result.price,
      status: "open",
    }).then((id) => { tradeIds.set(pair, id); }).catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(BOT_NAME, "Failed to record trade", { error: msg });
    });
  }

  async function closePosition(
    position: Position,
  ): Promise<void> {
    const result = await exchange.createOrder({
      pair: position.pair,
      side: "sell",
      amount: position.amount,
    });
    logger.info(BOT_NAME, `Closed position on ${position.pair}`, {
      orderId: result.id,
      entryPrice: position.entryPrice,
      exitPrice: result.price,
    });

    // Record trade close in DB
    const tradeId = tradeIds.get(position.pair);
    if (tradeId) {
      const pnl = calculatePnl({ side: position.side, entryPrice: position.entryPrice, exitPrice: result.price, amount: position.amount });
      void repo.closeTrade(tradeId, result.price, pnl).catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error(BOT_NAME, "Failed to record trade close", { error: msg });
      });
      tradeIds.delete(position.pair);
    }
  }

  // ── Public API ──

  return {
    tick,
    getPositions: () => [...positions],
    restorePositions(openTrades: readonly TradeRecord[]): void {
      for (const trade of openTrades) {
        positions.push({
          pair: trade.symbol,
          side: trade.side,
          entryPrice: trade.entry_price,
          amount: trade.amount,
          openedAt: trade.created_at ? new Date(trade.created_at).getTime() : Date.now(),
        });
        if (trade.id) {
          tradeIds.set(trade.symbol, trade.id);
        }
      }
      logger.info(BOT_NAME, `Restored ${openTrades.length} positions from DB`);
    },
    isHalted,
    getLatestSentiment: () => new Map(sentimentMap),
  };
}
