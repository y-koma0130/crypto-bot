import { drizzle } from "drizzle-orm/postgres-js";
import { eq, and, desc } from "drizzle-orm";
import postgres from "postgres";
import { trades, signals, botStatus } from "../db/schema.js";
import type {
  BotName,
  BotStatusRecord,
  EnvConfig,
  Logger,
  Repository,
  SignalRecord,
  TradeRecord,
  TradingPair,
} from "../types/index.js";

/**
 * Drizzle ORM を利用した Repository 実装を生成するファクトリ。
 * DB 接続の生成はこのファイルに閉じ込める。
 */
type TradeRow = typeof trades.$inferSelect;

function toTradeRecord(row: TradeRow): TradeRecord {
  return {
    id: row.id,
    bot_name: row.botName as BotName,
    symbol: row.symbol as TradingPair,
    side: row.side as TradeRecord["side"],
    amount: Number(row.amount),
    entry_price: Number(row.entryPrice),
    exit_price: row.exitPrice != null ? Number(row.exitPrice) : undefined,
    pnl: row.pnl != null ? Number(row.pnl) : undefined,
    partial_amount: row.partialAmount != null ? Number(row.partialAmount) : undefined,
    partial_at: row.partialAt?.toISOString(),
    status: row.status as TradeRecord["status"],
    created_at: row.createdAt?.toISOString(),
    closed_at: row.closedAt?.toISOString(),
  };
}

export function createRepository(config: EnvConfig, logger: Logger): Repository {
  const client = postgres(config.databaseUrl, {
    max: 10,
    idle_timeout: 30,
    ssl: { rejectUnauthorized: false },
    prepare: false,
  });
  const db = drizzle(client);

  return {
    async insertTrade(trade: TradeRecord): Promise<string> {
      const rows = await db
        .insert(trades)
        .values({
          botName: trade.bot_name,
          symbol: trade.symbol,
          side: trade.side,
          amount: String(trade.amount),
          entryPrice: String(trade.entry_price),
          status: trade.status,
        })
        .returning({ id: trades.id });

      const row = rows[0];
      if (!row) {
        logger.error("system", "Insert trade returned no rows");
        throw new Error("Insert trade returned no rows");
      }

      return row.id;
    },

    async closeTrade(id: string, exitPrice: number, pnl: number): Promise<void> {
      try {
        await db
          .update(trades)
          .set({
            exitPrice: String(exitPrice),
            pnl: String(pnl),
            status: "closed",
            closedAt: new Date(),
          })
          .where(eq(trades.id, id));
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        logger.error("system", "Failed to close trade", { id, error: message });
      }
    },

    async recordPartialTakeProfit(id: string, exitPrice: number, amount: number, pnl: number): Promise<void> {
      try {
        await db
          .update(trades)
          .set({
            partialExitPrice: String(exitPrice),
            partialAmount: String(amount),
            partialPnl: String(pnl),
            partialAt: new Date(),
          })
          .where(eq(trades.id, id));
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        logger.error("system", "Failed to record partial take-profit", { id, error: message });
      }
    },

    async findOpenTrade(botName: BotName, symbol: TradingPair): Promise<TradeRecord | null> {
      try {
        const rows = await db
          .select()
          .from(trades)
          .where(
            and(
              eq(trades.botName, botName),
              eq(trades.symbol, symbol),
              eq(trades.status, "open"),
            ),
          )
          .orderBy(desc(trades.createdAt))
          .limit(1);

        const row = rows[0];
        if (!row) return null;

        return toTradeRecord(row);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        logger.error("system", "Failed to find open trade", { botName, symbol, error: message });
        return null;
      }
    },

    async findOpenTrades(botName: BotName): Promise<TradeRecord[]> {
      try {
        const rows = await db
          .select()
          .from(trades)
          .where(
            and(
              eq(trades.botName, botName),
              eq(trades.status, "open"),
            ),
          )
          .orderBy(desc(trades.createdAt));

        return rows.map(toTradeRecord);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        logger.error("system", "Failed to find open trades", { botName, error: message });
        return [];
      }
    },

    async insertSignal(signal: SignalRecord): Promise<void> {
      try {
        await db
          .insert(signals)
          .values({
            botName: signal.bot_name,
            symbol: signal.symbol,
            signal: signal.signal,
            reasoning: signal.reasoning,
          });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        logger.error("system", "Failed to insert signal", { error: message });
      }
    },

    async getDailyPnl(): Promise<number> {
      try {
        // クローズ済み + 部分利確済みのオープントレードの両方を取得
        const rows = await db
          .select({
            pnl: trades.pnl,
            partialPnl: trades.partialPnl,
            closedAt: trades.closedAt,
            partialAt: trades.partialAt,
            status: trades.status,
          })
          .from(trades);

        const todayStart = new Date();
        todayStart.setHours(0, 0, 0, 0);

        let total = 0;
        for (const row of rows) {
          // クローズ済みトレード: pnl + partialPnl をクローズ日で計上
          if (row.status === "closed" && row.closedAt && row.closedAt >= todayStart) {
            if (row.pnl != null) total += Number(row.pnl);
            if (row.partialPnl != null) total += Number(row.partialPnl);
          }
          // オープン中で部分利確済み: partialPnl を部分利確日で計上
          if (row.status === "open" && row.partialPnl != null && row.partialAt && row.partialAt >= todayStart) {
            total += Number(row.partialPnl);
          }
        }
        return total;
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        logger.error("system", "Failed to get daily PnL", { error: message });
        return 0;
      }
    },

    async getRecentClosedPnls(botName: BotName, limit: number): Promise<number[]> {
      try {
        const rows = await db
          .select({ pnl: trades.pnl, partialPnl: trades.partialPnl })
          .from(trades)
          .where(and(eq(trades.botName, botName), eq(trades.status, "closed")))
          .orderBy(desc(trades.closedAt))
          .limit(limit);

        return rows
          .filter((r) => r.pnl != null)
          .map((r) => Number(r.pnl) + (r.partialPnl != null ? Number(r.partialPnl) : 0));
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        logger.error("system", "Failed to get recent PnLs", { error: message });
        return [];
      }
    },

    async updateBotStatus(status: BotStatusRecord): Promise<void> {
      try {
        await db
          .insert(botStatus)
          .values({
            botName: status.bot_name,
            isActive: status.is_active,
            isHalted: status.is_halted,
            lastRunAt: new Date(status.last_run_at),
            currentPosition: status.current_position,
          })
          .onConflictDoUpdate({
            target: botStatus.botName,
            set: {
              isActive: status.is_active,
              isHalted: status.is_halted,
              lastRunAt: new Date(status.last_run_at),
              currentPosition: status.current_position,
            },
          });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        logger.error("system", "Failed to update bot status", { error: message });
      }
    },
  };
}
