require("dotenv").config();

const express = require("express");
const helmet = require("helmet");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const http = require("http");
const https = require("https");
const path = require("path");

const app = express();
const port = Number(process.env.PORT || 3000);

const metabaseSecretKey = process.env.METABASE_SECRET_KEY;
const metabaseSiteUrl = process.env.METABASE_SITE_URL;
const allowedOrigins = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);
const allowedDashboardIds = (process.env.DASHBOARD_ALLOWLIST || "2")
  .split(",")
  .map((id) => Number(id.trim()))
  .filter((id) => Number.isInteger(id) && id > 0);
const tokenWindowMs = Number(process.env.TOKEN_RATE_WINDOW_MS || 60_000);
const tokenMaxRequests = Number(process.env.TOKEN_RATE_MAX || 30);
const trustProxy = process.env.TRUST_PROXY === "true";
const internalApiKey = process.env.INTERNAL_API_KEY || "";
const tokenRequestLog = new Map();

function hasRequiredMetabaseConfig() {
  return Boolean(metabaseSecretKey && metabaseSiteUrl);
}

function respondMissingConfig(res) {
  return res.status(500).json({
    error: "Server is missing METABASE_SECRET_KEY or METABASE_SITE_URL."
  });
}

function normalizeOrigin(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\/$/, "");
}

app.use(express.json());
app.set("trust proxy", trustProxy);
app.use(
  helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false
  })
);
app.use(express.static(path.join(__dirname, "public")));

function isOriginAllowed(origin) {
  const normalizedOrigin = normalizeOrigin(origin);

  if (!normalizedOrigin) {
    return true;
  }

  if (allowedOrigins.length === 0) {
    return true;
  }

  const normalizedAllowlist = allowedOrigins.map((item) => normalizeOrigin(item));

  if (normalizedAllowlist.includes("*")) {
    return true;
  }

  return normalizedAllowlist.includes(normalizedOrigin);
}

function isRateLimited(ipAddress, now) {
  const existing = tokenRequestLog.get(ipAddress);

  if (!existing || now - existing.windowStart >= tokenWindowMs) {
    tokenRequestLog.set(ipAddress, { count: 1, windowStart: now });
    return false;
  }

  existing.count += 1;
  tokenRequestLog.set(ipAddress, existing);
  return existing.count > tokenMaxRequests;
}

function safeEqual(left, right) {
  const leftBuffer = Buffer.from(String(left));
  const rightBuffer = Buffer.from(String(right));

  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function extractProvidedApiKey(req) {
  const headerValue = req.headers["x-embed-key"];
  const authHeader = req.headers.authorization || "";

  if (headerValue) {
    return String(headerValue).trim();
  }

  if (authHeader.toLowerCase().startsWith("bearer ")) {
    return authHeader.slice(7).trim();
  }

  return "";
}

function checkMetabaseHealth(timeoutMs = 2500) {
  if (!metabaseSiteUrl) {
    return Promise.resolve({ ok: false, error: "METABASE_SITE_URL is missing." });
  }

  const healthUrl = new URL("/api/health", metabaseSiteUrl);
  const client = healthUrl.protocol === "https:" ? https : http;

  return new Promise((resolve) => {
    const req = client.request(
      healthUrl,
      {
        method: "GET",
        timeout: timeoutMs,
        headers: {
          Accept: "application/json"
        }
      },
      (resp) => {
        let body = "";

        resp.on("data", (chunk) => {
          body += chunk;
        });

        resp.on("end", () => {
          resolve({
            ok: resp.statusCode >= 200 && resp.statusCode < 300,
            statusCode: resp.statusCode,
            body: body.slice(0, 500)
          });
        });
      }
    );

    req.on("timeout", () => {
      req.destroy();
      resolve({ ok: false, error: "Metabase health check timeout." });
    });

    req.on("error", (error) => {
      resolve({ ok: false, error: error.message });
    });

    req.end();
  });
}

app.use("/api/metabase/dashboard-token", (req, res, next) => {
  const requestOrigin = req.headers.origin;
  const requestHost = req.headers.host;
  const requestProto = req.headers["x-forwarded-proto"] || req.protocol || "https";
  const requestHostOrigin = requestHost ? `${requestProto}://${requestHost}` : "";
  const sameOriginRequest =
    normalizeOrigin(requestOrigin) &&
    normalizeOrigin(requestHostOrigin) &&
    normalizeOrigin(requestOrigin) === normalizeOrigin(requestHostOrigin);

  if (!sameOriginRequest && !isOriginAllowed(requestOrigin)) {
    console.warn(
      `[AUDIT] blocked_origin ip=${req.ip || "unknown"} origin=${requestOrigin || "none"}`
    );
    return res.status(403).json({ error: "Origin not allowed." });
  }

  if (requestOrigin) {
    res.setHeader("Access-Control-Allow-Origin", requestOrigin);
    res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Embed-Key");
    res.setHeader("Vary", "Origin");
  }

  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed." });
  }

  if (internalApiKey) {
    const providedApiKey = extractProvidedApiKey(req);

    if (!providedApiKey || !safeEqual(providedApiKey, internalApiKey)) {
      console.warn(`[AUDIT] invalid_api_key ip=${req.ip || "unknown"}`);
      return res.status(401).json({ error: "Unauthorized." });
    }
  }

  const clientIp = req.ip || req.socket.remoteAddress || "unknown";
  const now = Date.now();

  if (isRateLimited(clientIp, now)) {
    console.warn(`[AUDIT] rate_limited ip=${clientIp}`);
    return res.status(429).json({ error: "Too many requests. Please retry later." });
  }

  return next();
});

app.get("/api/metabase/dashboard-token", (req, res) => {
  if (!hasRequiredMetabaseConfig()) {
    return respondMissingConfig(res);
  }

  const dashboardId = Number(req.query.dashboardId || 2);

  if (!Number.isInteger(dashboardId) || dashboardId <= 0) {
    return res.status(400).json({ error: "dashboardId must be a positive integer." });
  }

  if (!allowedDashboardIds.includes(dashboardId)) {
    return res.status(403).json({ error: "Requested dashboardId is not allowed." });
  }

  const payload = {
    resource: { dashboard: dashboardId },
    params: {},
    exp: Math.round(Date.now() / 1000) + 60 * 5
  };

  try {
    const token = jwt.sign(payload, metabaseSecretKey);
    console.info(`[AUDIT] token_issued ip=${req.ip || "unknown"} dashboardId=${dashboardId}`);
    return res.json({ token, siteUrl: metabaseSiteUrl, dashboardId });
  } catch (error) {
    console.error(`[AUDIT] token_issue_failed ip=${req.ip || "unknown"}`);
    return res.status(500).json({ error: "Failed to generate token." });
  }
});

app.get("/health", async (_req, res) => {
  const metabaseHealth = await checkMetabaseHealth();
  const ok = Boolean(metabaseHealth.ok) && hasRequiredMetabaseConfig();

  return res.status(ok ? 200 : 503).json({
    ok,
    service: "metabase-embed-gateway",
    metabase: metabaseHealth
  });
});

if (!process.env.VERCEL) {
  app.listen(port, () => {
    console.log(`Server listening on http://localhost:${port}`);
  });
}

module.exports = app;