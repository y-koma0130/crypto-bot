import {
  getOrderClient,
  type Exchange, type FuturesExchange, type GPTClient, type Logger, type OHLCV, type Position, type TradingPair, type BollingerBands, type OrderSide, type Repository, type TradeRecord,
} from "../types/index.js";
import type { NewsFetcher } from "../core/news.js";
import { RANGE_CONFIG, INDICATOR } from "../config/settings.js";
import {
  calculatePositionSize,
  calculatePnl,
  shouldStopLoss,
  shouldPartialTakeProfit,
  canOpenPosition,
} from "../core/risk.js";

// ── Public interface ──

export interface RangeBot {
  tick(allPositions: readonly Position[]): Promise<void>;
  getPositions(): readonly Position[];
  restorePositions(trades: readonly TradeRecord[]): void;
  checkStopLosses(): Promise<void>;
}

// ── RSI calculation (Wilder's smoothing, pure function) ──

/**
 * Calculate Wilder's RSI for the given candles.
 * Returns an array of RSI values aligned with the candle indices.
 * The first `period` entries are NaN (insufficient data).
 */
export function calculateRSI(
  candles: readonly OHLCV[],
  period: number,
): number[] {
  const len = candles.length;
  const rsi: number[] = new Array<number>(len).fill(NaN);

  if (len < period + 1) return rsi;

  // 1. Calculate price changes
  const changes: number[] = [];
  for (let i = 1; i < len; i++) {
    changes.push(candles[i]!.close - candles[i - 1]!.close);
  }

  // 2. Separate gains and losses
  const gains = changes.map((c) => (c > 0 ? c : 0));
  const losses = changes.map((c) => (c < 0 ? -c : 0));

  // 3. First avg gain/loss = SMA of first `period` values
  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 0; i < period; i++) {
    avgGain += gains[i]!;
    avgLoss += losses[i]!;
  }
  avgGain /= period;
  avgLoss /= period;

  // 4. RSI at index `period` (changes index period-1 -> candle index period)
  const rs0 = avgLoss === 0 ? Infinity : avgGain / avgLoss;
  rsi[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + rs0);

  // 5. Subsequent: Wilder's smoothing
  for (let i = period; i < changes.length; i++) {
    avgGain = (avgGain * (period - 1) + gains[i]!) / period;
    avgLoss = (avgLoss * (period - 1) + losses[i]!) / period;

    const rs = avgLoss === 0 ? Infinity : avgGain / avgLoss;
    // changes[i] corresponds to candle index i+1
    rsi[i + 1] = avgLoss === 0 ? 100 : 100 - 100 / (1 + rs);
  }

  return rsi;
}

// ── Bollinger Bands calculation (pure function) ──

/**
 * Calculate Bollinger Bands for the most recent completed period.
 * Uses SMA as the middle band, with upper/lower at ±stdDevMultiplier standard deviations.
 */
export function calculateBB(
  candles: readonly OHLCV[],
  period: number,
  stdDevMultiplier: number,
): BollingerBands {
  if (candles.length < period) {
    return { upper: NaN, middle: NaN, lower: NaN };
  }

  // Use the last `period` candles' close prices
  const closes: number[] = [];
  for (let i = candles.length - period; i < candles.length; i++) {
    closes.push(candles[i]!.close);
  }

  // SMA (middle band)
  let sum = 0;
  for (const c of closes) {
    sum += c;
  }
  const middle = sum / period;

  // Standard deviation (population)
  let sqDiffSum = 0;
  for (const c of closes) {
    const diff = c - middle;
    sqDiffSum += diff * diff;
  }
  const stdDev = Math.sqrt(sqDiffSum / period);

  return {
    upper: middle + stdDev * stdDevMultiplier,
    middle,
    lower: middle - stdDev * stdDevMultiplier,
  };
}

// ── BB width calculation (pure function) ──

