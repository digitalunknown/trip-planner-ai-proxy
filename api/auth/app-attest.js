import { loadConfig } from "../../lib/config.js";
import { Store } from "../../lib/store.js";
import { issueAppToken } from "../../lib/token.js";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }
  const cfg = loadConfig();
  const store = new Store({ url: cfg.kvUrl, token: cfg.kvToken });

  try {
    const body =
      typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body ?? {};
    const keyId = String(body?.keyId || "").trim();
    const attestationObject = body?.attestationObject || null; // base64url CBOR
    const clientDataHash = body?.clientDataHash || null; // base64
    const challenge = body?.challenge || null; // raw/random (server-provided)
    const appleTransactionJws = body?.appleTransactionJws || null;

    if (!cfg.appTokenSecret) {
      return res
        .status(500)
        .json({ error: "APP_TOKEN_SECRET not set; cannot issue tokens" });
    }
    if (!keyId) {
      return res.status(400).json({ error: "Missing keyId" });
    }

    // NOTE: Full App Attest verification (cert chain, nonce, app ID) is nontrivial.
    // In log/off modes, we accept and record the key without enforcing attestation.
    // In enforce mode, we require the attestationObject to be present; detailed
    // verification can be added here or via an external verifier.
    const enforce = cfg.authMode === "enforce";
    if (enforce && !attestationObject) {
      return res.status(400).json({ error: "Missing attestationObject in enforce mode" });
    }

    const attestedKey = {
      keyId,
      createdAt: Date.now(),
      // Placeholders — set by a real verifier if available.
      teamId: process.env.APPLE_TEAM_ID || null,
      bundleId: process.env.IOS_BUNDLE_ID || null,
      clientDataHash: clientDataHash || null,
      challenge: challenge || null,
      appleTxnSeen: Boolean(appleTransactionJws),
    };
    // Persist with a long shelf life; quotas and tokens are separate entries.
    try {
      await store.set(`attest:${keyId}`, JSON.stringify(attestedKey), {
        exSeconds: 90 * 24 * 3600, // ~90 days
      });
    } catch {
      // Fail-open: do not block token issuance on KV errors
    }

    // Tier comes ONLY from a verified token. Do NOT trust a JWS string.
    // TODO: Add real StoreKit server verification and map valid entitlements to "plus".
    const tier = "free";
    const token = issueAppToken({
      keyId,
      tier,
      ttlSeconds: cfg.appTokenTtlSeconds,
      secret: cfg.appTokenSecret,
    });
    return res.status(200).json({
      ok: true,
      keyId,
      tier,
      token,
      expiresInSeconds: cfg.appTokenTtlSeconds,
      mode: cfg.authMode,
    });
  } catch (err) {
    return res.status(500).json({ error: String(err?.message || err) });
  }
}

