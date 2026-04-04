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
import { MOMENTUM_CONFIG, INDICATOR } from "../config/settings.js";
import { calculateADX } from "./range.js";
import {
  calculatePositionSize,
  calculatePnl,
  calculateATR,
  shouldStopLoss,
  shouldPartialTakeProfit,
  canOpenPosition,
  isVolatilityExpanding,
} from "../core/risk.js";

// Re-export from shared module for backward compatibility
import { calculateEMA, calculateMTFScore, analyzeVolume } from "../core/indicators.js";
export { calculateEMA };

// ── MACD calculation (pure function, exported for testing) ──

export interface MACDResult {
  readonly macdLine: number;
  readonly signalLine: number;
  readonly histogram: number;
}

/**
 * MACD(12,26,9) を計算する。
 * macdLine = EMA(12) - EMA(26)
 * signalLine = EMA(9) of macdLine
 * histogram = macdLine - signalLine
 */
export function calculateMACD(candles: readonly OHLCV[]): MACDResult {
  const ema12 = calculateEMA(candles, 12);
  const ema26 = calculateEMA(candles, 26);

  // MACD line = EMA12 - EMA26
  const macdValues: number[] = [];
  for (let i = 0; i < candles.length; i++) {
    const e12 = ema12[i];
    const e26 = ema26[i];
    if (e12 === undefined || e26 === undefined || Number.isNaN(e12) || Number.isNaN(e26)) {
      macdValues.push(NaN);
    } else {
      macdValues.push(e12 - e26);
    }
  }

  // Signal line = EMA(9) of MACD values
  const signalPeriod = 9;
  const k = 2 / (signalPeriod + 1);
  const signalValues: number[] = new Array(macdValues.length).fill(NaN) as number[];

  // Find first valid MACD index
  let firstValid = -1;
  for (let i = 0; i < macdValues.length; i++) {
    if (!Number.isNaN(macdValues[i]!)) {
      if (firstValid === -1) firstValid = i;
    }
  }

  if (firstValid === -1 || firstValid + signalPeriod > macdValues.length) {
    return { macdLine: NaN, signalLine: NaN, histogram: NaN };
  }

  // Seed with SMA of first signalPeriod valid MACD values
  let sum = 0;
  for (let i = firstValid; i < firstValid + signalPeriod; i++) {
    sum += macdValues[i]!;
  }
  signalValues[firstValid + signalPeriod - 1] = sum / signalPeriod;

  for (let i = firstValid + signalPeriod; i < macdValues.length; i++) {
    const prev = signalValues[i - 1]!;
    const curr = macdValues[i]!;
    if (Number.isNaN(prev) || Number.isNaN(curr)) continue;
    signalValues[i] = curr * k + prev * (1 - k);
  }

  const lastMacd = macdValues[macdValues.length - 1] ?? NaN;
  const lastSignal = signalValues[signalValues.length - 1] ?? NaN;

  return {
    macdLine: lastMacd,
    signalLine: lastSignal,
    histogram: Number.isNaN(lastMacd) || Number.isNaN(lastSignal) ? NaN : lastMacd - lastSignal,
  };
}

// ── Crossover detection ──

/**
 * Build an EMASignal from the two most recent values of short and long EMA
 * series. A crossover means the short EMA was at-or-below the long on the
 * previous bar and is now above (and vice-versa for crossunder).
 */
