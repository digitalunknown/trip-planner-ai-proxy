// Authentication and service wiring helpers for the AI proxy.
// Keep lightweight and dependency-free.
import { loadConfig } from "./config.js";
import { Store } from "./store.js";
import { RateLimiter } from "./rateLimit.js";
import { QuotaManager } from "./quota.js";
import { SpendMeter } from "./pricing.js";
import { verifyToken } from "./token.js";

export function buildServices() {
  const cfg = loadConfig();
  const store = new Store({ url: cfg.kvUrl, token: cfg.kvToken });
  const rl = new RateLimiter(store, {
    windowSeconds: cfg.rateLimitWindowSeconds,
    perKey: cfg.rateLimitPerKey,
    perIp: cfg.rateLimitPerIp,
  });
  const quota = new QuotaManager(store, {
    freeMonthly: cfg.freeMonthlyCredits,
    plusMonthly: cfg.plusMonthlyCredits,
    costs: cfg.creditCosts,
  });
  const spend = new SpendMeter(store, {
    modelPricing: cfg.modelPricing,
    dailyLimitUsd: cfg.dailySpendLimitUsd,
  });
  return { cfg, store, rl, quota, spend };
}

function readBearerToken(req) {
  const headers = (req && req.headers) || {};
  const auth = headers.authorization || headers.Authorization || "";
  if (typeof auth === "string" && auth.toLowerCase().startsWith("bearer ")) {
    return auth.slice(7).trim();
  }
  const x = headers["x-app-token"] || headers["X-App-Token"];
  return typeof x === "string" ? x.trim() : "";
}

function readClientIp(req) {
  const headers = (req && req.headers) || {};
  const xff = headers["x-forwarded-for"] || headers["X-Forwarded-For"];
  if (typeof xff === "string" && xff.trim() !== "") {
    // Use first entry in XFF
    const first = xff.split(",")[0].trim();
    if (first) return first;
  }
  const xrip = headers["x-real-ip"] || headers["X-Real-IP"];
  if (typeof xrip === "string" && xrip.trim() !== "") return xrip.trim();
  // Fallbacks (best-effort)
  return (req && req.socket && req.socket.remoteAddress) || null;
}

// Never throws. Missing/invalid token → keyId null, tier "free".
export async function authenticateRequest(req, services) {
  const cfg = services?.cfg || loadConfig();
  const token = readBearerToken(req);
  let keyId = null;
  let tier = "free";
  let tokenValid = false;
  if (token && cfg.appTokenSecret) {
    try {
      const v = verifyToken(token, cfg.appTokenSecret);
      if (v.ok && v.payload) {
        keyId = v.payload.k ? String(v.payload.k) : null;
        tier = v.payload.t === "plus" ? "plus" : "free";
        tokenValid = true;
      }
    } catch {
      // Treat as anonymous/free
      keyId = null;
      tier = "free";
      tokenValid = false;
    }
  }
  const ip = readClientIp(req);
  return { keyId, tier, ip, tokenValid };
}

export function structuredRateLimitError({
  scope,
  retryAfterSeconds,
  remaining = [],
}) {
  const seconds = Math.max(0, Number(retryAfterSeconds || 0));
  return {
    status: 429,
    headers: { "Retry-After": String(seconds) },
    body: {
      error: "rate_limited",
      scope: scope || null,
      retryAfterSeconds: seconds,
      remaining: Array.isArray(remaining) ? remaining : [],
    },
  };
}

export function structuredQuotaError({ tier, cost, balance }) {
  return {
    status: 402,
    headers: {},
    body: {
      error: "insufficient_credits",
      tier: tier || "free",
      cost: Number(cost || 0),
      balance: balance || null,
    },
  };
}

export function structuredSpendLimitError({ used, limit }) {
  return {
    status: 503,
    headers: {},
    body: {
      error: "spend_limit",
      used: Number(used || 0),
      limit: Number(limit || 0),
    },
  };
}

export function responseWithStructuredError(res, structured) {
  const status = Number(structured?.status || 400);
  const headers = structured?.headers || {};
  for (const [k, v] of Object.entries(headers)) {
    try {
      res.setHeader(k, v);
    } catch {
      // ignore header set failures
    }
  }
  return res.status(status).json(structured?.body || { error: "error" });
}

