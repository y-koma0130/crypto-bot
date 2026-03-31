import type {
  BotName,
  BotStatusRecord,
  Repository,
  SignalRecord,
  TradingPair,
  TradeRecord,
} from "../types/index.js";

/**
 * Create a no-op Repository for backtesting.
 * All methods return empty/default values without persisting anything.
 */
export function createMockRepository(): Repository {
  let idCounter = 0;

  return {
    async insertTrade(_trade: TradeRecord): Promise<string> {
      idCounter++;
      return `mock-trade-${String(idCounter)}`;
    },

    async closeTrade(
      _id: string,
      _exitPrice: number,
      _pnl: number,
    ): Promise<void> {
      // no-op
    },

    async findOpenTrade(
      _botName: BotName,
      _symbol: TradingPair,
    ): Promise<TradeRecord | null> {
      return null;
    },

    async findOpenTrades(_botName: BotName): Promise<TradeRecord[]> {
      return [];
    },

    async insertSignal(_signal: SignalRecord): Promise<void> {
      // no-op
    },

    async updateBotStatus(_status: BotStatusRecord): Promise<void> {
      // no-op
    },

    async getDailyPnl(): Promise<number> {
      return 0;
    },
  };
}
