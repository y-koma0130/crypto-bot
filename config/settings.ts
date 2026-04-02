import dotenv from "dotenv";
import type { BotConfig, EnvConfig } from "../types/index.js";

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

// ── ボット設定 ──

export const MOMENTUM_CONFIG: BotConfig = {
  name: "momentum",
  pairs: ["BTC/USDT", "ETH/USDT"],
  timeframe: "1h",
  capitalRatio: 0.3,
} as const;

export const MOMENTUM_FAST_CONFIG: BotConfig = {
  name: "momentum-fast",
  pairs: ["BTC/USDT", "ETH/USDT"],
  timeframe: "15m",
  capitalRatio: 0.1,
} as const;

export const RANGE_CONFIG: BotConfig = {
  name: "range",
  pairs: ["XRP/USDT", "SOL/USDT"],
  timeframe: "15m",
  capitalRatio: 0.35,
} as const;

export const SENTIMENT_CONFIG: BotConfig = {
  name: "sentiment",
  pairs: ["BTC/USDT", "ETH/USDT", "XRP/USDT", "SOL/USDT"],
  timeframe: "1h",
  capitalRatio: 0.25,
} as const;

// ── リスク管理定数 ──

export const RISK = {
  /** 損切りライン（-5%） */
  STOP_LOSS_PCT: -0.05,
  /** 各ボット最大同時ポジション数 */
  MAX_POSITIONS_PER_BOT: 1,
  /** ボット合計最大同時ポジション数 */
  MAX_TOTAL_POSITIONS: 4,
  /** 日次損失上限（-10%） */
  DAILY_LOSS_LIMIT_PCT: -0.10,
  /** KuCoin取引手数料（0.1%） */
  TRADING_FEE_PCT: 0.001,
  /** スリッページ許容（0.5%） */
  SLIPPAGE_TOLERANCE_PCT: 0.005,
  /** トレーリングストップ: 損切りラインを建値に移動する閾値 */
  TRAILING_BREAKEVEN_PCT: 0.03,
  /** トレーリングストップ: 損切りラインを引き上げる閾値 */
  TRAILING_LOCK_PCT: 0.05,
  /** トレーリングストップ: 引き上げ後の損切りライン（建値からの%） */
  TRAILING_LOCK_STOP_PCT: 0.02,
  /** ATR フィルター: ATRが平均の何倍以上でトレンドとみなすか */
  ATR_TREND_MULTIPLIER: 1.1,
  /** 1トレードあたりのリスク = 資本の1% */
  RISK_PER_TRADE_PCT: 0.01,
  /** 同方向ポジション上限 */
  MAX_SAME_DIRECTION: 2,
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
