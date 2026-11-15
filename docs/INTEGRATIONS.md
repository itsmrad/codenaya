# MCP integrations


Users can connect external services (Supabase, Neon, GitHub, Stripe, Context7,
Prisma, Sentry, Cloudflare, Linear, or any custom MCP server) and the coding agent
gains those services' tools. Credentials the agent provisions are stored encrypted
and injected into the preview, so generated apps can be genuinely full-stack.

## Required environment variables

```bash
# Master key for the credential store. REQUIRED before any connection can be made.
# Generate with: openssl rand -base64 32
CODENAYA_LOCAL_KEK=

# Absolute OAuth callback URL. Required for OAuth connections.
INTEGRATIONS_REDIRECT_URI=http://localhost:3000/api/integrations/oauth/callback   # local
# In production, swap the host for your real domain (https required off localhost).
```

Use the **same `CODENAYA_LOCAL_KEK` in every environment**. A different value means
credentials sealed in one cannot be opened in another, and the failure surfaces as a
decryption error rather than a configuration one.

**If you lose the key, stored credentials are unrecoverable.** That is the point of
encryption — keep a copy in a password manager. Users would need to reconnect.

## Optional

```bash
# KEK provider. Defaults to "local".
CODENAYA_KEK_PROVIDER=local          # or "gcp-kms"

# Only for CODENAYA_KEK_PROVIDER=gcp-kms. Reuses GOOGLE_CLIENT_EMAIL /
# GOOGLE_PRIVATE_KEY, so no new credentials are needed.
CODENAYA_GCP_KMS_KEY=projects/p/locations/l/keyRings/r/cryptoKeys/k

# Comma-separated decrypt-only keys, for rotation. See below.
CODENAYA_LOCAL_KEK_RETIRED=

# Allows http:// MCP URLs. Ignored in production even if set.
CODENAYA_ALLOW_INSECURE_MCP_URLS=1
```

## How credentials are stored

Envelope encryption. Each secret gets its own random 256-bit data encryption key
(DEK); the secret is encrypted with AES-256-GCM under that DEK, and the DEK is
wrapped by the KEK. Only the wrapped DEK and the ciphertext are persisted — the KEK
never reaches the database.

Every ciphertext is bound to its own row via GCM additional authenticated data, so a
sealed value copied into a different row fails to decrypt rather than silently
working.

**The tradeoff:** with the `local` provider the KEK lives in an environment
variable, so an attacker holding *both* the environment and the database can decrypt
everything. A hosted KMS would make the database alone insufficient. This is
accepted deliberately to keep running costs at zero.

## Rotating the KEK

No downtime and no bulk migration needed:

```bash
CODENAYA_LOCAL_KEK=<new key>          # wraps all new DEKs
CODENAYA_LOCAL_KEK_RETIRED=<old key>  # decrypt-only
```

New credentials seal under the new key; existing rows still open with the retired
one. Keys are identified by a SHA-256 fingerprint stored per row, so ordering does
not matter. Drop the retired entry once everything has been re-wrapped.

## Moving to Google Cloud KMS

Because the KEK only ever wraps DEKs, this is a pass over one short column rather
than a re-encryption of every credential — `ciphertext`, `iv` and `authTag` are
copied through byte-identical (asserted by `rewrap.test.ts`).

1. Create a key ring and key in Cloud KMS.
2. Grant the existing service account `roles/cloudkms.cryptoKeyEncrypterDecrypter`.
3. Set `CODENAYA_GCP_KMS_KEY`.
4. Re-wrap existing rows using `rewrapSealedSecret`, which is idempotent and safe to
   re-run after an interruption.
5. Set `CODENAYA_KEK_PROVIDER=gcp-kms`.

Old and new rows stay readable throughout, because each row records the provider and
key that sealed it.

## Preview engines and secret visibility

| | Cloud Sandbox (E2B) | In-browser (WebContainer) |
| --- | --- | --- |
| Runs | Server-side | In the user's page |
| Public vars | ✅ | ✅ |
| Secret vars | ✅ | ❌ withheld |

WebContainer boots in the browser, so anything given to it is readable by the end
user and by anyone they share a preview with. Variables prefixed
`NEXT_PUBLIC_`, `VITE_`, `PUBLIC_`, `REACT_APP_`, `EXPO_PUBLIC_`, `GATSBY_` or
`NUXT_PUBLIC_` are treated as public — bundlers inline them into client JavaScript
regardless, so calling them secret would be a false promise. Everything else
defaults to secret.

## Operational notes

- **Read-only by default.** New project connections are read-only; enabling writes
  requires explicit confirmation. Five providers (Stripe, Context7, Prisma,
  Cloudflare, Sentry) cannot express read-only in their MCP endpoint, so for those it
  is enforced by the approval gate instead and the UI says so.
- **Destructive tools require approval.** The agent pauses and waits up to 15 minutes
  for a decision. With no approval mechanism available the call is refused, never
  silently executed.
- **Tool budget.** 40 tools per connection, 80 per project. Tool schemas are sent to
  the model on every request, so an unbounded set would evict the conversation from
  context.
- **Tool drift.** Definitions are fingerprinted at approval time. If a server later
  changes a tool's description or schema, that tool is withheld until reviewed — a
  description is instruction text the model obeys.
- **Cleanup crons** prune expired OAuth states, lapsed approvals, orphaned links and
  audit entries older than 30 days. See `convex/crons.ts`.


## Public documentation providers (no sign-in)

Microsoft Learn (`https://learn.microsoft.com/api/mcp`) and Cloudflare Docs
(`https://docs.mcp.cloudflare.com/mcp`) use `authMode: "none"`. Connect probes the
fixed catalog endpoint before saving. No credential is sealed or opened, no KEK
is required, and probe/runtime requests carry no Authorization or API key.
The existing required credential columns contain empty strings on these rows;
existing OAuth and API-key rows retain their representation. The Convex auth-mode
validator is extended by a union member only; no data migration is needed.
User-supplied endpoints are rejected for these providers. Unknown tools remain
gated even on read-only links; only catalog-verified documentation reads qualify
for the existing read-only tool policy.

Verified on 2026-11-15 with unauthenticated MCP `initialize` and `tools/list`
(protocol `2025-03-26`), without invoking tools:

| Provider | Read-only inventory | Official source |
| --- | --- | --- |
| Microsoft Learn | `microsoft_docs_search`, `microsoft_docs_fetch`, `microsoft_code_sample_search` | [Microsoft README](https://github.com/MicrosoftDocs/mcp), [developer reference](https://learn.microsoft.com/en-us/training/support/mcp-developer-reference) |
| Cloudflare Docs | `search_cloudflare_documentation`, `migrate_pages_to_workers_guide` | [Cloudflare README](https://github.com/cloudflare/mcp-server-cloudflare/tree/main/apps/docs-ai-search), [tool source](https://github.com/cloudflare/mcp-server-cloudflare/blob/main/packages/mcp-common/src/shared-tools/docs-ai-search.tools.ts) |

Both servers currently expose documentation reads only (`supportsReadOnly: true`).
Cloudflare's migration-guide tool retrieves instructions; it does not migrate an
account. All three Microsoft tools and both Cloudflare tools advertise
`readOnlyHint: true`. None of these tools runs a user agent, crawls a site, returns
credentials or charges a connected account. No requested provider was deferred.
Other catalog providers keep their existing authentication modes.
