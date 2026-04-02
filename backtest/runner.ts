import type { OHLCV, Position, Logger } from "../types/index.js";
import type { BacktestConfig, BacktestResult, BacktestTrade } from "./types.js";
import type { MockExchange } from "./mock-exchange.js";
import { createMockExchange, createMockFuturesExchange } from "./mock-exchange.js";
import { createMockGPTClient } from "./mock-gpt.js";
import { createMockRepository } from "./mock-repository.js";
import { createMockNewsFetcher } from "./mock-news.js";
import { createLogger } from "../core/logger.js";
import { calculatePnl } from "../core/risk.js";

/** Minimal bot interface that the runner can drive. */
interface BacktestableBot {
  tick(allPositions: readonly Position[]): Promise<void>;
  getPositions(): readonly Position[];
}

/** Factory signature: creates a bot given DI deps. */
type BotFactory = (deps: {
  exchange: MockExchange;
  gpt: ReturnType<typeof createMockGPTClient>;
  logger: Logger;
  capitalUsd: number;
  repo: ReturnType<typeof createMockRepository>;
  newsFetcher: ReturnType<typeof createMockNewsFetcher>;
  futuresExchange: ReturnType<typeof createMockFuturesExchange>;
}) => BacktestableBot;

/**
 * Run a backtest over historical candle data.
 *
 * Iterates through candles one by one, calling bot.tick() at each step.
 * Tracks trades by watching position changes and calculates performance metrics.
 */
export async function runBacktest(
  config: BacktestConfig,
  botFactory: BotFactory,
  candles: readonly OHLCV[],
): Promise<BacktestResult> {
  const logger = createLogger();
  const mockExchange = createMockExchange(candles, config.initialCapital, config.pair);
  const mockGpt = createMockGPTClient();
  const mockRepo = createMockRepository();
  const mockNewsFetcher = createMockNewsFetcher();

  const mockFutures = createMockFuturesExchange(mockExchange);

  const bot = botFactory({
    exchange: mockExchange,
    gpt: mockGpt,
    logger,
    capitalUsd: config.initialCapital,
    repo: mockRepo,
    newsFetcher: mockNewsFetcher,
    futuresExchange: mockFutures,
  });

  // Track completed trades
  const completedTrades: BacktestTrade[] = [];

  // Track equity curve for drawdown / sharpe calculation
  const equityCurve: number[] = [config.initialCapital];
  let equity = config.initialCapital;

  // Snapshot previous positions to detect entries/exits
  let previousPositions: readonly Position[] = [];

  // Map to track entry candle index per pair for duration calculation
  const entryIndices = new Map<string, number>();

  logger.info("system", "Backtest started", {
    pair: config.pair,
    timeframe: config.timeframe,
    candles: candles.length,
    capital: config.initialCapital,
  });

  // Iterate through each candle
  for (let i = 0; i < candles.length; i++) {
    const candle = candles[i];
    if (candle === undefined) continue;

    // Advance mock exchange to this candle
    mockExchange.stepTo(candle.timestamp);

    // Execute bot logic
    await bot.tick([...bot.getPositions()]);

    const currentPositions = bot.getPositions();

    // Detect new entries (positions that appeared)
    for (const pos of currentPositions) {
      const existed = previousPositions.some(
        (prev) => prev.pair === pos.pair && prev.side === pos.side,
      );
      if (!existed) {
        entryIndices.set(`${pos.pair}-${pos.side}`, i);
      }
    }

    // Detect exits (positions that disappeared)
    for (const prev of previousPositions) {
      const stillExists = currentPositions.some(
        (curr) => curr.pair === prev.pair && curr.side === prev.side,
      );
      if (!stillExists) {
        // Position was closed
        const exitPrice = candle.close;
        const pnl = calculatePnl({
          side: prev.side,
          entryPrice: prev.entryPrice,
          exitPrice,
          amount: prev.amount,
        });

        const entryKey = `${prev.pair}-${prev.side}`;
        const entryIndex = entryIndices.get(entryKey) ?? i;
        entryIndices.delete(entryKey);

        completedTrades.push({
          entryTime: prev.openedAt,
          exitTime: candle.timestamp,
          entryPrice: prev.entryPrice,
          exitPrice,
          side: prev.side,
          amount: prev.amount,
          pnl,
          exitReason: "signal", // Generic; actual reason is logged by the bot
        });

        equity += pnl;
      }
    }

    equityCurve.push(equity);
    previousPositions = [...currentPositions];
  }

  // Close any remaining open positions at the last candle's close
  const lastCandle = candles[candles.length - 1];
  if (lastCandle !== undefined) {
    for (const pos of previousPositions) {
      const exitPrice = lastCandle.close;
      const pnl = calculatePnl({
        side: pos.side,
        entryPrice: pos.entryPrice,
        exitPrice,
        amount: pos.amount,
      });

      const entryKey = `${pos.pair}-${pos.side}`;
      const entryIndex = entryIndices.get(entryKey) ?? candles.length - 1;
      entryIndices.delete(entryKey);

      completedTrades.push({
        entryTime: pos.openedAt,
        exitTime: lastCandle.timestamp,
        entryPrice: pos.entryPrice,
        exitPrice,
        side: pos.side,
        amount: pos.amount,
        pnl,
        exitReason: "backtest-end",
      });

      equity += pnl;
      equityCurve.push(equity);
    }
  }

  // Calculate metrics
  const result = calculateMetrics(config, completedTrades, equityCurve);

  logger.info("system", "Backtest completed", {
    totalTrades: result.totalTrades,
    winRate: result.winRate,
    totalPnl: result.totalPnl,
    maxDrawdown: result.maxDrawdown,
    sharpeRatio: result.sharpeRatio,
  });

  return result;
}

