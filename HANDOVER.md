# MCP Integrations — Handover

Feature: users connect external services (Supabase, Neon, GitHub, …) and the coding
agent gains those services' tools. Credentials the agent provisions are encrypted and
injected into the preview, so generated apps can be full-stack.

**Status:** all planned work is code-complete. **Almost none of it has run against a
real provider.** Read [What is not verified](#what-is-not-verified) before assuming
anything works.

- 398 tests, 0 TypeScript errors, `npm run build` exits 0
- Shipped across 9 PRs (#24–#32)
- All code lives in `src/features/integrations/` plus `convex/{integrations,envVars,maintenance,crons}.ts`

---

## 1. Get it running first

Nothing works without this. Add to `.env.local` **and** to Vercel:

```bash
# Master key for the credential store. Nothing can be connected without it.
CODENAYA_LOCAL_KEK=          # openssl rand -base64 32

# Absolute OAuth callback URL. Only needed for OAuth providers.
INTEGRATIONS_REDIRECT_URI=https://your-domain.com/api/integrations/oauth/callback
```

⚠️ **Use the identical `CODENAYA_LOCAL_KEK` in every environment.** Different values
mean credentials sealed in one cannot be opened in another, and it surfaces as a
decryption error, not a config error. **Lose the key and all stored credentials are
unrecoverable** — keep a copy in a password manager.

Also absent on the original dev machine and needed for full testing:
`E2B_API_KEY` (sandbox previews), `GOOGLE_VERTEX_PROJECT`/`GOOGLE_CLIENT_EMAIL`/
`GOOGLE_PRIVATE_KEY` (the Vercel Workflow fallback backend).

### Smoke test, in this order

1. **Context7 via API key** — read-only, no destructive tools, lowest risk. Open a
   project → *Integrations* in the navbar → connect → link to the project → ask the
   agent to look up docs for a library. Success = it calls `context7__resolve-library-id`.
   Note: Context7 answers unauthenticated requests, so a *wrong* key still appears to work.
2. **GitHub via PAT** — actually validates the credential.
3. **Supabase via OAuth** — where real friction is expected. See [Known friction](#5-known-friction-you-will-probably-hit).
4. **Env injection** — needs `E2B_API_KEY`. Ask the agent to store a var, then boot a
   Cloud Sandbox preview and confirm the app reads it.

---

## 2. How it fits together

```
User connects a provider
  └─ POST /api/integrations/connect          (API key)
     or POST /api/integrations/oauth/start   → provider consent → /oauth/callback
        │
        ├─ probe the server (real MCP handshake) before persisting
        ├─ seal the credential  (crypto/)
        └─ store ciphertext     (convex: userConnections)

User links a connection to a project
  └─ convex: projectConnections   (per-project scope, read-only by default)

Agent turn (src/features/conversations/inngest/process-message.ts)
  └─ buildMcpAgentTools()
       ├─ resolve-servers    open credentials, apply scope → URL + headers
       ├─ discover-tools     list tools, fingerprint, drift-gate, cap at 40
       ├─ adapters/agentkit  wrap as AgentKit tools
       └─ call-tool          on invoke: approval gate → call → redact → audit

Preview boot
  ├─ E2B  (api/sandbox/route.ts)  public + secret vars, stream redacted
  └─ WebContainer                 public vars ONLY (runs in the browser)
```

### File map

| Area | Files | Notes |
| ---- | ----- | ----- |
| **Provider catalog** | `catalog.ts`, `types.ts`, `server/scope-url.ts` | 9 providers. Scoping is data-driven — **no provider-id switch anywhere**. Add a provider by adding a catalog entry. |
| **Crypto** | `server/crypto/**` | Envelope encryption. `getSecretSealer().seal(text, aad)` / `.open(sealed, aad)`. AAD is **required**. |
| **SSRF** | `server/url-guard.ts`, `server/mcp/guarded-fetch.ts` | Validates user-supplied URLs; re-validates every transport request. |
| **OAuth** | `server/oauth/as-guard.ts`, `server/oauth/flow.ts` | OAuth 2.1 + PKCE + dynamic client registration. |
| **MCP core** | `server/mcp/**` | Discovery, invocation, redaction, drift, approval. |
| **Agent bridge** | `adapters/agentkit.ts`, `server/mcp/build-agent-tools.ts` | Only place that knows about AgentKit. |
| **Env injection** | `dotenv.ts`, `server/env/**` | `.env` serialisation, decryption, stream redaction. |
| **UI** | `components/**`, `hooks/**` | Integrations dialog, project panel, approval prompt. |
| **Convex** | `convex/{integrations,envVars,system,maintenance,crons}.ts` | User-facing vs `internalKey`-gated split — see below. |

---

## 3. Design rules — do not break these

These are load-bearing. Each exists because the obvious alternative is a security bug.

**Two Convex functions, not one with a flag.**
`envVars.listPublicEnvVars` never reads the sealed columns, so it is *structurally
incapable* of returning a secret. `system.getEnvVarsForSandbox` is `internalKey`-only.
There is deliberately **no** reveal-secret query. Don't add one.

**Client-facing projections use field allowlists.**
`toConnectionSummary` / `toEnvVarSummary` list fields explicitly. A denylist would
start leaking the moment someone adds a sealed field to the schema.

**AAD binds every ciphertext to its row.**
`secretContext(table, recordId, field)` is required on seal and open, so a sealed value
copied into another row fails to decrypt. The anchor is a pre-generated nanoid
(`credentialRef` / `secretRef`), **not** the Convex `_id` — that's what allows a
single-write insert.

**`internalKey` is not a master key.**
`system.getProjectMcpConnections` skips any link whose credential owner differs from
the project owner. `internalKey` proves "this is our server", not "on behalf of user X".

**Everything from a remote server passes through redaction.**
`callMcpTool` has one exit function. Don't add an early `return` — anything the model
sees is persisted in `messages` and replayed as context forever.

**Destructive tools fail closed.**
No approval gate configured → the call is refused, never silently executed.

**WebContainer's hook accepts `publicEnv` and has no parameter for secrets.**
It boots in the page. Keep that a compile-time property.

**Classification is not the model's decision.**
`setEnvVar` takes no visibility argument; `classifyEnvKey` derives it from the key name
because *bundlers* decide it. Unknown keys default to `secret`.

---

## 4. What is not verified

The honest gap. Everything below is typechecked and unit-tested but **never executed**.

| Not exercised | Needs |
| ------------- | ----- |
| Any OAuth handshake end to end | `INTEGRATIONS_REDIRECT_URI` + a provider account |
| Any real destructive tool call + approval | a write-enabled connection |
| Env injection into a booting sandbox | `E2B_API_KEY` |
| Whether Next/Vite actually read the written `.env` | same |
| Stream redactor against real streaming output | same |
| All UI, in a browser | a Clerk session |
| Crons actually pruning | a deployment with expired rows |

**The one thing that has run live:** probing Cloudflare's docs MCP server
(`docs.mcp.cloudflare.com/mcp`) — handshake succeeded, 2 tools listed. So the
transport layer genuinely works.

There are **no component tests**. Vitest is node-only here; adding a DOM harness means
new devDependencies and config changes.

---

## 5. Known friction you will probably hit

**OAuth: authorization server origin rejected.**
`as-guard.ts` refuses an authorization server that isn't same-site with the MCP server,
because OAuth discovery lets the *MCP server* choose where we send your users — a
hostile server could harvest authorization codes. It fails closed on purpose.

The error names the discovered origin. Fix by adding it to that provider's
`trustedAuthorizationServerOrigins` in `catalog.ts`. **GitHub is the expected case** —
`api.githubcopilot.com` almost certainly authenticates via `github.com`, a different
registrable domain. There's a test documenting this.

**OAuth: provider rejects dynamic client registration.**
Not every server supports RFC 7591. The error says so explicitly. That provider needs a
pre-registered OAuth client; the code path exists but isn't wired to config yet.

**Destructive tools refuse silently-looking.**
If a tool is marked destructive in `catalog.ts` and something goes wrong resolving the
project owner, no approval gate is passed and it refuses. Check the warnings in the
system prompt section.

**Sentry scope throws on `projectSlug` without `orgSlug`.**
Deliberate — silently falling back to org-level scope would grant broader access than
the user selected.

**Read-only is not enforced for 5 providers.**
Stripe, Context7, Prisma, Cloudflare, Sentry have no read-only mode in their MCP
endpoint. The UI says so. Enforcement is the approval gate instead.

**Build gotchas.**
- `export const runtime` is rejected in route handlers — this project has
  `cacheComponents` enabled. Node is the default anyway.
- `npm run build` must be **just** `next build`. Adding `convex codegen` back causes a
  double Convex push → `409 ExistingModuleHashConflict` on Vercel. Use `build:local`
  for local builds outside a `convex deploy` wrapper.
- `convex/_generated/` **is committed** on purpose. `convex deploy --cmd` runs the build
  *before* generating it.
- Sentry's source-map upload can hang builds for 15+ min. `SENTRY_AUTH_TOKEN= npm run build`
  when testing locally.

---

## 6. Suggested next steps

**Priority 1 — validate, don't build.** Walk the smoke test in §1. The failure modes in
§5 are configuration, not redesign, and finding them takes minutes. Writing more code on
top of an unvalidated chain is the main risk right now.

**Priority 2 — small gaps worth closing:**
- Pre-registered OAuth client support (config-driven fallback when DCR is unsupported).
- Token refresh is implemented (`refreshOAuthTokens`) but **not wired** — `resolve-servers`
  sets `needsRefresh` and nothing acts on it. An OAuth connection will need manual
  reconnection when its token expires.
- Cascade delete: there is **no project-delete mutation anywhere** in this codebase. If
  you add one, follow `integrations.deleteUserConnection` — it removes dependent links
  before the parent. An orphan-pruning cron covers the partial-failure case today.
- 22 low/moderate npm vulnerabilities remain (0 critical, 0 high). None fixable without
  forcing a major on a transitive package. **Re-run `npm audit --omit=dev` yourself** —
  new advisories get published against unchanged dependencies, so this number drifts. The
  fix pattern is a constrained override in `package.json` (`">=x <major"`, always with an
  upper bound); see the existing entries.

**Priority 3 — deferred by decision:**
- **Vercel Workflow backend has no MCP tools.** Deliberate (owner's call). Inngest is
  primary. `build-agent-tools.ts` is backend-agnostic, so adding a Workflow adapter is a
  thin translation — mirror `adapters/agentkit.ts`. Note `message-processor.ts` degrades
  `MESSAGE_PROCESSOR=workflow` → `inngest` when Vertex credentials are missing.
- **Vercel MCP excluded** — their docs restrict access to a Vercel-approved client
  allowlist Codenaya isn't on. A test asserts its absence so nobody adds it blindly.
- **DNS rebinding narrowed, not closed.** Resolved addresses are validated and every
  transport request re-checked, but `fetch` does its own lookup. The full fix is pinning
  the validated IP via an undici dispatcher. `checkIp` is exported for that.
- **Rate limiting is per-instance memory** — with N serverless instances the effective
  limit is N×. Move behind a gateway limiter if abuse becomes real.
- **KEK is in an env var.** An attacker with *both* the environment and the database can
  decrypt everything. A hosted KMS makes the DB alone insufficient. Migration is cheap by
  design: the KEK only wraps DEKs, so it's a pass over one column, not a re-encryption.
  `server/crypto/kek/gcp-kms.ts` is written and `rewrap.test.ts` proves ciphertext comes
  out byte-identical. Set `CODENAYA_KEK_PROVIDER=gcp-kms`. See README.

---

## 7. Adding a provider

1. Add an entry to `catalog.ts` — endpoint, `authModes`, `trustedHostnames`,
   `destructiveTools`, and its scoping rules.
2. That's usually it. Scoping, UI tiles, the scope form and tool namespacing are all
   driven by that data.
3. If its scoping mechanism isn't one of the four already modelled (query param,
   repeatable query param, header, path), extend `types.ts` + `scope-url.ts` — **do not**
   add a provider-id conditional.
4. `destructiveTools` drives the approval gate, so be conservative.

## 8. Local notes

`steps/step1.md`–`step3.md` hold detailed implementation notes but are **gitignored**
(local only). This file is the committed handover. `git log --oneline` and PRs #24–#32
carry the reasoning per change — the PR descriptions are unusually detailed and are worth
reading for the *why* behind anything surprising here.
