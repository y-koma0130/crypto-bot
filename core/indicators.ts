import type { OHLCV } from "../types/index.js";

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

  for (let i = 0; i < Math.min(period - 1, candles.length); i++) {
    ema[i] = NaN;
  }

  if (candles.length < period) return ema;

  let sum = 0;
  for (let i = 0; i < period; i++) {
    const candle = candles[i];
    if (candle === undefined) return ema;
    sum += candle.close;
  }
  ema[period - 1] = sum / period;

  for (let i = period; i < candles.length; i++) {
    const candle = candles[i];
    const prev = ema[i - 1];
    if (candle === undefined || prev === undefined) break;
    ema[i] = candle.close * k + prev * (1 - k);
  }

  return ema;
}
