// FairReturn — refund what the policy owes, not the whole order.
// Zero-dependency Node (>=18) server: PayPal sandbox (Orders v2, Payments v2 refunds, Webhooks) + one LLM call per ticket.
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
const LLM_FALLBACK = process.env.LLM_FALLBACK_MODEL || 'gemini-2.5-flash-lite';
const LLM_MAX_PER_HOUR = Number(process.env.LLM_MAX_PER_HOUR || 80);
const SESSIONS_PER_HOUR = Number(process.env.SESSIONS_PER_HOUR || 40);
const SESSIONS_PER_IP = Number(process.env.SESSIONS_PER_IP || 8); // per 10 minutes
// Public HTTPS origin of this deployment. Render sets RENDER_EXTERNAL_URL automatically. Needed for PayPal webhooks.
const PUBLIC_URL = (process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || '').replace(/\/$/, '');
const CACHE_FILE = path.join(__dirname, 'cache', 'decisions.json');

function loadDotEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

// ---------- demo fixture: what three customers bought and wrote ----------
// Only the shopping carts and the complaints are fixtures. Each cart becomes a real PayPal order,
// and everything FairReturn decides on afterwards is read back from PayPal, not from this list.
const STORE = { name: 'Hearth & Kettle' };
const CARTS = [
  { id: 'T1', customer: 'Maya R.', deliveredDaysAgo: 3,
    items: [['KETTLE', 'Glass kettle', '25.00'], ['MUGS', 'Ceramic mug set (4)', '40.00'], ['TEA', 'Loose-leaf tea sampler', '15.00']],
    complaint: "ok so the kettle showed up cracked?? also tbh the mugs aren't really my style now that I've used them a few times. can I just get my money back for everything" },
  { id: 'T2', customer: 'Daniel K.', deliveredDaysAgo: 5,
    items: [['APRON', 'Linen apron', '30.00'], ['TRIVET', 'Cast-iron trivet', '20.00'], ['WRAPS', 'Beeswax wraps (3)', '18.00']],
    complaint: 'The apron arrived with a big tear along the seam. Everything else is perfect, thanks!' },
  { id: 'T3', customer: 'Priya S.', deliveredDaysAgo: 2,
    items: [['POUROVER', 'Pour-over coffee set', '45.00'], ['SCALE', 'Coffee scale', '35.00']],
    complaint: 'One of the things in my box arrived broken. Please refund me.' },
];
// A policy is a list of rules. Each rule says in plain language when it applies, and declares its effect.
// The model interprets the language; code enforces the effect (a "deny" rule can never justify a refund).
const POLICY_PRESETS = {
  strict: { label: 'Standard policy', rules: [
    { effect: 'refund', text: 'Items damaged on arrival are refunded in full for the damaged item only, if reported within 14 days of delivery.' },
    { effect: 'deny', text: 'Items that arrived in good condition and that the customer is keeping are not refunded.' },
    { effect: 'deny', text: 'Change-of-mind returns of opened or used items are not eligible.' },
  ] },
  generous: { label: 'Happiness guarantee', rules: [
    { effect: 'refund', text: 'Items damaged on arrival are refunded in full for the damaged item only, if reported within 14 days of delivery.' },
    { effect: 'deny', text: 'Items that arrived in good condition and that the customer is keeping are not refunded.' },
    { effect: 'refund', text: 'If the customer is unhappy with an item for any reason within 30 days, refund that item, even if it was opened or used.' },
  ] },
};
const cents = (v) => Math.round(Number(v) * 100);
const usd = (c) => (c / 100).toFixed(2);
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

// ---------- PayPal ----------
let token = null; // { value, exp }
const sessions = new Map(); // key -> { key, tickets[], created }
const captureIndex = new Map(); // captureId -> ticket
const seenEvents = new Set();
const webhook = { enabled: false, id: null, url: PUBLIC_URL ? PUBLIC_URL + '/webhooks/paypal' : null, error: null };

