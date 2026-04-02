import { pgTable, uuid, text, numeric, boolean, timestamp, jsonb } from "drizzle-orm/pg-core";

export const trades = pgTable("trades", {
  id: uuid("id").defaultRandom().primaryKey(),
  botName: text("bot_name").notNull(),
  symbol: text("symbol").notNull(),
  side: text("side").notNull(),
  amount: numeric("amount").notNull(),
  entryPrice: numeric("entry_price").notNull(),
  exitPrice: numeric("exit_price"),
  pnl: numeric("pnl"),
  partialExitPrice: numeric("partial_exit_price"),
  partialAmount: numeric("partial_amount"),
  partialPnl: numeric("partial_pnl"),
  partialAt: timestamp("partial_at", { withTimezone: true }),
  status: text("status").notNull().default("open"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  closedAt: timestamp("closed_at", { withTimezone: true }),
});

export const signals = pgTable("signals", {
  id: uuid("id").defaultRandom().primaryKey(),
  botName: text("bot_name").notNull(),
  symbol: text("symbol").notNull(),
  signal: text("signal").notNull(),
  reasoning: text("reasoning"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
});

export const botStatus = pgTable("bot_status", {
  botName: text("bot_name").primaryKey(),
  isActive: boolean("is_active").default(true),
  isHalted: boolean("is_halted").default(false),
  lastRunAt: timestamp("last_run_at", { withTimezone: true }),
  currentPosition: jsonb("current_position"),
});
