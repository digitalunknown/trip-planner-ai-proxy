// Minimal KV store wrapper with Upstash/Vercel KV REST support and in-memory fallback.
// Only implements operations needed by rate limit, quotas, and spend tracking.

const globalMemory = {
  // key -> { value, exp: unixSeconds|null }
  kv: new Map(),
  // key -> array of numbers (timestamps in ms) for sliding window
  zsets: new Map(),
};

const DEFAULT_TIMEOUT_MS = 1500;

function nowMs() {
  return Date.now();
}
function nowSec() {
  return Math.floor(nowMs() / 1000);
}

async function fetchWithTimeout(url, options = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const ac = new AbortController();
  const id = setTimeout(() => ac.abort(), Math.max(50, Number(timeoutMs || DEFAULT_TIMEOUT_MS)));
  try {
    const res = await fetch(url, { ...options, signal: ac.signal });
    return res;
  } finally {
    clearTimeout(id);
  }
}

export class Store {
  constructor({ url, token } = {}) {
    this.url = url || "";
    this.token = token || "";
    this.inMemory = !this.url || !this.token;
  }

  async get(key) {
    if (this.inMemory) {
      const entry = globalMemory.kv.get(key);
      if (!entry) return null;
      if (entry.exp && entry.exp <= nowSec()) {
        globalMemory.kv.delete(key);
        return null;
      }
      return entry.value;
    }
    try {
      const res = await fetchWithTimeout(`${this.url}/get/${encodeURIComponent(key)}`, {
        headers: { Authorization: `Bearer ${this.token}` },
      });
      if (!res.ok) return null;
      const json = await res.json().catch(() => null);
      return json?.result ?? null;
    } catch {
      return null; // fail-open
    }
  }

  async set(key, value, { exSeconds } = {}) {
    if (this.inMemory) {
      globalMemory.kv.set(key, {
        value,
        exp: exSeconds ? nowSec() + Number(exSeconds) : null,
      });
      return true;
    }
    try {
      const body = new URLSearchParams();
      body.set("value", typeof value === "string" ? value : JSON.stringify(value));
      if (exSeconds) body.set("ex", String(exSeconds));
      const res = await fetchWithTimeout(`${this.url}/set/${encodeURIComponent(key)}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.token}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body,
      });
      return res.ok;
    } catch {
      return false; // do not throw
    }
  }

  async incrBy(key, by = 1, { exSeconds } = {}) {
    if (this.inMemory) {
      const entry = globalMemory.kv.get(key);
      const current =
        entry && (!entry.exp || entry.exp > nowSec()) ? Number(entry.value) || 0 : 0;
      const next = current + Number(by);
      globalMemory.kv.set(key, {
        value: String(next),
        exp: exSeconds ? nowSec() + Number(exSeconds) : entry?.exp ?? null,
      });
      return next;
    }
    try {
      const body = new URLSearchParams();
      body.set("value", String(by));
      if (exSeconds) body.set("ex", String(exSeconds));
      const res = await fetchWithTimeout(
        `${this.url}/incrby/${encodeURIComponent(key)}`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.token}`,
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body,
        }
      );
      if (!res.ok) return null;
      const json = await res.json().catch(() => null);
      return Number(json?.result ?? 0);
    } catch {
      return null;
    }
  }

  async ttlSecondsTo(endUnixMs) {
    const ttl = Math.max(0, Math.floor(endUnixMs / 1000) - nowSec());
    return ttl;
  }

  // Sliding window: record an event timestamp for a key and count in [now - windowMs, now]
  async zaddAndCount(key, timestampMs, windowMs) {
    if (this.inMemory) {
      const arr = globalMemory.zsets.get(key) || [];
      const cutoff = timestampMs - windowMs;
      const filtered = arr.filter((t) => t >= cutoff);
      filtered.push(timestampMs);
      globalMemory.zsets.set(key, filtered);
      return filtered.length;
    }
    // Upstash REST: ZADD then ZREMRANGEBYSCORE then ZCOUNT
    try {
      const add = await fetchWithTimeout(`${this.url}/zadd/${encodeURIComponent(key)}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ score: timestampMs, member: String(timestampMs) }),
      });
      if (!add.ok) return null;
      const rem = await fetchWithTimeout(
        `${this.url}/zremrangebyscore/${encodeURIComponent(
          key
        )}/${encodeURIComponent("-inf")}/${encodeURIComponent(timestampMs - windowMs)}`,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${this.token}` },
        }
      );
      if (!rem.ok) return null;
      const cnt = await fetchWithTimeout(
        `${this.url}/zcount/${encodeURIComponent(
          key
        )}/${encodeURIComponent(timestampMs - windowMs)}/${encodeURIComponent("+inf")}`,
        {
          headers: { Authorization: `Bearer ${this.token}` },
        }
      );
      if (!cnt.ok) return null;
      const json = await cnt.json().catch(() => null);
      return Number(json?.result ?? 0);
    } catch {
      return null;
    }
  }
}

