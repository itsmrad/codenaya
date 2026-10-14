# 0002. Agent runs on Inngest AgentKit via OpenRouter; BYOK keys resolved outside steps

- Status: Accepted
- Date: 2026-10-14
- Related: #91, #96, #97, #152, #158, #159, #186

## Context

An agent run can take minutes, makes many LLM and tool calls, and has to survive
deploys, be cancellable (`message/cancel`) and leave a durable trail. A Next.js request
can't hold it. We also want a single bill and a single API shape across many models,
and users can bring their own provider key (BYOK).

Inngest persists every `step.run` return value. A step that returned a decrypted key, an
OAuth token or a model client holding one would write that secret into Inngest's run
history.

## Decision

- Agent runs are an Inngest function, `processMessage`
  (`src/features/conversations/inngest/process-message.ts`). It is triggered by
  `message/sent` from `/api/messages` and built with `@inngest/agent-kit`
  (`createAgent` / `createNetwork`). Tools live one per file in `inngest/tools/` and
  are bound by closure to the run's `projectId`.
- **The platform model is OpenRouter.** `src/lib/openrouter.ts` is the only platform LLM
  provider, for the agent and for editor AI (`/api/suggestion`, `/api/quick-edit`,
  `/api/enhance-prompt`).
- **BYOK runs on the user's own key, with no silent fallback.** The key is stored sealed
  (`features/ai-providers/server/sealed-key.ts`). `validateModelChoice` checks it in
  the route, and `resolveRunModel` checks it again in the function, because the event
  is a trust boundary of its own. A missing, invalid or rejected key ends the run with
  a pointer to `/settings/ai-providers`. It never falls back to the platform key.
- **Secrets get resolved in the function body, never in a step.** `resolveRunModel` and
  MCP server resolution run outside `step.run` and keep keys in memory. They run again
  on each replay, which costs one Convex read and one unwrap. Steps return only
  non-secret data, such as `{ rejected }` from `check-ai-provider-key`.
- Convex writes and external side effects run inside `step.run`. Permanent failures
  throw `NonRetriableError`.
- `MESSAGE_PROCESSOR=workflow` selects a Vercel Workflow fallback on Google Vertex
  (`features/conversations/workflow/`). It drops back to Inngest when Vertex isn't
  configured (`src/lib/message-processor.ts`). The platform-key path is the only one
  that uses a non-OpenRouter provider.

## Alternatives considered

- **Run the agent inside the API route with streaming.** It dies on deploys and
  timeouts, can't be cancelled from another request, and can't retry.
- **Call provider SDKs directly per model.** That means N keys, N billing accounts and N
  sets of quirks. OpenRouter gives one OpenAI-compatible endpoint.
- **Resolve the key in a step, for determinism.** It would persist the secret.
  Re-resolving on replay is cheap.
- **Fall back to the platform key when BYOK fails.** It would surprise the user with
  credit spend and a different model.

## Consequences

- Runs are durable and observable (Inngest dashboard, Sentry middleware), and BYOK keys
  never leave process memory.
- Local development needs the Inngest dev server, and e2e needs its own Inngest port.
- Code in the function body re-runs on every replay. It must stay idempotent and cheap.
- Two backends (Inngest and Workflow) have to stay behaviorally equivalent. If the
  Workflow path stops earning its keep, remove it in a superseding ADR.
