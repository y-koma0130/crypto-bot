import { RISK } from "../config/settings.js";
import type {
  Exchange,
  FuturesExchange,
  OHLCV,
  OrderRequest,
  OrderResult,
  TradingPair,
  Timeframe,
} from "../types/index.js";

export interface MockExchange extends Exchange {
  /** Advance the replay cursor so that candles up to `timestamp` are visible. */
  stepTo(timestamp: number): void;
  /** Get the current candle index. */
  getCurrentIndex(): number;
}

/**
 * Create a mock Exchange that replays historical OHLCV data.
 *
 * - `fetchOHLCV` returns the most recent `limit` candles up to `currentIndex`
 * - `fetchTicker` returns bid/ask/last from the current candle's close
 * - `createOrder` fills at the current candle's close with simulated slippage & fees
 * - `fetchOrder` returns a completed order immediately
 */
export function createMockExchange(
  candles: readonly OHLCV[],
  initialCapital: number,
  targetPair?: TradingPair,
): MockExchange {
  let currentIndex = 0;
  let orderCounter = 0;
  let balanceUsd = initialCapital;

  // Track filled orders for fetchOrder
  const filledOrders = new Map<string, OrderResult>();

  function getCurrentCandle(): OHLCV {
    const candle = candles[currentIndex];
    if (candle === undefined) {
      throw new Error(`No candle at index ${currentIndex}`);
    }
    return candle;
  }

  return {
    stepTo(timestamp: number): void {
      // Advance to the last candle whose timestamp <= the target
      while (
        currentIndex < candles.length - 1 &&
        candles[currentIndex + 1] !== undefined &&
        candles[currentIndex + 1]!.timestamp <= timestamp
      ) {
        currentIndex++;
      }
    },

    getCurrentIndex(): number {
      return currentIndex;
    },

    async fetchOHLCV(
      pair: TradingPair,
      _timeframe: Timeframe,
      limit: number,
    ): Promise<OHLCV[]> {
      // バックテスト対象ペア以外にはデータを返さない（重複トレード防止）
      if (targetPair && pair !== targetPair) return [];

      const start = Math.max(0, currentIndex - limit + 1);
      const end = currentIndex + 1;
      return candles.slice(start, end);
    },

    async fetchTicker(
      _pair: TradingPair,
    ): Promise<{ bid: number; ask: number; last: number }> {
      const candle = getCurrentCandle();
      return {
        bid: candle.close,
        ask: candle.close,
        last: candle.close,
      };
    },

    async fetchBalance(): Promise<{
      free: Record<string, number>;
      total: Record<string, number>;
    }> {
      return {
        free: { USDT: balanceUsd },
        total: { USDT: balanceUsd },
      };
    },

    async createOrder(order: OrderRequest): Promise<OrderResult> {
      const candle = getCurrentCandle();
      const basePrice = candle.close;

      // Apply slippage: buy at slightly higher price, sell at slightly lower
      const slippage = RISK.SLIPPAGE_TOLERANCE_PCT;
      const fillPrice =
        order.side === "buy"
          ? basePrice * (1 + slippage)
          : basePrice * (1 - slippage);

      // Update simulated balance
      const cost = fillPrice * order.amount;
      const fee = cost * RISK.TRADING_FEE_PCT;
      if (order.side === "buy") {
        balanceUsd -= cost + fee;
      } else {
        balanceUsd += cost - fee;
      }

      orderCounter++;
      const result: OrderResult = {
        id: `mock-${String(orderCounter)}`,
        pair: order.pair,
        side: order.side,
        amount: order.amount,
        price: fillPrice,
        timestamp: candle.timestamp,
      };

      filledOrders.set(result.id, result);
      return result;
    },

    async fetchOrder(orderId: string, pair: TradingPair): Promise<OrderResult> {
      const existing = filledOrders.get(orderId);
      if (existing) {
        return existing;
      }
      // Return a placeholder completed order
      return {
        id: orderId,
        pair,
        side: "buy",
        amount: 0,
        price: 0,
        timestamp: Date.now(),
      };
    },
  };
}

/**
 * Create a mock FuturesExchange that shares the same candle data as the spot mock.
 * Delegates to the spot mock for price/order execution.
 */
export function createMockFuturesExchange(spotMock: MockExchange): FuturesExchange {
  return {
    async fetchTicker(pair: TradingPair) {
      return spotMock.fetchTicker(pair);
    },
    async createOrder(order: OrderRequest) {
      return spotMock.createOrder(order);
    },
  };
}
