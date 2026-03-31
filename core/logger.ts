import { mkdir, appendFile } from "node:fs/promises";
import { join } from "node:path";
import type { BotName, LogEntry, Logger, LogLevel } from "../types/index.js";

const LOGS_DIR = join(process.cwd(), "logs");

const COLORS: Record<LogLevel, string> = {
  info: "\x1b[32m",   // green
  warn: "\x1b[33m",   // yellow
  error: "\x1b[31m",  // red
  debug: "\x1b[90m",  // gray
};

const RESET = "\x1b[0m";

const JST_OFFSET = 9 * 60;

function toJST(date: Date): Date {
  const utc = date.getTime() + date.getTimezoneOffset() * 60_000;
  return new Date(utc + JST_OFFSET * 60_000);
}

function formatTimestamp(date: Date): string {
  const jst = toJST(date);
  const y = jst.getFullYear();
  const mo = String(jst.getMonth() + 1).padStart(2, "0");
  const d = String(jst.getDate()).padStart(2, "0");
  const h = String(jst.getHours()).padStart(2, "0");
  const mi = String(jst.getMinutes()).padStart(2, "0");
  const s = String(jst.getSeconds()).padStart(2, "0");
  const ms = String(jst.getMilliseconds()).padStart(3, "0");
  return `${y}-${mo}-${d}T${h}:${mi}:${s}.${ms}+09:00`;
}

function formatDate(date: Date): string {
  const jst = toJST(date);
  const y = jst.getFullYear();
  const m = String(jst.getMonth() + 1).padStart(2, "0");
  const d = String(jst.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function getLogFilePath(date: Date): string {
  return join(LOGS_DIR, `bot-${formatDate(date)}.log`);
}

function toConsole(entry: LogEntry): void {
  const color = COLORS[entry.level];
  const prefix = `${color}[${entry.level.toUpperCase()}]${RESET}`;
  const bot = `[${entry.bot}]`;
  const dataStr = entry.data ? ` ${JSON.stringify(entry.data)}` : "";
  console.log(`${entry.timestamp} ${prefix} ${bot} ${entry.message}${dataStr}`);
}

const dirReady = mkdir(LOGS_DIR, { recursive: true }).catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`Failed to create logs directory: ${msg}`);
});

async function writeToFile(entry: LogEntry): Promise<void> {
  try {
    await dirReady;
    const line = JSON.stringify(entry) + "\n";
    await appendFile(getLogFilePath(new Date(entry.timestamp)), line, "utf-8");
  } catch (err: unknown) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    console.error(`Failed to write log to file: ${errorMessage}`);
  }
}

function createLogEntry(
  level: LogLevel,
  bot: BotName | "system",
  message: string,
  data?: Record<string, unknown>,
): LogEntry {
  const entry: LogEntry = {
    timestamp: formatTimestamp(new Date()),
    level,
    bot,
    message,
    ...(data !== undefined && { data }),
  };
  return entry;
}

export function createLogger(): Logger {
  const log = (level: LogLevel) => {
    return (bot: BotName | "system", message: string, data?: Record<string, unknown>): void => {
      const entry = createLogEntry(level, bot, message, data);
      toConsole(entry);
      // Fire-and-forget file write; errors are caught internally
      void writeToFile(entry);
    };
  };

  return {
    info: log("info"),
    warn: log("warn"),
    error: log("error"),
    debug: log("debug"),
  };
}
