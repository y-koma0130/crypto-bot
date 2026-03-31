import ccxt, { type Order } from "ccxt";
import { RISK } from "../config/settings.js";
import type {
  EnvConfig,
  Exchange,
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

  /** 注文の約定を待つ（最大30秒、指数バックオフでポーリング） */
  async function waitForFill(orderId: string, pair: string): Promise<Order> {
    const MAX_WAIT_MS = 30_000;
    const start = Date.now();
    let interval = 2_000;

    while (Date.now() - start < MAX_WAIT_MS) {
      const order = await withRetry(
        () => kucoin.fetchOrder(orderId, pair),
        logger,
        `fetchOrder(${orderId})`,
      );

      if (order.status === "closed" || order.status === "canceled" || order.status === "cancelled") {
        return order;
      }

      await new Promise((resolve) => setTimeout(resolve, interval));
      interval = Math.min(interval * 2, 10_000);
    }

    // タイムアウト: 最終状態を取得して返す
    return await withRetry(
      () => kucoin.fetchOrder(orderId, pair),
      logger,
      `fetchOrder(${orderId})`,
    );
  }

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
      if (config.dryRun) {
        const ticker = await withRetry(
          () => kucoin.fetchTicker(order.pair),
          logger,
          `fetchTicker(${order.pair})`,
        );
        const lastPrice = ticker.last ?? 0;
        const result = mockOrderResult(order, lastPrice);

        logger.info("system", "[DRY_RUN] Order would be placed", {
          pair: order.pair,
          side: order.side,
          amount: order.amount,
          price: result.price,
        });

        return result;
      }

      // スリッページ保護: 成行注文の代わりに、許容幅付き指値注文を使用
      let orderPrice = order.price;
      let type: "limit" | "market" = order.price != null ? "limit" : "market";

      if (type === "market") {
        // 現在価格にスリッページ許容幅を加算/減算した指値に変換
        const ticker = await withRetry(
          () => kucoin.fetchTicker(order.pair),
          logger,
          `fetchTicker(${order.pair})`,
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
        () => kucoin.createOrder(order.pair, type, order.side, order.amount, orderPrice),
        logger,
        `createOrder(${order.pair})`,
      );

      // 約定を待つ（指値注文の場合）
      const filledOrder = ccxtOrder.status === "closed"
        ? ccxtOrder
        : await waitForFill(ccxtOrder.id, order.pair);

      if (filledOrder.status === "canceled" || filledOrder.status === "cancelled") {
        logger.warn("system", `Order cancelled: ${filledOrder.id}`, { pair: order.pair });
        throw new Error(`Order ${filledOrder.id} was cancelled`);
      }

      const result: OrderResult = {
        id: filledOrder.id,
        pair: order.pair,
        side: order.side,
        amount: filledOrder.filled ?? order.amount,
        price: filledOrder.average ?? filledOrder.price ?? 0,
        timestamp: filledOrder.timestamp ?? Date.now(),
      };

      logger.info("system", "Order executed", {
        id: result.id,
        pair: result.pair,
        side: result.side,
        amount: result.amount,
        price: result.price,
      });

      return result;
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
