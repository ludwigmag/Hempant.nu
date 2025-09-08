// /api/book.js — Send owner notifications to Discord via Webhook (no SMS/email accounts)

export default async function handler(req, res) {
  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "Method not allowed" });

  // Parse JSON
  let data = req.body;
  if (!data || typeof data === "string") {
    try {
      const raw = typeof data === "string" ? data : await readRaw(req);
      data = raw ? JSON.parse(raw) : {};
    } catch {
      return res.status(400).json({ ok: false, error: "Invalid JSON body" });
    }
  }

  // Validate (Swedish mobiles only)
  const errs = [];
  if (!data.adress) errs.push("Adress saknas");
  if (!validSEMobile(data.telefon)) errs.push("Telefon ogiltigt (svenskt mobilnummer)");
  if (errs.length) return res.status(400).json({ ok: false, error: "Validation error", details: errs });

  // Rate-limit 60s via signed cookie
  try {
    const now = Date.now();
    const cookieHeader = req.headers.cookie || "";
    const { ts: prevTs } = parseRateCookie(cookieHeader, req) || {};
    if (typeof prevTs === "number" && now - prevTs < 60_000) {
      return res.status(429).json({ ok: false, error: "Rate limited" });
    }
    res.setHeader("Set-Cookie", await buildRateCookie(now, req));
  } catch {}

  // Compose Discord message
  const namn = (data.namn || "").toString().trim();
  const when = (data.onskadHamtningsTid || "").toString().trim();
  const phone = normalizeSE(data.telefon);

  const content = [
    "**Ny pantbokning – HEMPANT**",
    namn ? `**Namn:** ${namn}` : null,
    `**Telefon (Swish):** ${phone}`,
    `**Adress:** ${data.adress}`,
    when ? `**Önskad tid:** ${when}` : null
  ].filter(Boolean).join("\n");

  // Send to Discord
  const hook = process.env.DISCORD_WEBHOOK_URL || "";
  if (!hook) return res.status(500).json({ ok: false, error: "DISCORD_WEBHOOK_URL missing" });

  const resp = await fetch(hook, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content }) // simple text; could use embeds too
  });

  if (!(resp.ok || resp.status === 204)) {
    return res.status(502).json({ ok: false, error: "Notification failed" });
  }

  return res.status(200).json({ ok: true, serverId: uid(), serverTime: new Date().toISOString() });
}

// ----- helpers -----
function validSEMobile(v){
  if (!v) return false;
  const d = String(v).trim().replace(/[^\d+]/g, '');
  const reLocal = /^0?7[02369]\d{7}$/;   // 07XXXXXXXX
  const reE164  = /^\+467[02369]\d{7}$/; // +467XXXXXXXX
  return reLocal.test(d) || reE164.test(d);
}
function normalizeSE(v){
  const d = String(v).trim().replace(/[^\d+]/g, '');
  if (/^\+467[02369]\d{7}$/.test(d)) return d;
  if (/^07[02369]\d{7}$/.test(d)) return "+46" + d.slice(1);
  return d;
}
function readRaw(req){
  return new Promise((resolve, reject) => {
    let raw = ""; req.on("data", c => raw += c);
    req.on("end", () => resolve(raw)); req.on("error", reject);
  });
}

import crypto from "node:crypto";
const COOKIE_NAME = "rl";
const MAX_AGE = 60 * 60 * 24;
function parseRateCookie(header, req){
  const c = parseCookie(header)[COOKIE_NAME]; if (!c) return null;
  try{
    const [p,s] = c.split("."); if (!p || !s) return null;
    const expected = sign(p, secret(), clientKey(req)); if (s !== expected) return null;
    return JSON.parse(Buffer.from(p, "base64").toString("utf8"));
  }catch{ return null; }
}
async function buildRateCookie(ts, req){
  const p = Buffer.from(JSON.stringify({ ts }), "utf8").toString("base64");
  const s = sign(p, secret(), clientKey(req));
  return `${COOKIE_NAME}=${p}.${s}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${MAX_AGE}`;
}
function sign(p, key, extra){ const h=crypto.createHmac("sha256", key || "weak"); h.update(p + "|" + extra); return h.digest("base64url"); }
function clientKey(req){ const xff=(req.headers["x-forwarded-for"]||"")+"", ip = xff.split(",")[0].trim() || "unknown"; return ip; }
function secret(){ return process.env.RATE_LIMIT_SECRET || ""; }
function parseCookie(h){ const o={}; if(!h) return o; for(const part of h.split(";")){ const p=part.trim(); const i=p.indexOf("="); if(i>-1) o[p.slice(0,i)] = p.slice(i+1); } return o; }
function uid(){ return "svr_" + Math.random().toString(36).slice(2); }
