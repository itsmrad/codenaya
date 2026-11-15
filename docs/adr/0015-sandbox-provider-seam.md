# 0015. Sandbox provider seam

- Status: Accepted
- Date: 2026-11-15
- Related: [ADR 0003](0003-e2b-node22-preview-template.md), [ADR 0001](0001-convex-backend-and-ownership-checks.md)

## Context

Every cloud preview, `checkBuild`, build repair and swarm worker sandbox calls the
`e2b` SDK directly, from about ten files (`project-sandbox.ts`, `api/sandbox/route.ts`,
`api/sandbox/[sandboxId]/route.ts`, `sandbox-registry.ts`, `dev-server.ts`,
`check-build.ts`, `build-repair.ts`, `sandbox-repair.ts`, `swarm-sandbox.ts`). We want
to be able to move to another vendor (Blaxel, Daytona, ...) or fail over to one
without rewriting those paths again. Two things the code relies on are
security- or correctness-critical and must survive any vendor:

- **Ownership lives in sandbox metadata.** `getOwnedSandbox` connects and checks
  `getInfo().metadata.userId`; the per-user cap, the warm-preview lookup and swarm and
  repair cleanup list sandboxes by metadata. Convex stores no sandbox rows.
- **The client round-trips the sandbox id** (DELETE, PATCH sync, `resumeSandboxId`),
  so the id must say which vendor holds the sandbox.

## Decision

All sandbox access goes through `src/features/sandbox-preview/server/provider/`:

- `types.ts`: `SandboxProvider` (`create`, `connect`, `list`, `kill`, optional
  `snapshot`/`createFromSnapshot`/`deleteSnapshot`, `maxSessionMs`) and `Sandbox`
  (`run`, `start`, `writeFiles`, `readFile`, `previewUrl`, `info`, `kill`), plus
  `SandboxConfigError`, `SandboxRateLimitError` and `SandboxTimeoutError`.
  - `run` resolves with `{ exitCode, stdout, stderr }`; a non-zero exit is not an error.
  - `start` runs a command in the background with no time limit and resolves with its pid.
  - `list` returns running sandboxes only, one page, with `metadata` and `endAt`.
  - Every call takes `requestTimeoutMs`, so callers keep bounding each request by
    their remaining budget.
- `e2b.ts` is the only file that imports the `e2b` SDK. It maps
  `AuthenticationError`, `RateLimitError` and `TimeoutError` to the seam's errors
  (message kept, vendor error as `cause`) and turns `CommandExitError` into a result.
- `helpers.ts` holds what can be written once over `run`: `listProcesses` (read from
  `/proc`, with the full environment and the parent pid), `killTree`, `exists`, `remove`.
- `ids.ts`: the public id is `<provider>:<nativeId>`. An unprefixed id is E2B's, so
  previews opened before the rollout keep working. A prefix must be a known
  `ProviderId` and the native id must match `[A-Za-z0-9_-]{1,128}`; anything else is
  rejected before it reaches a vendor.
- `registry.ts`: `getProvider(id)` and `getDefaultProvider()`. A provider whose key is
  unset throws `SandboxConfigError`, so it stays dark until configured.

**Ownership rule.** Every adapter must store `userId` (and `projectId` where the caller
sets it) as metadata or labels at create time and return it from `info()` and `list()`.
`getOwnedSandbox` routes by the id's prefix and then still checks
`info().metadata.userId`. The prefix only says where to look; it never proves who owns
the sandbox. A vendor that cannot store or filter labels needs a Convex sandbox
registry before it gets an adapter.

## Alternatives considered

- **Keep calling `e2b` directly and swap the SDK later.** Every swap would touch the
  same ten files again, and failover would be impossible.
- **The handoff's `caps.snapshots` / `caps.labelQuery` flags.** Optional methods say the
  same thing and the type checker enforces them, so a flag can't disagree with the
  adapter. Label queries are required by the ownership rule, not a capability.
- **`listProcesses` per adapter (E2B `commands.list`).** It works only on vendors with
  a process API. `/proc` works on every Linux sandbox. Unlike `commands.list` it shows
  children too, so a marked command tree is found as the marked process whose parent is
  not marked.
- **Left out until something calls it:** pause/resume, `commands.kill(pid)` (`killTree`
  replaces it), `makeDir` (folded into `writeFiles`), template building (a per-vendor
  script, not a runtime call), env-based selection and failover.

## Consequences

- Rollout, one concern per PR:
  - **PR1a** (this ADR): the seam, the E2B adapter and tests. No call site changes.
  - **PR1b**: the preview paths (`project-sandbox.ts`, both sandbox routes,
    `sandbox-registry.ts`, `dev-server.ts`) move onto the seam, with their mocked tests
    and prefixed public ids. `isPortOpen` and the `SANDBOX_TEMPLATE` default move into
    the seam then.
  - **PR2**: the agent paths (`check-build`, `build-repair`, `sandbox-repair`,
    `swarm-sandbox`). The swarm's envd-version gate before a snapshot stays E2B-specific.
  - **PR3**: `SANDBOX_PROVIDER` / `SANDBOX_PROVIDER_FALLBACKS`, failover with a cooldown,
    and the cap and cleanup fanned out over every enabled provider.
- Until PR1b and PR2 land, the seam is unused and both styles exist side by side.
- PR1a is tested only against a mocked `e2b` SDK. The `/proc` listing script was run
  in a local Linux shell, not in an E2B sandbox. PR1b's preview e2e specs
  (`e2e/preview-e2b-*`) are the first run against the real service.
- A new vendor means a new adapter, an image build script and per-vendor e2e secrets.
  Each vendor also becomes a subprocessor for the `.env` secrets written into its sandboxes.

## PR2 status

`check-build.ts`, `build-repair.ts`, `sandbox-repair.ts` and `swarm-sandbox.ts` now
reach sandboxes only through the seam (`getDefaultProviderOrNull()`, `provider.create`,
`list`, `connect`, `kill`, the snapshot methods, and `run`/`writeFiles`/`readFile` plus
`runOrThrow`, `exists` and `remove` from `helpers.ts`). Metadata is unchanged:
`purpose`, `projectId`, `runId` and `messageId`, and `userId` on the warm-preview lookup.
The swarm stays off by default and needs a provider with all three snapshot methods.

`e2bHandleOf(sandbox)` (in `e2b.ts`) hands back the raw E2B handle in two places only:
- **The warm preview in `check-build.ts`.** The install poll uses `commands.list` and
  `findPreviewDevServer`/`restartDevServerIfDown` from `dev-server.ts`, all of which are
  typed to the E2B handle until PR1b moves `dev-server.ts`. Their E2B timeout handling
  is unchanged.
- **The swarm's envd-version gate** before a snapshot.

Seam errors replace E2B's on these paths, so the `[check-build] unfinished` log now
names `SandboxTimeoutError` rather than `TimeoutError`. The E2B adapter's `snapshot`
calls the sandbox's own `createSnapshot`. Coverage is still the mocked `e2b` SDK and
the agent e2e specs; there has been no live run.
