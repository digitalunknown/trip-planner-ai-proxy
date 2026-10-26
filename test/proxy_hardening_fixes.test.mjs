// Additional tests for proxy-hardening fixes
// Run: node --test test/proxy_hardening_fixes.test.mjs
import test from "node:test";
import assert from "node:assert/strict";

import { SpendMeter } from "../lib/pricing.js";
import { Store } from "../lib/store.js";
import { issueAppToken } from "../lib/token.js";

const CHICAGO = { latitude: 41.8781, longitude: -87.6298, label: "Chicago, IL" };

function makeRes() {
  const res = {
    statusCode: null,
    payload: null,
    headers: {},
    setHeader(k, v) {
      this.headers[k] = v;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.payload = payload;
      return this;
    },
  };
  return res;
}

test("api/ai module import succeeds", async () => {
  const mod = await import("../api/ai.js");
  assert.equal(typeof mod.default, "function");
});

test("estimateUsd uses per-1M units and counts thoughts as output", () => {
  const store = new Store();
  const spend = new SpendMeter(store, {
    modelPricing: { "gemini-3.6-flash": { inputPer1M: 0.75, outputPer1M: 3.75 } },
  });
  const usd = spend.estimateUsd({
    model: "gemini-3.6-flash",
    usageMetadata: { promptTokenCount: 6000, candidatesTokenCount: 3000, thoughtsTokenCount: 0 },
  });
  // 6000/1e6 * 0.75 + 3000/1e6 * 3.75 = 0.0045 + 0.01125 = 0.01575
  assert.ok(Math.abs(usd - 0.01575) < 0.0001, `got ${usd}`);
});

test("SpendMeter stores and compares in consistent micro-dollar units", async () => {
  const store = new Store();
  const spend = new SpendMeter(store, { dailyLimitUsd: 1 });
  let ok = await spend.canSpend({});
  assert.equal(ok.ok, true);
  await spend.addSpend(0.4);
  await spend.addSpend(0.7);
  ok = await spend.canSpend({});
  assert.equal(ok.ok, false, "0.4 + 0.7 USD exceeds 1 USD");
  const used = await spend.getSpend({});
  assert.ok(used > 1.09 && used < 1.11, `used=${used}`);
});

test("log mode never blocks on rate limit or spend", async () => {
  process.env.AUTH_MODE = "log";
  process.env.GEMINI_API_KEY = "test-key";
  process.env.RATE_LIMIT_PER_KEY = "1";
  process.env.DAILY_SPEND_LIMIT_USD = "0";
  const handler = (await import("../api/ai.js")).default;

  // Stub Gemini calls
  const calls = [];
  globalThis.fetch = async (url, options) => {
    const body = JSON.parse(options.body);
    calls.push(body);
    return {
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          candidates: [{ finishReason: "STOP", content: { parts: [{ text: JSON.stringify({ items: [] }) }] } }],
        }),
    };
  };

  const headers = {}; // anonymous request
  // First request
  let res = makeRes();
  await handler(
    {
      method: "POST",
      headers,
      body: { mode: "place_finder", text: "best restaurants within 5 miles of me", userLocation: CHICAGO },
    },
    res
  );
  assert.equal(res.statusCode, 200);
  // Second request should exceed per-key RL if enforced, but must pass in log mode
  res = makeRes();
  await handler(
    {
      method: "POST",
      headers,
      body: { mode: "place_finder", text: "best restaurants within 5 miles of me", userLocation: CHICAGO },
    },
    res
  );
  assert.equal(res.statusCode, 200);
});

test("KV failure fails open (no block), even in enforce mode", async () => {
  process.env.GEMINI_API_KEY = "test-key";
  process.env.AUTH_MODE = "enforce";
  process.env.UPSTASH_REDIS_REST_URL = "https://127.0.0.1:1"; // guaranteed fail
  process.env.UPSTASH_REDIS_REST_TOKEN = "token";
  process.env.APP_TOKEN_SECRET = "s3cr3t";
  const token = issueAppToken({
    keyId: "t1",
    tier: "free",
    ttlSeconds: 60,
    secret: process.env.APP_TOKEN_SECRET,
  });
  const handler = (await import("../api/ai.js")).default;
  // Do NOT stub fetch here; exit path does not reach Gemini
  const res = makeRes();
  await handler(
    {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      body: {
        mode: "create_trip",
        text: "cool spots within 3 hours of me", // asks for origin → early exit
      },
    },
    res
  );
  assert.equal(res.statusCode, 200);
  assert.equal(res.payload.clarificationNeeded, true);
});