async function ppToken(trace) {
  if (token && token.exp > Date.now() + 60000) return token.value;
  const t0 = Date.now();
  const res = await fetch(PP_BASE + '/v1/oauth2/token', {
    method: 'POST',
    headers: { Authorization: 'Basic ' + Buffer.from(PP_ID + ':' + PP_SECRET).toString('base64'), 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials',
  });
  const j = await res.json().catch(() => ({}));
  trace.push({ dir: 'out', method: 'POST', path: '/v1/oauth2/token', status: res.status, ms: Date.now() - t0, what: 'Get an access token with the sandbox app credentials' });
  if (!res.ok || !j.access_token) throw httpError(502, 'PayPal rejected the sandbox credentials. Check PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET.');
  token = { value: j.access_token, exp: Date.now() + (j.expires_in || 300) * 1000 };
  return token.value;
}

// body may be an object (JSON-encoded here) or a ready-made JSON string (used to forward a webhook body byte-for-byte).
async function pp(trace, what, method, apiPath, body, requestId) {
  const tk = await ppToken(trace);
  const t0 = Date.now();
  const headers = { Authorization: 'Bearer ' + tk, 'Content-Type': 'application/json' };
  if (requestId) headers['PayPal-Request-Id'] = requestId;
  let res, j = {};
  try {
    res = await fetch(PP_BASE + apiPath, { method, headers, body: body == null ? undefined : typeof body === 'string' ? body : JSON.stringify(body), signal: AbortSignal.timeout(30000) });
    j = await res.json().catch(() => ({}));
  } catch (e) {
    trace.push({ dir: 'out', method, path: apiPath, status: 0, ms: Date.now() - t0, what: what + ' (no answer from PayPal)', requestId: requestId || null });
    return { ok: false, status: 0, json: {} };
  }
  trace.push({ dir: 'out', method, path: apiPath, status: res.status, ms: Date.now() - t0, what, requestId: requestId || null, debugId: res.headers.get('paypal-debug-id') || j.debug_id || null });
  return { ok: res.ok, status: res.status, json: j };
}

function ppProblem(r) {
  const issue = r.json && r.json.details && r.json.details[0] && r.json.details[0].issue;
  if (issue === 'PAYEE_NOT_ENABLED_FOR_CARD_PROCESSING') {
    return 'This sandbox business account cannot take card payments. Create a US sandbox Business account, link a new app to it, and use its credentials (see README).';
  }
  if (r.status === 0) return 'PayPal did not answer in time. Press the button again: the same request is replayed safely.';
  return 'PayPal error: ' + (issue || (r.json && r.json.name) || r.status);
}

// Turn PayPal's own order representation into the snapshot every later decision is bound to. Fail closed on anything odd.
function snapshotOrder(o) {
  const pu = o && o.purchase_units && o.purchase_units[0];
  const cap = pu && pu.payments && pu.payments.captures && pu.payments.captures[0];
  if (!pu || !cap || !Array.isArray(pu.items) || !pu.items.length) return null;
  const currency = cap.amount.currency_code;
  const items = pu.items.map((i) => ({ sku: String(i.sku || ''), name: String(i.name || ''), qty: Number(i.quantity), cents: cents(i.unit_amount.value) * Number(i.quantity) }));
  const sum = items.reduce((s, i) => s + i.cents, 0);
  const skus = new Set(items.map((i) => i.sku));
  if (items.some((i) => !i.sku || !Number.isInteger(i.qty) || i.qty < 1 || !(i.cents > 0)) || skus.size !== items.length) return null;
  if (items.some((i) => pu.items.find((x) => x.sku === i.sku).unit_amount.currency_code !== currency)) return null;
  if (sum !== cents(cap.amount.value)) return null; // the lines must add up to what was actually captured
  return { orderId: o.id, captureId: cap.id, captureStatus: cap.status, currency, items, totalCents: sum };
}

async function openTicket(sessionKey, cart) {
  const t = { id: cart.id, customer: cart.customer, deliveredDaysAgo: cart.deliveredDaysAgo, complaint: cart.complaint, trace: [], order: null, decision: null, intent: null, refund: null, pendingEvent: null };
  const total = usd(cart.items.reduce((s, i) => s + cents(i[2]), 0));
  const body = {
    intent: 'CAPTURE',
    purchase_units: [{
      reference_id: 'FR-' + sessionKey + '-' + cart.id,
      description: STORE.name + ' order',
      amount: { currency_code: 'USD', value: total, breakdown: { item_total: { currency_code: 'USD', value: total } } },
      items: cart.items.map((i) => ({ sku: i[0], name: i[1], quantity: '1', unit_amount: { currency_code: 'USD', value: i[2] } })),
    }],
    // PayPal's published sandbox test card: a real captured payment for every demo run, with no buyer login.
    payment_source: { card: { number: '4111111111111111', expiry: '2030-12', security_code: '123', name: 'Test Buyer',
      billing_address: { address_line_1: '1 Main St', admin_area_2: 'San Jose', admin_area_1: 'CA', postal_code: '95131', country_code: 'US' } } },
  };
  const made = await pp(t.trace, cart.customer + ' pays $' + total + ' by card: create + capture the order in one call', 'POST', '/v2/checkout/orders', body, 'fr-order-' + sessionKey + '-' + cart.id);
  if (!made.ok || !made.json.id) throw httpError(502, ppProblem(made));
  const read = await pp(t.trace, 'Read the order back: these PayPal line items are what gets adjudicated', 'GET', '/v2/checkout/orders/' + made.json.id);
  const snap = read.ok ? snapshotOrder(read.json) : null;
  if (!snap || snap.captureStatus !== 'COMPLETED') throw httpError(502, read.ok ? 'PayPal returned an order FairReturn cannot safely adjudicate (missing or inconsistent line items).' : ppProblem(read));
  t.order = snap;
  captureIndex.set(snap.captureId, t);
  return t;
}

// ---------- policy ----------
function cleanPolicy(input) {
  const rules = Array.isArray(input) ? input : POLICY_PRESETS.strict.rules;
  if (rules.length < 1 || rules.length > 6) throw httpError(400, 'A policy needs between 1 and 6 rules.');
  return rules.map((r, i) => {
    const text = String((r && r.text) || '').replace(/\s+/g, ' ').trim();
    if (text.length < 10 || text.length > 300) throw httpError(400, 'Each policy rule needs 10 to 300 characters.');
    if (!r || (r.effect !== 'refund' && r.effect !== 'deny')) throw httpError(400, 'Each policy rule must either grant or deny a refund.');
    return { id: 'R' + (i + 1), effect: r.effect, text };
  });
}

// ---------- the AI decision ----------
const SYSTEM_PROMPT = [
  'You are a refund adjudicator for an online store. You receive the store policy, one delivered order, and the customer complaint.',
  'Each policy rule is tagged [GRANTS REFUND] or [DENIES REFUND]. For EVERY item in the order decide whether the policy makes it eligible for a refund right now.',
  'Rules of conduct:',
  '- Decide only from what the complaint actually says about each item. What the customer asks for is not evidence.',
  '- An item is eligible only if a [GRANTS REFUND] rule applies to it; cite that rule. Otherwise cite the [DENIES REFUND] rule that applies.',
  '- Never mention or compute money amounts. The store system does the arithmetic.',
  '- complaint_quote must be copied verbatim from the complaint (a short contiguous span about that item). Use "" if the complaint says nothing about that item.',
  '- If the complaint does not make clear WHICH item has a problem, set needs_human to true and put the single best clarifying question in "question".',
  '- reply is a short, warm message to the customer (max 60 words) explaining the outcome per item in plain language, without amounts.',
  'Output JSON only, exactly this shape:',
  '{"items":[{"sku":"...","eligible":true,"rule":"R1","complaint_quote":"...","why":"max 12 words"}],"needs_human":false,"question":"","reply":"..."}',
].join('\n');

let cache = {};
try { cache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')); } catch (_) { cache = {}; }
const norm = (s) => String(s).toLowerCase().replace(/\s+/g, ' ').trim();
// The cache identity covers everything the answer depends on: the complaint, the policy, and the order lines.
const cacheKey = (complaint, policy, items) => crypto.createHash('sha256')
  .update(JSON.stringify([norm(complaint), policy.map((r) => [r.effect, norm(r.text)]), items.map((i) => [i.sku, i.name])])).digest('hex').slice(0, 24);
let llmCalls = [];

async function askModel(complaint, policy, t) {
  const now = Date.now();
  llmCalls = llmCalls.filter((x) => now - x < 3600000);
  if (!LLM_KEY) throw httpError(503, 'No LLM key configured, so only the built-in tickets with a preset policy work (their answers ship with the repo). Set LLM_API_KEY to judge edited complaints or policies.');
  if (llmCalls.length >= LLM_MAX_PER_HOUR) throw httpError(429, 'The demo has used its hourly AI budget. The built-in tickets still work with a preset policy.');
  llmCalls.push(now);
  const user = 'POLICY:\n' + policy.map((r) => r.id + ' [' + (r.effect === 'refund' ? 'GRANTS REFUND' : 'DENIES REFUND') + '] ' + r.text).join('\n') +
    '\n\nORDER (delivered ' + t.deliveredDaysAgo + ' days ago):\n' + t.order.items.map((i) => '- sku ' + i.sku + ': ' + i.name).join('\n') +
    '\n\nCOMPLAINT:\n' + complaint;
  // Free model tiers answer 503/429 under load: retry briefly, then fall back to a second model before giving up.
  let last = 0;
  for (const model of [LLM_MODEL, LLM_MODEL, LLM_FALLBACK, LLM_FALLBACK]) {
    try {
      const res = await fetch(LLM_BASE + 'chat/completions', {
        method: 'POST', signal: AbortSignal.timeout(25000),
        headers: { Authorization: 'Bearer ' + LLM_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, temperature: 0, max_tokens: 900, response_format: { type: 'json_object' },
          messages: [{ role: 'system', content: SYSTEM_PROMPT }, { role: 'user', content: user }] }),
      });
      const j = await res.json().catch(() => ({}));
      if (res.ok) return { raw: JSON.parse(j.choices[0].message.content), model };
      last = res.status;
    } catch (e) { last = e.name === 'TimeoutError' ? 408 : 500; }
    await new Promise((r) => setTimeout(r, 900));
  }
  throw httpError(last === 429 ? 429 : 502, last === 429 ? 'The AI model is rate-limited right now. Retry in a minute, or use a built-in ticket.'
    : last === 408 ? 'The AI model took too long. Please retry.' : 'The AI model is unavailable right now (' + last + '). Please retry.');
}

// Guardrails: the model proposes, this code disposes. Nothing the model says moves money unless it survives these checks.
function verify(raw, complaint, policy, items) {
  const flags = [];
  const byId = {};
  for (const r of policy) byId[r.id] = r;
  const hay = norm(complaint);
  const list = raw && Array.isArray(raw.items) ? raw.items : [];
  const out = items.map((c) => {
    const m = list.find((x) => x && x.sku === c.sku);
    if (!m) { flags.push('The model gave no verdict for ' + c.name + '.'); return { sku: c.sku, name: c.name, cents: c.cents, price: usd(c.cents), eligible: false, rule: null, quote: '', why: 'No verdict' }; }
    const quote = typeof m.complaint_quote === 'string' ? m.complaint_quote.trim() : '';
    const quoteOk = quote.length >= 4 && hay.includes(norm(quote));
    const rule = typeof m.rule === 'string' && own(byId, m.rule) ? byId[m.rule] : null; // own keys only: "toString" is not a rule
    let eligible = m.eligible === true;
    if (eligible && !quoteOk) { eligible = false; flags.push('No verbatim evidence in the complaint for refunding ' + c.name + '.'); }
    if (eligible && !rule) { eligible = false; flags.push('No valid policy rule cited for refunding ' + c.name + '.'); }
    if (eligible && rule.effect !== 'refund') { eligible = false; flags.push('The rule cited for ' + c.name + ' (' + rule.id + ') denies refunds, so it cannot justify one.'); }
    return { sku: c.sku, name: c.name, cents: c.cents, price: usd(c.cents), eligible, rule: rule ? rule.id : null, quote: quoteOk ? quote : '', why: String(m.why || '').slice(0, 120) };
  });
  const needsHuman = !raw || raw.needs_human === true || flags.length > 0;
  const total = items.reduce((s, i) => s + i.cents, 0);
  const refundCents = needsHuman ? 0 : out.filter((i) => i.eligible).reduce((s, i) => s + i.cents, 0);
  return {
    items: out, needsHuman, flags,
    question: needsHuman ? String((raw && raw.question) || 'Which item has a problem, and what is wrong with it?').slice(0, 240) : '',
    reply: needsHuman ? '' : String(raw.reply || '').slice(0, 600),
    refundCents, refund: usd(refundCents), blanket: usd(total), kept: usd(total - refundCents),
  };
}

async function decide(t, complaint, policy) {
  const k = cacheKey(complaint, policy, t.order.items);
  const t0 = Date.now();
  let raw = own(cache, k) ? cache[k].raw : null, model = raw ? cache[k].model : LLM_MODEL, source = 'saved';
  if (!raw) {
    ({ raw, model } = await askModel(complaint, policy, t)); source = 'live';
    cache[k] = { raw, model };
    try { fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 1)); } catch (_) { /* read-only fs is fine */ }
  }
  return Object.assign(verify(raw, complaint, policy, t.order.items), { complaint, policy, ai: { model, source, ms: Date.now() - t0 } });
}

