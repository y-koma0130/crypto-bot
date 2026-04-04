import dotenv from "dotenv";
import type { BotConfig, EnvConfig, ExitProfile } from "../types/index.js";

export function loadEnvConfig(): EnvConfig {
  const envFile = process.env["ENV_FILE"] ?? ".env.test";
  dotenv.config({ path: envFile });

  const kucoinApiKey = requireEnv("KUCOIN_API_KEY");
  const kucoinApiSecret = requireEnv("KUCOIN_API_SECRET");
  const kucoinPassphrase = requireEnv("KUCOIN_PASSPHRASE");
  const openaiApiKey = requireEnv("OPENAI_API_KEY");
  const openaiModel = process.env["OPENAI_MODEL"] ?? "gpt-4o-mini";
  const databaseUrl = requireEnv("DATABASE_URL");
  const dryRun = process.env["DRY_RUN"] !== "false";
  const env = process.env["ENV"] === "prod" ? "prod" as const : "test" as const;
  const totalCapital = Number(process.env["TOTAL_CAPITAL"] ?? "1000");
  const futuresEnabled = process.env["FUTURES_ENABLED"] === "true";
  const futuresLeverage = Number(process.env["FUTURES_LEVERAGE"] ?? "2");

  if (Number.isNaN(totalCapital) || totalCapital <= 0) {
    throw new Error("TOTAL_CAPITAL must be a positive number");
  }

  if (futuresEnabled && (Number.isNaN(futuresLeverage) || futuresLeverage < 1 || futuresLeverage > 20)) {
    throw new Error("FUTURES_LEVERAGE must be between 1 and 20");
  }

  return {
    kucoinApiKey,
    kucoinApiSecret,
    kucoinPassphrase,
    openaiApiKey,
    openaiModel,
    databaseUrl,
    dryRun,
    env,
    totalCapital,
    futuresEnabled,
    futuresLeverage,
  };
}

