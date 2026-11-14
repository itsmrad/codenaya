# 0013. Agent swarm: an orchestrator run that delegates to parallel workers

- Status: Proposed
- Date: 2026-11-14
- Related: ADR 0002 (agent runtime), ADR 0011 (credit metering), RELIABILITY PR-A (build gate) and PR-B (`verifyAndFix`)

## Context

One coding agent writes a whole app file by file, so a large first build is slow. Most
of that work splits cleanly: pages and components that share only a few foundation
files. We want several cheap agents writing at once without a second preview, a merge
step, or a second build-and-fix loop next to the one that already exists.

Constraints from the code:

- Agent writes reach only the Convex file tree; the browser syncs that tree to the one
  preview sandbox (`process-message.ts`). The auto-fixer stays disarmed while a run is
  active, and the first-build banner hides mid-run errors.
- AgentKit names inference steps after the agent and gives tools fixed step ids
  (`update-file`). N networks inside one Inngest function would rely on Inngest
  suffixing duplicate ids in discovery order, which is a replay hazard.
- `messages.steps` is rewritten whole and capped at 100, so it can't hold N live logs.
- `creditLedger` is keyed by message only (ADR 0011).

## Decision

- **Swarm is a third message `mode`** (`"swarm"`, next to `"plan"`). It is still one
  `processMessage` run with one assistant message.
- **The orchestrator is the run's model.** It is validated as today
  (`validateModelChoice` → `resolveRunModel`: promo, spend caps, credits). Auto routes a
  build to Sonnet 5.5. Workers are Haiku 5.5, resolved by `resolveWorkerModel` from the
  platform catalog (hidden entries allowed) or the user's key; otherwise the run's model.
- **Planning is a tool, `delegateTasks`.** The orchestrator writes the shared foundation
  itself, then calls `delegateTasks` once with 2-4 tasks. The plan is zod-validated; a bad
  plan returns `Error: …` so the model re-plans. A second call is refused.
- **One `swarm-worker` Inngest function per task, via parallel `step.invoke`.** Each worker
  gets its own run, step ids, step budget, retries, concurrency key and `cancelOn` (the
  parent's `message/cancel`). Results are collected with `Promise.allSettled`; a failed or
  unfinished worker is reported in the tool result, and the orchestrator finishes its
  files. No automatic re-dispatch.
- **The Convex file tree is the merge point, and the single preview stays.** Workers write
  the same tree the orchestrator does. Nothing is copied or merged.
- **Path ownership.** Each task owns disjoint paths under `src/` (no path equals or prefixes
  another's). Shared files (package.json, lockfile, index.html, vite/ts/tailwind configs,
  components.json, src/main.tsx, src/App.tsx, src/index.css, src/lib/utils.ts) are reserved
  for the orchestrator. Worker write tools are wrapped by `guardOwnedPaths`; reads are
  unrestricted. Deps or shared edits a worker needs go under `NEEDS:` in its report.
- **Data.** A new `agentTasks` table holds each task's status, owned paths, model and live
  steps. Metering writes one `creditLedger` row per (message, task) with the task's model
  (`agentTaskId`); the parent row keeps `agentTaskId` undefined, so old rows are unchanged.
- **Integration goes through the existing build gate** (RELIABILITY PR-A). After the workers
  settle, the orchestrator continues in the same network as the integrator and ends through
  `checkBuild` and the build-check gate. There is no second verify/fix loop and no per-worker
  build: a partial tree fails static checks for sibling files.
- **Caps** (constants in `src/features/conversations/swarm.ts`): 2-4 tasks, one
  `delegateTasks` call per run, 4 concurrent workers per owner, `WORKER_MAX_STEPS=20`,
  `MAX_WORKER_USD=0.50` at catalog price (BYOK is unpriced, so only the step cap applies),
  a 12-minute `step.invoke` timeout, and the existing `MAX_AGENT_STEPS=40` for the
  orchestrator plus integration. Workers start no sandboxes.
- **Liveness.** Each worker turn upserts the parent's `turn-heartbeat` step, so the stalled
  and lost-run timers and the reaper work unchanged. Running tasks under a cancelled or
  finished parent show as cancelled; no extra row writes.
- **e2e.** `e2e/stub-provider.ts` tells roles apart with `stubRole`: a worker's system prompt
  contains `SWARM_WORKER_MARKER` (`"[swarm-worker]"`, which `SWARM_WORKER_NOTE` must include),
  and the orchestrator is offered `delegateTasks`. Tool-call ids are random so concurrent
  workers never collide.

## Alternatives considered

- **N agent networks inside `processMessage`.** Depends on Inngest's duplicate-id suffixing
  (replay hazard), shares one step budget, and bloats an already long function.
- **A separate planner agent before the run.** It would bypass the router, loop guard,
  cut-off handling, gate and metering that the network already applies. A tool keeps them.
- **One sandbox per worker (multi-sandbox), skipped in v1.** Workers can't build partial
  trees; it adds 3-10 cold boots and installs; the 3-preview cap and E2B rate limits apply;
  and copying files back would duplicate the Convex merge point.
- **Storing worker logs in `messages.steps`.** The whole-array rewrite and the 100-step cap
  don't fit N concurrent writers.

## Consequences

- A large first build can run 2-4 writers at once on one preview and one integration build.
- Worker cost is bounded (≈$1 worst case per swarm above a single run, ≈$0.3 typical).
- The orchestrator absorbs failures, so a weak plan costs integrator turns, not a crash.
- Workers can't see each other's work until it lands in the tree; contracts must be in the
  foundation the orchestrator writes first.
- Follow-up S6: an optional per-worker self-check using RELIABILITY PR-B `verifyAndFix`.
  Filtered per-worker results can only be "scoped-ok" (the checks ignore sibling files);
  the integration verify is always unfiltered and stays the only "verified" signal.
- Revisit multi-sandbox only if evals show the single integration build is the bottleneck.
