import { currentMonthKey } from "./config.js";

function endOfUtcMonthMs(date = new Date()) {
  const y = date.getUTCFullYear();
  const m = date.getUTCMonth();
  const firstNext = Date.UTC(y, m + 1, 1, 0, 0, 0, 0);
  return firstNext;
}

export class QuotaManager {
  constructor(store, { freeMonthly = 5, plusMonthly = 30, costs = {} } = {}) {
    this.store = store;
    this.freeMonthly = Number(freeMonthly || 5);
    this.plusMonthly = Number(plusMonthly || 30);
    this.costs = {
      plan_day: 1,
      place_finder: 1,
      recommendations: 1,
      create_trip: 3,
      clarification: 0,
      ...(costs || {}),
    };
  }

  creditCostForMode(mode) {
    return Number(this.costs?.[mode] ?? 1);
  }

  async getBalance({ keyId, tier, now = new Date() } = {}) {
    if (!keyId) return { total: 0, used: 0, remaining: 0, resetAt: null };
    const month = currentMonthKey(now);
    const total = tier === "plus" ? this.plusMonthly : this.freeMonthly;
    const key = `quota:${month}:${tier}:${keyId}`;
    const usedRaw = await this.store.get(key);
    const used = Number(usedRaw || 0);
    const resetAt = endOfUtcMonthMs(now);
    return {
      total,
      used,
      remaining: Math.max(0, total - used),
      resetAt,
      key,
    };
  }

  async precheck({ keyId, tier, mode, now = new Date() } = {}) {
    const cost = this.creditCostForMode(mode);
    const bal = await this.getBalance({ keyId, tier, now });
    return {
      ok: bal.remaining >= cost,
      cost,
      balance: bal,
    };
  }

  async consume({ keyId, tier, mode, now = new Date() } = {}) {
    const { ok, cost, balance } = await this.precheck({ keyId, tier, mode, now });
    if (!ok) {
      return {
        ok: false,
        reason: "insufficient_credits",
        cost,
        balance,
      };
    }
    const ttlSeconds = await this.store.ttlSecondsTo(balance.resetAt);
    const next = await this.store.incrBy(balance.key, cost, { exSeconds: ttlSeconds });
    const remaining = Math.max(0, balance.total - Number(next || 0));
    return {
      ok: true,
      cost,
      total: balance.total,
      used: Number(next || 0),
      remaining,
      resetAt: balance.resetAt,
    };
  }
}

