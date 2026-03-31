import dotenv from "dotenv";
import type { TradingPair, Timeframe, Position } from "../types/index.js";
import type { BacktestConfig, BacktestResult } from "./types.js";
import { runBacktest } from "./runner.js";
import { fetchHistoricalData } from "./data-fetcher.js";
import { createExchange } from "../core/exchange.js";
import { createLogger } from "../core/logger.js";
import { MOMENTUM_CONFIG, RANGE_CONFIG } from "../config/settings.js";
import { createMomentumBot } from "../bots/momentum.js";
import { createRangeBot } from "../bots/range.js";
import type { MockExchange } from "./mock-exchange.js";
import type { NewsFetcher } from "../core/news.js";

// ── CLI argument parsing ──

interface CliArgs {
  bot: "momentum" | "range";
  pair: TradingPair;
  days: number;
}

function parseArgs(): CliArgs {
  const args = process.argv.slice(2);

  let bot: "momentum" | "range" = "momentum";
  let pair: TradingPair = "BTC/USDT";
  let days = 90;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const next = args[i + 1];

    if (arg === "--bot" && next !== undefined) {
      if (next !== "momentum" && next !== "range") {
        console.error(`Invalid bot: ${next}. Must be "momentum" or "range".`);
        process.exit(1);
      }
      bot = next;
      i++;
    } else if (arg === "--pair" && next !== undefined) {
      const validPairs: TradingPair[] = ["BTC/USDT", "ETH/USDT", "XRP/USDT", "SOL/USDT"];
      if (!validPairs.includes(next as TradingPair)) {
        console.error(`Invalid pair: ${next}. Must be one of: ${validPairs.join(", ")}`);
        process.exit(1);
      }
      pair = next as TradingPair;
      i++;
    } else if (arg === "--days" && next !== undefined) {
      days = Number(next);
      if (Number.isNaN(days) || days <= 0) {
        console.error(`Invalid days: ${next}. Must be a positive number.`);
        process.exit(1);
      }
      i++;
    }
  }

  return { bot, pair, days };
}

// ── Results formatting ──

function formatResults(result: BacktestResult): void {
  const separator = "=".repeat(60);
  console.log("\n" + separator);
  console.log("  BACKTEST RESULTS");
  console.log(separator);

  const rows: [string, string][] = [
    ["Pair", result.pair],
    ["Timeframe", result.timeframe],
    ["Total Trades", String(result.totalTrades)],
    ["Winning Trades", String(result.winningTrades)],
    ["Losing Trades", String(result.losingTrades)],
    ["Win Rate", `${(result.winRate * 100).toFixed(1)}%`],
    ["Total PnL", `$${result.totalPnl.toFixed(2)}`],
    ["Max Drawdown", `${(result.maxDrawdown * 100).toFixed(2)}%`],
    ["Sharpe Ratio", result.sharpeRatio.toFixed(3)],
    ["Profit Factor", result.profitFactor === Infinity ? "Inf" : result.profitFactor.toFixed(3)],
    ["Avg Trade Duration", `${(result.averageTradeDuration / 3_600_000).toFixed(1)}h`],
  ];

  for (const [label, value] of rows) {
    console.log(`  ${label.padEnd(22)} ${value}`);
  }

  console.log(separator);

  if (result.trades.length > 0) {
    console.log("\n  TRADE LOG");
    console.log(separator);
    console.log(
      "  " +
        "Side".padEnd(6) +
        "Entry Price".padEnd(14) +
        "Exit Price".padEnd(14) +
        "PnL".padEnd(12) +
        "Reason",
    );
    console.log("  " + "-".repeat(56));

    for (const trade of result.trades) {
      const pnlStr = trade.pnl >= 0 ? `+$${trade.pnl.toFixed(2)}` : `-$${Math.abs(trade.pnl).toFixed(2)}`;
      console.log(
        "  " +
          trade.side.padEnd(6) +
          trade.entryPrice.toFixed(2).padEnd(14) +
          trade.exitPrice.toFixed(2).padEnd(14) +
          pnlStr.padEnd(12) +
          trade.exitReason,
      );
    }
    console.log(separator);
  }
}

// ── Main ──

async function main(): Promise<void> {
  // Load .env.test for exchange credentials
  dotenv.config({ path: ".env.test" });

  const cliArgs = parseArgs();

  console.log(`\nBacktest: bot=${cliArgs.bot} pair=${cliArgs.pair} days=${cliArgs.days}\n`);

  // Determine timeframe from bot config
  const botConfig = cliArgs.bot === "momentum" ? MOMENTUM_CONFIG : RANGE_CONFIG;
  const timeframe: Timeframe = botConfig.timeframe;

  // Date range
  const endDate = new Date();
  const startDate = new Date(endDate.getTime() - cliArgs.days * 24 * 60 * 60 * 1000);

  // Fetch historical data using real exchange
  const logger = createLogger();
  const envConfig = {
    kucoinApiKey: process.env["KUCOIN_API_KEY"] ?? "",
    kucoinApiSecret: process.env["KUCOIN_API_SECRET"] ?? "",
    kucoinPassphrase: process.env["KUCOIN_PASSPHRASE"] ?? "",
    openaiApiKey: process.env["OPENAI_API_KEY"] ?? "",
    openaiModel: process.env["OPENAI_MODEL"] ?? "gpt-4o-mini",
    databaseUrl: process.env["DATABASE_URL"] ?? "",
    dryRun: true,
    env: "test" as const,
    totalCapital: Number(process.env["TOTAL_CAPITAL"] ?? "1000"),
  };

  const realExchange = createExchange(envConfig, logger);

  const candles = await fetchHistoricalData({
    pair: cliArgs.pair,
    timeframe,
    startDate,
    endDate,
    exchange: realExchange,
  });

  if (candles.length === 0) {
    console.error("No historical data fetched. Check your exchange credentials and date range.");
    process.exit(1);
  }

  // Build backtest config
  const config: BacktestConfig = {
    pair: cliArgs.pair,
    timeframe,
    startDate,
    endDate,
    initialCapital: envConfig.totalCapital,
  };

  // Create bot factory based on selected bot type
  const botFactory =
    cliArgs.bot === "momentum"
      ? (deps: {
          exchange: MockExchange;
          gpt: Parameters<typeof createMomentumBot>[0]["gpt"];
          logger: Parameters<typeof createMomentumBot>[0]["logger"];
          capitalUsd: number;
          repo: Parameters<typeof createMomentumBot>[0]["repo"];
          newsFetcher: NewsFetcher;
        }) =>
          createMomentumBot({
            exchange: deps.exchange,
            gpt: deps.gpt,
            logger: deps.logger,
            capitalUsd: deps.capitalUsd,
            repo: deps.repo,
          })
      : (deps: {
          exchange: MockExchange;
          gpt: Parameters<typeof createRangeBot>[0]["gpt"];
          logger: Parameters<typeof createRangeBot>[0]["logger"];
          capitalUsd: number;
          repo: Parameters<typeof createRangeBot>[0]["repo"];
          newsFetcher: NewsFetcher;
        }) =>
          createRangeBot({
            exchange: deps.exchange,
            gpt: deps.gpt,
            logger: deps.logger,
            capitalUsd: deps.capitalUsd,
            repo: deps.repo,
            newsFetcher: deps.newsFetcher,
          });

  // Run backtest
  const result = await runBacktest(config, botFactory, candles);

  // Print results
  formatResults(result);
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`Backtest failed: ${message}`);
  process.exit(1);
});