// ---------- refund ----------
function applyEvent(t, ev) { // a verified PAYMENT.CAPTURE.REFUNDED event for this ticket's capture
  if (!t.refund) { t.pendingEvent = ev; return; }
  if (ev.refundId !== t.refund.id) return;
  t.refund.webhook = { eventId: ev.eventId, type: ev.type, at: ev.at };
  if (ev.status) t.refund.status = ev.status;
}

async function refund(t) {
  // The intent is frozen BEFORE the first call to PayPal. Whatever happens next (timeout, lost response, a changed
  // verdict in another tab), every retry sends exactly this body under exactly this idempotency key.
  if (!t.intent) {
    const d = t.decision;
    if (!d) throw httpError(409, 'Resolve the complaint first.');
    if (d.needsHuman || d.refundCents <= 0) throw httpError(409, 'Nothing to refund for this decision.');
    const paid = d.items.filter((i) => i.eligible);
    t.intent = {
      requestId: 'fr-refund-' + t.order.captureId, // one capture, one refund decision, one key
      items: paid.map((i) => i.name),
      body: {
        amount: { currency_code: t.order.currency, value: d.refund },
        invoice_id: 'FR-' + t.order.orderId,
        note_to_payer: ('Refund for ' + paid.map((i) => i.name + ' (' + i.rule + ')').join(', ') + ' per our returns policy.').slice(0, 255),
      },
    };
  }
  const it = t.intent;
  const first = !t.refund;
  const r = await pp(t.trace, first ? 'Send the $' + it.body.amount.value + ' partial refund' : 'Same request again: PayPal replays the original refund, no new money moves',
    'POST', '/v2/payments/captures/' + t.order.captureId + '/refund', it.body, it.requestId);
  if (!r.ok || !r.json.id) throw httpError(502, ppProblem(r));
  if (first) {
    t.refund = { id: r.json.id, status: r.json.status || 'PENDING', amount: it.body.amount.value, note: it.body.note_to_payer, items: it.items, attempts: 0, replayed: false, webhook: null };
    if (t.pendingEvent) { applyEvent(t, t.pendingEvent); t.pendingEvent = null; }
  }
  t.refund.attempts += 1;
  t.refund.replayed = !first && r.json.id === t.refund.id;
  // Never trust local state for money: read the refund and the payment back from PayPal.
  const rr = await pp(t.trace, 'Read the refund back for its authoritative status', 'GET', '/v2/payments/refunds/' + t.refund.id);
  if (rr.ok && rr.json.status) t.refund.status = rr.json.status;
  const c = await pp(t.trace, 'Read the payment back to confirm its new state', 'GET', '/v2/payments/captures/' + t.order.captureId);
  t.order.captureStatus = c.ok && c.json.status ? c.json.status : 'UNKNOWN';
  return t.refund;
}

