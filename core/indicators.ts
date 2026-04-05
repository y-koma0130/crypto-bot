import type { Exchange, GPTClient, MarketRegime, OHLCV, TradingPair, Timeframe, Logger } from "../types/index.js";
import { INDICATOR } from "../config/settings.js";

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

// ── マルチタイムフレーム（MTF）一致度スコアリング ──

/** MTF分析で使用する時間足と対応するEMA期間の設定 */
export const MTF_TIMEFRAMES: readonly { timeframe: Timeframe; emaPeriod: number; candleLimit: number }[] = [
  { timeframe: "15m", emaPeriod: 20, candleLimit: 25 },
  { timeframe: "1h",  emaPeriod: 20, candleLimit: 25 },
  { timeframe: "4h",  emaPeriod: 50, candleLimit: 55 },
  { timeframe: "1d",  emaPeriod: 20, candleLimit: 25 },
];

export interface MTFScoreResult {
  /** 一致度スコア: 0.0 〜 1.0 (同方向の時間足数 / 全時間足数) */
  readonly score: number;
  /** 各時間足の方向 ("buy" | "sell" | null) */
  readonly details: readonly { timeframe: Timeframe; direction: "buy" | "sell" | null }[];
}

/**
 * マルチタイムフレーム一致度スコアを計算する。
 * 各時間足で「価格 vs EMA」を判定し、targetDirection と一致する割合を返す。
 *
 * score 1.0 = 全時間足が同方向、score 0.5 = 半分一致、score 0.0 = 全て逆方向
 */
export async function calculateMTFScore(
  exchange: Exchange,
  pair: TradingPair,
  targetDirection: "buy" | "sell",
  logger: Logger,
  preloadedCandles?: ReadonlyMap<Timeframe, readonly OHLCV[]>,
): Promise<MTFScoreResult> {
  const details: { timeframe: Timeframe; direction: "buy" | "sell" | null }[] = [];

  await Promise.all(
    MTF_TIMEFRAMES.map(async ({ timeframe, emaPeriod, candleLimit }) => {
      try {
        const candles = preloadedCandles?.get(timeframe)
          ?? await exchange.fetchOHLCV(pair, timeframe, candleLimit);
        if (candles.length < emaPeriod) {
          details.push({ timeframe, direction: null });
          return;
        }
        const ema = calculateEMA(candles, emaPeriod);
        const lastEma = ema[ema.length - 1];
        const lastClose = candles[candles.length - 1]?.close;
        if (lastEma === undefined || Number.isNaN(lastEma) || lastClose === undefined) {
          details.push({ timeframe, direction: null });
          return;
        }
        details.push({ timeframe, direction: lastClose >= lastEma ? "buy" : "sell" });
      } catch {
        details.push({ timeframe, direction: null });
      }
    }),
  );

  const validDetails = details.filter((d) => d.direction !== null);
  if (validDetails.length === 0) {
    return { score: 0.5, details };
  }

  const alignedCount = validDetails.filter((d) => d.direction === targetDirection).length;
  const score = alignedCount / validDetails.length;

  logger.debug("system", `MTF score for ${pair} (${targetDirection}): ${score.toFixed(2)}`, {
    aligned: alignedCount,
    total: validDetails.length,
    details: details.map((d) => `${d.timeframe}:${d.direction ?? "N/A"}`),
  });

  return { score, details };
}

// ── ボリューム加重分析 ──

export interface VolumeAnalysis {
  /** 直近出来高が平均を上回っているか（従来の二値判定） */
  readonly aboveAverage: boolean;
  /** 直近N本の出来高トレンド: "increasing" | "decreasing" | "flat" */
  readonly trend: "increasing" | "decreasing" | "flat";
  /** 突発スパイクか持続的増加か: "spike" | "sustained" | "none" */
  readonly pattern: "spike" | "sustained" | "none";
  /** 総合スコア: 0.0 〜 1.0（高い = エントリー信頼度が高い） */
  readonly score: number;
}

/**
 * ボリューム加重分析を実行する。
 * 単純な「平均超え」に加え、トレンドとパターンを総合判断してスコア化。
 *
 * - increasing + sustained = 最高スコア（機関投資家の参入パターン）
 * - spike のみ = 中スコア（ニュース等の一時的反応、ダマシの可能性）
 * - decreasing = 低スコア（勢い減退）
 */
