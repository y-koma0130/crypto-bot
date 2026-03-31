import ccxt, { type Order, type Ticker } from "ccxt";
import { RISK } from "../config/settings.js";
import type {
  EnvConfig,
  Exchange,
  FuturesExchange,
  Logger,
  OHLCV,
  OrderRequest,
  OrderResult,
  OrderSide,
  Timeframe,
  TradingPair,
} from "../types/index.js";

/**
 * 指数バックオフ付きリトライユーティリティ。
 * 初回 1s → 2s → 4s（最大 10s）で再試行する。
 */
async function withRetry<T>(
  fn: () => Promise<T>,
  logger: Logger,
  label: string,
  maxRetries = 3,
): Promise<T> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      if (attempt === maxRetries) {
        logger.error("system", `${label} failed after ${maxRetries} attempts`, { error: message });
        throw err;
      }
      const delayMs = Math.min(1000 * 2 ** (attempt - 1), 10000);
      logger.warn("system", `${label} failed (attempt ${attempt}/${maxRetries}), retrying in ${delayMs}ms`, { error: message });
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw new Error("Unreachable");
}

/**
 * ccxt OHLCV の生配列（[timestamp, open, high, low, close, volume]）を
 * OHLCV 型に変換する。
 */
function toOHLCV(raw: [number, number, number, number, number, number]): OHLCV {
  return {
    timestamp: raw[0],
    open: raw[1],
    high: raw[2],
    low: raw[3],
    close: raw[4],
    volume: raw[5],
  };
}

/**
 * DRY_RUN 用のモック OrderResult を生成する。
 */