/**
 * BB幅を計算する（パーセンテージ）。
 * 幅が狭い = レンジ相場（逆張り有効）、広い = トレンド相場（逆張り危険）。
 */
export function calculateBBWidth(bb: BollingerBands): number {
  if (bb.middle <= 0 || Number.isNaN(bb.middle)) return Infinity;
  return (bb.upper - bb.lower) / bb.middle;
}

// ── ADX calculation (pure function) ──

/**
 * ADX (Average Directional Index) を計算する。
 * ADX > 25: トレンド相場（逆張り危険）
 * ADX < 25: レンジ相場（逆張り有効）
 */
export function calculateADX(candles: readonly OHLCV[], period: number): number {
  if (candles.length < period * 2 + 1) return 0;

  const plusDM: number[] = [];
  const minusDM: number[] = [];
  const tr: number[] = [];

  for (let i = 1; i < candles.length; i++) {
    const curr = candles[i]!;
    const prev = candles[i - 1]!;

    const highDiff = curr.high - prev.high;
    const lowDiff = prev.low - curr.low;

    plusDM.push(highDiff > lowDiff && highDiff > 0 ? highDiff : 0);
    minusDM.push(lowDiff > highDiff && lowDiff > 0 ? lowDiff : 0);

    const trueRange = Math.max(
      curr.high - curr.low,
      Math.abs(curr.high - prev.close),
      Math.abs(curr.low - prev.close),
    );
    tr.push(trueRange);
  }

  if (tr.length < period) return 0;

  // Wilder's smoothing for ATR, +DM, -DM
  let atr = 0;
  let smoothPlusDM = 0;
  let smoothMinusDM = 0;

  for (let i = 0; i < period; i++) {
    atr += tr[i]!;
    smoothPlusDM += plusDM[i]!;
    smoothMinusDM += minusDM[i]!;
  }
  atr /= period;
  smoothPlusDM /= period;
  smoothMinusDM /= period;

  const dxValues: number[] = [];

  for (let i = period; i < tr.length; i++) {
    atr = (atr * (period - 1) + tr[i]!) / period;
    smoothPlusDM = (smoothPlusDM * (period - 1) + plusDM[i]!) / period;
    smoothMinusDM = (smoothMinusDM * (period - 1) + minusDM[i]!) / period;

    const plusDI = atr > 0 ? (smoothPlusDM / atr) * 100 : 0;
    const minusDI = atr > 0 ? (smoothMinusDM / atr) * 100 : 0;
    const diSum = plusDI + minusDI;
    const dx = diSum > 0 ? (Math.abs(plusDI - minusDI) / diSum) * 100 : 0;
    dxValues.push(dx);
  }

  if (dxValues.length < period) return 0;

  // ADX = SMA of DX for first period, then Wilder's smoothing
  let adx = 0;
  for (let i = 0; i < period; i++) {
    adx += dxValues[i]!;
  }
  adx /= period;

  for (let i = period; i < dxValues.length; i++) {
    adx = (adx * (period - 1) + dxValues[i]!) / period;
  }

  return adx;
}

// ── Factory ──

