// Run only inside Docker. Prints selected sandbox diagnostic fields, never tokens or credentials.
'use strict';
const BASE = 'https://api-m.sandbox.paypal.com';
const webhookId = process.env.CHECK_WEBHOOK_ID || '8CV06189KP946225M';
const refundId = process.env.CHECK_REFUND_ID || '22H71620WT0211126';
const simulate = process.argv.includes('--simulate');

async function main() {
  const client = process.env.PAYPAL_CLIENT_ID, secret = process.env.PAYPAL_CLIENT_SECRET;
  if (!client || !secret) throw new Error('Missing sandbox credentials; pass the project PayPal env file to Docker.');
  const auth = await fetch(BASE + '/v1/oauth2/token', {
    method: 'POST', signal: AbortSignal.timeout(20000),
    headers: { Authorization: 'Basic ' + Buffer.from(client + ':' + secret).toString('base64'), 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials',
  });
  const token = await auth.json();
  if (!auth.ok || !token.access_token) throw new Error('Sandbox OAuth failed: HTTP ' + auth.status);
  async function call(method, path, body) {
    const res = await fetch(BASE + path, { method, signal: AbortSignal.timeout(20000),
      headers: { Authorization: 'Bearer ' + token.access_token, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(method + ' ' + path + ' failed: HTTP ' + res.status + ' (' + (json.name || 'unknown') + ')');
    return { status: res.status, json };
  }
  console.log('Checked at: ' + new Date().toISOString() + '; sandbox only.');
  const hook = (await call('GET', '/v1/notifications/webhooks/' + encodeURIComponent(webhookId))).json;
  console.log(JSON.stringify({ webhook: { id: hook.id, url: hook.url, event_types: (hook.event_types || []).map((e) => e.name) } }));
  const refund = (await call('GET', '/v2/payments/refunds/' + encodeURIComponent(refundId))).json;
  console.log(JSON.stringify({ refund: { id: refund.id, status: refund.status, amount: refund.amount, create_time: refund.create_time } }));
  const available = (await call('GET', '/v1/notifications/webhooks-event-types')).json;
  console.log(JSON.stringify({ availableRefundEvents: (available.event_types || []).map((e) => e.name).filter((n) => /REFUND/.test(n)) }));
  const recent = (await call('GET', '/v1/notifications/webhooks-events?page_size=10')).json;
  console.log(JSON.stringify({ count: recent.count, scope: 'most recent 10 app events; not proof of delivery to this listener' }));
  for (const event of recent.events || []) {
    const detail = (await call('GET', '/v1/notifications/webhooks-events/' + encodeURIComponent(event.id))).json;
    console.log(JSON.stringify({ event: { id: detail.id, type: detail.event_type, created: detail.create_time,
      resourceId: detail.resource && detail.resource.id, matchesRefund: !!detail.resource && detail.resource.id === refundId,
      transmissions: (detail.transmissions || []).map((tr) => ({ webhook_url: tr.webhook_url, status: tr.status, http_status: tr.http_status, reason_phrase: tr.reason_phrase })) } }));
  }
  if (simulate) {
    const mock = await call('POST', '/v1/notifications/simulate-event', { webhook_id: webhookId, event_type: 'PAYMENT.CAPTURE.REFUNDED', resource_version: '2.0' });
    console.log(JSON.stringify({ simulated: true, http_status: mock.status, eventId: mock.json.id }));
    console.log('A simulator event cannot pass the PayPal verify-webhook-signature API. Inspect Render request logs for delivery and the expected rejection. This does not verify a real refund webhook.');
  }
  console.log('Only a real matching event, successful delivery and a verified event attached to the app ticket establish end-to-end webhook confirmation.');
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });
