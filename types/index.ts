// ── 環境設定 ──

export interface EnvConfig {
  readonly kucoinApiKey: string;
  readonly kucoinApiSecret: string;
  readonly kucoinPassphrase: string;
  readonly openaiApiKey: string;
  readonly openaiModel: string;
  readonly databaseUrl: string;
  readonly dryRun: boolean;
  readonly env: "test" | "prod";
  readonly totalCapital: number;
  readonly futuresEnabled: boolean;
  readonly futuresLeverage: number;
}

// ── 取引ペア・時間軸 ──

export type TradingPair = "BTC/USDT" | "ETH/USDT" | "XRP/USDT" | "SOL/USDT";

export type Timeframe = "1m" | "5m" | "15m" | "1h" | "4h" | "1d";

// ── OHLCV ──

export interface OHLCV {
  readonly timestamp: number;
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
  readonly volume: number;
}

// ── 注文 ──

export type OrderSide = "buy" | "sell";

export interface OrderRequest {
  readonly pair: TradingPair;
  readonly side: OrderSide;
  readonly amount: number;
  readonly price?: number;
}

export interface OrderResult {
  readonly id: string;
  readonly pair: TradingPair;
  readonly side: OrderSide;
  readonly amount: number;
  readonly price: number;
  readonly timestamp: number;
}

// ── ポジション ──

export interface Position {
  readonly pair: TradingPair;
  readonly side: OrderSide;
  readonly entryPrice: number;
  readonly amount: number;
  readonly openedAt: number;
  /** トレーリングストップ用: ポジション保有中の最高/最低到達価格 */
  highWaterMark: number;
}

// ── ボット ──

export type BotName = "momentum" | "momentum-fast" | "range" | "sentiment";

export interface BotConfig {
  readonly name: BotName;
  readonly pairs: readonly TradingPair[];
  readonly timeframe: Timeframe;
  readonly capitalRatio: number;
}

// ── GPT 分析 ──

export type SentimentLevel = "BULLISH" | "NEUTRAL" | "BEARISH" | "HALT";

export interface SentimentResult {
  readonly level: SentimentLevel;
  readonly reasoning: string;
  readonly timestamp: number;
}

export type MarketRegime = "TRENDING" | "RANGING";

export interface MarketRegimeResult {
  readonly regime: MarketRegime;
  readonly confidence: number;
  readonly reasoning: string;
}

export interface NewsFilterResult {
  readonly safe: boolean;
  readonly reasoning: string;
}

// ── テクニカル指標 ──

export interface EMASignal {
  readonly emaShort: number;
  readonly emaLong: number;
  readonly crossOver: boolean;
  readonly crossUnder: boolean;
}

export interface BollingerBands {
  readonly upper: number;
  readonly middle: number;
  readonly lower: number;
}

// ── ログ ──

export type LogLevel = "info" | "warn" | "error" | "debug";

export interface LogEntry {
  readonly timestamp: string;
  readonly level: LogLevel;
  readonly bot: BotName | "system";
  readonly message: string;
  readonly data?: Record<string, unknown>;
}

// ── DB レコード ──

export interface TradeRecord {
  readonly id?: string;
  readonly bot_name: BotName;
  readonly symbol: TradingPair;
  readonly side: OrderSide;
  readonly amount: number;
  readonly entry_price: number;
  readonly exit_price?: number;
  readonly pnl?: number;
  readonly status: "open" | "closed";
  readonly created_at?: string;
  readonly closed_at?: string;
}

export interface SignalRecord {
  readonly bot_name: BotName;
  readonly symbol: TradingPair;
  readonly signal: string;
  readonly reasoning?: string;
}

export interface BotStatusRecord {
  readonly bot_name: BotName;
  readonly is_active: boolean;
  readonly is_halted: boolean;
  readonly last_run_at: string;
  readonly current_position: Position | null;
}

// ── Repository インターフェース（DI用） ──

export interface Repository {
  insertTrade(trade: TradeRecord): Promise<string>;
  closeTrade(id: string, exitPrice: number, pnl: number): Promise<void>;
  findOpenTrade(botName: BotName, symbol: TradingPair): Promise<TradeRecord | null>;
  findOpenTrades(botName: BotName): Promise<TradeRecord[]>;
  getRecentClosedPnls(botName: BotName, limit: number): Promise<number[]>;
  insertSignal(signal: SignalRecord): Promise<void>;
  updateBotStatus(status: BotStatusRecord): Promise<void>;
  getDailyPnl(): Promise<number>;
}

// ── Exchange インターフェース（DI用） ──

export interface Exchange {
  fetchOHLCV(pair: TradingPair, timeframe: Timeframe, limit: number): Promise<OHLCV[]>;
  fetchTicker(pair: TradingPair): Promise<{ bid: number; ask: number; last: number }>;
  fetchBalance(): Promise<{ free: Record<string, number>; total: Record<string, number> }>;
  createOrder(order: OrderRequest): Promise<OrderResult>;
  fetchOrder(orderId: string, pair: TradingPair): Promise<OrderResult>;
}

/** 先物取引用インターフェース（ショートポジション用） */
export interface FuturesExchange {
  createOrder(order: OrderRequest): Promise<OrderResult>;
  fetchTicker(pair: TradingPair): Promise<{ bid: number; ask: number; last: number }>;
}

/** ショート（sell）は先物、ロング（buy）はスポットに振り分ける */
export function getOrderClient(
  side: OrderSide,
  exchange: Exchange | FuturesExchange,
  futuresExchange?: FuturesExchange,
): Exchange | FuturesExchange {
  return side === "sell" && futuresExchange ? futuresExchange : exchange;
}

// ── GPT インターフェース（DI用） ──

export interface GPTClient {
  analyzeSentiment(pair: TradingPair, newsTexts: string[]): Promise<SentimentResult>;
  analyzeSentimentBatch(pairNewsMap: ReadonlyMap<TradingPair, string[]>): Promise<Map<TradingPair, SentimentResult>>;
  classifyMarketRegime(pair: TradingPair, candles: OHLCV[]): Promise<MarketRegimeResult>;
  filterNewsSignal(pair: TradingPair, signal: string, recentNews: string[]): Promise<NewsFilterResult>;
}

// ── Logger インターフェース（DI用） ──

export interface Logger {
  info(bot: BotName | "system", message: string, data?: Record<string, unknown>): void;
  warn(bot: BotName | "system", message: string, data?: Record<string, unknown>): void;
  error(bot: BotName | "system", message: string, data?: Record<string, unknown>): void;
  debug(bot: BotName | "system", message: string, data?: Record<string, unknown>): void;
}