export function detectSignal(
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
export function isVolumeConfirmed(candles: readonly OHLCV[]): boolean {
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
  checkStopLosses(): Promise<void>;
}

export function createMomentumBot(deps: {
  exchange: Exchange;
  gpt: GPTClient;
  logger: Logger;
  capitalUsd: number;
  repo: Repository;
  futuresExchange?: FuturesExchange;
  getDailyTrend?: (pair: TradingPair) => Promise<"buy" | "sell" | null>;
}): MomentumBot {
  const { exchange, gpt, logger, capitalUsd, repo, futuresExchange, getDailyTrend } = deps;
  const BOT_NAME = MOMENTUM_CONFIG.name;

  // Mutable internal position state (closure)
  const positions: Position[] = [];
  const tradeIds = new Map<TradingPair, string>();
  const lastAtr = new Map<TradingPair, number>();

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
    atr?: number,
  ): Promise<void> {
    // Stop-loss check
    if (shouldStopLoss(position, currentPrice, MOMENTUM_CONFIG.exitProfile, atr)) {
      logger.warn(BOT_NAME, `Stop-loss triggered for ${pair} (${position.side})`, {
        entryPrice: position.entryPrice,
        currentPrice,
      });
      await closePosition(pair, position, "stop-loss");
      return;
    }

    // 部分利確
    if (shouldPartialTakeProfit(position, currentPrice, MOMENTUM_CONFIG.exitProfile)) {
      const halfAmount = position.amount / 2;
      const client = getOrderClient(position.side, exchange, futuresExchange);
      const closeSide = position.side === "buy" ? "sell" as const : "buy" as const;
      try {
        const result = await client.createOrder({ pair, side: closeSide, amount: halfAmount });
        const partialPnl = calculatePnl({ side: position.side, entryPrice: position.entryPrice, exitPrice: result.price, amount: halfAmount });
        position.amount -= halfAmount;
        position.partialTaken = true;
        logger.info(BOT_NAME, `Partial take-profit on ${pair}: closed half at ${String(result.price)}, pnl: ${partialPnl.toFixed(2)}`, {
          remainingAmount: position.amount,
        });
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

    // ロング: EMAクロスアンダーで決済
    if (position.side === "buy" && signal.crossUnder) {
      logger.info(BOT_NAME, `EMA cross-under exit signal for ${pair} (long)`, {
        emaShort: signal.emaShort,
        emaLong: signal.emaLong,
      });
      await closePosition(pair, position, "cross-under");
    }

    // ショート: EMAクロスオーバーで決済
    if (position.side === "sell" && signal.crossOver) {
      logger.info(BOT_NAME, `EMA cross-over exit signal for ${pair} (short)`, {
        emaShort: signal.emaShort,
        emaLong: signal.emaLong,
      });
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
      logger.error(BOT_NAME, `Failed to close ${position.side} position on ${pair}`, {
        error: message,
      });
      return; // Keep position if the order failed
    }
    removePosition(pair);
  }

  // ── Entry logic ──

  /** 参考指標の必要通過数 */
  const REQUIRED_SUPPLEMENTARY = 2;

  type EntryDirection = "long" | "short";

  /**
   * 参考指標を評価する（ロング/ショート共通）。
   * MTF の比較方向のみ direction で分岐する。
   */
  async function evaluateSupplementary(
    pair: TradingPair,
    confirmedCandles: readonly OHLCV[],
    direction: EntryDirection,
  ): Promise<{ passed: boolean; passedCount: number; mtfScore: number }> {
    const supplementary: { name: string; passed: boolean }[] = [];

    // S1. 出来高加重分析（トレンド・パターンを加味したスコアリング）
    const volAnalysis = analyzeVolume(confirmedCandles, INDICATOR.VOLUME_LOOKBACK, INDICATOR.VOLUME_MULTIPLIER);
    // スコア 0.5 以上で通過（sustained + increasing = 1.0、spike のみ = 0.5）
    supplementary.push({ name: "volume_weighted", passed: volAnalysis.score >= 0.5 });
    logger.debug(BOT_NAME, `Volume analysis for ${pair}: score=${volAnalysis.score.toFixed(2)}, trend=${volAnalysis.trend}, pattern=${volAnalysis.pattern}`);

    // S2. ATRボラティリティ拡大
    supplementary.push({ name: "atr", passed: isVolatilityExpanding(confirmedCandles, INDICATOR.ATR_PERIOD) });

    // S3. マルチタイムフレーム一致度スコア（15m/1h/4h/日足の方向一致度）
    const targetSide = direction === "long" ? "buy" as const : "sell" as const;
    const mtfResult = await calculateMTFScore(exchange, pair, targetSide, logger);
    // スコア 0.75 以上（4時間足中3つ以上が同方向）で通過
    const mtfOk = mtfResult.score >= 0.75;
    supplementary.push({ name: "mtf_alignment", passed: mtfOk });

    // S4. マーケットレジーム判定（GPT分類 → ADXフォールバック）
    let regimeOk = false;
    try {
      const regimeResult = await gpt.classifyMarketRegime(pair, [...confirmedCandles]);
      regimeOk = regimeResult.regime === "TRENDING" && regimeResult.confidence >= 0.6;
      logger.debug(BOT_NAME, `GPT regime for ${pair}: ${regimeResult.regime} (confidence: ${regimeResult.confidence.toFixed(2)})`, {
        regime: regimeResult.regime,
        confidence: regimeResult.confidence,
        reasoning: regimeResult.reasoning,
      });
    } catch (err: unknown) {
      // GPT失敗時はADXフォールバック
      const message = err instanceof Error ? err.message : String(err);
      logger.warn(BOT_NAME, `GPT regime classification failed, falling back to ADX`, { error: message });
      const adx = calculateADX(confirmedCandles, INDICATOR.ADX_PERIOD);
      regimeOk = adx > INDICATOR.ADX_TREND_THRESHOLD;
    }
    supplementary.push({ name: "regime_trending", passed: regimeOk });

    const passedCount = supplementary.filter((s) => s.passed).length;
    const passedNames = supplementary.filter((s) => s.passed).map((s) => s.name);
    const failedNames = supplementary.filter((s) => !s.passed).map((s) => s.name);

    logger.info(BOT_NAME, `${direction} supplementary signals for ${pair}: ${String(passedCount)}/${String(supplementary.length)}`, {
      passed: passedNames,
      failed: failedNames,
    });

    return { passed: passedCount >= REQUIRED_SUPPLEMENTARY, passedCount, mtfScore: mtfResult.score };
  }

  /**
   * ロング/ショート共通エントリーロジック。
   * コア条件チェック → 参考指標評価 → 注文実行。
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

    // ショートは先物が必要
    if (!isLong && !futuresExchange) return;

    // コア条件1: EMAクロス（ロング: クロスオーバー / ショート: クロスアンダー）
    if (isLong ? !signal.crossOver : !signal.crossUnder) return;

    // コア条件2: MACDヒストグラム（ロング: > 0 / ショート: < 0）
    const macd = calculateMACD(confirmedCandles);
    if (Number.isNaN(macd.histogram)) return;
    if (isLong ? macd.histogram <= 0 : macd.histogram >= 0) {
      logger.debug(BOT_NAME, `MACD histogram not ${isLong ? "positive" : "negative"} for ${pair}, skipping ${direction}`, {
        histogram: macd.histogram,
      });
      return;
    }

    // コア条件3: ポジション制限
    if (!canOpenPosition(positions, BOT_NAME, allPositions, side)) {
      logger.info(BOT_NAME, `Position limit reached, skipping ${direction} on ${pair}`);
      return;
    }

    // 日足トレンドフィルター: 日足EMAに逆らう方向はスキップ
    if (getDailyTrend) {
      const allowed = await getDailyTrend(pair);
      if (allowed && allowed !== side) {
        logger.info(BOT_NAME, `Daily trend filter: ${direction} blocked on ${pair} (daily trend: ${allowed === "buy" ? "bullish" : "bearish"})`);
        return;
      }
    }

    // 参考指標評価
    const { passed, mtfScore } = await evaluateSupplementary(pair, confirmedCandles, direction);
    if (!passed) return;

    // 価格取得（ロング: ask / ショート: bid）
    const client = getOrderClient(side, exchange, futuresExchange);
    const ticker = await client.fetchTicker(pair);
    const entryPrice = isLong ? ticker.ask : ticker.bid;

    // MTFスコアに基づくポジションサイズ調整（全一致=100%, 3/4一致=70%）
    const mtfSizeMultiplier = mtfScore >= 1.0 ? 1.0 : 0.7;
    const amount = calculatePositionSize({
      capitalUsd,
      capitalRatio: MOMENTUM_CONFIG.capitalRatio * mtfSizeMultiplier,
      price: entryPrice,
    });

    if (amount <= 0) {
      logger.warn(BOT_NAME, `Calculated position size is 0 for ${direction} on ${pair}`);
      return;
    }

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
      logger.error(BOT_NAME, `Failed to open ${direction} position on ${pair}`, {
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

    // exchange.fetchOHLCV は未確定足を除外済みなのでそのまま使用
    const candles = rawCandles;

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

    // ATRを計算（トレーリングストップ用 + checkStopLossesキャッシュ）
    const atr = calculateATR(candles, INDICATOR.ATR_PERIOD);
    lastAtr.set(pair, atr);

    const existingPosition = findPosition(pair);

    if (existingPosition) {
      await tryExit(pair, existingPosition, signal, currentPrice, atr);
    } else {
      // ロングとショートの両方を試行（コア条件で片方のみ通過する）
      await tryDirectionalEntry(pair, signal, candles, allPositions, "long");
      await tryDirectionalEntry(pair, signal, candles, allPositions, "short");
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
          if (shouldStopLoss(position, ticker.last, MOMENTUM_CONFIG.exitProfile, atr)) {
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
