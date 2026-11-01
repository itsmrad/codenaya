# 0010. Per-model provider routing: one platform catalog, priced per route

- Status: Accepted
- Date: 2026-10-28
- Related: supersedes ADR 0006's "active provider" and per-provider selection,
  and ADR 0005's "one provider for every platform run"; ADR 0009 (promo)

## Context

Today one active provider serves every platform run (ADR 0005/0006), and its
key, model list and promo models all follow from that one switch. The owner
wants each model to name its own route: Claude Opus/Sonnet 5.5 on the official
Anthropic key (the GitHub promo's models), everything else on OpenRouter, and
GPT models on OpenRouter, OpenAI or Groq as he chooses. He wants a simple price
per route (one number) with separate input/output as an option, and a hardened
admin panel. Only OpenRouter's models API returns prices.

## Decision

### Data
- **One catalog doc**, `platformCatalog` (`convex/schema.ts`): `models[]` (at
  most `MAX_PLATFORM_MODELS`), `defaultModelId`, `utilityModelId`. Each model
  (`catalogModelValidator`): stable `id`, `name`, `vendor`, `provider`,
  `providerModelId`, `contextLength?`, `vision`, `tools`, `pricing`, `access`,
  `hidden`. One read on the send path, as before.
- **`id` is stable; the route is not.** Users pick `id`; preferences, local
  storage and messages record it. Switching a model to another provider changes
  `provider` + `providerModelId` (picked from that provider's live list) and
  keeps `id`. A model added from a provider list takes that list's id as `id`.
  `id`s are unique in the catalog, so cross-provider id collisions can't happen.
- **Pricing** (`modelPricingValidator`): `{ mode: "blended", usdPerMTok }` by
  default, or `{ mode: "split", inputUsdPerMTok, outputUsdPerMTok }` behind an
  "Advanced" toggle. Blending uses `blendPrices` (3:1 input:output) in
  `src/features/ai-providers/catalog.ts`. Prices are admin-only.
- **Access** (`modelAccessValidator`): `everyone`, `promo_counted` (uses the
  claim's counted runs, today's Opus rule), `promo_unlimited` (today's Sonnet
  rule). This replaces the hard-coded `PROMO_MODELS` map: promo models are
  whatever the admin marks. `promoKindOf` maps access to the existing
  `promoClaims` kinds (`opus` = counted, `sonnet` = unlimited); `promoClaims`
  is unchanged.
- **Utility model**: `utilityModelId` names the catalog model used for chat
  titles, editor autocomplete, quick edit and prompt enhancement (today: the
  active provider's `titleModel`). It must be `access: "everyone"`, and may be
  hidden (a cheap model users don't pick); the default model may not.
- **No catalog** (fresh deploy): the env provider's curated catalog
  (`NEXT_PUBLIC_AI_PROVIDER`, `AI_PROVIDERS[p]`), as today, mapped into the same
  shape with that provider as every route.
- **Migration**: `platformCatalog.migrateFromProviderConfigs` copies the active
  provider's saved selection (split prices kept) into the catalog once, and on
  OpenRouter or Anthropic seeds the promo's Opus/Sonnet 5.5 with promo access
  (unless already listed), so claimants keep them across the deploy. The
  deprecated `platformModelConfigs` / `platformSettings` tables are dropped in a
  follow-up after prod has migrated.

### Runtime
- `getForServer` returns the catalog; the send route and the agent run resolve
  the requested `id` to its route and use **that route's provider key**
  (`PLATFORM_KEY_ENV`, still the only key reader, ADR 0005). A route whose key
  is missing is refused (`ai_not_configured`), never re-routed.
- Unknown or hidden ids fall back to the default model, as today; promo models
  follow ADR 0009 (refused, not re-routed, when the claim can't run them).
- The agent run re-reads the catalog instead of trusting the event.
- `runModel` records the platform `provider` for future cost tracking.

### Admin and security
- **Admin identity**: `ADMIN_EMAIL` (verified) **and** `ADMIN_USER_ID` (the
  Clerk user id) when set. Both are Convex env vars.
- **Writes only through Next routes**: `POST /api/admin/catalog` (save) and
  `POST /api/admin/catalog/test` (test a route). Each: admin check, Clerk
  **reverification** (step-up within 10 minutes; 403 `reverification_required`
  otherwise), same-origin check (`Origin` / `Sec-Fetch-Site`) and JSON-only
  body, rate limit, zod validation. Save checks every route's provider key is
  set, then calls `platformCatalog.save` with the admin's token **and** the
  internal key; Convex refuses either missing. No admin write is callable from
  the browser alone.
- **Guards**: a new or changed $0 price, or a change over 50% from the saved price, needs
  `confirmRiskyPrices` (UI confirm dialog; enforced in Convex). Re-routing and
  removing models ask for confirmation.
- **Audit**: every save writes `adminAuditLog` with structured `changes`
  (field, before, after) per model and setting, plus `requestId`, `ip`,
  `userAgent` from the route; the summary stays for the list view. The log has
  no update/delete function.
- **Test route**: sends a one-token request through the route's provider key
  and model; returns ok/latency or the provider's refusal (no key material).
- Provider keys stay in env (one per provider); /admin shows only set/not set.

## Alternatives considered

- **Keep per-provider selections plus an active switch.** Can't route Opus to
  Anthropic while the rest run on OpenRouter.
- **A route table with priorities and fallbacks (LiteLLM-style).** Failover is
  not needed yet; one route per model keeps one read and one rule.
- **Several keys per provider.** No need yet; env names stay fixed in code so a
  stored value can never name an arbitrary secret.

## Consequences

- One admin surface decides routes, prices, promo access and the utility model.
- A provider switch is a model edit, audited per field.
- The deprecated tables linger until the follow-up drop.
- Revisit for failover, per-run metering against these prices, or a usage view.
