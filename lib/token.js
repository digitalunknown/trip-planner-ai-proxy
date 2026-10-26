// Minimal HMAC token (JWT-like) for device/app clients without external deps.
import crypto from "crypto";

function base64url(input) {
  return Buffer.from(input)
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}
function fromBase64url(s) {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  const pad = s.length % 4;
  if (pad) s += "=".repeat(4 - pad);
  return Buffer.from(s, "base64");
}

export function signToken(payload, secret) {
  const header = { alg: "HS256", typ: "JWT" };
  const body = { ...payload };
  const enc = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(body))}`;
  const sig = crypto.createHmac("sha256", secret).update(enc).digest();
  return `${enc}.${base64url(sig)}`;
}

export function verifyToken(token, secret) {
  if (!token || !secret) return { ok: false, error: "missing" };
  const parts = String(token).split(".");
  if (parts.length !== 3) return { ok: false, error: "format" };
  const [h, p, s] = parts;
  const toSign = `${h}.${p}`;
  const expected = crypto.createHmac("sha256", secret).update(toSign).digest();
  const given = fromBase64url(s);
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) {
    return { ok: false, error: "signature" };
  }
  let payload;
  try {
    payload = JSON.parse(fromBase64url(p).toString("utf8"));
  } catch {
    return { ok: false, error: "payload" };
  }
  const nowSec = Math.floor(Date.now() / 1000);
  if (typeof payload.exp === "number" && nowSec >= payload.exp) {
    return { ok: false, error: "expired", payload };
  }
  return { ok: true, payload };
}

export function issueAppToken({
  keyId,
  tier = "free",
  originalTransactionId = null,
  ttlSeconds = 900,
  secret = "",
}) {
  const nowSec = Math.floor(Date.now() / 1000);
  const payload = {
    sub: "tripstacks-app",
    k: String(keyId || ""),
    t: String(tier || "free"),
    txn: originalTransactionId ? String(originalTransactionId) : undefined,
    iat: nowSec,
    exp: nowSec + Number(ttlSeconds || 900),
  };
  return signToken(payload, secret);
}

