import type { OHLCV, TradingPair, Timeframe } from "../types/index.js";

export interface BacktestConfig {
  readonly pair: TradingPair;
  readonly timeframe: Timeframe;
  readonly startDate: Date;
  readonly endDate: Date;
  readonly initialCapital: number;
}

export interface BacktestResult {
  readonly pair: TradingPair;
  readonly timeframe: Timeframe;
  readonly totalTrades: number;
  readonly winningTrades: number;
  readonly losingTrades: number;
  readonly winRate: number;
  readonly totalPnl: number;
  readonly maxDrawdown: number;
  readonly sharpeRatio: number;
  readonly profitFactor: number;
  readonly averageTradeDuration: number;
  readonly trades: readonly BacktestTrade[];
}

export interface BacktestTrade {
  readonly entryTime: number;
  readonly exitTime: number;
  readonly entryPrice: number;
  readonly exitPrice: number;
  readonly side: "buy" | "sell";
  readonly amount: number;
  readonly pnl: number;
  readonly exitReason: string;
}
