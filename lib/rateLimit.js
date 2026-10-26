import { Store } from "./store.js";

export class RateLimiter {
  constructor(store, { windowSeconds = 60, perKey = 60, perIp = 120 } = {}) {
    this.store = store;
    this.windowMs = Math.max(1, Number(windowSeconds || 60)) * 1000;
    this.perKey = Math.max(1, Number(perKey || 60));
    this.perIp = Math.max(1, Number(perIp || 120));
  }

  async check({ keyId, ip }) {
    const now = Date.now();
    const scopes = [];
    if (keyId) {
      const count = await this.store.zaddAndCount(
        `rl:key:${keyId}`,
        now,
        this.windowMs
      );
      scopes.push({ scope: "key", limit: this.perKey, count: count ?? 0 });
    }
    if (ip) {
      const count = await this.store.zaddAndCount(`rl:ip:${ip}`, now, this.windowMs);
      scopes.push({ scope: "ip", limit: this.perIp, count: count ?? 0 });
    }
    const blocked = scopes.find((s) => s.count > s.limit);
    return {
      ok: !blocked,
      blockedScope: blocked?.scope ?? null,
      retryAfterSeconds: blocked ? Math.ceil(this.windowMs / 1000) : 0,
      details: scopes,
    };
  }
}

