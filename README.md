# FairReturn

**Refund what the policy owes. Not the whole order.**

A customer writes: *"the kettle showed up cracked, and the mugs aren't really my style now that I've used them. Can I just get my money back for everything?"*

A rushed support agent refunds the whole $80 order. FairReturn reads the complaint against the store's returns policy, shows that only the $25 kettle is owed, quotes the evidence for every line, and sends that exact partial refund through PayPal with one click. Click twice and it still refunds once.

Built for the *Build What's Next with PayPal and AI* hackathon.

- **Live demo:** LIVE_DEMO_URL (free tier: the first load can take up to a minute to wake up)
- **Video:** VIDEO_URL

## Try it in 30 seconds

No login. The page opens on a real, freshly paid PayPal sandbox order.

1. Press **Resolve this complaint**. Each receipt line is stamped `REFUND` or `NOT OWED`, with the customer's own words and the policy rule next to it. `$80.00` is struck through and becomes `$25.00`.
2. Press **Send $25.00 refund via PayPal**. You get a real PayPal refund ID and the payment becomes *partially refunded*.
3. Press **Try to refund it again**. PayPal replays the same refund: "Clicked 2 times. Refunded once."
4. Try the **Too vague to pay** sample, or type your own complaint. When the complaint doesn't say which item is damaged, no refund button appears; the agent gets the question to ask instead.
5. Open **What just happened on PayPal** at the bottom to see every API call, its idempotency key and PayPal debug ID.

**Start over with a new order** charges a fresh test payment so you can repeat the whole flow.

## Who it is for

Small online merchants and their support agents. Partial-refund decisions are slow (read the ticket, read the policy, work out the amount, find the transaction) so agents under time pressure refund everything, or refuse everything. Both cost money: one in margin, the other in disputes and lost customers. FairReturn makes the correct, explainable answer the fastest one to give.

## How it works

```
complaint + policy + order
        │
        ▼
  one LLM call ──► per-item verdict: eligible? which rule? verbatim quote
        │
        ▼
  guardrails in code (server.js: verify)
   • every quote must appear word-for-word in the complaint
   • every rule must exist in the policy
   • the model never sees or sets an amount; code adds up catalog prices
   • anything missing or unclear ⇒ "needs a human", $0, no refund button
        │
        ▼
  agent clicks once ──► PayPal refund with a fixed idempotency key
```

The model does the part rules can't: mapping messy language ("not really my style now that I've used them") to the right policy clause for the right item, and ignoring what the customer merely *asks for*. Code does the part a model shouldn't: arithmetic, evidence checking, and moving money.

## How PayPal is used

All calls go to the PayPal sandbox REST API from `server.js`.

| Step | Call | Why |
|---|---|---|
| Auth | `POST /v1/oauth2/token` | Client-credentials token, cached until it expires |
| Customer pays | `POST /v2/checkout/orders` with `intent: CAPTURE` and `payment_source.card` | Creates **and captures** a real $80 itemised order with PayPal's sandbox test card in one request, so every demo run starts from a genuine captured payment without a buyer login |
| Refund | `POST /v2/payments/captures/{capture_id}/refund` | Partial refund for the owed amount, with `note_to_payer` naming the item and policy rule, and `invoice_id` tying it to the ticket |
| Exactly once | `PayPal-Request-Id: fr-refund-{capture_id}` on the refund | A double click, a retry after a timeout, or a second agent replays the original refund instead of paying twice |
| Confirm | `GET /v2/payments/captures/{capture_id}` | Reads the payment back (`PARTIALLY_REFUNDED`) rather than trusting local state |

PayPal is also the last line of defence: if anything tried to refund more than the capture has left, PayPal rejects it with `REFUND_AMOUNT_EXCEEDED`.

## How AI is used

- **Model:** Google Gemini `gemini-3.5-flash-lite` through its OpenAI-compatible endpoint (one call per complaint, temperature 0, JSON output). Any OpenAI-compatible chat endpoint works via `LLM_BASE_URL` / `LLM_MODEL`.
- **Job:** per-item eligibility, the policy rule that applies, a verbatim quote from the complaint, a clarifying question when the complaint is ambiguous, and a draft reply to the customer.
- **Not its job:** amounts, PayPal calls, or the final say. See `verify()` in `server.js` and the tests in `test/verify.test.js`.
- The answers for the three sample complaints are stored in `cache/decisions.json`, so the samples work even without an LLM key or when the free tier is rate-limited. Free-text complaints call the model live.
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
docker run --rm -p 8787:8787 --env-file .env fairreturn
```

Or with Node 18+ (there are no dependencies, so there is nothing to install):

```bash
node server.js
```

Open http://localhost:8787.

Without `LLM_API_KEY` the three sample complaints still work. To judge free-text complaints, add a key for any OpenAI-compatible endpoint; a free Google AI Studio key works with the defaults in `.env.example`.

Tests (no network needed):

```bash
node --test
```

## Deploy on Render

`render.yaml` describes a free Docker web service. Create a new **Blueprint** from this repository and fill in `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET` and `LLM_API_KEY` when asked.

## Scope and limits

- One demo store with a fixed three-item order and a four-rule policy. Connecting a real catalog, order history and policy document is the next step, not part of this build.
- Sandbox only: PayPal's published test card, no real money.
- Live AI calls on the hosted demo are capped per hour; the samples are always available.
- The draft reply is shown to the agent, not sent.

## Files

```
server.js              PayPal + LLM + guardrails + static server (zero dependencies)
public/index.html      the single screen
cache/decisions.json   stored AI answers for the three samples
test/verify.test.js    guardrail tests
Dockerfile, render.yaml, .env.example
```

## License

MIT, see [LICENSE](LICENSE).
