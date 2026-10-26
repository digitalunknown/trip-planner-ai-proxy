// Configuration loader for env-based settings with sane defaults.
// Keep logic minimal and dependency-free.
const DEFAULTS = {
  AUTH_MODE: "log", // off|log|enforce
  APP_TOKEN_TTL_SECONDS: 15 * 60,
  RATE_LIMIT_WINDOW_SECONDS: 60,
  RATE_LIMIT_PER_KEY: 60,
  RATE_LIMIT_PER_IP: 120,
  DAILY_SPEND_LIMIT_USD: 50, // soft global breaker; set low for safety in staging
  // Quotas
  FREE_MONTHLY_CREDITS: 5,
  PLUS_MONTHLY_CREDITS: 30,
  // Credit costs per logical mode
  CREDIT_COSTS: {
    plan_day: 1,
    place_finder: 1,
    recommendations: 1,
    create_trip: 3,
    clarification: 0,
  },
  // Model pricing defaults (USD per 1M tokens). Adjust via MODEL_PRICING_JSON.
  // Use keys inputPer1M and outputPer1M. Thinking tokens bill as output.
  MODEL_PRICING: {
    "gemini-3.6-flash": { inputPer1M: 0.75, outputPer1M: 3.75 },
  },
};

function parseJSONEnv(name, fallback) {
  const raw = process.env[name];
  if (!raw) return fallback;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : fallback;
  } catch {
    return fallback;
  }
}

export function loadConfig() {
  const creditCosts = parseJSONEnv("CREDIT_COSTS_JSON", DEFAULTS.CREDIT_COSTS);
  const modelPricing = parseJSONEnv("MODEL_PRICING_JSON", DEFAULTS.MODEL_PRICING);
  const freeMonthly = Number(process.env.FREE_MONTHLY_CREDITS) || DEFAULTS.FREE_MONTHLY_CREDITS;
  const plusMonthly = Number(process.env.PLUS_MONTHLY_CREDITS) || DEFAULTS.PLUS_MONTHLY_CREDITS;
  // Prefer REST variables; accept Upstash aliases too. Ignore a non-HTTPS KV_URL (redis://).
  const restUrl =
    process.env.UPSTASH_REDIS_REST_URL ||
    process.env.KV_REST_API_URL ||
    process.env.KV_URL ||
    "";
  const restToken =
    process.env.UPSTASH_REDIS_REST_TOKEN ||
    process.env.KV_REST_API_TOKEN ||
    process.env.KV_TOKEN ||
    "";
  const kvUrl = typeof restUrl === "string" && restUrl.startsWith("https") ? restUrl : "";
  return {
    authMode: (process.env.AUTH_MODE || DEFAULTS.AUTH_MODE).toLowerCase(),
    appTokenSecret: process.env.APP_TOKEN_SECRET || "",
    appTokenTtlSeconds:
      Number(process.env.APP_TOKEN_TTL_SECONDS) || DEFAULTS.APP_TOKEN_TTL_SECONDS,
    kvUrl,
    kvToken: restToken,
    rateLimitWindowSeconds:
      Number(process.env.RATE_LIMIT_WINDOW_SECONDS) || DEFAULTS.RATE_LIMIT_WINDOW_SECONDS,
    rateLimitPerKey: Number(process.env.RATE_LIMIT_PER_KEY) || DEFAULTS.RATE_LIMIT_PER_KEY,
    rateLimitPerIp: Number(process.env.RATE_LIMIT_PER_IP) || DEFAULTS.RATE_LIMIT_PER_IP,
    dailySpendLimitUsd:
      Number(process.env.DAILY_SPEND_LIMIT_USD) || DEFAULTS.DAILY_SPEND_LIMIT_USD,
    creditCosts,
    freeMonthlyCredits: freeMonthly,
    plusMonthlyCredits: plusMonthly,
    modelPricing,
  };
}

export function currentMonthKey(date = new Date()) {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

export function currentDayKey(date = new Date()) {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

