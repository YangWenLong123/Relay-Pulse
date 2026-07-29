import { config } from '../config.js';
export class BalanceScheduler {
    relays;
    balance;
    timer;
    running = false;
    constructor(relays, balance) {
        this.relays = relays;
        this.balance = balance;
    }
    start() {
        if (this.timer)
            return;
        void this.refreshDueBalances();
        this.timer = setInterval(() => void this.refreshDueBalances(), 60_000);
        this.timer.unref();
    }
    async refreshDueBalances() {
        if (this.running)
            return;
        this.running = true;
        try {
            const now = Date.now();
            const relays = await this.relays.list();
            const due = relays.filter((relay) => {
                const query = relay.balanceConfig;
                if (!query?.enabled || query.intervalMinutes <= 0 || !relay.balance?.queriedAt)
                    return Boolean(query?.enabled && query.intervalMinutes > 0 && !relay.balance?.queriedAt);
                const previous = Date.parse(relay.balance.queriedAt);
                return Number.isFinite(previous) && now - previous >= query.intervalMinutes * 60_000;
            });
            for (let index = 0; index < due.length; index += config.batchConcurrency) {
                await Promise.allSettled(due.slice(index, index + config.batchConcurrency).map((relay) => this.balance.query(relay.id)));
            }
        }
        finally {
            this.running = false;
        }
    }
}
