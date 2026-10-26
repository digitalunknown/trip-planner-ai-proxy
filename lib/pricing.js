import { currentDayKey } from "./config.js";

function endOfUtcDayMs(date = new Date()) {
  const y = date.getUTCFullYear();
  const m = date.getUTCMonth();
  const d = date.getUTCDate();
  const next = Date.UTC(y, m, d + 1, 0, 0, 0, 0);
  return next;
}

const MICRO_PER_USD = 1_000_000; // store micro-dollars to avoid rounding small calls

export class SpendMeter {
  constructor(store, { modelPricing = {}, dailyLimitUsd = 50 } = {}) {
    this.store = store;
    this.modelPricing = modelPricing || {};
    this.dailyLimitUsd = Number(dailyLimitUsd || 50);
  }

  estimateUsd({ model, usageMetadata }) {
    // usageMetadata sample shape from Gemini:
    // { promptTokenCount, candidatesTokenCount, thoughtsTokenCount, totalTokenCount }
    // Pricing units: USD per 1,000,000 tokens. Output bills on candidates+thoughts tokens.
    const pr = this.modelPricing?.[model] || { inputPer1M: 0.0, outputPer1M: 0.0 };
    const inTok = Number(usageMetadata?.promptTokenCount ?? 0);
    const outTok =
      Number(usageMetadata?.candidatesTokenCount ?? 0) +
      Number(usageMetadata?.thoughtsTokenCount ?? 0);
    const usd =
      (inTok / 1_000_000) * Number(pr.inputPer1M || 0) +
      (outTok / 1_000_000) * Number(pr.outputPer1M || 0);
    return Number.isFinite(usd) ? usd : 0;
  }

  async canSpend({ now = new Date() } = {}) {
    const day = currentDayKey(now);
    const key = `spend:${day}:usd_micro`;
    const usedRaw = await this.store.get(key);
    const usedMicro = Number(usedRaw || 0);
    const limitMicro = Math.round(this.dailyLimitUsd * MICRO_PER_USD);
    return {
      ok: usedMicro < limitMicro,
      used: usedMicro / MICRO_PER_USD,
      limit: this.dailyLimitUsd,
      key,
    };
  }

  async addSpend(usd, { now = new Date() } = {}) {
    if (!Number.isFinite(usd) || usd <= 0) return;
    const day = currentDayKey(now);
    const key = `spend:${day}:usd_micro`;
    const ttlSeconds = Math.floor((endOfUtcDayMs(now) - Date.now()) / 1000);
    // Store integer micro-dollars
    await this.store.incrBy(key, Math.round(usd * MICRO_PER_USD), {
      exSeconds: ttlSeconds,
    });
  }

  async getSpend({ now = new Date() } = {}) {
    const day = currentDayKey(now);
    const key = `spend:${day}:usd_micro`;
    const usedRaw = await this.store.get(key);
    return Number(usedRaw || 0) / MICRO_PER_USD;
  }
}

