# 0013. Swarm tasks have independent step trails and usage totals

- Status: Accepted
- Date: 2026-11-15
- Related: ADR 0011, ADR 0012; Agent Swarm slice S1

## Context

Swarm runs share one assistant message, but parallel workers cannot share its
whole-array step updates or its single usage ledger row. Replayed running totals
from different workers would overwrite each other and undercount usage.

## Decision

- `agentTasks` stores each worker's identity, instructions, model, lifecycle and
  bounded step trail. `(messageId, taskId)` is idempotent; a message has at most
  `MAX_SWARM_TASKS = 4` tasks. The reserved `sub-orchestrator` role uses the same shape.
- `convex/agentTasks.ts` owns internal-key writes and a public, authenticated,
  project-owner query. Creation checks that the message belongs to the project.
  Project deletion removes tasks in bounded batches before messages.
- Tasks and messages reuse `mergeMessageSteps`: merge by step id, preserve omitted
  fields and original start time, keep the last 100 steps. Lifecycle replays never
  reset timestamps or reopen completed tasks.
- Ledger identity becomes `(messageId, agentTaskId)`. An absent task id selects the
  existing parent row. Worker rows use their task's model label and model id for
  spend limits; totals only grow and charges only add the delta (ADR 0011/0012).
- Schema changes are additive: a new table/indexes, an optional ledger field and
  the widened optional message mode (`plan | swarm`). No backfill is needed.

## Alternatives considered

- **Keep all steps on messages.** Parallel agents would contend on the same array
  and lose their individual trails within the shared 100-step cap.
- **One combined usage total.** Every parallel worker would need synchronized
  aggregation before reporting; independent ledger rows preserve replay safety.

## Consequences

The later worker, orchestrator and UI slices can write and subscribe independently.
This slice adds only data APIs, with no worker execution, routing or UI changes.
Convex-test covers ownership, replay safety, bounds, model spend and batched deletion;
typecheck, lint, the full test suite and build validate integration without a deploy.
