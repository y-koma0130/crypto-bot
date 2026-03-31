import cron from "node-cron";
import { loadEnvConfig } from "./config/settings.js";
import { createLogger } from "./core/logger.js";
import { createExchange, createFuturesExchange } from "./core/exchange.js";
import { createGPTClient } from "./core/gpt.js";
import { createRepository } from "./core/db.js";
import { createNewsFetcher } from "./core/news.js";
import { createMomentumBot } from "./bots/momentum.js";
import { createMomentumFastBot } from "./bots/momentum-fast.js";
import { createRangeBot } from "./bots/range.js";
import { createSentimentBot } from "./bots/sentiment.js";
import { isDailyLossLimitReached } from "./core/risk.js";
import type { BotName, Position } from "./types/index.js";

async function main(): Promise<void> {
  const logger = createLogger();
  let shuttingDown = false;
  logger.info("system", "Starting crypto-bot...");

  function createMutex() {
    let locked = false;
    return {
      async run(fn: () => Promise<void>): Promise<void> {
        if (locked) return;
        locked = true;
        try {
          await fn();
        } finally {
          locked = false;
        }
      },
    };
  }

  const sentimentMutex = createMutex();
  const momentumMutex = createMutex();
  const momentumFastMutex = createMutex();
  const rangeMutex = createMutex();
  // stopLossMutex は不要 — 各ボットのmutex内で実行して競合を防ぐ

  const config = loadEnvConfig();
  logger.info("system", `Environment: ${config.env}, DRY_RUN: ${config.dryRun}`);

  const exchange = createExchange(config, logger);
  const futuresExchange = config.futuresEnabled ? createFuturesExchange(config, logger) : undefined;
  const gpt = createGPTClient(config, logger);
  const repo = createRepository(config, logger);

  if (futuresExchange) {
    logger.info("system", `Futures enabled (leverage: ${String(config.futuresLeverage)}x)`);
  }

  const newsFetcher = createNewsFetcher(logger);

  const sentimentBot = createSentimentBot({
    exchange,
    gpt,
    logger,
    capitalUsd: config.totalCapital,
    repo,
    newsFetcher,
    futuresExchange,
  });

  const momentumBot = createMomentumBot({
    exchange,
    gpt,
    logger,
    capitalUsd: config.totalCapital,
    repo,
    futuresExchange,
  });

  const momentumFastBot = createMomentumFastBot({
    exchange,
    gpt,
    logger,
    capitalUsd: config.totalCapital,
    repo,
    futuresExchange,
  });

  const rangeBot = createRangeBot({
    exchange,
    gpt,
    logger,
    capitalUsd: config.totalCapital,
    repo,
    newsFetcher,
    futuresExchange,
  });

  // ── 起動時ヘルスチェック ──
  async function healthCheck(): Promise<void> {
    logger.info("system", "Running startup health checks...");

    // DB接続確認
    try {
      await repo.getDailyPnl();
      logger.info("system", "✓ Database connection OK");
    } catch {
      throw new Error("Health check failed: Database unreachable");
    }

    // Exchange API確認
    try {
      await exchange.fetchTicker("BTC/USDT");
      logger.info("system", "✓ Exchange API OK");
    } catch {
      throw new Error("Health check failed: Exchange API unreachable");
    }

    logger.info("system", "All health checks passed");
  }

  await healthCheck();

  function getAllPositions(): readonly Position[] {
    return [
      ...sentimentBot.getPositions(),
      ...momentumBot.getPositions(),
      ...momentumFastBot.getPositions(),
      ...rangeBot.getPositions(),
    ];
  }

  function updateBotStatus(botName: BotName, positions: readonly Position[], isHalted = false): void {
    const currentPosition = positions.length > 0 ? (positions[0] ?? null) : null;
    void repo.updateBotStatus({
      bot_name: botName,
      is_active: true,
      is_halted: isHalted,
      last_run_at: new Date().toISOString(),
      current_position: currentPosition,
    }).catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error("system", `Failed to update bot_status for ${botName}`, { error: msg });
    });
  }

  async function tickSentiment(): Promise<void> {
    if (shuttingDown) return;
    try {
      await sentimentBot.tick(getAllPositions());
      updateBotStatus("sentiment", sentimentBot.getPositions(), sentimentBot.isHalted());
      logger.info("system", `Sentiment tick complete. Halted: ${sentimentBot.isHalted()}`);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error("system", `Sentiment tick failed: ${message}`);
    }
  }

  // 日次損失チェックのキャッシュ（1分間有効、tick毎の重複DBクエリを防止）
  let dailyLossCache: { value: boolean; expiresAt: number } = { value: false, expiresAt: 0 };

  async function checkDailyLossLimit(): Promise<boolean> {
    const now = Date.now();
    if (now < dailyLossCache.expiresAt) return dailyLossCache.value;

    try {
      const dailyPnl = await repo.getDailyPnl();
      const reached = isDailyLossLimitReached(dailyPnl, config.totalCapital);
      dailyLossCache = { value: reached, expiresAt: now + 60_000 };
      if (reached) {
        logger.warn("system", `Daily loss limit reached (PnL: ${dailyPnl.toFixed(2)} USD) — blocking new entries`, {
          dailyPnl,
          limit: config.totalCapital * -0.10,
        });
      }
      return reached;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error("system", "Failed to check daily loss limit", { error: message });
      return false;
    }
  }

  async function tickMomentum(): Promise<void> {
    if (shuttingDown) return;
    if (sentimentBot.isHalted()) {
      logger.warn("momentum", "Skipping tick — HALT active");
      return;
    }
    if (await checkDailyLossLimit()) {
      logger.warn("momentum", "Skipping tick — daily loss limit reached");
      return;
    }
    try {
      await momentumBot.tick(getAllPositions());
      updateBotStatus("momentum", momentumBot.getPositions());
      logger.info("momentum", "Momentum tick complete");
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error("momentum", `Momentum tick failed: ${message}`);
    }
  }

  async function tickMomentumFast(): Promise<void> {
    if (shuttingDown) return;
    if (sentimentBot.isHalted()) {
      logger.warn("momentum-fast", "Skipping tick — HALT active");
      return;
    }
    if (await checkDailyLossLimit()) {
      logger.warn("momentum-fast", "Skipping tick — daily loss limit reached");
      return;
    }
    try {
      await momentumFastBot.tick(getAllPositions());
      updateBotStatus("momentum-fast", momentumFastBot.getPositions());
      logger.info("momentum-fast", "Momentum-fast tick complete");
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error("momentum-fast", `Momentum-fast tick failed: ${message}`);
    }
  }

  async function tickRange(): Promise<void> {
    if (shuttingDown) return;
    if (sentimentBot.isHalted()) {
      logger.warn("range", "Skipping tick — HALT active");
      return;
    }
    if (await checkDailyLossLimit()) {
      logger.warn("range", "Skipping tick — daily loss limit reached");
      return;
    }
    try {
      await rangeBot.tick(getAllPositions());
      updateBotStatus("range", rangeBot.getPositions());
      logger.info("range", "Range tick complete");
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error("range", `Range tick failed: ${message}`);
    }
  }

  // ── 1分毎の高頻度損切りチェッカー（各ボットのmutex内で実行し競合を防ぐ） ──
  async function tickStopLoss(): Promise<void> {
    if (shuttingDown) return;
    if (getAllPositions().length === 0) return;

    await Promise.all([
      momentumMutex.run(() => momentumBot.checkStopLosses()),
      momentumFastMutex.run(() => momentumFastBot.checkStopLosses()),
      rangeMutex.run(() => rangeBot.checkStopLosses()),
      sentimentMutex.run(() => sentimentBot.checkStopLosses()),
    ]);
  }

  // ── スケジューリング ──
  // Bot3（センチメント）: 30分毎
  const cronSentiment = cron.schedule("*/30 * * * *", () => void sentimentMutex.run(tickSentiment));

  // Bot1（モメンタム）: 1時間毎（1h足ベース）
  const cronMomentum = cron.schedule("5 * * * *", () => void momentumMutex.run(tickMomentum));

  // Bot1-fast（短期モメンタム）: 15分毎（15m足ベース）
  const cronMomentumFast = cron.schedule("*/15 * * * *", () => void momentumFastMutex.run(tickMomentumFast));

  // Bot2（レンジ）: 15分毎（15m足ベース）
  const cronRange = cron.schedule("*/15 * * * *", () => void rangeMutex.run(tickRange));

  // 損切りチェッカー: 1分毎（各ボットのmutex内で実行）
  const cronStopLoss = cron.schedule("* * * * *", () => void tickStopLoss());

  // ── Graceful shutdown ──
  async function shutdown(signal: string): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info("system", `${signal} received, shutting down gracefully...`);

    // Stop cron jobs
    cronSentiment.stop();
    cronMomentum.stop();
    cronMomentumFast.stop();
    cronRange.stop();
    cronStopLoss.stop();
    logger.info("system", "Cron jobs stopped");

    // Update bot status to inactive
    await Promise.allSettled([
      repo.updateBotStatus({ bot_name: "sentiment", is_active: false, is_halted: false, last_run_at: new Date().toISOString(), current_position: null }),
      repo.updateBotStatus({ bot_name: "momentum", is_active: false, is_halted: false, last_run_at: new Date().toISOString(), current_position: null }),
      repo.updateBotStatus({ bot_name: "momentum-fast", is_active: false, is_halted: false, last_run_at: new Date().toISOString(), current_position: null }),
      repo.updateBotStatus({ bot_name: "range", is_active: false, is_halted: false, last_run_at: new Date().toISOString(), current_position: null }),
    ]);
    logger.info("system", "Bot status updated to inactive");

    logger.info("system", "Shutdown complete");
    process.exit(0);
  }

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  // ── 起動時にDBからポジション復元 ──
  const [sentimentTrades, momentumTrades, momentumFastTrades, rangeTrades] = await Promise.all([
    repo.findOpenTrades("sentiment"),
    repo.findOpenTrades("momentum"),
    repo.findOpenTrades("momentum-fast"),
    repo.findOpenTrades("range"),
  ]);
  sentimentBot.restorePositions(sentimentTrades);
  momentumBot.restorePositions(momentumTrades);
  momentumFastBot.restorePositions(momentumFastTrades);
  rangeBot.restorePositions(rangeTrades);

  logger.info("system", "All cron jobs scheduled. Bot is running.");

  // 起動直後に1回実行（センチメント→他ボットの順で、HALT判定を先に行う）
  await sentimentMutex.run(tickSentiment);
  await Promise.all([
    momentumMutex.run(tickMomentum),
    momentumFastMutex.run(tickMomentumFast),
    rangeMutex.run(tickRange),
  ]);

  logger.info("system", "Initial tick complete. Waiting for next cron triggers...");
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`Fatal error: ${message}`);
  process.exit(1);
});