export function createRangeBot(deps: {
  exchange: Exchange;
  gpt: GPTClient;
  logger: Logger;
  capitalUsd: number;
  repo: Repository;
  newsFetcher: NewsFetcher;
  getDailyTrend?: (pair: TradingPair) => Promise<"buy" | "sell" | null>;
  isBtcCrashing?: () => Promise<boolean>;
  futuresExchange?: FuturesExchange;
}): RangeBot {
  const { exchange, gpt, logger, capitalUsd, repo, newsFetcher, futuresExchange, getDailyTrend, isBtcCrashing } = deps;
  const BOT_NAME = RANGE_CONFIG.name;

  /** RSI neutral zone tolerance (±5 around RSI_NEUTRAL) */
  const RSI_NEUTRAL_TOLERANCE = 5;

  // Mutable internal position state
  const positions: Position[] = [];
  const tradeIds = new Map<TradingPair, string>();

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
    rsiValue: number,
    currentPrice: number,
  ): Promise<void> {
    // Stop-loss check
    if (shouldStopLoss(position, currentPrice, RANGE_CONFIG.exitProfile)) {
      logger.warn(BOT_NAME, `Stop-loss triggered for ${pair}`, {
        entryPrice: position.entryPrice,
        currentPrice,
      });
      await closePosition(pair, position, currentPrice, "stop-loss");
      return;
    }

    // 部分利確
    if (shouldPartialTakeProfit(position, currentPrice, RANGE_CONFIG.exitProfile)) {
      const halfAmount = position.amount / 2;
      const closeSide = position.side === "buy" ? "sell" as const : "buy" as const;
      const client = getOrderClient(position.side, exchange, futuresExchange);
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

    // RSI returns to neutral zone (within ±5 of 50)
    const rsiNeutralLow = INDICATOR.RSI_NEUTRAL - RSI_NEUTRAL_TOLERANCE;
    const rsiNeutralHigh = INDICATOR.RSI_NEUTRAL + RSI_NEUTRAL_TOLERANCE;

    if (rsiValue >= rsiNeutralLow && rsiValue <= rsiNeutralHigh) {
      logger.info(BOT_NAME, `RSI neutral exit for ${pair}`, {
        rsi: rsiValue,
        neutralRange: `${String(rsiNeutralLow)}-${String(rsiNeutralHigh)}`,
      });
      await closePosition(pair, position, currentPrice, "rsi-neutral");
    }
  }

  async function closePosition(
    pair: TradingPair,
    position: Position,
    currentPrice: number,
    reason: string,
  ): Promise<void> {
    const closeSide: OrderSide = position.side === "buy" ? "sell" : "buy";
    const client = getOrderClient(position.side, exchange, futuresExchange);

    try {
      const result = await client.createOrder({
        pair,
        side: closeSide,
        amount: position.amount,
      });
      logger.info(BOT_NAME, `Closed position on ${pair} (${reason})`, {
        orderId: result.id,
        exitPrice: result.price,
        entryPrice: position.entryPrice,
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
      return; // Do not remove position if order failed
    }

    removePosition(pair);
  }

  // ── Entry logic ──

  /** 参考指標の必要通過数 */
  const REQUIRED_SUPPLEMENTARY = 2;

  async function tryEntry(
    pair: TradingPair,
    rsiValue: number,
    prevRsi: number,
    bb: BollingerBands,
    currentPrice: number,
    allPositions: readonly Position[],
    candles: readonly OHLCV[],
  ): Promise<void> {
    // ── コア条件（全て必須） ──

    // 1. RSI反転確認 + BB外側（レンジ逆張りの根幹）
    let side: OrderSide | null = null;
    if (prevRsi < INDICATOR.RSI_OVERSOLD && rsiValue > prevRsi && currentPrice < bb.lower) {
      side = "buy";
    } else if (prevRsi > INDICATOR.RSI_OVERBOUGHT && rsiValue < prevRsi && currentPrice > bb.upper) {
      side = "sell";
    }
    if (side === null) return;

    // 2. ポジション制限（リスク管理）
    if (!canOpenPosition(positions, BOT_NAME, allPositions, side)) {
      logger.debug(BOT_NAME, `Position limit reached, skipping ${pair}`);
      return;
    }

    // 日足トレンドフィルター
    if (getDailyTrend) {
      const allowed = await getDailyTrend(pair);
      if (allowed && allowed !== side) {
        logger.info(BOT_NAME, `Daily trend filter: ${side} blocked on ${pair}`);
        return;
      }
    }

    // 相関フィルター: BTC急落時はアルトのロングのみブロック（ショートは許可）
    if (side === "buy" && isBtcCrashing) {
      if (await isBtcCrashing()) {
        logger.warn(BOT_NAME, `BTC crash detected — blocking buy on ${pair}`);
        return;
      }
    }

    // ── 参考指標（3つ中2つ以上で実行） ──

    const supplementary: { name: string; passed: boolean }[] = [];

    // S1. BB幅フィルター（スクイーズ確認）
    const bbWidth = calculateBBWidth(bb);
    supplementary.push({ name: "bb_squeeze", passed: bbWidth <= INDICATOR.BB_SQUEEZE_THRESHOLD });

    // S2. マーケットレジーム判定（GPT分類 → ADXフォールバック）
    let regimeRanging = false;
    try {
      const regimeResult = await gpt.classifyMarketRegime(pair, [...candles]);
      regimeRanging = regimeResult.regime === "RANGING" && regimeResult.confidence >= 0.6;
      logger.debug(BOT_NAME, `GPT regime for ${pair}: ${regimeResult.regime} (confidence: ${regimeResult.confidence.toFixed(2)})`, {
        regime: regimeResult.regime,
        confidence: regimeResult.confidence,
        reasoning: regimeResult.reasoning,
      });
    } catch (err: unknown) {
      // GPT失敗時はADXフォールバック
      const message = err instanceof Error ? err.message : String(err);
      logger.warn(BOT_NAME, `GPT regime classification failed, falling back to ADX`, { error: message });
      const adx = calculateADX(candles, INDICATOR.ADX_PERIOD);
      regimeRanging = adx <= INDICATOR.ADX_TREND_THRESHOLD;
    }
    supplementary.push({ name: "regime_ranging", passed: regimeRanging });

    // S3. Polymarket確率フィルター（GPTの代わりにPolymarketの確率で判定、トークンコスト0）
    const polymarketContradicts = newsFetcher.isPolymarketContradicting(pair, side);
    if (polymarketContradicts) {
      logger.info(BOT_NAME, `Polymarket contradicts ${side} on ${pair}`);
    }
    supplementary.push({ name: "polymarket_safe", passed: !polymarketContradicts });

    const passedCount = supplementary.filter((s) => s.passed).length;
    const passedNames = supplementary.filter((s) => s.passed).map((s) => s.name);
    const failedNames = supplementary.filter((s) => !s.passed).map((s) => s.name);

    logger.info(BOT_NAME, `Supplementary signals for ${pair}: ${String(passedCount)}/${String(supplementary.length)}`, {
      passed: passedNames,
      failed: failedNames,
    });

    if (passedCount < REQUIRED_SUPPLEMENTARY) {
      logger.info(BOT_NAME, `Insufficient supplementary signals for ${pair} (${String(passedCount)}/${String(REQUIRED_SUPPLEMENTARY)} required), skipping`);
      return;
    }

    // Calculate position size
    const amount = calculatePositionSize({
      capitalUsd,
      capitalRatio: RANGE_CONFIG.capitalRatio,
      price: currentPrice,
    });

    if (amount <= 0) {
      logger.warn(BOT_NAME, `Calculated position size is 0 for ${pair}`);
      return;
    }

    if (side === "sell" && !futuresExchange) {
      logger.debug(BOT_NAME, `Futures not enabled, skipping sell entry on ${pair}`);
      return;
    }
    const entryClient = getOrderClient(side, exchange, futuresExchange);

    // Execute order
    let fillPrice = currentPrice;
    try {
      const result = await entryClient.createOrder({
        pair,
        side,
        amount,
      });
      logger.info(BOT_NAME, `Opened ${side} position on ${pair}${side === "sell" ? " (futures)" : ""}`, {
        orderId: result.id,
        price: result.price,
        amount: result.amount,
        rsi: rsiValue,
      });
      fillPrice = result.price;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error(BOT_NAME, `Failed to open position on ${pair}`, {
        error: message,
      });
      return;
    }

    positions.push({
      pair,
      side,
      entryPrice: fillPrice,
      amount,
      openedAt: Date.now(),
      highWaterMark: fillPrice,
    });

    // Record trade in DB
    void repo.insertTrade({
      bot_name: BOT_NAME,
      symbol: pair,
      side,
      amount,
      entry_price: fillPrice,
      status: "open",
    }).then((id) => { tradeIds.set(pair, id); }).catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(BOT_NAME, "Failed to record trade", { error: msg });
    });
  }

  // ── Tick: per-pair processing ──

  async function processPair(
    pair: TradingPair,
    allPositions: readonly Position[],
  ): Promise<void> {
    // RSI/BB の seed 期間 + 安定化バッファ
    const SEED_BUFFER = 20;
    const requiredCandles =
      Math.max(INDICATOR.BB_PERIOD, INDICATOR.RSI_PERIOD, INDICATOR.ADX_PERIOD * 2 + 1) + SEED_BUFFER;

    let candles: OHLCV[];
    try {
      candles = await exchange.fetchOHLCV(
        pair,
        RANGE_CONFIG.timeframe,
        requiredCandles,
      );
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error(BOT_NAME, `Failed to fetch OHLCV for ${pair}`, {
        error: message,
      });
      return;
    }

    const minRequired = Math.max(INDICATOR.BB_PERIOD, INDICATOR.RSI_PERIOD + 1);
    if (candles.length < minRequired) {
      logger.warn(BOT_NAME, `Not enough candles for ${pair}`, {
        received: candles.length,
        required: minRequired,
      });
      return;
    }

    // Candles: index 0 = oldest, index [length-1] = newest confirmed
    const rsiSeries = calculateRSI(candles, INDICATOR.RSI_PERIOD);
    const bb = calculateBB(candles, INDICATOR.BB_PERIOD, INDICATOR.BB_STD_DEV);

    // Use the last element of RSI series for the current signal
    const latestRSI = rsiSeries[rsiSeries.length - 1];
    const currentPrice = candles[candles.length - 1]!.close;

    const prevRSI = rsiSeries[rsiSeries.length - 2];

    if (latestRSI === undefined || Number.isNaN(latestRSI)) {
      logger.warn(BOT_NAME, `RSI not available for ${pair}`);
      return;
    }

    if (prevRSI === undefined || Number.isNaN(prevRSI)) {
      logger.warn(BOT_NAME, `Previous RSI not available for ${pair}`);
      return;
    }

    if (Number.isNaN(bb.middle)) {
      logger.warn(BOT_NAME, `Bollinger Bands not available for ${pair}`);
      return;
    }

    logger.debug(BOT_NAME, `Indicators for ${pair}`, {
      rsi: latestRSI,
      prevRsi: prevRSI,
      bbUpper: bb.upper,
      bbMiddle: bb.middle,
      bbLower: bb.lower,
      currentPrice,
    });

    const existingPosition = findPosition(pair);

    if (existingPosition) {
      await tryExit(pair, existingPosition, latestRSI, currentPrice);
    } else {
      await tryEntry(pair, latestRSI, prevRSI, bb, currentPrice, allPositions, candles);
    }
  }

  // ── Public API ──

  return {
    async tick(allPositions: readonly Position[]): Promise<void> {
      logger.debug(BOT_NAME, "Tick started", {
        pairs: [...RANGE_CONFIG.pairs],
        openPositions: positions.length,
      });

      await Promise.all(
        RANGE_CONFIG.pairs.map((pair) => processPair(pair, allPositions)),
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
          if (shouldStopLoss(position, ticker.last, RANGE_CONFIG.exitProfile)) {
            logger.warn(BOT_NAME, `[rapid-check] Stop-loss triggered for ${position.pair} (${position.side})`, {
              entryPrice: position.entryPrice,
              currentPrice: ticker.last,
            });
            await closePosition(position.pair, position, ticker.last, "stop-loss");
          }
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          logger.error(BOT_NAME, `[rapid-check] Failed for ${position.pair}`, { error: message });
        }
      }
    },
  };
}