// ---------- webhooks ----------
async function ensureWebhook() {
  if (!webhook.url || !webhook.url.startsWith('https://') || !PP_ID) return;
  const trace = [];
  try {
    const list = await pp(trace, 'list webhooks', 'GET', '/v1/notifications/webhooks');
    const mine = list.ok && (list.json.webhooks || []).find((w) => w.url === webhook.url);
    if (mine) { webhook.id = mine.id; webhook.enabled = true; }
    else {
      const made = await pp(trace, 'create webhook', 'POST', '/v1/notifications/webhooks', { url: webhook.url, event_types: [{ name: 'PAYMENT.CAPTURE.REFUNDED' }] });
      if (made.ok && made.json.id) { webhook.id = made.json.id; webhook.enabled = true; } else webhook.error = ppProblem(made);
    }
  } catch (e) { webhook.error = e.message; }
  console.log('PayPal webhook: ' + (webhook.enabled ? 'listening at ' + webhook.url + ' (id ' + webhook.id + ')' : 'not registered (' + webhook.error + ')'));
}

async function handleWebhook(req, raw) {
  if (!webhook.enabled) throw httpError(503, 'Webhook not configured.');
  let ev;
  try { ev = JSON.parse(raw); } catch (_) { throw httpError(400, 'Invalid JSON.'); }
  const hd = (n) => String(req.headers[n] || '');
  const trace = [];
  // Ask PayPal whether this exact payload was signed by PayPal for OUR webhook id. The event body is forwarded
  // byte-for-byte (string concatenation, not re-serialised) so the signature check sees what PayPal signed.
  const envelope = JSON.stringify({ auth_algo: hd('paypal-auth-algo'), cert_url: hd('paypal-cert-url'), transmission_id: hd('paypal-transmission-id'),
    transmission_sig: hd('paypal-transmission-sig'), transmission_time: hd('paypal-transmission-time'), webhook_id: webhook.id });
  const v = await pp(trace, 'Verify the webhook signature with PayPal', 'POST', '/v1/notifications/verify-webhook-signature', envelope.slice(0, -1) + ',"webhook_event":' + raw + '}');
  if (!v.ok || v.json.verification_status !== 'SUCCESS') throw httpError(400, 'Signature verification failed.');
  if (!ev.id || seenEvents.has(ev.id)) return { ok: true, duplicate: true }; // PayPal retries; process each event once
  seenEvents.add(ev.id);
  if (seenEvents.size > 5000) seenEvents.clear();
  if (ev.event_type !== 'PAYMENT.CAPTURE.REFUNDED' || !ev.resource) return { ok: true, ignored: true };
  const up = (ev.resource.links || []).find((l) => l.rel === 'up');
  const captureId = up ? String(up.href).split('/').pop() : null;
  const t = captureId && captureIndex.get(captureId);
  if (!t) return { ok: true, unmatched: true }; // a refund from another server instance or an expired session
  t.trace.push(...trace.filter((c) => c.path !== '/v1/oauth2/token'));
  t.trace.push({ dir: 'in', method: 'HOOK', path: ev.event_type, status: 200, ms: 0, what: 'PayPal pushed a signed event: refund ' + ev.resource.id + ' is ' + (ev.resource.status || 'done'), debugId: ev.id });
  applyEvent(t, { eventId: ev.id, type: ev.event_type, refundId: ev.resource.id, status: ev.resource.status || null, at: new Date().toISOString() });
  return { ok: true };
}

