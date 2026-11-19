# Dodo receipt queue (stage 4)

`convex/billingQueue.ts` processes the receipts stage 3 records. It schedules, leases
and retries work; it does not read the provider or fulfill anything (stage 5).

- **Scheduling.** `recordReceipt` schedules `processCustomer` in the same mutation as a
  new `pending` receipt, so a failed insert schedules nothing. Ignored, unmapped
  (`quarantineReason: "unmapped"`) and digest-collision (`"digest_mismatch"`) receipts
  schedule nothing.
- **Lease and generation.** The `billingCustomers` row is the lock. `claimCustomer`
  bumps `generation` and sets `leaseExpiresAt = now + 11 min`. The lease is longer than
  Convex's 10-minute action limit, so a live worker is never overtaken; only a crashed
  one is. The generation is the lease token: a crashed worker's later commit fails
  `assertBillingFence`, and its stale `releaseCustomer` is a no-op. Held and deleted
  customers stay claimable so cancellations and refunds still process.
- **Batches.** A claim reads at most 25 pending receipts in `nextAttemptAt` order. Due
  receipts get `attempts + 1` and back off; not-yet-due ones join unchanged so stage 5
  sees the whole unresolved set. More than 25 logs a backlog alert, and the release
  reschedules immediately.
- **Backoff.** 1 min doubling per attempt, capped at 6 h, plus up to 20% jitter. An
  alert logs from attempt 5. On release the customer is rescheduled at its earliest
  pending `nextAttemptAt`.
- **Dead-letter.** A due receipt that already has 10 attempts becomes `quarantined`
  with `quarantineReason: "retries_exhausted"` and an error log (ids and type only). It
  stays counted in `unresolvedReceipts`, so the customer's fence stays closed.
- **Sweep.** A 5-minute cron (`sweepReceipts`) pages `pending` receipts 100 at a time in
  `nextAttemptAt` order and schedules every due, unleased customer. It continues to the
  next page while the page is all due, so one leased backlog cannot starve others. It
  recovers lost scheduled actions and crashed leases.
- **Redrive.** Operator only, on dev; production needs explicit approval:
  `npx convex run billingQueue:redriveReceipt '{"eventRef":"<id>"}'`. Only a mapped
  `quarantined` receipt qualifies. It returns to `pending` with 0 attempts, bumps the
  customer's `inputRevision`, keeps `unresolvedReceipts` and schedules the customer.

Placeholder: `reconcileClaim` (`convex/billingReconcile.ts`) does nothing until stage 5
replaces it with provider reads and the fenced commit. Until then every claimed receipt
backs off and dead-letters after about 15 hours, and can be redriven once stage 5 ships.