function calculateMetrics(
  config: BacktestConfig,
  trades: BacktestTrade[],
  equityCurve: number[],
): BacktestResult {
  const totalTrades = trades.length;
  const winningTrades = trades.filter((t) => t.pnl > 0).length;
  const losingTrades = trades.filter((t) => t.pnl < 0).length;
  const winRate = totalTrades > 0 ? winningTrades / totalTrades : 0;
  const totalPnl = trades.reduce((sum, t) => sum + t.pnl, 0);

  // Max drawdown: largest peak-to-trough decline in equity
  let maxDrawdown = 0;
  let peak = equityCurve[0] ?? config.initialCapital;
  for (const eq of equityCurve) {
    if (eq > peak) {
      peak = eq;
    }
    const drawdown = (peak - eq) / peak;
    if (drawdown > maxDrawdown) {
      maxDrawdown = drawdown;
    }
  }

  // Sharpe ratio: mean(daily returns) / stddev(daily returns) * sqrt(365)
  const dailyReturns: number[] = [];
  for (let i = 1; i < equityCurve.length; i++) {
    const prev = equityCurve[i - 1];
    const curr = equityCurve[i];
    if (prev !== undefined && curr !== undefined && prev > 0) {
      dailyReturns.push((curr - prev) / prev);
    }
  }

  let sharpeRatio = 0;
  if (dailyReturns.length > 1) {
    const meanReturn =
      dailyReturns.reduce((s, r) => s + r, 0) / dailyReturns.length;
    const variance =
      dailyReturns.reduce((s, r) => s + (r - meanReturn) ** 2, 0) /
      (dailyReturns.length - 1);
    const stdDev = Math.sqrt(variance);
    if (stdDev > 0) {
      sharpeRatio = (meanReturn / stdDev) * Math.sqrt(365);
    }
  }

  // Profit factor: sum(winning PnL) / |sum(losing PnL)|
  const totalWinPnl = trades
    .filter((t) => t.pnl > 0)
    .reduce((s, t) => s + t.pnl, 0);
  const totalLossPnl = Math.abs(
    trades.filter((t) => t.pnl < 0).reduce((s, t) => s + t.pnl, 0),
  );
  const profitFactor = totalLossPnl > 0 ? totalWinPnl / totalLossPnl : totalWinPnl > 0 ? Infinity : 0;

  // Average trade duration in candles (approximated from timestamps)
  let averageTradeDuration = 0;
  if (trades.length > 0) {
    const totalDuration = trades.reduce(
      (sum, t) => sum + (t.exitTime - t.entryTime),
      0,
    );
    averageTradeDuration = totalDuration / trades.length;
  }

  return {
    pair: config.pair,
    timeframe: config.timeframe,
    totalTrades,
    winningTrades,
    losingTrades,
    winRate,
    totalPnl,
    maxDrawdown,
    sharpeRatio,
    profitFactor,
    averageTradeDuration,
    trades,
  };
}