// ---------- http ----------
function httpError(statusCode, message) { const e = new Error(message); e.statusCode = statusCode; return e; }
let sessionTimes = [];
const ipTimes = new Map();

function throttleSession(req) {
  const now = Date.now();
  sessionTimes = sessionTimes.filter((x) => now - x < 3600000);
  const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  const mine = (ipTimes.get(ip) || []).filter((x) => now - x < 600000);
  if (mine.length >= SESSIONS_PER_IP) throw httpError(429, 'You have started several demo runs in a row. Give it a few minutes, or keep using the tickets on screen.');
  if (sessionTimes.length >= SESSIONS_PER_HOUR) throw httpError(429, 'The demo is busy creating test payments. Please retry in a few minutes.');
  sessionTimes.push(now); mine.push(now); ipTimes.set(ip, mine);
  if (ipTimes.size > 2000) ipTimes.clear();
}

async function createSession(req) {
  throttleSession(req);
  const key = crypto.randomBytes(8).toString('hex');
  const tickets = await Promise.all(CARTS.map((c) => openTicket(key, c)));
  const s = { key, tickets, created: Date.now() };
  sessions.set(key, s);
  while (sessions.size > 300) { // forget the oldest session and its captures
    const [oldKey, old] = sessions.entries().next().value;
    for (const t of old.tickets) captureIndex.delete(t.order.captureId);
    sessions.delete(oldKey);
  }
  return s;
}

