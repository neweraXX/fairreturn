# FairReturn

**Refund what the policy owes. Not the whole order.**

A customer writes: *"the kettle showed up cracked, and the mugs aren't really my style now that I've used them. Can I just get my money back for everything?"*

If an agent refunds that whole $80 order, $55 is more than the standard policy owes. FairReturn reads the complaint against the store's returns policy, proposes the $25 kettle refund with cited evidence, and sends that partial refund through PayPal after the agent approves. Retry with the same frozen request and PayPal returns the original refund. Status is read back from PayPal's API.

Built for the *Build What's Next with PayPal and AI* hackathon.

- **Live demo:** https://fairreturn.onrender.com (free tier: the first load can take up to a minute to wake up)
- **Video:** https://youtu.be/1NzUEOZooh0

## Try it in a minute

No login. The page opens on a support queue of three tickets. Behind each ticket is a real PayPal sandbox order that was paid by card a few seconds ago.

1. Press **Resolve this complaint** on Maya's ticket. Each receipt line is stamped `REFUND` or `NOT OWED`, with the customer's own words and the policy rule next to it. `$80.00` is struck through and becomes `$25.00`.
2. Switch the policy to **Happiness guarantee** and resolve again. Same complaint, different policy: `$65.00`. Rewrite a rule in your own words, or flip a rule from `REFUNDS` to `DENIES`, and the verdict follows.
3. Press **Send refund via PayPal**. You get a real sandbox refund ID. The app reads the refund and payment status back from PayPal; a completed partial refund makes the payment *partially refunded*. **Confirmed by PayPal** appears only after a matching, signature-verified webhook. Real delivery was verified on the hosted build on November 12, 2026; delivery can be delayed, and a missing webhook does not imply that the refund failed.
4. Press **Try to refund it again**. PayPal replays the same refund: "Clicked 2 times. Refunded once."
5. Open Priya's ticket ("one of the things in my box arrived broken"). No refund button appears; the agent gets the question to ask instead.
6. Before sending a refund, enter a new complaint and resolve again: uncached text is read live by the model. A ticket is locked once its refund request starts.
7. Open **What just happened on PayPal** at the bottom to see every API call for the ticket, with its idempotency key and PayPal debug ID.

**Resolve all open tickets** works through the queue, and the dark tile adds it up. **Start over** charges three fresh test payments.

## Who it is for

Small online merchants and their support agents. Partial-refund decisions are slow (read the ticket, read the policy, work out the amount, find the transaction), so agents under time pressure refund everything, or refuse everything. One costs margin, the other costs disputes and customers. FairReturn makes the correct, explainable answer the fastest one to give.

The "refund all in full" figure in the app is a what-if baseline for comparison, not a measured cost from a real merchant.

## How it works

```
PayPal order (line items read back from PayPal) + complaint + policy
        │
        ▼
  one LLM call ──► per-item verdict: eligible? which rule? verbatim quote
        │
        ▼
  guardrails in code (server.js: verify)
   • every refund quote must appear word-for-word in the complaint
   • the cited rule must exist AND be a rule that grants refunds
   • the model never sees or sets an amount; code adds up PayPal's line prices
   • missing/invalid item verdicts, invalid refund evidence, or a human-review flag ⇒ $0, no refund button
        │
        ▼
  agent clicks once ──► refund intent frozen ──► PayPal refund under a fixed idempotency key
        │
        ▼
  status read back from PayPal ──► optional signed-webhook confirmation
```

The model does the part rules can't: mapping messy language ("not really my style now that I've used them") to the right clause for the right item, and ignoring what the customer merely *asks for*. Code does the part a model shouldn't: arithmetic, evidence checking, and moving money.

A policy is a short list of plain-language rules, each marked as granting or denying a refund. The model interprets the wording; code enforces the effect, so a rule that denies refunds can never be used to justify one, whatever the model says.

## How PayPal is used

All calls go to the PayPal sandbox REST API from `server.js`.

| Step | Call | Why |
|---|---|---|
| Auth | `POST /v1/oauth2/token` | Client-credentials token, cached until it expires |
| Customer pays | `POST /v2/checkout/orders` with `intent: CAPTURE` and `payment_source.card` | Creates **and captures** a real itemised order with PayPal's sandbox test card in one request, so every run starts from genuine captured payments without a buyer login |
| Source of truth | `GET /v2/checkout/orders/{id}` | The line items, prices, currency and capture that get adjudicated come from PayPal's own record. The app refuses orders whose lines don't add up to the captured amount |
| Refund | `POST /v2/payments/captures/{capture_id}/refund` | Partial refund for the owed amount, with `note_to_payer` naming the item and policy rule, and `invoice_id` tying it to the order |
| Exactly once | `PayPal-Request-Id: fr-refund-{capture_id}` | The refund body is frozen before the first attempt. A double click, a retry after a timeout, or a second agent replays the original refund instead of paying twice |
| Confirm | `GET /v2/payments/refunds/{id}`, `GET /v2/payments/captures/{id}` | Reads the refund and payment back rather than trusting local state. A refund that is not `COMPLETED` is shown as such |
| Webhook setup | `GET` / `POST /v1/notifications/webhooks` | On start, the hosted app registers itself for `PAYMENT.CAPTURE.REFUNDED` |
| Webhook check | `POST /v1/notifications/verify-webhook-signature` | Every incoming event is verified with PayPal against this app's webhook ID (body forwarded byte-for-byte), de-duplicated by event ID, and matched to its capture before the UI shows "Confirmed by PayPal" |