function mockOrderResult(order: OrderRequest, lastPrice: number): OrderResult {
  return {
    id: `dry-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    pair: order.pair,
    side: order.side,
    amount: order.amount,
    price: order.price ?? lastPrice,
    timestamp: Date.now(),
  };
}

// ── 共通注文実行ロジック ──

/** ccxt クライアントの注文関連メソッド */
interface CcxtOrderClient {
  fetchTicker(symbol: string): Promise<Ticker>;
  fetchOrder(id: string, symbol?: string): Promise<Order>;
  createOrder(symbol: string, type: string, side: string, amount: number, price?: number): Promise<Order>;
}

/** 注文の約定を待つ（最大30秒、指数バックオフでポーリング） */
async function waitForFill(
  client: CcxtOrderClient,
  orderId: string,
  symbol: string,
  logger: Logger,
  label: string,
): Promise<Order> {
  const MAX_WAIT_MS = 30_000;
  const start = Date.now();
  let interval = 2_000;

  while (Date.now() - start < MAX_WAIT_MS) {
    const order = await withRetry(
      () => client.fetchOrder(orderId, symbol),
      logger,
      `${label}.fetchOrder(${orderId})`,
    );

    if (order.status === "closed" || order.status === "canceled" || order.status === "cancelled") {
      return order;
    }

    await new Promise((resolve) => setTimeout(resolve, interval));
    interval = Math.min(interval * 2, 10_000);
  }

  return await withRetry(
    () => client.fetchOrder(orderId, symbol),
    logger,
    `${label}.fetchOrder(${orderId})`,
  );
}

/**
 * スリッページ保護付き注文実行。DRY_RUN対応。
 * スポット・先物の共通ロジック。
 */
async function executeOrder(params: {
  client: CcxtOrderClient;
  order: OrderRequest;
  symbol: string;
  config: EnvConfig;
  logger: Logger;
  label: string;
  extraLogData?: Record<string, unknown>;
  preExecute?: () => Promise<void>;
}): Promise<OrderResult> {
  const { client, order, symbol, config, logger, label, extraLogData, preExecute } = params;

  if (preExecute) {
    await preExecute();
  }

  if (config.dryRun) {
    const ticker = await withRetry(
      () => client.fetchTicker(symbol),
      logger,
      `${label}.fetchTicker(${symbol})`,
    );
    const lastPrice = ticker.last ?? 0;
    const result = mockOrderResult(order, lastPrice);

    logger.info("system", `[DRY_RUN] ${label} order would be placed`, {
      pair: order.pair,
      side: order.side,
      amount: order.amount,
      price: result.price,
      ...extraLogData,
    });

    return result;
  }

  // スリッページ保護: 成行注文の代わりに許容幅付き指値注文
  let orderPrice = order.price;
  let type: "limit" | "market" = order.price != null ? "limit" : "market";

  if (type === "market") {
    const ticker = await withRetry(
      () => client.fetchTicker(symbol),
      logger,
      `${label}.fetchTicker(${symbol})`,
    );
    const slippage = RISK.SLIPPAGE_TOLERANCE_PCT;
    if (order.side === "buy") {
      orderPrice = (ticker.ask ?? 0) * (1 + slippage);
    } else {
      orderPrice = (ticker.bid ?? 0) * (1 - slippage);
    }
    type = "limit";
  }

  const ccxtOrder = await withRetry(
    () => client.createOrder(symbol, type, order.side, order.amount, orderPrice),
    logger,
    `${label}.createOrder(${symbol})`,
  );

  const filledOrder = ccxtOrder.status === "closed"
    ? ccxtOrder
    : await waitForFill(client, ccxtOrder.id, symbol, logger, label);

  if (filledOrder.status === "canceled" || filledOrder.status === "cancelled") {
    logger.warn("system", `${label} order cancelled: ${filledOrder.id}`, { pair: order.pair });
    throw new Error(`${label} order ${filledOrder.id} was cancelled`);
  }

  const result: OrderResult = {
    id: filledOrder.id,
    pair: order.pair,
    side: order.side,
    amount: filledOrder.filled ?? order.amount,
    price: filledOrder.average ?? filledOrder.price ?? 0,
    timestamp: filledOrder.timestamp ?? Date.now(),
  };

  logger.info("system", `${label} order executed`, {
    id: result.id,
    pair: result.pair,
    side: result.side,
    amount: result.amount,
    price: result.price,
    ...extraLogData,
  });

  return result;
}

// ── スポット Exchange ──

/**
 * Exchange インターフェースの実装を生成するファクトリ。
 *
 * - ccxt を直接 import するのはこのファイルだけ
 * - DRY_RUN=true の場合、発注はログ出力のみで実行しない
 * - KuCoin は passphrase（第3認証）が必要
 */
export function createExchange(config: EnvConfig, logger: Logger): Exchange {
  const kucoin = new ccxt.kucoin({
    apiKey: config.kucoinApiKey,
    secret: config.kucoinApiSecret,
    password: config.kucoinPassphrase,
  });

  return {
    async fetchOHLCV(
      pair: TradingPair,
      timeframe: Timeframe,
      limit: number,
    ): Promise<OHLCV[]> {
      // ccxt は古い順（oldest first）で返す。最後の要素は未確定足なので除外。
      // limit + 1 本取得して最後を捨てることで、確定済み limit 本を確保する。
      const raw = await withRetry(
        () => kucoin.fetchOHLCV(pair, timeframe, undefined, limit + 1),
        logger,
        `fetchOHLCV(${pair})`,
      );

      // 最後の未確定足を除外してから変換する。
      const confirmed = raw.slice(0, -1);

      return confirmed.map((candle) => {
        const tuple = candle as [number, number, number, number, number, number];
        return toOHLCV(tuple);
      });
    },

    async fetchTicker(
      pair: TradingPair,
    ): Promise<{ bid: number; ask: number; last: number }> {
      const ticker = await withRetry(
        () => kucoin.fetchTicker(pair),
        logger,
        `fetchTicker(${pair})`,
      );

      return {
        bid: ticker.bid ?? 0,
        ask: ticker.ask ?? 0,
        last: ticker.last ?? 0,
      };
    },

    async fetchBalance(): Promise<{
      free: Record<string, number>;
      total: Record<string, number>;
    }> {
      const balance = await withRetry(
        () => kucoin.fetchBalance(),
        logger,
        "fetchBalance",
      );

      const free: Record<string, number> = {};
      const total: Record<string, number> = {};

      if (balance.free) {
        for (const [currency, value] of Object.entries(balance.free)) {
          if (typeof value === "number") {
            free[currency] = value;
          }
        }
      }

      if (balance.total) {
        for (const [currency, value] of Object.entries(balance.total)) {
          if (typeof value === "number") {
            total[currency] = value;
          }
        }
      }

      return { free, total };
    },

    async createOrder(order: OrderRequest): Promise<OrderResult> {
      return executeOrder({
        client: kucoin,
        order,
        symbol: order.pair,
        config,
        logger,
        label: "Spot",
      });
    },

    async fetchOrder(orderId: string, pair: TradingPair): Promise<OrderResult> {
      const order = await withRetry(
        () => kucoin.fetchOrder(orderId, pair),
        logger,
        `fetchOrder(${orderId})`,
      );

      return {
        id: order.id,
        pair,
        side: order.side as OrderSide,
        amount: order.filled ?? 0,
        price: order.average ?? order.price ?? 0,
        timestamp: order.timestamp ?? Date.now(),
      };
    },
  };
}

// ── 先物 Exchange ──

/**
 * スポットの TradingPair を先物シンボルに変換する。
 * KuCoin 先物の USDT-M ペアは "BTC/USDT:USDT" 形式。
 */
function toFuturesSymbol(pair: TradingPair): string {
  return `${pair}:USDT`;
}

/**
 * FuturesExchange インターフェースの実装を生成するファクトリ。
 *
 * - kucoinfutures クライアントを使用
 * - レバレッジ設定を注文前に適用
 * - ショートポジション（sell）用に設計
 */
export function createFuturesExchange(config: EnvConfig, logger: Logger): FuturesExchange {
  const futures = new ccxt.kucoinfutures({
    apiKey: config.kucoinApiKey,
    secret: config.kucoinApiSecret,
    password: config.kucoinPassphrase,
  });

  // レバレッジ設定済みペアを追跡（重複API呼び出しを避ける）
  const leverageSet = new Set<string>();

  async function ensureLeverage(pair: TradingPair): Promise<void> {
    const symbol = toFuturesSymbol(pair);
    if (leverageSet.has(symbol)) return;

    try {
      await withRetry(
        () => futures.setLeverage(config.futuresLeverage, symbol),
        logger,
        `setLeverage(${symbol})`,
      );
      leverageSet.add(symbol);
      logger.info("system", `Futures leverage set to ${String(config.futuresLeverage)}x for ${symbol}`);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn("system", `Failed to set leverage for ${symbol}, may use exchange default`, { error: message });
    }
  }

  return {
    async fetchTicker(
      pair: TradingPair,
    ): Promise<{ bid: number; ask: number; last: number }> {
      const symbol = toFuturesSymbol(pair);
      const ticker = await withRetry(
        () => futures.fetchTicker(symbol),
        logger,
        `futures.fetchTicker(${symbol})`,
      );
      return {
        bid: ticker.bid ?? 0,
        ask: ticker.ask ?? 0,
        last: ticker.last ?? 0,
      };
    },

    async createOrder(order: OrderRequest): Promise<OrderResult> {
      const symbol = toFuturesSymbol(order.pair);
      return executeOrder({
        client: futures,
        order,
        symbol,
        config,
        logger,
        label: "Futures",
        extraLogData: { leverage: config.futuresLeverage },
        preExecute: () => ensureLeverage(order.pair),
      });
    },
  };
}