const viewTicket = (t) => ({ id: t.id, customer: t.customer, deliveredDaysAgo: t.deliveredDaysAgo, complaint: t.complaint, locked: !!t.intent,
  order: { orderId: t.order.orderId, captureId: t.order.captureId, captureStatus: t.order.captureStatus, total: usd(t.order.totalCents),
    items: t.order.items.map((i) => ({ sku: i.sku, name: i.name, qty: i.qty, price: usd(i.cents) })) },
  decision: t.decision, refund: t.refund, trace: t.trace });
const viewSession = (s) => ({ key: s.key, tickets: s.tickets.map(viewTicket) });
const needSession = (key) => { const s = sessions.get(String(key || '')); if (!s) throw httpError(404, 'This demo run is gone (the server restarted or it expired). Start over to create new test payments.'); return s; };
const needTicket = (b) => { const t = needSession(b.key).tickets.find((x) => x.id === b.ticket); if (!t) throw httpError(404, 'Unknown ticket.'); return t; };

async function readBody(req) {
  let s = '';
  for await (const chunk of req) { s += chunk; if (s.length > 60000) throw httpError(413, 'Request too large.'); }
  return s;
}
const parse = (s) => { try { return s ? JSON.parse(s) : {}; } catch (_) { throw httpError(400, 'Invalid JSON.'); } };

