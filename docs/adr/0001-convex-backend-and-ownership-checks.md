# 0001. Convex as the backend; ownership checked at every trust boundary

- Status: Accepted
- Date: 2026-10-14
- Related: #208, #209, #220, #215

## Context

Codenaya needs real-time project, file and chat state in the browser, plus server-side
writers that have no user session: API routes, and Inngest agent runs acting for the
project owner. Convex gives us reactive queries, a typed schema, storage and crons with
no servers to run.

Server-side callers can't present a Clerk JWT. They call Convex through
`ConvexHttpClient` (`src/lib/convex-client.ts`) and prove who they are with a shared
secret, `CODENAYA_CONVEX_INTERNAL_KEY`. Those `api.system.*` functions trust whatever
ids they receive. Two bugs came from that. API routes accepted another user's
`projectId` (#208). Agent file tools accepted file ids from model output that belonged
to other projects (#209).

## Decision

- Convex is the only datastore. Each domain gets one file (`convex/projects.ts`,
  `convex/files.ts`, ...), and every table and index is declared in `convex/schema.ts`.
- There are three kinds of function:
  - **Public functions** authenticate with `verifyAuth` (`convex/auth.ts`) and authorize
    with `getOwnedProject(ctx, id, ownerId)` (`convex/projects.ts`). That helper also
    treats projects with `deletingAt` set as gone.
  - **Internal-key functions** (`api.system.*`) start with `validateInternalKey`.
    Anything they touch beyond the project row is scoped to the project they're given
    (`getProjectFile` / `assertProjectFolder` in `convex/system.ts`).
  - **Scheduled and maintenance work** uses `internalMutation` / `internalQuery`.
- **API routes check ownership before any Convex write, Inngest event or sandbox.** They
  call `requireUserId` and then `requireOwnedProject` / `requireOwnedConversation`
  (`src/features/projects/server/require-owned-project.ts`). Missing, malformed and
  foreign ids get the same 404.
- Ids that arrive from outside (URLs, model output) come in as `v.string()` and go
  through `ctx.db.normalizeId`. A bad id resolves to `null` instead of throwing.

## Alternatives considered

- **Postgres plus an ORM.** It would need a separate realtime layer, a migration tool
  and hosting. Convex covers all three at zero running cost.
- **Mint a service JWT for server callers.** That means more moving parts (signing
  keys, a Clerk template), and every function would still need an ownership check.
  The shared key is simpler, as long as routes enforce ownership.
- **Pass `userId` into every `api.system.*` function and check there.** This is better
  long term, but the agent acts for the owner without a session. For now the
  route-level and project-scoped checks are where we draw the line.

## Consequences

- Real-time UI comes for free, and `convex-test` can exercise the authorization rules
  directly (`convex/system.ownership.test.ts`).
- Anyone holding the internal key can act as any user. The key is server-only, gets
  read per request, and must never reach the client or logs.
- `convex/system.ts` has grown into a 1,800-line catch-all, and there are still
  duplicate ownership checks (`convex/files.ts`, `convex/skills.ts`).
  `docs/ENGINEERING.md` §3 sets the direction: domain files, one helper, `ConvexError`
  codes.
