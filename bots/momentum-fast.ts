/**
 * 短期モメンタムボット（15分足、EMA 5/13）。
 * GPT判定を省略し速度優先、参考指標は出来高+ATRの2つ中1つでエントリー。
 */
import {
  getOrderClient,
  type Exchange,
  type FuturesExchange,
  type GPTClient,
  type Logger,
  type OHLCV,
  type Position,
  type EMASignal,
  type TradingPair,
  type Repository,
  type TradeRecord,
} from "../types/index.js";
import { MOMENTUM_FAST_CONFIG, INDICATOR } from "../config/settings.js";
import { calculateEMA, calculateMACD, detectSignal, isVolumeConfirmed } from "./momentum.js";
import { analyzeVolume } from "../core/indicators.js";
import {
  calculatePositionSize,
  calculatePnl,
  calculateATR,
  shouldStopLoss,
  shouldPartialTakeProfit,
  canOpenPosition,
  isVolatilityExpanding,
} from "../core/risk.js";

export interface MomentumFastBot {
  tick(allPositions: readonly Position[]): Promise<void>;
  getPositions(): readonly Position[];
  restorePositions(trades: readonly TradeRecord[]): void;
  checkStopLosses(): Promise<void>;
}

export function createMomentumFastBot(deps: {
  exchange: Exchange;
  gpt: GPTClient;
  logger: Logger;
  capitalUsd: number;
  repo: Repository;
  futuresExchange?: FuturesExchange;
  getDailyTrend?: (pair: TradingPair) => Promise<"buy" | "sell" | null>;
}): MomentumFastBot {
  const { exchange, logger, capitalUsd, repo, futuresExchange, getDailyTrend } = deps;
  const BOT_NAME = MOMENTUM_FAST_CONFIG.name;

  const positions: Position[] = [];
  const tradeIds = new Map<TradingPair, string>();
  const lastAtr = new Map<TradingPair, number>();

  const CANDLE_LIMIT = INDICATOR.FAST_EMA_LONG_PERIOD + 30;

  function findPosition(pair: TradingPair): Position | undefined {
    return positions.find((p) => p.pair === pair);
  }

  function removePosition(pair: TradingPair): void {
    const idx = positions.findIndex((p) => p.pair === pair);
    if (idx !== -1) positions.splice(idx, 1);
  }

  async function tryExit(
    pair: TradingPair,
    position: Position,
    signal: EMASignal,
    currentPrice: number,
    atr?: number,
  ): Promise<void> {
    if (shouldStopLoss(position, currentPrice, MOMENTUM_FAST_CONFIG.exitProfile, atr)) {
      logger.warn(BOT_NAME, `Stop-loss triggered for ${pair} (${position.side})`, {
        entryPrice: position.entryPrice,
        currentPrice,
      });
      await closePosition(pair, position, "stop-loss");
      return;
    }

    // 時間ベース損切り
    const { timeStopMs, timeStopMinProfitPct } = MOMENTUM_FAST_CONFIG.exitProfile;
    const elapsed = Date.now() - position.openedAt;
    if (timeStopMs > 0 && elapsed >= timeStopMs) {
      const unrealizedPct = position.side === "buy"
        ? (currentPrice - position.entryPrice) / position.entryPrice
        : (position.entryPrice - currentPrice) / position.entryPrice;
      if (unrealizedPct < timeStopMinProfitPct) {
        logger.info(BOT_NAME, `Time stop on ${pair}: ${(elapsed / 3_600_000).toFixed(1)}h elapsed, profit ${(unrealizedPct * 100).toFixed(2)}%`);
        await closePosition(pair, position, "time-stop");
        return;
      }
    }

    // 部分利確
    if (shouldPartialTakeProfit(position, currentPrice, MOMENTUM_FAST_CONFIG.exitProfile)) {
      const halfAmount = position.amount / 2;
      const client = getOrderClient(position.side, exchange, futuresExchange);
      const closeSide = position.side === "buy" ? "sell" as const : "buy" as const;
      try {
        const result = await client.createOrder({ pair, side: closeSide, amount: halfAmount });
        const partialPnl = calculatePnl({ side: position.side, entryPrice: position.entryPrice, exitPrice: result.price, amount: halfAmount });
        position.amount -= halfAmount;
        position.partialTaken = true;
        logger.info(BOT_NAME, `Partial take-profit on ${pair}: pnl ${partialPnl.toFixed(2)}`, { remainingAmount: position.amount });
        const tradeId = tradeIds.get(pair);
        if (tradeId) {
          void repo.recordPartialTakeProfit(tradeId, result.price, halfAmount, partialPnl).catch((err: unknown) => {
            const msg = err instanceof Error ? err.message : String(err);
            logger.error(BOT_NAME, "Failed to record partial take-profit", { error: msg });
          });
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        logger.error(BOT_NAME, `Failed partial take-profit on ${pair}`, { error: message });
      }
    }

    if (position.side === "buy" && signal.crossUnder) {
      await closePosition(pair, position, "cross-under");
    }
    if (position.side === "sell" && signal.crossOver) {
      await closePosition(pair, position, "cross-over");
    }
  }

  async function closePosition(
    pair: TradingPair,
    position: Position,
    reason: string,
  ): Promise<void> {
    const closeSide = position.side === "buy" ? "sell" as const : "buy" as const;
    const client = getOrderClient(position.side, exchange, futuresExchange);

    try {
      const result = await client.createOrder({
        pair,
        side: closeSide,
        amount: position.amount,
      });
      logger.info(BOT_NAME, `Closed ${position.side} position on ${pair} (${reason})`, {
        orderId: result.id,
        entryPrice: position.entryPrice,
        exitPrice: result.price,
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

  type EntryDirection = "long" | "short";

  /**
   * 短期モメンタムのエントリー。
   * コア: EMAクロス + MACD方向
   * 参考: 出来高 + ATR（2つ中1つ以上でOK — 短期なので緩め）
   * GPT判定は省略（速度優先）
   */
  async function tryDirectionalEntry(
    pair: TradingPair,
    signal: EMASignal,
    confirmedCandles: readonly OHLCV[],
    allPositions: readonly Position[],
    direction: EntryDirection,
  ): Promise<void> {
    const isLong = direction === "long";
    const side = isLong ? "buy" as const : "sell" as const;

    if (!isLong && !futuresExchange) return;

    if (isLong ? !signal.crossOver : !signal.crossUnder) return;

    const macd = calculateMACD(confirmedCandles);
    if (Number.isNaN(macd.histogram)) return;
    if (isLong ? macd.histogram <= 0 : macd.histogram >= 0) return;

    if (!canOpenPosition(positions, BOT_NAME, allPositions, side)) return;

    // 日足トレンドフィルター
    if (getDailyTrend) {
      const allowed = await getDailyTrend(pair);
      if (allowed && allowed !== side) {
        logger.info(BOT_NAME, `Daily trend filter: ${direction} blocked on ${pair}`);
        return;
      }
    }

    // 参考指標（2つ中1つ以上）
    const volAnalysis = analyzeVolume(confirmedCandles, INDICATOR.VOLUME_LOOKBACK, INDICATOR.VOLUME_MULTIPLIER);
    const volumeOk = volAnalysis.score >= 0.5;
    const atrOk = isVolatilityExpanding(confirmedCandles, INDICATOR.ATR_PERIOD);
    if (!volumeOk && !atrOk) {
      logger.debug(BOT_NAME, `No supplementary signal for ${direction} on ${pair}, skipping`, {
        volumeScore: volAnalysis.score,
        volumeTrend: volAnalysis.trend,
        volumePattern: volAnalysis.pattern,
      });
      return;
    }

    const client = getOrderClient(side, exchange, futuresExchange);
    const ticker = await client.fetchTicker(pair);
    const entryPrice = isLong ? ticker.ask : ticker.bid;

    const amount = calculatePositionSize({
      capitalUsd,
      capitalRatio: MOMENTUM_FAST_CONFIG.capitalRatio,
      price: entryPrice,
    });
    if (amount <= 0) return;

    try {
      const result = await client.createOrder({ pair, side, amount });
      positions.push({
        pair,
        side,
        entryPrice: result.price,
        amount: result.amount,
        openedAt: result.timestamp,
        highWaterMark: result.price,
      });

      logger.info(BOT_NAME, `Opened ${direction} position on ${pair}${isLong ? "" : " (futures)"}`, {
        orderId: result.id,
        price: result.price,
        amount: result.amount,
      });

      void repo.insertTrade({
        bot_name: BOT_NAME,
        symbol: pair,
        side,
        amount: result.amount,
        entry_price: result.price,
        status: "open",
      }).then((id) => { tradeIds.set(pair, id); }).catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error(BOT_NAME, "Failed to record trade", { error: msg });
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error(BOT_NAME, `Failed to open ${direction} position on ${pair}`, { error: message });
    }
  }

  async function processPair(
    pair: TradingPair,
    allPositions: readonly Position[],
  ): Promise<void> {
    let candles: OHLCV[];
    try {
      candles = await exchange.fetchOHLCV(pair, MOMENTUM_FAST_CONFIG.timeframe, CANDLE_LIMIT);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error(BOT_NAME, `Failed to fetch OHLCV for ${pair}`, { error: message });
      return;
    }

    if (candles.length < INDICATOR.FAST_EMA_LONG_PERIOD + 1) {
      logger.warn(BOT_NAME, `Not enough candles for ${pair}`);
      return;
    }

    const emaShortSeries = calculateEMA(candles, INDICATOR.FAST_EMA_SHORT_PERIOD);
    const emaLongSeries = calculateEMA(candles, INDICATOR.FAST_EMA_LONG_PERIOD);
    const signal = detectSignal(emaShortSeries, emaLongSeries);
    const lastCandle = candles[candles.length - 1];
    if (lastCandle === undefined) return;
    const currentPrice = lastCandle.close;

    const atr = calculateATR(candles, INDICATOR.ATR_PERIOD);
    lastAtr.set(pair, atr);
    const existingPosition = findPosition(pair);

    if (existingPosition) {
      await tryExit(pair, existingPosition, signal, currentPrice, atr);
    } else {
      await tryDirectionalEntry(pair, signal, candles, allPositions, "long");
      await tryDirectionalEntry(pair, signal, candles, allPositions, "short");
    }
  }

  return {
    async tick(allPositions: readonly Position[]): Promise<void> {
      logger.debug(BOT_NAME, "Tick started", { openPositions: positions.length });
      await Promise.all(
        MOMENTUM_FAST_CONFIG.pairs.map((pair) => processPair(pair, allPositions)),
      );
      logger.debug(BOT_NAME, "Tick completed", { openPositions: positions.length });
    },

    getPositions: () => [...positions],

    restorePositions(openTrades: readonly TradeRecord[]): void {
      for (const trade of openTrades) {
        const alreadyPartial = trade.partial_at != null;
        const restoredAmount = alreadyPartial && trade.partial_amount
          ? trade.amount - trade.partial_amount
          : trade.amount;
        positions.push({
          pair: trade.symbol,
          side: trade.side,
          entryPrice: trade.entry_price,
          amount: restoredAmount,
          openedAt: trade.created_at ? new Date(trade.created_at).getTime() : Date.now(),
          highWaterMark: trade.entry_price,
          partialTaken: alreadyPartial,
        });
        if (trade.id) {
          tradeIds.set(trade.symbol, trade.id);
        }
      }
      logger.info(BOT_NAME, `Restored ${openTrades.length} positions from DB`);
    },

    async checkStopLosses(): Promise<void> {
      for (const position of [...positions]) {
        try {
          const ticker = await exchange.fetchTicker(position.pair);
          const atr = lastAtr.get(position.pair);
          if (shouldStopLoss(position, ticker.last, MOMENTUM_FAST_CONFIG.exitProfile, atr)) {
            logger.warn(BOT_NAME, `[rapid-check] Stop-loss triggered for ${position.pair} (${position.side})`, {
              entryPrice: position.entryPrice,
              currentPrice: ticker.last,
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
