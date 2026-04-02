import type { BotName, OHLCV, OrderSide, Position } from "../types/index.js";
import { RISK } from "../config/settings.js";
import { calculateEMA } from "./indicators.js";

/**
 * ポジションサイズを計算する。
 * 利用可能資金 × 資金比率 ÷ 現在価格 で数量を算出。
 */
export function calculatePositionSize(params: {
  capitalUsd: number;
  capitalRatio: number;
  price: number;
  stopDistance?: number;
}): number {
  const { capitalUsd, capitalRatio, price, stopDistance } = params;

  if (capitalUsd <= 0 || capitalRatio <= 0 || price <= 0) {
    return 0;
  }

  if (stopDistance && stopDistance > 0) {
    // リスクベース: 1トレードあたりのリスク額 / ストップまでの距離
    const riskPerTrade = capitalUsd * RISK.RISK_PER_TRADE_PCT;
    return riskPerTrade / stopDistance;
  }

  // フォールバック: 従来の固定比率
  return (capitalUsd * capitalRatio) / price;
}

/**
 * トレーリングストップを考慮した損切り判定。
 *
 * 1. highWaterMark を更新（buy: 最高値、sell: 最安値）
 * 2. 含み益が TRAILING_BREAKEVEN_PCT 以上 → 損切りラインを建値に引き上げ
 * 3. 含み益が TRAILING_LOCK_PCT 以上 → 損切りラインを建値+TRAILING_LOCK_STOP_PCT に引き上げ
 * 4. 引き上げ後の損切りラインと固定損切り(-5%)のうち、有利な方で判定
 */
export function shouldStopLoss(
  position: Position,
  currentPrice: number,
  atr?: number,
  stopLossPct?: number,
): boolean {
  const { entryPrice, side } = position;

  // highWaterMark を更新（mutable: Position.highWaterMark は書き換え可能）
  if (side === "buy") {
    if (currentPrice > position.highWaterMark) {
      position.highWaterMark = currentPrice;
    }
  } else {
    if (currentPrice < position.highWaterMark) {
      position.highWaterMark = currentPrice;
    }
  }

  // 含み益率を計算
  const unrealizedPct = side === "buy"
    ? (position.highWaterMark - entryPrice) / entryPrice
    : (entryPrice - position.highWaterMark) / entryPrice;

  // トレーリングストップの損切りラインを決定
  let stopPrice: number;

  if (atr && atr > 0) {
    // ATRベース: 最高値/最安値から2×ATR
    const atrMultiplier = 2;
    stopPrice = side === "buy"
      ? position.highWaterMark - atr * atrMultiplier
      : position.highWaterMark + atr * atrMultiplier;
    // 建値以下にはしない（最低でもブレークイーブン保護）
    if (unrealizedPct >= RISK.TRAILING_BREAKEVEN_PCT) {
      const breakevenPrice = side === "buy"
        ? entryPrice * (1 + RISK.TRADING_FEE_PCT * 2)
        : entryPrice * (1 - RISK.TRADING_FEE_PCT * 2);
      stopPrice = side === "buy"
        ? Math.max(stopPrice, breakevenPrice)
        : Math.min(stopPrice, breakevenPrice);
    }
  } else {
    // フォールバック: 固定パーセンテージ
    if (unrealizedPct >= RISK.TRAILING_LOCK_PCT) {
      stopPrice = side === "buy"
        ? entryPrice * (1 + RISK.TRAILING_LOCK_STOP_PCT)
        : entryPrice * (1 - RISK.TRAILING_LOCK_STOP_PCT);
    } else if (unrealizedPct >= RISK.TRAILING_BREAKEVEN_PCT) {
      stopPrice = entryPrice;
    } else {
      const sl = stopLossPct ?? RISK.STOP_LOSS_PCT;
      stopPrice = side === "buy"
        ? entryPrice * (1 + sl)
        : entryPrice * (1 - sl);
    }
  }

  // 現在価格が損切りラインを割ったか判定
  return side === "buy" ? currentPrice <= stopPrice : currentPrice >= stopPrice;
}

/**
 * ATR (Average True Range) を計算する。
 * ボラティリティの指標として、トレンド発生の判定に使用。
 */
