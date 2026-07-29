import { config } from '../config.js';
import { RelayRepository } from '../repositories/relay-repository.js';
import { BalanceService } from './balance-service.js';

export class BalanceScheduler {
  private timer: NodeJS.Timeout | undefined;
  private running = false;

  constructor(
    private readonly relays: RelayRepository,
    private readonly balance: BalanceService
  ) {}

  start(): void {
    if (this.timer) return;
    void this.refreshDueBalances();
    this.timer = setInterval(() => void this.refreshDueBalances(), 60_000);
    this.timer.unref();
  }

  async refreshDueBalances(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const now = Date.now();
      const relays = await this.relays.list();
      const due = relays.filter((relay) => {
        const query = relay.balanceConfig;
        if (!query?.enabled || query.intervalMinutes <= 0 || !relay.balance?.queriedAt) return Boolean(query?.enabled && query.intervalMinutes > 0 && !relay.balance?.queriedAt);
        const previous = Date.parse(relay.balance.queriedAt);
        return Number.isFinite(previous) && now - previous >= query.intervalMinutes * 60_000;
      });
      for (let index = 0; index < due.length; index += config.batchConcurrency) {
        await Promise.allSettled(due.slice(index, index + config.batchConcurrency).map((relay) => this.balance.query(relay.id)));
      }
    } finally {
      this.running = false;
    }
  }
}