function requireEnv(key: string): string {
  const value = process.env[key];
  if (!value) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

// ── エグジットプロファイル（共通定義） ──

/** Momentum / Sentiment 共通: 大きなトレンドを追跡するプロファイル */
const TREND_EXIT_PROFILE: ExitProfile = {
  stopLossPct: -0.05,
  partialTakeProfitPct: 0.04,
  trailingSteps: [
    [0.08, 0.055],   // +8% → 損切り+5.5%
    [0.05, 0.03],    // +5% → 損切り+3%
    [0.03, 0.01],    // +3% → 損切り+1%
    [0.02, 0],        // +2% → 建値（ブレークイーブン）
  ],
  trailingPct: 0.03,  // +10%超は最高値から-3%で追跡
  timeStopMs: 0,
  timeStopMinProfitPct: 0,
};

// ── ボット設定 ──

export const MOMENTUM_CONFIG: BotConfig = {
  name: "momentum",
  pairs: ["BTC/USDT", "ETH/USDT"],
  timeframe: "1h",
  capitalRatio: 0.3,
  exitProfile: TREND_EXIT_PROFILE,
} as const;

export const MOMENTUM_FAST_CONFIG: BotConfig = {
  name: "momentum-fast",
  pairs: ["BTC/USDT", "ETH/USDT"],
  timeframe: "15m",
  capitalRatio: 0.1,
  exitProfile: {
    stopLossPct: -0.02,
    partialTakeProfitPct: 0.02,
    trailingSteps: [
      [0.03, 0.015],   // +3% → 損切り+1.5%
      [0.02, 0.005],   // +2% → 損切り+0.5%
      [0.015, 0],       // +1.5% → 建値
    ],
    trailingPct: 0.015, // 最高値から-1.5%で追跡
    timeStopMs: 4 * 60 * 60 * 1000,
    timeStopMinProfitPct: 0.01,
  },
} as const;

export const RANGE_CONFIG: BotConfig = {
  name: "range",
  pairs: ["XRP/USDT", "SOL/USDT"],
  timeframe: "15m",
  capitalRatio: 0.35,
  exitProfile: {
    stopLossPct: -0.02,
    partialTakeProfitPct: 0.015,
    trailingSteps: [
      [0.02, 0.01],    // +2% → 損切り+1%
      [0.015, 0.005],  // +1.5% → 損切り+0.5%
      [0.01, 0],        // +1% → 建値
    ],
    trailingPct: 0.01,  // 最高値から-1%で追跡
    timeStopMs: 0,
    timeStopMinProfitPct: 0,
  },
} as const;

export const POLYMARKET_BOT_CONFIG: BotConfig = {
  name: "polymarket",
  pairs: ["BTC/USDT", "ETH/USDT", "XRP/USDT", "SOL/USDT"],
  timeframe: "15m",
  capitalRatio: 0.05,
  exitProfile: {
    stopLossPct: -0.02,
    partialTakeProfitPct: 0.03,
    trailingSteps: [
      [0.05, 0.03],    // +5% → 損切り+3%
      [0.03, 0.015],   // +3% → 損切り+1.5%
      [0.02, 0],        // +2% → 建値
    ],
    trailingPct: 0.02,  // 最高値から-2%で追跡
    timeStopMs: 0,
    timeStopMinProfitPct: 0,
  },
} as const;

export const SENTIMENT_CONFIG: BotConfig = {
  name: "sentiment",
  pairs: ["BTC/USDT", "ETH/USDT", "XRP/USDT", "SOL/USDT"],
  timeframe: "1h",
  capitalRatio: 0.2,
  exitProfile: TREND_EXIT_PROFILE,
} as const;

// ── リスク管理定数 ──

export const RISK = {
  /** 各ボット最大同時ポジション数 */
  MAX_POSITIONS_PER_BOT: 1,
  /** ボット合計最大同時ポジション数 */
  MAX_TOTAL_POSITIONS: 5,
  /** 日次損失上限（-10%） */
  DAILY_LOSS_LIMIT_PCT: -0.10,
  /** KuCoin取引手数料（0.1%） */
  TRADING_FEE_PCT: 0.001,
  /** スリッページ許容（0.5%） */
  SLIPPAGE_TOLERANCE_PCT: 0.005,
  /** ATR フィルター: ATRが平均の何倍以上でトレンドとみなすか */
  ATR_TREND_MULTIPLIER: 1.1,
  /** 1トレードあたりのリスク = 資本の1% */
  RISK_PER_TRADE_PCT: 0.01,
  /** 同方向ポジション上限 */
  MAX_SAME_DIRECTION: 3,
  /** 日足トレンドフィルター用EMA期間 */
  DAILY_TREND_EMA_PERIOD: 20,
  /** 連敗制御: この回数連続で負けたら次のtickをスキップ */
  MAX_CONSECUTIVE_LOSSES: 3,
  /** 相関フィルター: BTCの直近1h変動がこれ以下ならアルトのロングをブロック */
  BTC_CRASH_THRESHOLD_PCT: -0.02,
} as const;

// ── テクニカル指標パラメータ ──

export const INDICATOR = {
  EMA_SHORT_PERIOD: 20,
  EMA_LONG_PERIOD: 50,
  VOLUME_MULTIPLIER: 1.2,
  VOLUME_LOOKBACK: 20,
  RSI_PERIOD: 14,
  RSI_OVERSOLD: 30,
  RSI_OVERBOUGHT: 70,
  RSI_NEUTRAL: 50,
  BB_PERIOD: 20,
  BB_STD_DEV: 2,
  ATR_PERIOD: 14,
  /** BB幅がこれ以上ならトレンド中とみなしスキップ（6%） */
  BB_SQUEEZE_THRESHOLD: 0.06,
  /** ADX計算期間 */
  ADX_PERIOD: 14,
  /** ADXがこれ以上ならトレンド相場 */
  ADX_TREND_THRESHOLD: 25,
  /** 短期モメンタム用 EMA */
  FAST_EMA_SHORT_PERIOD: 9,
  FAST_EMA_LONG_PERIOD: 21,
} as const;
