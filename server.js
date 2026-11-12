// FairReturn — refund what the policy owes, not the whole order.
// Zero-dependency Node (>=18) server: PayPal sandbox (Orders v2 + Payments v2 refunds) + one LLM call.
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ---------- config ----------
loadDotEnv(path.join(__dirname, '.env'));
const PORT = Number(process.env.PORT || 8787);
const PP_BASE = process.env.PAYPAL_BASE_URL || 'https://api-m.sandbox.paypal.com';
const PP_ID = process.env.PAYPAL_CLIENT_ID || '';
const PP_SECRET = process.env.PAYPAL_CLIENT_SECRET || '';
const LLM_BASE = (process.env.LLM_BASE_URL || process.env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta/openai/').replace(/\/?$/, '/');
const LLM_KEY = process.env.LLM_API_KEY || process.env.GEMINI_API_KEY || '';
const LLM_MODEL = process.env.LLM_MODEL || 'gemini-3.5-flash-lite';
const LLM_MAX_PER_HOUR = Number(process.env.LLM_MAX_PER_HOUR || 60);
const CACHE_FILE = path.join(__dirname, 'cache', 'decisions.json');

function loadDotEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

// ---------- the store's world (demo fixture) ----------
const STORE = { name: 'Hearth & Kettle', customer: 'Maya R.', deliveredDaysAgo: 3 };
const CATALOG = [
  { sku: 'KETTLE', name: 'Glass kettle', cents: 2500 },
  { sku: 'MUGS', name: 'Ceramic mug set (4)', cents: 4000 },
  { sku: 'TEA', name: 'Loose-leaf tea sampler', cents: 1500 },
];
const POLICY = [
  { id: 'R1', text: 'Items damaged on arrival are refunded in full for the damaged item only, if reported within 14 days of delivery.' },
  { id: 'R2', text: 'Undamaged items are refunded only after they are returned unopened within 30 days.' },
  { id: 'R3', text: 'Change-of-mind returns of opened or used items are not eligible.' },
  { id: 'R4', text: 'Shipping is refunded only if every item in the order is refunded.' },
];
const SAMPLES = [
  { label: 'Wants everything back', text: "ok so the kettle showed up cracked?? also tbh the mugs aren't really my style now that I've used them a few times. can I just get my money back for everything" },
  { label: 'Clear damage report', text: 'Hi, my order came today. The glass kettle has a crack down the side. The mugs and the tea are fine, we love them.' },
  { label: 'Too vague to pay', text: 'One of the things in my box arrived broken. Please refund me.' },
];
const usd = (c) => (c / 100).toFixed(2);
const TOTAL = CATALOG.reduce((s, i) => s + i.cents, 0);

// ---------- PayPal ----------
let token = null; // { value, exp }
const orders = new Map(); // key -> { key, orderId, captureId, trace[], decision, refund }

async function ppToken(trace) {
  if (token && token.exp > Date.now() + 60000) return token.value;
  const t0 = Date.now();
  const res = await fetch(PP_BASE + '/v1/oauth2/token', {
    method: 'POST',
    headers: { Authorization: 'Basic ' + Buffer.from(PP_ID + ':' + PP_SECRET).toString('base64'), 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials',
  });
  const j = await res.json().catch(() => ({}));
  trace.push({ method: 'POST', path: '/v1/oauth2/token', status: res.status, ms: Date.now() - t0, what: 'Get an access token with the sandbox app credentials' });
  if (!res.ok || !j.access_token) throw httpError(502, 'PayPal rejected the sandbox credentials. Check PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET.');
  token = { value: j.access_token, exp: Date.now() + (j.expires_in || 300) * 1000 };
  return token.value;
}

async function pp(trace, what, method, apiPath, body, requestId) {
  const tk = await ppToken(trace);
  const t0 = Date.now();
  const headers = { Authorization: 'Bearer ' + tk, 'Content-Type': 'application/json' };
  if (requestId) headers['PayPal-Request-Id'] = requestId;
  const res = await fetch(PP_BASE + apiPath, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const j = await res.json().catch(() => ({}));
  trace.push({ method, path: apiPath, status: res.status, ms: Date.now() - t0, what, requestId: requestId || null, debugId: res.headers.get('paypal-debug-id') || j.debug_id || null });
  return { ok: res.ok, status: res.status, json: j };
}

function ppProblem(r) {
  const issue = r.json && r.json.details && r.json.details[0] && r.json.details[0].issue;
  if (issue === 'PAYEE_NOT_ENABLED_FOR_CARD_PROCESSING') {
    return 'This sandbox business account cannot take card payments. Create a US sandbox Business account, link a new app to it, and use its credentials (see README).';
  }
  return 'PayPal error: ' + (issue || (r.json && r.json.name) || r.status);
}

async function createPaidOrder() {
  const key = crypto.randomBytes(6).toString('hex');
  const o = { key, trace: [], decision: null, refund: null };
  const body = {
    intent: 'CAPTURE',
    purchase_units: [{
      reference_id: 'FR-' + key,
      description: STORE.name + ' order',
      amount: { currency_code: 'USD', value: usd(TOTAL), breakdown: { item_total: { currency_code: 'USD', value: usd(TOTAL) } } },
      items: CATALOG.map((i) => ({ name: i.name, sku: i.sku, quantity: '1', unit_amount: { currency_code: 'USD', value: usd(i.cents) } })),
    }],
    // PayPal's published sandbox test card: lets the demo create a real captured payment with no buyer login.
    payment_source: { card: { number: '4111111111111111', expiry: '2030-12', security_code: '123', name: 'Maya Rivera',
      billing_address: { address_line_1: '1 Main St', admin_area_2: 'San Jose', admin_area_1: 'CA', postal_code: '95131', country_code: 'US' } } },
  };
  const r = await pp(o.trace, 'Customer pays $' + usd(TOTAL) + ' by card: create + capture the order in one call', 'POST', '/v2/checkout/orders', body, 'fr-order-' + key);
  const cap = r.ok && r.json.purchase_units && r.json.purchase_units[0].payments && r.json.purchase_units[0].payments.captures[0];
  if (!cap || cap.status !== 'COMPLETED') throw httpError(502, ppProblem(r));
  o.orderId = r.json.id; o.captureId = cap.id; o.captureStatus = cap.status;
  orders.set(key, o);
  if (orders.size > 500) orders.delete(orders.keys().next().value);
  return o;
}

// ---------- the AI decision ----------
const SYSTEM_PROMPT = [
  'You are a refund adjudicator for an online store. You receive the store policy, one delivered order, and the customer complaint.',
  'For EVERY item in the order decide whether the policy makes it eligible for a refund right now.',
  'Rules of conduct:',
  '- Decide only from what the complaint actually says about each item. What the customer asks for is not evidence.',
  '- Never mention or compute money amounts. The store system does the arithmetic.',
  '- complaint_quote must be copied verbatim from the complaint (a short contiguous span). Use "" if the complaint says nothing about that item.',
  '- If the complaint does not make clear WHICH item has a problem, set needs_human to true and put the single best clarifying question in "question".',
  '- reply is a short, warm message to the customer (max 60 words) explaining the outcome per item in plain language, without amounts.',
  'Output JSON only, exactly this shape:',
  '{"items":[{"sku":"...","eligible":true,"rule":"R1","complaint_quote":"...","why":"max 12 words"}],"needs_human":false,"question":"","reply":"..."}',
].join('\n');

let cache = {};
try { cache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')); } catch (_) { cache = {}; }
const norm = (s) => String(s).toLowerCase().replace(/\s+/g, ' ').trim();
const cacheKey = (complaint) => crypto.createHash('sha256').update(norm(complaint)).digest('hex').slice(0, 24);
let llmCalls = [];

async function askModel(complaint) {
  const now = Date.now();
  llmCalls = llmCalls.filter((t) => now - t < 3600000);
  if (!LLM_KEY) throw httpError(503, 'No LLM key configured, so only the three sample complaints work (their decisions ship with the repo). Set LLM_API_KEY to judge free-text complaints.');
  if (llmCalls.length >= LLM_MAX_PER_HOUR) throw httpError(429, 'The demo has used its hourly AI budget. Try one of the sample complaints, or come back in a few minutes.');
  llmCalls.push(now);
  const user = 'POLICY:\n' + POLICY.map((r) => r.id + '. ' + r.text).join('\n') +
    '\n\nORDER (delivered ' + STORE.deliveredDaysAgo + ' days ago):\n' + CATALOG.map((i) => '- sku ' + i.sku + ': ' + i.name).join('\n') +
    '\n\nCOMPLAINT:\n' + complaint;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 30000);
  try {
    const res = await fetch(LLM_BASE + 'chat/completions', {
      method: 'POST', signal: ctl.signal,
      headers: { Authorization: 'Bearer ' + LLM_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: LLM_MODEL, temperature: 0, max_tokens: 900, response_format: { type: 'json_object' },
        messages: [{ role: 'system', content: SYSTEM_PROMPT }, { role: 'user', content: user }] }),
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw httpError(res.status === 429 ? 429 : 502, res.status === 429 ? 'The AI model is rate-limited right now. Try a sample complaint, or retry in a minute.' : 'The AI model returned an error (' + res.status + ').');
    return JSON.parse(j.choices[0].message.content);
  } catch (e) {
    if (e.statusCode) throw e;
    throw httpError(502, e.name === 'AbortError' ? 'The AI model took too long. Please retry.' : 'Could not read the AI model answer. Please retry.');
  } finally { clearTimeout(timer); }
}

// Guardrails: the model proposes, this code disposes. Nothing the model says moves money unless it survives these checks.
function verify(raw, complaint) {
  const flags = [];
  const byRule = Object.fromEntries(POLICY.map((r) => [r.id, r.text]));
  const hay = norm(complaint);
  const items = CATALOG.map((c) => {
    const m = (Array.isArray(raw.items) ? raw.items : []).find((x) => x && x.sku === c.sku);
    if (!m) { flags.push('The model gave no verdict for ' + c.name + '.'); return { sku: c.sku, name: c.name, cents: c.cents, eligible: false, rule: null, ruleText: '', quote: '', why: 'No verdict' }; }
    const quote = typeof m.complaint_quote === 'string' ? m.complaint_quote.trim() : '';
    const quoteOk = quote.length >= 4 && hay.includes(norm(quote));
    const rule = byRule[m.rule] ? m.rule : null;
    let eligible = m.eligible === true;
    if (eligible && !quoteOk) { eligible = false; flags.push('No verbatim evidence in the complaint for refunding ' + c.name + '.'); }
    if (eligible && !rule) { eligible = false; flags.push('No valid policy rule cited for ' + c.name + '.'); }
    return { sku: c.sku, name: c.name, cents: c.cents, eligible, rule, ruleText: rule ? byRule[rule] : '', quote: quoteOk ? quote : '', why: String(m.why || '').slice(0, 120) };
  });
  const needsHuman = raw.needs_human === true || flags.length > 0;
  const refundCents = needsHuman ? 0 : items.filter((i) => i.eligible).reduce((s, i) => s + i.cents, 0);
  return {
    items, needsHuman, flags,
    question: needsHuman ? String(raw.question || 'Which item arrived damaged, and what is wrong with it?').slice(0, 240) : '',
    reply: String(raw.reply || '').slice(0, 600),
    refundCents, refund: usd(refundCents), blanket: usd(TOTAL), saved: usd(TOTAL - refundCents),
  };
}

async function decide(complaint) {
  const k = cacheKey(complaint);
  const t0 = Date.now();
  let raw = cache[k], source = 'cached';
  if (!raw) {
    raw = await askModel(complaint); source = 'live';
    cache[k] = raw;
    try { fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 1)); } catch (_) { /* read-only fs is fine */ }
  }
  return Object.assign(verify(raw, complaint), { ai: { model: LLM_MODEL, source, ms: Date.now() - t0 } });
}

// ---------- refund ----------
async function refund(o) {
  const d = o.decision;
  if (!d) throw httpError(409, 'Resolve the complaint first.');
  if (d.needsHuman || d.refundCents <= 0) throw httpError(409, 'Nothing to refund for this decision.');
  const paid = d.items.filter((i) => i.eligible);
  // Once money has moved, the amount is locked to what was first sent, whatever happens in the UI afterwards.
  const body = o.refund ? o.refund.body : {
    amount: { currency_code: 'USD', value: d.refund },
    invoice_id: 'FR-' + o.key,
    note_to_payer: ('Refund for ' + paid.map((i) => i.name + ' (' + i.rule + ')').join(', ') + ' per our returns policy.').slice(0, 255),
  };
  // One capture, one refund decision, one idempotency key. A double click, a retry, or a second agent replays the same refund.
  const requestId = 'fr-refund-' + o.captureId;
  const first = !o.refund;
  const r = await pp(o.trace, first ? 'Send the $' + body.amount.value + ' partial refund' : 'Same request again: PayPal replays the original refund, no new money moves',
    'POST', '/v2/payments/captures/' + o.captureId + '/refund', body, requestId);
  if (!r.ok || !r.json.id) throw httpError(502, ppProblem(r));
  if (first) o.refund = { id: r.json.id, status: r.json.status, amount: body.amount.value, body, requestId, note: body.note_to_payer, attempts: 0, items: paid.map((i) => i.name) };
  o.refund.attempts += 1;
  const replayed = !first && r.json.id === o.refund.id;
  const c = await pp(o.trace, 'Read the payment back to confirm its new state', 'GET', '/v2/payments/captures/' + o.captureId);
  if (c.ok) o.captureStatus = c.json.status;
  return { id: o.refund.id, status: o.refund.status, amount: o.refund.amount, note: o.refund.note, items: o.refund.items, requestId, attempts: o.refund.attempts, replayed, captureStatus: o.captureStatus };
}

// ---------- http ----------
function httpError(statusCode, message) { const e = new Error(message); e.statusCode = statusCode; return e; }
const view = (o) => ({ key: o.key, orderId: o.orderId, captureId: o.captureId, captureStatus: o.captureStatus, total: usd(TOTAL),
  items: CATALOG.map((i) => ({ sku: i.sku, name: i.name, price: usd(i.cents) })), trace: o.trace, refund: o.refund ? { id: o.refund.id, amount: o.refund.amount } : null });

async function readJson(req) {
  let s = '';
  for await (const chunk of req) { s += chunk; if (s.length > 20000) throw httpError(413, 'Request too large.'); }
  try { return s ? JSON.parse(s) : {}; } catch (_) { throw httpError(400, 'Invalid JSON.'); }
}
const needOrder = (b) => { const o = orders.get(String(b.key || '')); if (!o) throw httpError(404, 'That order is gone (the demo server restarted). Start a new order.'); return o; };

const routes = {
  'GET /api/config': async () => ({ store: STORE, policy: POLICY, samples: SAMPLES, total: usd(TOTAL), model: LLM_MODEL, liveAi: !!LLM_KEY, paypalReady: !!(PP_ID && PP_SECRET) }),
  'POST /api/order': async () => view(await createPaidOrder()),
  'POST /api/decide': async (b) => {
    const o = needOrder(b);
    if (o.refund) throw httpError(409, 'This order is already settled. Start a new order to try another complaint.');
    const complaint = String(b.complaint || '').trim();
    if (complaint.length < 8) throw httpError(400, 'Write the complaint first (at least a sentence).');
    if (complaint.length > 1200) throw httpError(400, 'Keep the complaint under 1200 characters.');
    o.decision = await decide(complaint);
    return { decision: o.decision };
  },
  'POST /api/refund': async (b) => { const o = needOrder(b); const r = await refund(o); return { refund: r, trace: o.trace }; },
};

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const route = routes[req.method + ' ' + url.pathname];
  if (route) {
    try {
      const out = await route(req.method === 'POST' ? await readJson(req) : {});
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(out));
    } catch (e) {
      if (!e.statusCode) console.error(e);
      res.writeHead(e.statusCode || 500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.statusCode ? e.message : 'Something went wrong on the server.' }));
    }
    return;
  }
  if (req.method !== 'GET') { res.writeHead(405); return res.end(); }
  const rel = url.pathname === '/' ? 'index.html' : url.pathname.replace(/^\/+/, '');
  const file = path.join(__dirname, 'public', path.normalize(rel));
  if (!file.startsWith(path.join(__dirname, 'public') + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end('Not found'); }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});

if (require.main === module) {
  server.listen(PORT, () => {
    console.log('FairReturn on http://localhost:' + PORT + '  (PayPal: ' + (PP_ID ? 'sandbox credentials loaded' : 'MISSING credentials') + ', AI: ' + (LLM_KEY ? LLM_MODEL : 'samples only') + ')');
  });
}
module.exports = { verify, CATALOG, POLICY, SAMPLES };
