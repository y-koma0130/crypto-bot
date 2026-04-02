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
import { createPolymarketBot } from "./bots/polymarket.js";
import { isDailyLossLimitReached, getAllowedSide, countConsecutiveLosses } from "./core/risk.js";
import { RISK } from "./config/settings.js";
import type { BotName, OrderSide, Position, TradingPair } from "./types/index.js";

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
  const polymarketMutex = createMutex();
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

  // getDailyTrend は後で定義されるが、ボットはtick時に呼ぶので遅延参照で問題ない
  let getDailyTrendFn: ((pair: TradingPair) => Promise<OrderSide | null>) | undefined;
  const getDailyTrendProxy = (pair: TradingPair) => getDailyTrendFn ? getDailyTrendFn(pair) : Promise.resolve(null as OrderSide | null);

  const sentimentBot = createSentimentBot({
    exchange,
    logger,
    capitalUsd: config.totalCapital,
    repo,
    newsFetcher,
    futuresExchange,
    getDailyTrend: getDailyTrendProxy,
  });

  const momentumBot = createMomentumBot({
    exchange,
    gpt,
    logger,
    capitalUsd: config.totalCapital,
    repo,
    futuresExchange,
    getDailyTrend: getDailyTrendProxy,
  });

  const momentumFastBot = createMomentumFastBot({
    exchange,
    gpt,
    logger,
    capitalUsd: config.totalCapital,
    repo,
    futuresExchange,
    getDailyTrend: getDailyTrendProxy,
  });

  const rangeBot = createRangeBot({
    exchange,
    gpt,
    logger,
    capitalUsd: config.totalCapital,
    repo,
    newsFetcher,
    futuresExchange,
    getDailyTrend: getDailyTrendProxy,
    isBtcCrashing: () => isBtcCrashing(),
  });

  const polymarketBot = createPolymarketBot({
    exchange,
    logger,
    capitalUsd: config.totalCapital,
    repo,
    newsFetcher,
    futuresExchange,
    getDailyTrend: getDailyTrendProxy,
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

  // ── 日足トレンドフィルター（1時間キャッシュ） ──
  const dailyTrendCache = new Map<TradingPair, { side: OrderSide | null; expiresAt: number }>();
  const ALL_PAIRS: TradingPair[] = ["BTC/USDT", "ETH/USDT", "XRP/USDT", "SOL/USDT"];

  async function getDailyTrend(pair: TradingPair): Promise<OrderSide | null> {
    const cached = dailyTrendCache.get(pair);
    if (cached && Date.now() < cached.expiresAt) return cached.side;

    try {
      const dailyCandles = await exchange.fetchOHLCV(pair, "1d", RISK.DAILY_TREND_EMA_PERIOD + 5);
      const side = getAllowedSide(dailyCandles, RISK.DAILY_TREND_EMA_PERIOD);
      dailyTrendCache.set(pair, { side, expiresAt: Date.now() + 60 * 60 * 1000 });
      logger.info("system", `Daily trend for ${pair}: ${side === "buy" ? "BULLISH" : "BEARISH"}`, { pair, allowedSide: side });
      return side;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn("system", `Failed to fetch daily trend for ${pair}`, { error: message });
      return null; // フィルターを適用しない
    }
  }

  /** 日足トレンドに逆らうポジションがないか全ペアで確認 */
  async function refreshDailyTrends(): Promise<void> {
    await Promise.all(ALL_PAIRS.map((pair) => getDailyTrend(pair)));
  }

  // ボットに渡したプロキシを接続
  getDailyTrendFn = getDailyTrend;

  // ── 連敗制御（5分キャッシュ — トレードクローズは稀なので頻繁にDBを叩く必要なし） ──
  const losingStreakCache = new Map<BotName, { value: boolean; expiresAt: number }>();

  async function isOnLosingStreak(botName: BotName): Promise<boolean> {
    const cached = losingStreakCache.get(botName);
    if (cached && Date.now() < cached.expiresAt) return cached.value;

    try {
      const recentPnls = await repo.getRecentClosedPnls(botName, RISK.MAX_CONSECUTIVE_LOSSES);
      const streak = countConsecutiveLosses(recentPnls);
      const result = streak >= RISK.MAX_CONSECUTIVE_LOSSES;
      losingStreakCache.set(botName, { value: result, expiresAt: Date.now() + 5 * 60_000 });
      if (result) {
        logger.warn(botName, `Losing streak (${String(streak)} consecutive losses) — skipping tick`);
      }
      return result;
    } catch {
      return false;
    }
  }

  // ── 相関フィルター: BTC急落時はアルトのロングをブロック ──
  let btcCrashCache: { value: boolean; expiresAt: number } = { value: false, expiresAt: 0 };

  async function isBtcCrashing(): Promise<boolean> {
    const now = Date.now();
    if (now < btcCrashCache.expiresAt) return btcCrashCache.value;

    try {
      // fetchOHLCVは未確定足を除外済み。直近2本の確定足を比較
      const candles = await exchange.fetchOHLCV("BTC/USDT", "1h", 3);
      if (candles.length >= 2) {
        const prev = candles[candles.length - 2]!.close;
        const curr = candles[candles.length - 1]!.close;
        const changePct = (curr - prev) / prev;
        const crashing = changePct <= RISK.BTC_CRASH_THRESHOLD_PCT;
        btcCrashCache = { value: crashing, expiresAt: now + 5 * 60_000 };
        if (crashing) {
          logger.warn("system", `BTC crash detected (${(changePct * 100).toFixed(2)}%) — blocking alt longs`);
        }
        return crashing;
      }
    } catch {
      // フィルターを適用しない
    }
    return false;
  }

  function getAllPositions(): readonly Position[] {
    return [
      ...sentimentBot.getPositions(),
      ...momentumBot.getPositions(),
      ...momentumFastBot.getPositions(),
      ...polymarketBot.getPositions(),
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
    if (sentimentBot.isHalted()) { logger.warn("momentum", "Skipping tick — HALT active"); return; }
    if (await checkDailyLossLimit()) { logger.warn("momentum", "Skipping tick — daily loss limit reached"); return; }
    if (await isOnLosingStreak("momentum")) return;
    try {
      await momentumBot.tick(getAllPositions());
      updateBotStatus("momentum", momentumBot.getPositions());
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error("momentum", `Momentum tick failed: ${message}`);
    }
  }

  async function tickMomentumFast(): Promise<void> {
    if (shuttingDown) return;
    if (sentimentBot.isHalted()) { logger.warn("momentum-fast", "Skipping tick — HALT active"); return; }
    if (await checkDailyLossLimit()) { logger.warn("momentum-fast", "Skipping tick — daily loss limit reached"); return; }
    if (await isOnLosingStreak("momentum-fast")) return;
    try {
      await momentumFastBot.tick(getAllPositions());
      updateBotStatus("momentum-fast", momentumFastBot.getPositions());
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error("momentum-fast", `Momentum-fast tick failed: ${message}`);
    }
  }

  async function tickPolymarket(): Promise<void> {
    if (shuttingDown) return;
    if (sentimentBot.isHalted()) { logger.warn("polymarket", "Skipping tick — HALT active"); return; }
    if (await checkDailyLossLimit()) { logger.warn("polymarket", "Skipping tick — daily loss limit reached"); return; }
    if (await isOnLosingStreak("polymarket")) return;
    try {
      await polymarketBot.tick(getAllPositions());
      updateBotStatus("polymarket", polymarketBot.getPositions());
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error("polymarket", `Polymarket tick failed: ${message}`);
    }
  }

  async function tickRange(): Promise<void> {
    if (shuttingDown) return;
    if (sentimentBot.isHalted()) { logger.warn("range", "Skipping tick — HALT active"); return; }
    if (await checkDailyLossLimit()) { logger.warn("range", "Skipping tick — daily loss limit reached"); return; }
    if (await isOnLosingStreak("range")) return;
    // 相関フィルターはtick内の日足トレンドフィルターで処理（ショートは許可する）
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
      polymarketMutex.run(() => polymarketBot.checkStopLosses()),
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

  // Polymarket Bot: 10分毎（確率変化を監視）
  const cronPolymarket = cron.schedule("*/10 * * * *", () => void polymarketMutex.run(tickPolymarket));

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
    cronPolymarket.stop();
    cronRange.stop();
    cronStopLoss.stop();
    logger.info("system", "Cron jobs stopped");

    // Update bot status to inactive
    await Promise.allSettled([
      repo.updateBotStatus({ bot_name: "sentiment", is_active: false, is_halted: false, last_run_at: new Date().toISOString(), current_position: null }),
      repo.updateBotStatus({ bot_name: "momentum", is_active: false, is_halted: false, last_run_at: new Date().toISOString(), current_position: null }),
      repo.updateBotStatus({ bot_name: "momentum-fast", is_active: false, is_halted: false, last_run_at: new Date().toISOString(), current_position: null }),
      repo.updateBotStatus({ bot_name: "polymarket", is_active: false, is_halted: false, last_run_at: new Date().toISOString(), current_position: null }),
      repo.updateBotStatus({ bot_name: "range", is_active: false, is_halted: false, last_run_at: new Date().toISOString(), current_position: null }),
    ]);
    logger.info("system", "Bot status updated to inactive");

    logger.info("system", "Shutdown complete");
    process.exit(0);
  }

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  // ── 起動時にDBからポジション復元 ──
  const [sentimentTrades, momentumTrades, momentumFastTrades, polymarketTrades, rangeTrades] = await Promise.all([
    repo.findOpenTrades("sentiment"),
    repo.findOpenTrades("momentum"),
    repo.findOpenTrades("momentum-fast"),
    repo.findOpenTrades("polymarket"),
    repo.findOpenTrades("range"),
  ]);
  sentimentBot.restorePositions(sentimentTrades);
  momentumBot.restorePositions(momentumTrades);
  momentumFastBot.restorePositions(momentumFastTrades);
  polymarketBot.restorePositions(polymarketTrades);
  rangeBot.restorePositions(rangeTrades);

  logger.info("system", "All cron jobs scheduled. Bot is running.");

  // 起動直後に日足トレンドをキャッシュ
  await refreshDailyTrends();

  // 起動直後に1回実行（センチメント→他ボットの順で、HALT判定を先に行う）
  await sentimentMutex.run(tickSentiment);
  await Promise.all([
    momentumMutex.run(tickMomentum),
    momentumFastMutex.run(tickMomentumFast),
    polymarketMutex.run(tickPolymarket),
    rangeMutex.run(tickRange),
  ]);

  logger.info("system", "Initial tick complete. Waiting for next cron triggers...");
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`Fatal error: ${message}`);
  process.exit(1);
});
