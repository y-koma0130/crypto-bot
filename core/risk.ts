import type { BotName, ExitProfile, OHLCV, OrderSide, Position } from "../types/index.js";
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
 * ExitProfile ベースの段階的トレーリングストップ判定。
 *
 * 1. highWaterMark を更新
 * 2. trailingSteps を含み益が大きい順に評価し、最初にマッチした段階の損切りラインを適用
 * 3. trailingSteps の最大閾値を超えた場合は highWaterMark - trailingPct で追跡
 * 4. ATR が提供されている場合、ATRベースの損切りラインも計算し有利な方を採用
 */
export function shouldStopLoss(
  position: Position,
  currentPrice: number,
  exitProfile: ExitProfile,
  atr?: number,
): boolean {
  const { entryPrice, side } = position;

  // highWaterMark を更新
  if (side === "buy") {
    if (currentPrice > position.highWaterMark) position.highWaterMark = currentPrice;
  } else {
    if (currentPrice < position.highWaterMark) position.highWaterMark = currentPrice;
  }

  // 最高値/最安値からの含み益率
  const peakPct = side === "buy"
    ? (position.highWaterMark - entryPrice) / entryPrice
    : (entryPrice - position.highWaterMark) / entryPrice;

  let stopPrice: number;

  // 閾値の大きい順にソート（設定ミス防御）
  const steps = exitProfile.trailingSteps.length > 1
    ? [...exitProfile.trailingSteps].sort((a, b) => b[0] - a[0])
    : exitProfile.trailingSteps;

  const maxStep = steps.length > 0 ? steps[0]![0] : Infinity;

  if (peakPct > maxStep && exitProfile.trailingPct > 0) {
    // 最高値から trailingPct で追跡
    stopPrice = side === "buy"
      ? position.highWaterMark * (1 - exitProfile.trailingPct)
      : position.highWaterMark * (1 + exitProfile.trailingPct);
  } else {
    // 段階的トレーリング: 含み益が大きい順に評価
    let matched = false;
    stopPrice = side === "buy"
      ? entryPrice * (1 + exitProfile.stopLossPct)
      : entryPrice * (1 - exitProfile.stopLossPct);

    for (const [threshold, lockPct] of steps) {
      if (peakPct >= threshold) {
        stopPrice = side === "buy"
          ? entryPrice * (1 + lockPct)
          : entryPrice * (1 - lockPct);
        matched = true;
        break;
      }
    }

    // ATRベースの損切りも考慮（有利な方を採用）
    if (atr && atr > 0 && matched) {
      const atrStop = side === "buy"
        ? position.highWaterMark - atr * 2
        : position.highWaterMark + atr * 2;
      // ATRの方が有利（損切りラインが高い/低い）なら採用
      stopPrice = side === "buy"
        ? Math.max(stopPrice, atrStop)
        : Math.min(stopPrice, atrStop);
    }
  }

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
 * 部分利確が必要か判定する。
 * ExitProfile の partialTakeProfitPct 以上で、まだ部分利確していなければ true。
 */
export function shouldPartialTakeProfit(
  position: Position,
  currentPrice: number,
  exitProfile: ExitProfile,
): boolean {
  if (position.partialTaken) return false;

  const unrealizedPct = position.side === "buy"
    ? (currentPrice - position.entryPrice) / position.entryPrice
    : (position.entryPrice - currentPrice) / position.entryPrice;

  return unrealizedPct >= exitProfile.partialTakeProfitPct;
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