const routes = {
  'GET /api/config': async () => ({ store: STORE, presets: POLICY_PRESETS, model: LLM_MODEL, liveAi: !!LLM_KEY, paypalReady: !!(PP_ID && PP_SECRET), webhook: { enabled: webhook.enabled } }),
  'POST /api/session': async (b, url, req) => viewSession(await createSession(req)),
  'GET /api/session': async (b, url) => viewSession(needSession(url.searchParams.get('key'))),
  'POST /api/decide': async (b) => {
    const t = needTicket(b);
    if (t.intent) throw httpError(409, 'A refund for this ticket is already on its way or settled, so its verdict is locked.');
    const complaint = String(b.complaint || '').trim();
    if (complaint.length < 8) throw httpError(400, 'Write the complaint first (at least a sentence).');
    if (complaint.length > 1200) throw httpError(400, 'Keep the complaint under 1200 characters.');
    const d = await decide(t, complaint, cleanPolicy(b.policy));
    if (t.intent) throw httpError(409, 'A refund for this ticket was sent while the complaint was being read.');
    t.decision = d;
    return { ticket: viewTicket(t) };
  },
  'POST /api/refund': async (b) => { const t = needTicket(b); await refund(t); return { ticket: viewTicket(t) }; },
};

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); };
  const fail = (e) => { if (!e.statusCode) console.error(e); send(e.statusCode || 500, { error: e.statusCode ? e.message : 'Something went wrong on the server.' }); };
  if (req.method === 'POST' && url.pathname === '/webhooks/paypal') {
    try { send(200, await handleWebhook(req, await readBody(req))); } catch (e) { fail(e); }
    return;
  }
  const route = routes[req.method + ' ' + url.pathname];
  if (route) {
    try { send(200, await route(req.method === 'POST' ? parse(await readBody(req)) : {}, url, req)); } catch (e) { fail(e); }
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
    console.log('FairReturn on http://localhost:' + PORT + '  (PayPal: ' + (PP_ID ? 'sandbox credentials loaded' : 'MISSING credentials') + ', AI: ' + (LLM_KEY ? LLM_MODEL : 'saved answers only') + ')');
    ensureWebhook();
  });
}
module.exports = { verify, cleanPolicy, snapshotOrder, POLICY_PRESETS };
