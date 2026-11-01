import { v } from "convex/values";
import type { WithoutSystemFields } from "convex/server";

import type { Doc, Id } from "./_generated/dataModel";
import {
  internalQuery,
  mutation,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import { verifyAuth } from "./auth";
import { validateInternalKey } from "./internalKey";
import { getOwnedProject } from "./projects";

/**
 * First-party activation events (#339): sign-up to first preview, then publish
 * or export. Server code writes them inside the mutations that already mark
 * each moment (project inserts, message status changes, file creation), so an
 * event commits with the change it describes. Only `first_preview_shown` comes
 * from the browser, and only for the caller's own project.
 */

type StoredEvent = WithoutSystemFields<Doc<"activationEvents">>;
type EventName = StoredEvent["name"];
type Body<E> = E extends unknown ? Omit<E, "userId" | "projectId" | "at"> : never;
/** An event's name and props; who, which project and when are filled in here. */
type EventBody = Body<StoredEvent>;

const DAY_MS = 24 * 60 * 60 * 1000;
const FUNNEL_WINDOW_MS = 7 * DAY_MS;

// shortcut: one transaction reads at most this many sign-ups (and first builds)
// per report, about 3k index lookups; page through an action once a week
// brings more sign-ups than this.
const MAX_REPORT_ROWS = 500;
/** `run_finished` rows checked per user for an `ok` one within the window. */
const MAX_RUNS_CHECKED = 20;

const earliestProjectEvent = (
  ctx: QueryCtx,
  projectId: Id<"projects">,
  name: EventName,
) =>
  ctx.db
    .query("activationEvents")
    .withIndex("by_projectId_and_name_and_at", (q) =>
      q.eq("projectId", projectId).eq("name", name),
    )
    .first();

/**
 * Records a project's event for its owner. With `once`, a project that already
 * has an event of this name keeps the first. A missing project records nothing.
 */
export async function recordProjectEvent(
  ctx: MutationCtx,
  projectId: Id<"projects">,
  event: EventBody,
  { once = false }: { once?: boolean } = {},
) {
  const project = await ctx.db.get("projects", projectId);
  if (!project) return;
  if (once && (await earliestProjectEvent(ctx, projectId, event.name))) return;

  await ctx.db.insert("activationEvents", {
    ...event,
    userId: project.ownerId,
    projectId,
    at: Date.now(),
  } as StoredEvent);
}

/** Once per user, at Clerk's sign-up time, so a replayed webhook adds nothing. */
export async function recordSignedUp(ctx: MutationCtx, userId: string, at: number) {
  const existing = await ctx.db
    .query("activationEvents")
    .withIndex("by_userId_and_name_and_at", (q) =>
      q.eq("userId", userId).eq("name", "signed_up"),
    )
    .first();
  if (!existing) {
    await ctx.db.insert("activationEvents", { name: "signed_up", userId, at });
  }
}

/**
 * `run_started` for a new assistant placeholder. `firstBuild` (here and on
 * `run_finished`) means the project's first run to start (or finish).
 */
export async function recordRunStarted(ctx: MutationCtx, projectId: Id<"projects">) {
  const firstBuild = !(await earliestProjectEvent(ctx, projectId, "run_started"));
  await recordProjectEvent(ctx, projectId, { name: "run_started", props: { firstBuild } });
}

/**
 * `run_finished` when a message leaves `processing`. Call it before the patch:
 * a message that is no longer processing has already ended its run, so a
 * replayed or late write records nothing.
 */
export async function recordRunFinished(
  ctx: MutationCtx,
  message: Doc<"messages"> | null,
  outcome: "ok" | "error" | "cancelled",
) {
  if (!message || message.role !== "assistant" || message.status !== "processing") return;
  const firstBuild = !(await earliestProjectEvent(ctx, message.projectId, "run_finished"));
  await recordProjectEvent(ctx, message.projectId, {
    name: "run_finished",
    props: { outcome, firstBuild },
  });
}

/** `package_json_ready` the first time a project gets a root `package.json`. */
export async function recordPackageJsonReady(
  ctx: MutationCtx,
  file: { projectId: Id<"projects">; parentId?: Id<"files">; name: string },
) {
  if (file.parentId !== undefined || file.name !== "package.json") return;
  await recordProjectEvent(ctx, file.projectId, { name: "package_json_ready" }, { once: true });
}

/**
 * `sandbox_running` from `POST /api/sandbox`, which has already checked that
 * the caller owns the project (ADR 0001). One per boot.
 */
export const recordSandboxRunning = mutation({
  args: {
    internalKey: v.string(),
    projectId: v.id("projects"),
    installMs: v.number(),
    bootMs: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, { internalKey, projectId, installMs, bootMs }) => {
    validateInternalKey(internalKey);
    await recordProjectEvent(ctx, projectId, {
      name: "sandbox_running",
      props: { installMs, bootMs },
    });
    return null;
  },
});

/** The browser saw the preview load: once per project, owner only. */
export const recordFirstPreviewShown = mutation({
  args: { projectId: v.id("projects") },
  returns: v.null(),
  handler: async (ctx, { projectId }) => {
    const identity = await verifyAuth(ctx);
    await getOwnedProject(ctx, projectId, identity.subject);
    await recordProjectEvent(ctx, projectId, { name: "first_preview_shown" }, { once: true });
    return null;
  },
});

// ─── Read side ───

/** Nearest-rank percentile of ascending `sorted`, or null when empty. */
const percentile = (sorted: number[], p: number) =>
  sorted.length === 0 ? null : sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)];

