import type { BotName, Position } from "../types/index.js";
import { RISK } from "../config/settings.js";

/**
 * ポジションサイズを計算する。
 * 利用可能資金 × 資金比率 ÷ 現在価格 で数量を算出。
 */
export function calculatePositionSize(params: {
  capitalUsd: number;
  capitalRatio: number;
  price: number;
}): number {
  const { capitalUsd, capitalRatio, price } = params;

  if (capitalUsd <= 0 || capitalRatio <= 0 || price <= 0) {
    return 0;
  }

  return (capitalUsd * capitalRatio) / price;
}

/**
 * 損切りラインに達しているか判定する。
 * buy ポジション: 価格が entryPrice から STOP_LOSS_PCT 以上下落したら true
 * sell ポジション: 価格が entryPrice から STOP_LOSS_PCT 以上上昇したら true
 */
export function shouldStopLoss(
  position: Position,
  currentPrice: number,
): boolean {
  if (position.side === "buy") {
    const pctChange =
      (currentPrice - position.entryPrice) / position.entryPrice;
    return pctChange < RISK.STOP_LOSS_PCT;
  }

  // sell ポジション: 価格上昇が損失
  const pctChange =
    (position.entryPrice - currentPrice) / position.entryPrice;
  return pctChange < RISK.STOP_LOSS_PCT;
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
): boolean {
  if (currentPositions.length >= RISK.MAX_POSITIONS_PER_BOT) {
    return false;
  }

  if (allPositions.length >= RISK.MAX_TOTAL_POSITIONS) {
    return false;
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
