import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Exchange, OHLCV, TradingPair, Timeframe } from "../types/index.js";

const DATA_DIR = join(import.meta.dirname, "data");

/** Timeframe → milliseconds per candle */
const TIMEFRAME_MS: Record<Timeframe, number> = {
  "1m": 60_000,
  "5m": 5 * 60_000,
  "15m": 15 * 60_000,
  "1h": 60 * 60_000,
  "4h": 4 * 60 * 60_000,
  "1d": 24 * 60 * 60_000,
};

/** Max candles per request (KuCoin limit) */
const CHUNK_SIZE = 1500;

/**
 * Generate a cache file name from fetch parameters.
 * e.g. "BTC_USDT-1h-2024-01-01-2024-04-01.json"
 */
function cacheFileName(
  pair: TradingPair,
  timeframe: Timeframe,
  startDate: Date,
  endDate: Date,
): string {
  const pairSlug = pair.replace("/", "_");
  const startStr = startDate.toISOString().slice(0, 10);
  const endStr = endDate.toISOString().slice(0, 10);
  return `${pairSlug}-${timeframe}-${startStr}-${endStr}.json`;
}

/**
 * Try to load cached data from disk.
 */
async function loadFromCache(fileName: string): Promise<OHLCV[] | null> {
  try {
    const filePath = join(DATA_DIR, fileName);
    const raw = await readFile(filePath, "utf-8");
    const data: unknown = JSON.parse(raw);
    if (!Array.isArray(data)) return null;
    return data as OHLCV[];
  } catch {
    return null;
  }
}

/**
 * Save data to cache on disk.
 */
async function saveToCache(fileName: string, data: readonly OHLCV[]): Promise<void> {
  await mkdir(DATA_DIR, { recursive: true });
  const filePath = join(DATA_DIR, fileName);
  await writeFile(filePath, JSON.stringify(data, null, 2), "utf-8");
}

/**
 * Fetch historical OHLCV data from the exchange, with pagination and caching.
 *
 * - Fetches data in chunks of up to 1500 candles (KuCoin limit)
 * - Caches the result to `backtest/data/` as JSON to avoid refetching
 * - Returns candles sorted oldest-first
 */
export async function fetchHistoricalData(params: {
  pair: TradingPair;
  timeframe: Timeframe;
  startDate: Date;
  endDate: Date;
  exchange: Exchange;
}): Promise<OHLCV[]> {
  const { pair, timeframe, startDate, endDate, exchange } = params;
  const fileName = cacheFileName(pair, timeframe, startDate, endDate);

  // Try cache first
  const cached = await loadFromCache(fileName);
  if (cached !== null && cached.length > 0) {
    console.log(`Loaded ${cached.length} candles from cache: ${fileName}`);
    return cached;
  }

  console.log(`Fetching historical data for ${pair} ${timeframe} from ${startDate.toISOString()} to ${endDate.toISOString()}...`);

  const candleMs = TIMEFRAME_MS[timeframe];
  const allCandles: OHLCV[] = [];
  let currentSince = startDate.getTime();
  const endMs = endDate.getTime();

  while (currentSince < endMs) {
    // Calculate how many candles to fetch in this chunk
    const remainingMs = endMs - currentSince;
    const remainingCandles = Math.ceil(remainingMs / candleMs);
    const limit = Math.min(remainingCandles, CHUNK_SIZE);

    const chunk = await exchange.fetchOHLCV(pair, timeframe, limit);

    if (chunk.length === 0) {
      break;
    }

    // Filter to only candles within our date range
    const filtered = chunk.filter(
      (c) => c.timestamp >= startDate.getTime() && c.timestamp <= endMs,
    );

    for (const candle of filtered) {
      // Avoid duplicates
      if (!allCandles.some((c) => c.timestamp === candle.timestamp)) {
        allCandles.push(candle);
      }
    }

    // Advance since to after the last candle we received
    const lastCandle = chunk[chunk.length - 1];
    if (lastCandle === undefined) break;

    const nextSince = lastCandle.timestamp + candleMs;
    if (nextSince <= currentSince) {
      // No progress; stop to avoid infinite loop
      break;
    }
    currentSince = nextSince;

    // Brief pause to respect rate limits
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  // Sort oldest first
  allCandles.sort((a, b) => a.timestamp - b.timestamp);

  console.log(`Fetched ${allCandles.length} candles for ${pair}`);

  // Cache to disk
  await saveToCache(fileName, allCandles);
  console.log(`Cached to ${fileName}`);

  return allCandles;
}