export function calculateATR(candles: readonly OHLCV[], period: number): number {
  if (candles.length < period + 1) return 0;

  const trueRanges: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const curr = candles[i]!;
    const prev = candles[i - 1]!;
    const tr = Math.max(
      curr.high - curr.low,
      Math.abs(curr.high - prev.close),
      Math.abs(curr.low - prev.close),
    );
    trueRanges.push(tr);
  }

  // 最初のATRはSMAで算出
  let atr = 0;
  for (let i = 0; i < period; i++) {
    atr += trueRanges[i]!;
  }
  atr /= period;

  // 以降はWilder's smoothing
  for (let i = period; i < trueRanges.length; i++) {
    atr = (atr * (period - 1) + trueRanges[i]!) / period;
  }

  return atr;
}

/**
 * ATR が直近平均に比べて十分高いか判定する。
 * 高い → ボラティリティ拡大 → トレンド発生の可能性。
 */
export function isVolatilityExpanding(candles: readonly OHLCV[], period: number): boolean {
  if (candles.length < period * 2 + 1) return false;

  const recentCandles = candles.slice(-period - 1);
  const olderCandles = candles.slice(-(period * 2 + 1), -period);

  const recentATR = calculateATR(recentCandles, period);
  const olderATR = calculateATR(olderCandles, period);

  if (olderATR <= 0) return false;
  return recentATR / olderATR >= RISK.ATR_TREND_MULTIPLIER;
}

/**
 * 新規ポジションを開けるか判定する。
 * - 当該ボットのポジション数が MAX_POSITIONS_PER_BOT 未満
 * - 全ボット合計のポジション数が MAX_TOTAL_POSITIONS 未満
 */
export function canOpenPosition(
  currentPositions: readonly Position[],
  botName: BotName,
  allPositions: readonly Position[],
  side?: "buy" | "sell",
): boolean {
  if (currentPositions.length >= RISK.MAX_POSITIONS_PER_BOT) {
    return false;
  }

  if (allPositions.length >= RISK.MAX_TOTAL_POSITIONS) {
    return false;
  }

  // 相関リスク: 同方向のポジションが2つ以上あれば新規エントリーをブロック
  if (side) {
    const sameSideCount = allPositions.filter((p) => p.side === side).length;
    if (sameSideCount >= RISK.MAX_SAME_DIRECTION) {
      return false;
    }
  }

  return true;
}

/**
 * 日次損失上限に達しているか判定する。
 * 当日の累計損益が DAILY_LOSS_LIMIT_PCT 以下ならサーキットブレーカー発動。
 */
export function isDailyLossLimitReached(
  dailyPnl: number,
  totalCapital: number,
): boolean {
  if (totalCapital <= 0) return true;
  const dailyPnlPct = dailyPnl / totalCapital;
  return dailyPnlPct <= RISK.DAILY_LOSS_LIMIT_PCT;
}

/**
 * 手数料を考慮した損益を計算する。
 * エントリー・エグジット両方の取引手数料を差し引く。
 */
export function calculatePnl(params: {
  side: "buy" | "sell";
  entryPrice: number;
  exitPrice: number;
  amount: number;
}): number {
  const { side, entryPrice, exitPrice, amount } = params;
  const rawPnl = side === "buy"
    ? (exitPrice - entryPrice) * amount
    : (entryPrice - exitPrice) * amount;

  // Subtract entry and exit fees
  const entryFee = entryPrice * amount * RISK.TRADING_FEE_PCT;
  const exitFee = exitPrice * amount * RISK.TRADING_FEE_PCT;

  return rawPnl - entryFee - exitFee;
}

/**
 * 日足EMAに基づいて許可されるトレード方向を判定する。
 * 価格がEMA上 → ロングのみ許可、EMA下 → ショートのみ許可。
 */
export function getAllowedSide(
  dailyCandles: readonly OHLCV[],
  emaPeriod: number,
): OrderSide | null {
  if (dailyCandles.length < emaPeriod) return null;

  const ema = calculateEMA(dailyCandles, emaPeriod);
  const lastEma = ema[ema.length - 1];
  if (lastEma === undefined || Number.isNaN(lastEma)) return null;

  const lastClose = dailyCandles[dailyCandles.length - 1]!.close;
  return lastClose >= lastEma ? "buy" : "sell";
}

/**
 * 連敗制御: 直近のクローズ済みトレードから連敗数をカウントする。
 */
export function countConsecutiveLosses(recentPnls: readonly number[]): number {
  let count = 0;
  for (let i = recentPnls.length - 1; i >= 0; i--) {
    if (recentPnls[i]! < 0) {
      count++;
    } else {
      break;
    }
  }
  return count;
}
