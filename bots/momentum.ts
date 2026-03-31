import type {
  Exchange,
  GPTClient,
  Logger,
  OHLCV,
  Position,
  EMASignal,
  TradingPair,
  Repository,
  TradeRecord,
} from "../types/index.js";
import { MOMENTUM_CONFIG, INDICATOR } from "../config/settings.js";
import {
  calculatePositionSize,
  calculatePnl,
  shouldStopLoss,
  canOpenPosition,
  isVolatilityExpanding,
} from "../core/risk.js";

// ── EMA calculation (pure function, exported for testing) ──

/**
 * Compute Exponential Moving Average for a candle series.
 *
 *   EMA_today = close * k + EMA_yesterday * (1 - k)
 *   k = 2 / (period + 1)
 *
 * Returns an array aligned with `candles`. The first `period - 1` entries
 * are NaN because there is not enough data to seed the EMA.
 */
export function calculateEMA(
  candles: readonly OHLCV[],
  period: number,
): number[] {
  if (candles.length === 0) return [];

  const k = 2 / (period + 1);
  const ema: number[] = new Array<number>(candles.length);

  // First period-1 entries: insufficient data → NaN
  for (let i = 0; i < Math.min(period - 1, candles.length); i++) {
    ema[i] = NaN;
  }

  if (candles.length < period) return ema;

  // Seed EMA with SMA of the first `period` closes
  let sum = 0;
  for (let i = 0; i < period; i++) {
    const candle = candles[i];
    if (candle === undefined) return ema;
    sum += candle.close;
  }
  ema[period - 1] = sum / period;

  // EMA recurrence from period onward
  for (let i = period; i < candles.length; i++) {
    const candle = candles[i];
    const prev = ema[i - 1];
    if (candle === undefined || prev === undefined) break;
    ema[i] = candle.close * k + prev * (1 - k);
  }

  return ema;
}

// ── Crossover detection ──

/**
 * Build an EMASignal from the two most recent values of short and long EMA
 * series. A crossover means the short EMA was at-or-below the long on the
 * previous bar and is now above (and vice-versa for crossunder).
 */
function detectSignal(
  emaShort: readonly number[],
  emaLong: readonly number[],
): EMASignal {
  const len = Math.min(emaShort.length, emaLong.length);
  if (len < 2) {
    return { emaShort: 0, emaLong: 0, crossOver: false, crossUnder: false };
  }

  const currShort = emaShort[len - 1] ?? 0;
  const currLong = emaLong[len - 1] ?? 0;
  const prevShort = emaShort[len - 2] ?? 0;
  const prevLong = emaLong[len - 2] ?? 0;

  return {
    emaShort: currShort,
    emaLong: currLong,
    crossOver: prevShort <= prevLong && currShort > currLong,
    crossUnder: prevShort >= prevLong && currShort < currLong,
  };
}

// ── Volume confirmation ──

/**
 * Check whether the latest confirmed candle's volume exceeds
 * VOLUME_MULTIPLIER times the average of the preceding VOLUME_LOOKBACK bars.
 */
function isVolumeConfirmed(candles: readonly OHLCV[]): boolean {
  if (candles.length < INDICATOR.VOLUME_LOOKBACK + 1) return false;

  const latest = candles[candles.length - 1];
  if (latest === undefined) return false;

  let volSum = 0;
  const start = candles.length - 1 - INDICATOR.VOLUME_LOOKBACK;
  for (let i = start; i < candles.length - 1; i++) {
    const candle = candles[i];
    if (candle === undefined) return false;
    volSum += candle.volume;
  }
  const avgVolume = volSum / INDICATOR.VOLUME_LOOKBACK;

  return latest.volume >= avgVolume * INDICATOR.VOLUME_MULTIPLIER;
}

// ── Public interface ──

export interface MomentumBot {
  tick(allPositions: readonly Position[]): Promise<void>;
  getPositions(): readonly Position[];
  restorePositions(trades: readonly TradeRecord[]): void;
}