export function analyzeVolume(
  candles: readonly OHLCV[],
  lookback: number,
  multiplier: number,
): VolumeAnalysis {
  if (candles.length < lookback + 1) {
    return { aboveAverage: false, trend: "flat", pattern: "none", score: 0 };
  }

  const latest = candles[candles.length - 1]!;
  const volumeWindow = candles.slice(candles.length - 1 - lookback, candles.length - 1);

  // 平均出来高
  let volSum = 0;
  for (const c of volumeWindow) volSum += c.volume;
  const avgVolume = volSum / lookback;

  const aboveAverage = latest.volume >= avgVolume * multiplier;

  // 出来高トレンド: 直近5本を前半/後半で比較
  const trendWindow = Math.min(5, volumeWindow.length);
  const recentVols = candles.slice(candles.length - trendWindow).map((c) => c.volume);
  const mid = Math.floor(recentVols.length / 2);
  const firstHalfAvg = recentVols.length > 0 && mid > 0
    ? recentVols.slice(0, mid).reduce((a, b) => a + b, 0) / mid
    : 0;
  const secondHalfAvg = recentVols.length > mid
    ? recentVols.slice(mid).reduce((a, b) => a + b, 0) / (recentVols.length - mid)
    : 0;

  let trend: VolumeAnalysis["trend"];
  if (firstHalfAvg > 0 && secondHalfAvg / firstHalfAvg >= 1.15) {
    trend = "increasing";
  } else if (firstHalfAvg > 0 && secondHalfAvg / firstHalfAvg <= 0.85) {
    trend = "decreasing";
  } else {
    trend = "flat";
  }

  // スパイク判定: 最新1本が平均の2倍以上 かつ 直前1本は平均以下 → spike
  // 持続的増加: 直近3本全てが平均を上回る → sustained
  let pattern: VolumeAnalysis["pattern"] = "none";
  if (aboveAverage) {
    const prevCandle = candles[candles.length - 2];
    if (latest.volume >= avgVolume * 2.0 && prevCandle && prevCandle.volume < avgVolume) {
      pattern = "spike";
    } else {
      // 直近3本全てが平均以上か確認
      const last3 = candles.slice(Math.max(0, candles.length - 3));
      const allAbove = last3.every((c) => c.volume >= avgVolume);
      if (allAbove && last3.length >= 3) {
        pattern = "sustained";
      } else if (aboveAverage) {
        pattern = "spike"; // 平均超えだが持続していない → スパイク扱い
      }
    }
  }

  // スコアリング
  let score = 0;

  // ベーススコア: 平均超えなら0.3
  if (aboveAverage) score += 0.3;

  // トレンドボーナス: increasing +0.3, flat +0.1, decreasing +0
  if (trend === "increasing") score += 0.3;
  else if (trend === "flat") score += 0.1;

  // パターンボーナス: sustained +0.4, spike +0.2, none +0
  if (pattern === "sustained") score += 0.4;
  else if (pattern === "spike") score += 0.2;

  return { aboveAverage, trend, pattern, score: Math.min(1, score) };
}

// ── GPTマーケットレジーム分類（共通ヘルパー） ──

/**
 * GPTでマーケットレジームを分類し、期待レジームと一致するか判定する。
 * GPT失敗時は adxFallbackValue を使ってADXベースの判定にフォールバック。
 */
export async function checkMarketRegime(
  gpt: GPTClient,
  pair: TradingPair,
  candles: readonly OHLCV[],
  expectedRegime: MarketRegime,
  adxValue: number,
  logger: Logger,
): Promise<boolean> {
  try {
    const result = await gpt.classifyMarketRegime(pair, [...candles]);
    logger.debug("system", `GPT regime for ${pair}: ${result.regime} (confidence: ${result.confidence.toFixed(2)})`, {
      regime: result.regime,
      confidence: result.confidence,
      reasoning: result.reasoning,
    });
    return result.regime === expectedRegime && result.confidence >= INDICATOR.GPT_REGIME_CONFIDENCE_THRESHOLD;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn("system", `GPT regime classification failed, falling back to ADX`, { error: message });
    return expectedRegime === "TRENDING"
      ? adxValue > INDICATOR.ADX_TREND_THRESHOLD
      : adxValue <= INDICATOR.ADX_TREND_THRESHOLD;
  }
}
