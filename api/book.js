// /api/book.js — Vercel Serverless Function
// Validates incoming booking payload and returns server-generated id + timestamp.
// NOTE: No persistent storage here (Vercel functions are stateless). Plug in a DB/KV later if needed.

export default async function handler(req, res) {
  // Basic CORS (same-origin on Vercel doesn't need it, but harmless)
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  // Robust JSON body parse (works whether body is already parsed or raw)
  let body = req.body;
  if (!body || typeof body === 'string') {
    try {
      const raw = typeof body === 'string' ? body : await readRaw(req);
      body = raw ? JSON.parse(raw) : {};
    } catch (e) {
      return res.status(400).json({ ok: false, error: 'Invalid JSON body' });
    }
  }

  const data = body || {};

  // Validation (match the frontend rules)
  const errs = [];
  if (!data.namn) errs.push('Namn saknas');
  if (!/^\s*07\d[\d\s-]{6,}\s*$/.test(data.telefon || '')) errs.push('Telefon (svenskt mobilnr) ogiltigt');
  if (data.email && !/^\S+@\S+\.\S+$/.test(data.email)) errs.push('E-postadress ogiltig');
  if (!data.adress) errs.push('Adress saknas');
  if (!data.postnummer) errs.push('Postnummer saknas');
  if (!data.ort) errs.push('Ort saknas');
  if (!data.antalPasar || Number(data.antalPasar) < 0) errs.push('Antal påsar ogiltigt');
  if (!data.pantBelopp || Number(data.pantBelopp) < 0) errs.push('Pantbelopp ogiltigt');
  if (!data.onskadHamtningsTid) errs.push('Önskad hämtning saknas');
  if ((data.utbetalning === 'swish') && !/^\s*07\d[\d\s-]{6,}\s*$/.test(data.swish || '')) errs.push('Swish-nummer ogiltigt');

  if (errs.length) {
    return res.status(400).json({ ok: false, error: 'Validation error', details: errs });
  }

  const serverId = 'svr_' + Math.random().toString(36).slice(2);
  const serverTime = new Date().toISOString();

  // TODO: Persist somewhere (KV/DB/email/webhook) if desired.
  // Example stub (disabled): await saveToKV({ serverId, serverTime, ...data })

  return res.status(200).json({ ok: true, serverId, serverTime });
}

function readRaw(req) {
  return new Promise((resolve, reject) => {
    try {
      let raw = '';
      req.on('data', (c) => raw += c);
      req.on('end', () => resolve(raw));
      req.on('error', reject);
    } catch (e) {
      reject(e);
    }
  });
}