export function createMomentumBot(deps: {
  exchange: Exchange;
  gpt: GPTClient;
  logger: Logger;
  capitalUsd: number;
  repo: Repository;
}): MomentumBot {
  const { exchange, gpt, logger, capitalUsd, repo } = deps;
  const BOT_NAME = MOMENTUM_CONFIG.name;

  // Mutable internal position state (closure)
  const positions: Position[] = [];
  const tradeIds = new Map<TradingPair, string>();

  /** Number of candles to fetch: EMA_LONG_PERIOD + buffer */
  const CANDLE_LIMIT = INDICATOR.EMA_LONG_PERIOD + 10; // 60

  function findPosition(pair: TradingPair): Position | undefined {
    return positions.find((p) => p.pair === pair);
  }

  function removePosition(pair: TradingPair): void {
    const idx = positions.findIndex((p) => p.pair === pair);
    if (idx !== -1) positions.splice(idx, 1);
  }

  // ── Exit logic ──

  async function tryExit(
    pair: TradingPair,
    position: Position,
    signal: EMASignal,
    currentPrice: number,
  ): Promise<void> {
    // Stop-loss check
    if (shouldStopLoss(position, currentPrice)) {
      logger.warn(BOT_NAME, `Stop-loss triggered for ${pair}`, {
        entryPrice: position.entryPrice,
        currentPrice,
      });
      await closePosition(pair, position, "stop-loss");
      return;
    }

    // EMA crossunder exit
    if (signal.crossUnder) {
      logger.info(BOT_NAME, `EMA cross-under exit signal for ${pair}`, {
        emaShort: signal.emaShort,
        emaLong: signal.emaLong,
      });
      await closePosition(pair, position, "cross-under");
    }
  }

  async function closePosition(
    pair: TradingPair,
    position: Position,
    reason: string,
  ): Promise<void> {
    try {
      const result = await exchange.createOrder({
        pair,
        side: "sell",
        amount: position.amount,
      });
      logger.info(BOT_NAME, `Closed position on ${pair} (${reason})`, {
        orderId: result.id,
        entryPrice: position.entryPrice,
        exitPrice: result.price,
        amount: result.amount,
      });

      // Record trade close in DB
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
      logger.error(BOT_NAME, `Failed to close position on ${pair}`, {
        error: message,
      });
      return; // Keep position if the order failed
    }
    removePosition(pair);
  }

  // ── Entry logic ──

  async function tryEntry(
    pair: TradingPair,
    signal: EMASignal,
    confirmedCandles: readonly OHLCV[],
    allPositions: readonly Position[],
  ): Promise<void> {
    // Must have crossover
    if (!signal.crossOver) return;

    // Volume confirmation
    if (!isVolumeConfirmed(confirmedCandles)) {
      logger.debug(BOT_NAME, `Volume not confirmed for ${pair}, skipping`);
      return;
    }

    // Position limit check
    if (!canOpenPosition(positions, BOT_NAME, allPositions)) {
      logger.info(BOT_NAME, `Position limit reached, skipping ${pair}`);
      return;
    }

    // ATR ボラティリティフィルター: ボラが拡大していない場合はスキップ
    if (!isVolatilityExpanding(confirmedCandles, INDICATOR.ATR_PERIOD)) {
      logger.debug(BOT_NAME, `Volatility not expanding for ${pair}, skipping entry`);
      return;
    }

    // GPT market regime classification
    try {
      const regime = await gpt.classifyMarketRegime(pair, [...confirmedCandles]);
      logger.info(BOT_NAME, `GPT regime for ${pair}: ${regime.regime}`, {
        confidence: regime.confidence,
        reasoning: regime.reasoning,
      });

      if (regime.regime === "RANGING") {
        logger.info(
          BOT_NAME,
          `Skipping entry on ${pair} — GPT classified as RANGING`,
        );
        return;
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error(BOT_NAME, `GPT regime check failed for ${pair}`, {
        error: message,
      });
      // Conservative: skip entry if GPT is unavailable
      return;
    }

    // Fetch current price from ticker (use ask for buy orders)
    const ticker = await exchange.fetchTicker(pair);
    const entryPrice = ticker.ask;

    // Calculate position size
    const amount = calculatePositionSize({
      capitalUsd,
      capitalRatio: MOMENTUM_CONFIG.capitalRatio,
      price: entryPrice,
    });

    if (amount <= 0) {
      logger.warn(BOT_NAME, `Calculated position size is 0 for ${pair}`);
      return;
    }

    // Execute order
    try {
      const result = await exchange.createOrder({
        pair,
        side: "buy",
        amount,
      });

      const newPosition: Position = {
        pair,
        side: "buy",
        entryPrice: result.price,
        amount: result.amount,
        openedAt: result.timestamp,
        highWaterMark: result.price,
      };
      positions.push(newPosition);

      logger.info(BOT_NAME, `Opened position on ${pair}`, {
        orderId: result.id,
        price: result.price,
        amount: result.amount,
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error(BOT_NAME, `Failed to open position on ${pair}`, {
        error: message,
      });
    }
  }

  // ── Tick: per-pair processing ──

  async function processPair(
    pair: TradingPair,
    allPositions: readonly Position[],
  ): Promise<void> {
    let rawCandles: OHLCV[];
    try {
      rawCandles = await exchange.fetchOHLCV(
        pair,
        MOMENTUM_CONFIG.timeframe,
        CANDLE_LIMIT,
      );
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error(BOT_NAME, `Failed to fetch OHLCV for ${pair}`, {
        error: message,
      });
      return;
    }

    // Drop the latest (unconfirmed) candle to avoid look-ahead bias
    const candles = rawCandles.slice(0, -1);

    if (candles.length < INDICATOR.EMA_LONG_PERIOD + 1) {
      logger.warn(BOT_NAME, `Not enough confirmed candles for ${pair}`, {
        received: candles.length,
        required: INDICATOR.EMA_LONG_PERIOD + 1,
      });
      return;
    }

    const emaShortSeries = calculateEMA(candles, INDICATOR.EMA_SHORT_PERIOD);
    const emaLongSeries = calculateEMA(candles, INDICATOR.EMA_LONG_PERIOD);
    const signal = detectSignal(emaShortSeries, emaLongSeries);
    const lastCandle = candles[candles.length - 1];
    if (lastCandle === undefined) return;
    const currentPrice = lastCandle.close;

    logger.debug(BOT_NAME, `Signal for ${pair}`, {
      emaShort: signal.emaShort,
      emaLong: signal.emaLong,
      crossOver: signal.crossOver,
      crossUnder: signal.crossUnder,
      currentPrice,
    });

    const existingPosition = findPosition(pair);

    if (existingPosition) {
      await tryExit(pair, existingPosition, signal, currentPrice);
    } else {
      await tryEntry(pair, signal, candles, allPositions);
    }
  }

  // ── Public API ──

  return {
    async tick(allPositions: readonly Position[]): Promise<void> {
      logger.debug(BOT_NAME, "Tick started", {
        pairs: [...MOMENTUM_CONFIG.pairs],
        openPositions: positions.length,
      });

      await Promise.all(
        MOMENTUM_CONFIG.pairs.map((pair) => processPair(pair, allPositions)),
      );

      logger.debug(BOT_NAME, "Tick completed", {
        openPositions: positions.length,
      });
    },

    getPositions(): readonly Position[] {
      return [...positions];
    },

    restorePositions(openTrades: readonly TradeRecord[]): void {
      for (const trade of openTrades) {
        positions.push({
          pair: trade.symbol,
          side: trade.side,
          entryPrice: trade.entry_price,
          amount: trade.amount,
          openedAt: trade.created_at ? new Date(trade.created_at).getTime() : Date.now(),
          highWaterMark: trade.entry_price,
        });
        if (trade.id) {
          tradeIds.set(trade.symbol, trade.id);
        }
      }
      logger.info(BOT_NAME, `Restored ${openTrades.length} positions from DB`);
    },
  };
}
