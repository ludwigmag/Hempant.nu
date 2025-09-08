// /api/book.js — Vercel Serverless Function
// - Receives booking JSON { adress, telefon, namn?, onskadHamtningsTid? }
// - Simple 60s rate-limit via signed cookie (no DB).
// - Sends SMS to owners via Twilio REST API (no npm deps).

// If you prefer Edge runtime, adjust crypto usage to WebCrypto. Node runtime is simplest here.

export default async function handler(req, res) {
  // CORS (safe to leave for same-origin; adjust as needed)
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }

  // Parse JSON robustly
  let body = req.body;
  if (!body || typeof body === "string") {
    try {
      const raw = typeof body === "string" ? body : await readRaw(req);
      body = raw ? JSON.parse(raw) : {};
    } catch {
      return res.status(400).json({ ok: false, error: "Invalid JSON body" });
    }
  }
  const data = body || {};

  // Basic validation
  const errs = [];
  if (!data.adress) errs.push("Adress saknas");
  if (!validPhone(data.telefon)) errs.push("Telefon ogiltigt");
  if (errs.length) return res.status(400).json({ ok: false, error: "Validation error", details: errs });

  // Minimal rate limit with signed cookie
  try {
    const now = Date.now();
    const cookieHeader = req.headers.cookie || "";
    const { ts: prevTs } = parseRateCookie(cookieHeader, req) || {};
    if (typeof prevTs === "number" && now - prevTs < 60_000) {
      return res.status(429).json({ ok: false, error: "Rate limited" });
    }
    // set new cookie
    const setCookie = await buildRateCookie(now, req);
    res.setHeader("Set-Cookie", setCookie);
  } catch {
    // If cookie/signature fails, we still proceed (best effort)
  }

  // Compose SMS
  const namn = (data.namn || "").toString().trim();
  const when = (data.onskadHamtningsTid || "").toString().trim();
  const smsBody =
    `Ny pantbokning:\n` +
    (namn ? `Namn: ${namn}\n` : "") +
    `Telefon (Swish): ${data.telefon}\n` +
    `Adress: ${data.adress}\n` +
    (when ? `Önskad tid: ${when}\n` : "") +
    `— Skickad från hemsidan`;

  // Send via Twilio REST API without dependencies
  const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID || "";
  const TWILIO_AUTH_TOKEN  = process.env.TWILIO_AUTH_TOKEN  || "";
  const TWILIO_FROM        = process.env.TWILIO_FROM        || ""; // e.g. +4670...
  const TWILIO_MSS_SID     = process.env.TWILIO_MESSAGING_SERVICE_SID || "";
  const OWNERS             = (process.env.OWNERS_SMS_NUMBERS || "").split(",").map(s => s.trim()).filter(Boolean);

  if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || (!TWILIO_FROM && !TWILIO_MSS_SID) || OWNERS.length === 0) {
    return res.status(500).json({ ok: false, error: "Server SMS not configured" });
  }

  const auth = Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString("base64");
  const url  = `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Messages.json`;

  let successes = 0, failures = 0;
  for (const to of OWNERS) {
    const params = new URLSearchParams();
    params.append("To", to);
    if (TWILIO_MSS_SID) params.append("MessagingServiceSid", TWILIO_MSS_SID);
    else params.append("From", TWILIO_FROM);
    params.append("Body", smsBody);

    try {
      const resp = await fetch(url, {
        method: "POST",
        headers: {
          "Authorization": `Basic ${auth}`,
          "Content-Type": "application/x-www-form-urlencoded"
        },
        body: params.toString()
      });
      const json = await resp.json().catch(() => ({}));
      if (resp.ok && json && json.sid) successes++;
      else failures++;
    } catch {
      failures++;
    }
  }

  if (successes === 0) {
    return res.status(502).json({ ok: false, error: "SMS send failed" });
  }

  const serverId = "svr_" + Math.random().toString(36).slice(2);
  const serverTime = new Date().toISOString();
  return res.status(200).json({ ok: true, serverId, serverTime, sent: successes, failed: failures });
}

// --- helpers ---

function validPhone(v) {
  if (!v) return false;
  const s = String(v).trim();
  // Very permissive: allow E.164 or typical mobile formats
  return /^\+?\d[\d\s-]{6,}$/.test(s);
}

function readRaw(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", c => raw += c);
    req.on("end", () => resolve(raw));
    req.on("error", reject);
  });
}

// Signed rate-limit cookie (includes IP in signature if available)
import crypto from "node:crypto";

const COOKIE_NAME = "rl";
const MAX_AGE = 60 * 60 * 24; // 1 day

function parseRateCookie(cookieHeader, req) {
  const cookie = parseCookie(cookieHeader)[COOKIE_NAME];
  if (!cookie) return null;
  try {
    const [payloadB64, sigB64] = cookie.split(".");
    if (!payloadB64 || !sigB64) return null;
    const secret = process.env.RATE_LIMIT_SECRET || "";
    const expected = sign(payloadB64, secret, clientKey(req));
    if (sigB64 !== expected) return null;
    const json = JSON.parse(Buffer.from(payloadB64, "base64").toString("utf8"));
    if (typeof json.ts !== "number") return null;
    return { ts: json.ts };
  } catch {
    return null;
  }
}

async function buildRateCookie(ts, req) {
  const payload = { ts };
  const payloadB64 = Buffer.from(JSON.stringify(payload), "utf8").toString("base64");
  const secret = process.env.RATE_LIMIT_SECRET || "";
  const sigB64 = sign(payloadB64, secret, clientKey(req));
  const cookie = `${COOKIE_NAME}=${payloadB64}.${sigB64}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${MAX_AGE}`;
  return cookie;
}

function sign(payloadB64, secret, keyExtra) {
  const h = crypto.createHmac("sha256", secret || "weak-secret");
  h.update(payloadB64 + "|" + keyExtra);
  return h.digest("base64url");
}

function clientKey(req) {
  const xff = (req.headers["x-forwarded-for"] || "").toString();
  const ip = xff.split(",")[0].trim() || "unknown";
  return ip;
}

// Simple cookie parser
function parseCookie(h) {
  const out = {};
  if (!h) return out;
  const parts = h.split(";").map(s => s.trim());
  for (const p of parts) {
    const i = p.indexOf("=");
    if (i > -1) out[p.slice(0, i)] = p.slice(i + 1);
  }
  return out;
}
