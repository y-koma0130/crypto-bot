/**
 * Polymarket Bot — 予測市場の確率急変をトリガーにエントリー。
 * GPT不要。Polymarketの確率が10分間で15%以上変動した場合にエントリー。
 */
import {
  getOrderClient,
  type Exchange,
  type FuturesExchange,
  type Logger,
  type Position,
  type TradingPair,
  type Repository,
  type TradeRecord,
  type OrderSide,
} from "../types/index.js";
import type { NewsFetcher } from "../core/news.js";
import { POLYMARKET_BOT_CONFIG } from "../config/settings.js";
import {
  calculatePositionSize,
  calculatePnl,
  shouldStopLoss,
  shouldPartialTakeProfit,
  canOpenPosition,
} from "../core/risk.js";

/** 確率急変のトリガー閾値（15%） */
const SIGNAL_THRESHOLD = 0.15;

export interface PolymarketBot {
  tick(allPositions: readonly Position[]): Promise<void>;
  getPositions(): readonly Position[];
  restorePositions(trades: readonly TradeRecord[]): void;
  checkStopLosses(): Promise<void>;
}

export function createPolymarketBot(deps: {
  exchange: Exchange;
  logger: Logger;
  capitalUsd: number;
  repo: Repository;
  newsFetcher: NewsFetcher;
  futuresExchange?: FuturesExchange;
  getDailyTrend?: (pair: TradingPair) => Promise<"buy" | "sell" | null>;
}): PolymarketBot {
  const { exchange, logger, capitalUsd, repo, newsFetcher, futuresExchange, getDailyTrend } = deps;
  const BOT_NAME = POLYMARKET_BOT_CONFIG.name;

  const positions: Position[] = [];
  const tradeIds = new Map<TradingPair, string>();

  function findPosition(pair: TradingPair): Position | undefined {
    return positions.find((p) => p.pair === pair);
  }

  function removePosition(pair: TradingPair): void {
    const idx = positions.findIndex((p) => p.pair === pair);
    if (idx !== -1) positions.splice(idx, 1);
  }

  async function closePosition(
    pair: TradingPair,
    position: Position,
    reason: string,
  ): Promise<void> {
    const closeSide = position.side === "buy" ? "sell" as const : "buy" as const;
    const client = getOrderClient(position.side, exchange, futuresExchange);

    try {
      const result = await client.createOrder({ pair, side: closeSide, amount: position.amount });
      logger.info(BOT_NAME, `Closed ${position.side} position on ${pair} (${reason})`, {
        orderId: result.id, entryPrice: position.entryPrice, exitPrice: result.price,
      });

      const tradeId = tradeIds.get(pair);
      if (tradeId) {
        const pnl = calculatePnl({ side: position.side, entryPrice: position.entryPrice, exitPrice: result.price, amount: position.amount });
        void repo.closeTrade(tradeId, result.price, pnl).catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          logger.error(BOT_NAME, "Failed to record trade close", { error: msg });
        });
        tradeIds.delete(pair);
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error(BOT_NAME, `Failed to close position on ${pair}`, { error: message });
      return;
    }
    removePosition(pair);
  }

  async function processPair(pair: TradingPair, allPositions: readonly Position[]): Promise<void> {
    const existing = findPosition(pair);

    // 既存ポジションの管理
    if (existing) {
      try {
        const ticker = await exchange.fetchTicker(pair);
        if (shouldStopLoss(existing, ticker.last, POLYMARKET_BOT_CONFIG.exitProfile)) {
          logger.warn(BOT_NAME, `Stop-loss triggered for ${pair}`, { entryPrice: existing.entryPrice, currentPrice: ticker.last });
          await closePosition(pair, existing, "stop-loss");
          return;
        }

        // 部分利確
        if (shouldPartialTakeProfit(existing, ticker.last, POLYMARKET_BOT_CONFIG.exitProfile)) {
          const halfAmount = existing.amount / 2;
          const closeSide = existing.side === "buy" ? "sell" as const : "buy" as const;
          const client = getOrderClient(existing.side, exchange, futuresExchange);
          try {
            await client.createOrder({ pair, side: closeSide, amount: halfAmount });
            existing.amount -= halfAmount;
            existing.partialTaken = true;
            logger.info(BOT_NAME, `Partial take-profit on ${pair}`, { remainingAmount: existing.amount });
          } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            logger.error(BOT_NAME, `Failed partial take-profit on ${pair}`, { error: message });
          }
        }

        // 確率が反転したら決済
        const reverseSignals = newsFetcher.getPolymarketSignals(pair, SIGNAL_THRESHOLD);
        for (const sig of reverseSignals) {
          const contradictsPosition =
            (existing.side === "buy" && sig.direction === "bearish") ||
            (existing.side === "sell" && sig.direction === "bullish");
          if (contradictsPosition) {
            logger.info(BOT_NAME, `Polymarket reversal on ${pair}: ${sig.question} (${(sig.changePct * 100).toFixed(1)}%)`, {
              direction: sig.direction,
            });
            await closePosition(pair, existing, "polymarket-reversal");
            return;
          }
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        logger.error(BOT_NAME, `Error managing position on ${pair}`, { error: message });
      }
      return;
    }

    // 新規エントリー: 確率急変シグナルを探す
    const signals = newsFetcher.getPolymarketSignals(pair, SIGNAL_THRESHOLD);
    if (signals.length === 0) return;

    // 最も大きい変化のシグナルを使う
    const strongest = signals.reduce((a, b) => Math.abs(a.changePct) > Math.abs(b.changePct) ? a : b);
    const side: OrderSide = strongest.direction === "bullish" ? "buy" : "sell";

    if (side === "sell" && !futuresExchange) return;

    if (!canOpenPosition(positions, BOT_NAME, allPositions, side)) return;

    // 日足トレンドフィルター
    if (getDailyTrend) {
      const allowed = await getDailyTrend(pair);
      if (allowed && allowed !== side) {
        logger.info(BOT_NAME, `Daily trend filter: ${side} blocked on ${pair}`);
        return;
      }
    }

    const client = getOrderClient(side, exchange, futuresExchange);
    const ticker = await client.fetchTicker(pair);
    const entryPrice = side === "buy" ? ticker.ask : ticker.bid;

    const amount = calculatePositionSize({
      capitalUsd,
      capitalRatio: POLYMARKET_BOT_CONFIG.capitalRatio,
      price: entryPrice,
    });
    if (amount <= 0) return;

    try {
      const result = await client.createOrder({ pair, side, amount });
      positions.push({
        pair, side,
        entryPrice: result.price,
        amount: result.amount,
        openedAt: result.timestamp,
        highWaterMark: result.price,
      });

      logger.info(BOT_NAME, `Opened ${side} on ${pair} — Polymarket signal: ${strongest.question}`, {
        orderId: result.id,
        changePct: (strongest.changePct * 100).toFixed(1),
        currentPct: (strongest.currentPct * 100).toFixed(0),
      });

      void repo.insertTrade({
        bot_name: BOT_NAME, symbol: pair, side,
        amount: result.amount, entry_price: result.price, status: "open",
      }).then((id) => { tradeIds.set(pair, id); }).catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error(BOT_NAME, "Failed to record trade", { error: msg });
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error(BOT_NAME, `Failed to open ${side} on ${pair}`, { error: message });
    }
  }

  return {
    async tick(allPositions: readonly Position[]): Promise<void> {
      logger.debug(BOT_NAME, "Tick started", { openPositions: positions.length });
      await Promise.all(
        POLYMARKET_BOT_CONFIG.pairs.map((pair) => processPair(pair, allPositions)),
      );
      logger.debug(BOT_NAME, "Tick completed", { openPositions: positions.length });
    },

    getPositions: () => [...positions],

    restorePositions(openTrades: readonly TradeRecord[]): void {
      for (const trade of openTrades) {
        positions.push({
          pair: trade.symbol, side: trade.side,
          entryPrice: trade.entry_price, amount: trade.amount,
          openedAt: trade.created_at ? new Date(trade.created_at).getTime() : Date.now(),
          highWaterMark: trade.entry_price,
        });
        if (trade.id) tradeIds.set(trade.symbol, trade.id);
      }
      logger.info(BOT_NAME, `Restored ${openTrades.length} positions from DB`);
    },

    async checkStopLosses(): Promise<void> {
      for (const position of [...positions]) {
        try {
          const ticker = await exchange.fetchTicker(position.pair);
          if (shouldStopLoss(position, ticker.last, POLYMARKET_BOT_CONFIG.exitProfile)) {
            logger.warn(BOT_NAME, `[rapid-check] Stop-loss on ${position.pair}`, {
              entryPrice: position.entryPrice, currentPrice: ticker.last,
            });
            await closePosition(position.pair, position, "stop-loss");
          }
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          logger.error(BOT_NAME, `[rapid-check] Failed for ${position.pair}`, { error: message });
        }
      }
    },
  };
}