PayPal is also the last line of defence: a refund larger than what is left on the capture is rejected with `REFUND_AMOUNT_EXCEEDED`.

## How AI is used

- **Model:** Google Gemini `gemini-3.5-flash-lite` through its OpenAI-compatible endpoint (one call per ticket, temperature 0, JSON output), with a short retry and a fallback model because free tiers answer 503 under load. Any OpenAI-compatible chat endpoint works via `LLM_BASE_URL` / `LLM_MODEL`.
- **Job:** per-item eligibility, the policy rule that applies, a verbatim quote from the complaint, a clarifying question when the complaint is ambiguous, and a draft reply to the customer.
- **Not its job:** amounts, PayPal calls, or the final say. See `verify()` in `server.js` and `test/verify.test.js`.
- Answers for the three built-in tickets under both preset policies are stored in `cache/decisions.json` (the receipt says "saved answer"), so those decisions work without an LLM key or when the free tier is rate-limited. A new, uncached complaint or policy is read live (the receipt says "live").
- Development tools: the code was written with AI coding assistants (Claude Code, OpenAI Codex CLI) and reviewed by the author.

## Run it yourself

You need a PayPal sandbox app. It is free and takes about five minutes.

1. Sign in at [developer.paypal.com](https://developer.paypal.com/) and switch to **Sandbox**.
2. **Testing Tools → Sandbox Accounts → Create account**: type **Business**, country **United States**.
   The default sandbox business account of non-US developers cannot take card payments, and the order call fails with `PAYEE_NOT_ENABLED_FOR_CARD_PROCESSING`. A US business account works out of the box.
3. **Apps & Credentials → Create App**: type Merchant, and pick the US business account you just created.
4. Copy the Client ID and Secret.

```bash
cp .env.example .env        # paste the two PayPal values; LLM_API_KEY is optional
```

With Docker:

```bash
docker build -t fairreturn .
```

```bash
docker run --rm -p 127.0.0.1:8787:8787 --env-file .env --cap-drop ALL --security-opt no-new-privileges fairreturn
```

Or with Node 18+ (there are no dependencies, so there is nothing to install):

```bash
node server.js
```

Open http://localhost:8787.

- Without `LLM_API_KEY` the built-in tickets still work with either preset policy. To judge edited complaints or policies, add a key for any OpenAI-compatible endpoint; a free Google AI Studio key works with the defaults in `.env.example`.
- Webhooks need a public HTTPS address, so a local run confirms refunds by reading them back from the API. Set `PUBLIC_URL=https://your-host` (Render sets this automatically) to turn webhook confirmation on.

Tests in Docker (no network or API keys needed), from this repository directory:

```bash
docker run --rm --network none --user node --cap-drop ALL --security-opt no-new-privileges -v "$PWD:/app:ro" -w /app node:22-alpine node --test
```

## Deploy on Render

`render.yaml` describes a free Docker web service. Create a new **Blueprint** from this repository and fill in `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET` and `LLM_API_KEY` when asked. The app registers its own PayPal webhook on first start.

## Scope and limits

- One demo store. The three shopping carts, delivery ages and complaints are fixtures; orders, payments, refunds and received webhook events are real sandbox objects. A real matching refund webhook was signature-verified on the hosted build: refund `4TC04254R01776237`, event `WH-5NF53608X01755745-8F542397EG8037502` (November 12, 2026). This verifies that run, not a delivery-time guarantee. Connecting a merchant's own orders, tickets and policy document is the next step, not part of this build.
- Evidence checks validate literal quotations and a rule's declared refund/deny effect. They do not prove that the model interpreted the complaint, item or policy correctly. The support agent reviews each proposal before approving a refund.
- State lives in memory. If the server restarts, the demo run is gone (the payments still exist at PayPal); a production version needs a database for audit and reconciliation.
- Sandbox only: PayPal's published test card, no real money.
- New demo runs and live AI calls are rate-limited on the hosted demo.
- The draft reply is shown to the agent, not sent.

## Files

```
server.js              PayPal + LLM + guardrails + webhooks + static server (zero dependencies)
public/index.html      the single screen
cache/decisions.json   stored AI answers for the built-in tickets
test/verify.test.js    guardrail tests
Dockerfile, render.yaml, .env.example
```

## License

MIT, see [LICENSE](LICENSE).