const summarize = (durations: number[]) => {
  const sorted = [...durations].sort((a, b) => a - b);
  return {
    count: sorted.length,
    medianMs: percentile(sorted, 0.5),
    p90Ms: percentile(sorted, 0.9),
  };
};

const durationSummaryValidator = v.object({
  count: v.number(),
  medianMs: v.union(v.number(), v.null()),
  p90Ms: v.union(v.number(), v.null()),
});

/**
 * Activation numbers for users who signed up in `[from, to)` (ms), run from
 * the Convex dashboard or
 * `npx convex run activationEvents:report '{"from": 1793491200000, "to": 1794096000000}'`.
 *
 * - `signupToFirstPreview`: sign-up to the user's first `first_preview_shown`.
 * - `firstBuildToSandboxRunning`: each first build started in the range to
 *   that project's next `sandbox_running`.
 * - `funnel`: of those sign-ups, how many reached each step within 7 days.
 */
export const report = internalQuery({
  args: { from: v.number(), to: v.number() },
  returns: v.object({
    truncated: v.boolean(),
    signupToFirstPreview: durationSummaryValidator,
    firstBuildToSandboxRunning: durationSummaryValidator,
    funnel: v.object({
      signedUp: v.number(),
      projectCreated: v.number(),
      runFinishedOk: v.number(),
      firstPreviewShown: v.number(),
      publishedOrExported: v.number(),
    }),
  }),
  handler: async (ctx, { from, to }) => {
    const inRange = (name: EventName) =>
      ctx.db
        .query("activationEvents")
        .withIndex("by_name_and_at", (q) => q.eq("name", name).gte("at", from).lt("at", to))
        .take(MAX_REPORT_ROWS + 1);

    const signups = await inRange("signed_up");
    const runStarts = await inRange("run_started");
    const truncated = signups.length > MAX_REPORT_ROWS || runStarts.length > MAX_REPORT_ROWS;

    const funnel = {
      signedUp: 0,
      projectCreated: 0,
      runFinishedOk: 0,
      firstPreviewShown: 0,
      publishedOrExported: 0,
    };
    const toFirstPreview: number[] = [];

    for (const signup of signups.slice(0, MAX_REPORT_ROWS)) {
      const deadline = signup.at + FUNNEL_WINDOW_MS;
      const userEvents = (name: EventName) =>
        ctx.db
          .query("activationEvents")
          .withIndex("by_userId_and_name_and_at", (q) =>
            q.eq("userId", signup.userId).eq("name", name).gte("at", signup.at),
          );
      const withinWindow = (name: EventName) =>
        userEvents(name)
          .first()
          .then((event) => (event && event.at <= deadline ? event : null));

      const firstPreview = await userEvents("first_preview_shown").first();
      if (firstPreview) toFirstPreview.push(firstPreview.at - signup.at);

      const runs = await userEvents("run_finished").take(MAX_RUNS_CHECKED);
      funnel.signedUp += 1;
      if (await withinWindow("project_created")) funnel.projectCreated += 1;
      if (runs.some((run) => run.at <= deadline && run.name === "run_finished" && run.props.outcome === "ok")) {
        funnel.runFinishedOk += 1;
      }
      if (firstPreview && firstPreview.at <= deadline) funnel.firstPreviewShown += 1;
      if (await withinWindow("first_publish_or_export")) funnel.publishedOrExported += 1;
    }

    const toSandboxRunning: number[] = [];
    for (const start of runStarts.slice(0, MAX_REPORT_ROWS)) {
      if (start.name !== "run_started" || !start.props.firstBuild || !start.projectId) continue;
      const projectId = start.projectId;
      const running = await ctx.db
        .query("activationEvents")
        .withIndex("by_projectId_and_name_and_at", (q) =>
          q.eq("projectId", projectId).eq("name", "sandbox_running").gte("at", start.at),
        )
        .first();
      if (running) toSandboxRunning.push(running.at - start.at);
    }

    return {
      truncated,
      signupToFirstPreview: summarize(toFirstPreview),
      firstBuildToSandboxRunning: summarize(toSandboxRunning),
      funnel,
    };
  },
});

