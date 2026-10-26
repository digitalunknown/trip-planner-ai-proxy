import { currentDayKey } from "./config.js";

function endOfUtcDayMs(date = new Date()) {
  const y = date.getUTCFullYear();
  const m = date.getUTCMonth();
  const d = date.getUTCDate();
  const next = Date.UTC(y, m, d + 1, 0, 0, 0, 0);
  return next;
}

export class SpendMeter {
  constructor(store, { modelPricing = {}, dailyLimitUsd = 50 } = {}) {
    this.store = store;
    this.modelPricing = modelPricing || {};
    this.dailyLimitUsd = Number(dailyLimitUsd || 50);
  }

  estimateUsd({ model, usageMetadata }) {
    // usageMetadata sample shape from Gemini:
    // { promptTokenCount, candidatesTokenCount, totalTokenCount }
    const pr = this.modelPricing?.[model] || { input: 0.0, output: 0.0 };
    const inTok = Number(usageMetadata?.promptTokenCount ?? 0);
    const outTok = Number(usageMetadata?.candidatesTokenCount ?? 0);
    const usd = (inTok / 1000) * Number(pr.input || 0) + (outTok / 1000) * Number(pr.output || 0);
    return Number.isFinite(usd) ? usd : 0;
  }

  async canSpend({ now = new Date() } = {}) {
    const day = currentDayKey(now);
    const key = `spend:${day}:usd`;
    const usedRaw = await this.store.get(key);
    const used = Number(usedRaw || 0);
    return { ok: used < this.dailyLimitUsd, used, limit: this.dailyLimitUsd, key };
  }

  async addSpend(usd, { now = new Date() } = {}) {
    if (!Number.isFinite(usd) || usd <= 0) return;
    const day = currentDayKey(now);
    const key = `spend:${day}:usd`;
    const ttlSeconds = Math.floor((endOfUtcDayMs(now) - Date.now()) / 1000);
    await this.store.incrBy(key, Math.round(usd * 1000), { exSeconds: ttlSeconds }); // store mill (0.001 USD)
  }

  async getSpend({ now = new Date() } = {}) {
    const day = currentDayKey(now);
    const key = `spend:${day}:usd`;
    const usedRaw = await this.store.get(key);
    return Number(usedRaw || 0) / 1000;
  }
}

