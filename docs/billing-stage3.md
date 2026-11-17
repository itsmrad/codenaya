# Dodo webhook receiver (stage 3)

`POST /billing/webhook` (`convex/http.ts`, implemented in `convex/billingWebhook.ts`)
receives Dodo's Standard Webhooks. It only verifies and records receipts; it does not
schedule, reconcile or fulfill anything (later stages).

Order of checks, each without writes until the last step:

1. Receiver config (`readDodoConfig("convex-receiver", CODENAYA_DEPLOYMENT)`, ADR 0016).
   Absent, invalid or placeholder values return 503 so Dodo retries.
2. Body bounded to 256 KiB before buffering; larger returns 413.
3. `webhook-id`, `webhook-timestamp` and `webhook-signature` must be present and
   well-formed, then the exact raw UTF-8 body is verified with `svix`'s Standard
   Webhooks verifier (constant-time, five-minute tolerance) against the current key
   and, if configured, `DODO_PAYMENTS_WEBHOOK_KEY_PREVIOUS`. Failure returns 400.
4. Signed JSON is parsed and narrowed to bounded scalars; `business_id` must equal
   the configured business. Anything else returns 400.
5. Mode comes from config, never the payload. The provider customer is looked up by
   `(mode, customerId)`; `internal.billing.recordReceipt` stores the webhook id, event
   type, occurrence time, SHA-256 digest of the raw bytes and resource IDs only.
   Mapped financial events (`payment.*`, `subscription.*`, `refund.*`, `dispute.*`) are
   `pending`; unmapped ones are `quarantined`; other event types are `ignored`. A
   durable receipt, including a duplicate, returns 200. No raw payload, email,
   signature or URL is stored or logged.

Known gap for stage 5: a receipt first stored unmapped (quarantined) and redelivered
after the customer is mapped has the same digest, so it stays a no-op. Reconciliation
must associate quarantined unmapped receipts with their customers.
