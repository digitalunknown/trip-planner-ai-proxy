// Unit tests for auth token, quota manager, and rate limiter
// Run: node --test test/auth_quota_rl.test.mjs
import test from "node:test";
import assert from "node:assert/strict";

import { issueAppToken, verifyToken } from "../lib/token.js";
import { Store } from "../lib/store.js";
import { QuotaManager } from "../lib/quota.js";
import { RateLimiter } from "../lib/rateLimit.js";

test("issue and verify app token", () => {
  const secret = "s3cr3t";
  const token = issueAppToken({
    keyId: "ABC123",
    tier: "plus",
    ttlSeconds: 60,
    secret,
  });
  const v = verifyToken(token, secret);
  assert.equal(v.ok, true);
  assert.equal(v.payload.k, "ABC123");
  assert.equal(v.payload.t, "plus");
});

test("quota manager consumes within monthly limits", async () => {
  const store = new Store(); // in-memory
  const quota = new QuotaManager(store, {
    freeMonthly: 5,
    plusMonthly: 30,
    costs: { plan_day: 1, create_trip: 3, clarification: 0 },
  });
  const keyId = "key-1";
  // Start balance
  let bal = await quota.getBalance({ keyId, tier: "free" });
  assert.equal(bal.total, 5);
  assert.equal(bal.used, 0);
  // Consume plan_day (1)
  let res = await quota.consume({ keyId, tier: "free", mode: "plan_day" });
  assert.equal(res.ok, true);
  assert.equal(res.used, 1);
  // Clarification should be free (no increment)
  res = await quota.consume({ keyId, tier: "free", mode: "clarification" });
  assert.equal(res.ok, true);
  assert.equal(res.used, 1);
  // Consume create_trip (3) — now used should be 4
  res = await quota.consume({ keyId, tier: "free", mode: "create_trip" });
  assert.equal(res.ok, true);
  assert.equal(res.used, 4);
  // Another create_trip should exceed (needs 3 but remaining 1)
  const pre = await quota.precheck({ keyId, tier: "free", mode: "create_trip" });
  assert.equal(pre.ok, false);
});

test("rate limiter blocks after N in window", async () => {
  const store = new Store();
  const rl = new RateLimiter(store, { windowSeconds: 1, perKey: 3, perIp: 5 });
  const keyId = "k123";
  const ip = "1.2.3.4";
  for (let i = 0; i < 3; i++) {
    const r = await rl.check({ keyId, ip });
    assert.equal(r.ok, true);
  }
  // 4th should block on key scope
  const blocked = await rl.check({ keyId, ip });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.blockedScope, "key");
});

