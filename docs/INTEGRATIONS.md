# MCP integrations


Users can connect external services (Supabase, Neon, GitHub, Stripe, Context7,
Prisma, Sentry, Cloudflare, Linear, or any custom MCP server) and the coding agent
gains those services' tools. Credentials the agent provisions are stored encrypted
and injected into the preview, so generated apps can be genuinely full-stack.

## Required environment variables

These settings apply to the connection modes that need them. The
[public documentation providers](#public-documentation-providers-no-sign-in)
in the catalog do not need a credential store or an OAuth callback. Custom MCP
servers still use their supported authenticated connection modes.

```bash
# Master key for credential-bearing connections when using the local KEK provider.
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

## GitHub OAuth (pre-registered OAuth app)

GitHub's hosted MCP server has no dynamic client
registration, so OAuth needs an OAuth app you register yourself. Until both
variables below are set, GitHub is offered by personal access token only: the
OAuth option is hidden and `/api/integrations/oauth/start` refuses it.

1. In GitHub, go to **Settings → Developer settings → OAuth Apps → New OAuth App**
   (or the organization's equivalent).
2. Set the **Authorization callback URL** to exactly the value of
   `INTEGRATIONS_REDIRECT_URI`. Use one app per deployment host, since each app has
   one callback URL.
3. Generate a client secret, then set both server environment variables:

```bash
GITHUB_OAUTH_CLIENT_ID=       # the OAuth app's client ID
GITHUB_OAUTH_CLIENT_SECRET=   # server-only; never NEXT_PUBLIC_, never logged
```

4. Rebuild and redeploy. Whether the OAuth option shows is decided at build time
   (`next.config.ts` inlines the configured provider ids, never the credentials).
   The start route checks the variables again at request time.

The flow keeps PKCE (S256) and `state`, and requests the `repo` and `read:org`
scopes. The secret is read from the environment only for each token request. It is
not stored in the flow state or the sealed credential, and it is redacted from
token errors. The token endpoint auth method follows the authorization server's
metadata: `client_secret_basic` when advertised, otherwise `client_secret_post`.
GitHub advertises no method and documents body credentials, so it gets
`client_secret_post`. After a client ID rotation, any connection that needs a token
refresh must be reconnected.

The same mechanism serves any catalog provider without dynamic registration. Give
the entry `preRegisteredClient: { clientIdEnv, clientSecretEnv }` (variable names
only) and, if its authorization server is cross-site, `trustedAuthorizationServerOrigins`.

## Client-access prerequisites (Figma, Slack, Square)

These three hosted servers admit only clients the vendor has approved. They are
not in the catalog, and Connect is not offered, until the product owner completes
the steps below and this section is updated to say admission is verified. Checked
2026-11-15. Do not file the vendor applications from this repository.

| Provider | Requirement (paraphrase) | Owner steps and decision |
| --- | --- | --- |
| Figma | Only clients listed in the [Figma MCP catalog](https://www.figma.com/mcp-catalog) can connect to the remote server. A developer connecting a new MCP client joins the [waitlist](https://form.asana.com/?k=kBG-ejRQTdY8x_H6a4vM3Q&d=10497086658021). [Remote server installation](https://developers.figma.com/docs/figma-mcp-server/remote-server-installation/), checked 2026-11-15. | The product owner joins the waitlist and waits to be listed. **Not offered: needs vendor catalog admission.** |
| Square | Square maintains an allowlist of MCP clients against malicious client registration, and asks to request an addition in the [developer forum](https://developer.squareup.com/forums/c/mcp/14). Remote instances only access production resources; sandbox is a local server. [Square MCP](https://developer.squareup.com/docs/mcp), checked 2026-11-15. | The product owner requests allowlisting. **Not offered: needs vendor allowlisting.** Remote Connect would be production-only. |
| Slack | The client must be a registered Slack app with a fixed app id. Only directory-published apps or internal apps may use MCP; unlisted apps are prohibited. No dynamic client registration; OAuth is confidential (`client_id` and `client_secret`). Workspace admins approve the app. [Slack MCP server](https://docs.slack.dev/ai/mcp-server), checked 2026-11-15. | Confidential pre-registered client support is merged ([#539](https://github.com/itsmrad/codenaya/issues/539)). Still required: the product owner publishes a Marketplace app, or creates an internal app (that app serves only its own workspace), then sets the pre-registered client variables. **Not offered: needs a directory-published or internal Slack app.** |

## Community catalog (unreviewed)

Below the vetted providers, the catalog shows a **Community** section: up to 500 of the
most-starred servers from the public
[awesome-mcp-servers](https://github.com/punkpeye/awesome-mcp-servers) list
(MIT, attributed in `THIRD_PARTY_NOTICES.md`). It is labelled "not reviewed",
and nothing in it is trusted.

- **Data:** `src/features/integrations/community-catalog.json`, one entry per
  line, sorted by stars then id. Generated, not hand-edited.
- **Remote vs local.** An entry gets a `remoteUrl` (and `http`/`sse` transport)
  only from the official MCP registry (its server list, `remotes[]`), matched to
  its GitHub repo. A GitHub-owner vouch means the registry namespace matches the repo owner
  (`io.github.<owner>/…`) and the remote host is not on the aggregator/app-hosting
  denylist; it does not establish domain ownership. A domain vouch requires an
  owner-named domain (recognised single-label suffixes only; other domain vouches
  fail closed). Denylisted hosting/proxy domains cannot vouch. Entries matching vetted
  providers’ trusted hosts are omitted in favour of the vetted entry. URLs are
  never scraped from READMEs. Everything else is `stdio` and stays in the JSON, but
  the catalog, search, categories and counts omit it while
  `SHOW_LOCAL_RUNTIME_COMMUNITY_SERVERS` is false. Flip that flag when stdio MCP
  in the sandbox (#545) ships.
- **Auth** is `api-key` when the registry remote declares headers, `oauth` when
  the remote publishes RFC 9728 protected-resource metadata (opt-in
  `--probe-oauth`: one unauthenticated GET per remote entry, paced), else
  `unknown`. The custom-server form is key-based today, so an OAuth-only remote
  needs a bearer token pasted as its key. Its tile says "Remote · token"; sign-in
  is not supported yet.

### Safety model

A community remote opens the **existing custom-server form**, prefilled with its
name and URL. From there it is an ordinary custom connection:

- the URL gets full SSRF/DNS validation, with no trusted-host bypass;
- the server is resolved with `annotationsTrusted: false`, no `readOnlyTools`
  and no `destructiveTools`, so **every tool asks for approval**, including
  tools that claim `readOnlyHint: true`;
- with no approval gate available, calls are refused.

Community entries are never added to `catalog.ts`, its `readOnlyTools`, or any
trust list. `community-approval.test.ts` checks this for every remote entry.

### Refreshing (weekly)

```bash
node scripts/mcp-catalog/build.mjs \
  --exclude-file <path to the excluded-names list>
```

`--probe-oauth` is maintainer-only: it makes requests to registry-provided URLs
without a private-IP check. Normal refreshes reuse cached OAuth observations
without probing. Do not enable probes for untrusted input or on a privileged network.

The generator also drops descriptions/names advertising CAPTCHA, anti-bot,
stealth, undetected automation, or bot-detection bypass tooling.

Needs an authenticated `gh` CLI. Stars are fetched by GraphQL in batches of 100,
paced, and cached with registry responses under `scripts/mcp-catalog/.cache/`
(gitignored, reused for `--cache-hours`, default 24). The run prints how many
entries were skipped as duplicates, excluded, archived/disabled, or missing.

`--exclude-file` is required. It holds names that must never appear in this
repo, one per line (`#` comments allowed), and it is **never committed**.
Matching entries are dropped (whole word, plus embedded in a repo name for
terms of 6+ characters), whole-word matches in descriptions become
"MCP clients", and the build fails if any term survives. After a refresh,
grep the JSON with the same file before committing.


## Per-auth-mode MCP endpoints

Catalog entries may declare `urlByAuthMode`; `mcpUrl` remains the default.
Connect, OAuth discovery/token flows, and runtime project scoping resolve through
`resolveProviderMcpUrl`. Each endpoint host must be in the provider's
`trustedHostnames`. Existing connections already persist `authMode`; runtime
derives the endpoint from that mode without a schema change or migration.

Firecrawl supports OAuth at `https://mcp.firecrawl.dev/v2/mcp-oauth` and API
keys at `https://mcp.firecrawl.dev/v2/mcp`, using `Authorization: Bearer <key>`.
Verified from the [official sign-in docs](https://docs.firecrawl.dev/mcp-server)
and [API-key docs](https://docs.firecrawl.dev/mcp-server/keyless#add-an-api-key)
on 2026-11-15. Validation uses mocked MCP handshakes; no vendor calls or real
credentials are needed.
