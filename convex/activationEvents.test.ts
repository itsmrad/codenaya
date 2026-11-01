// @vitest-environment edge-runtime
/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import type { GenericValidator } from "convex/values";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

const INTERNAL_KEY = "test-internal-key";
const ALICE = "user_alice";
const BOB = "user_bob";
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

beforeEach(() => {
  vi.stubEnv("CODENAYA_CONVEX_INTERNAL_KEY", INTERNAL_KEY);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

type T = ReturnType<typeof convexTest>;

const listEvents = (t: T) =>
  t.run((ctx) => ctx.db.query("activationEvents").collect());

const names = async (t: T) => (await listEvents(t)).map((event) => event.name);

const createProject = (t: T, ownerId = ALICE) =>
  t.mutation(api.system.createProjectWithConversation, {
    internalKey: INTERNAL_KEY,
    projectName: "p",
    conversationTitle: "New",
    ownerId,
    source: "landing",
  });

const startRun = (
  t: T,
  ids: { projectId: Id<"projects">; conversationId: Id<"conversations"> },
) =>
  t.mutation(api.system.createMessage, {
    internalKey: INTERNAL_KEY,
    ...ids,
    role: "assistant",
    content: "",
    status: "processing",
  });

/** Every string-typed field path in a validator. */
function stringFields(validator: GenericValidator, path: string[] = []): string[] {
  if (validator.kind === "string") return [path.join(".")];
  if (validator.kind === "union") {
    return validator.members.flatMap((member) => stringFields(member, path));
  }
  if (validator.kind === "object") {
    return Object.entries(validator.fields).flatMap(([key, field]) =>
      stringFields(field, [...path, key]),
    );
  }
  return [];
}

describe("activation events schema", () => {
  test("holds no free text: the Clerk user id is the only string", () => {
    const fields = stringFields(schema.tables.activationEvents.validator);
    expect([...new Set(fields)]).toEqual(["userId"]);
  });

  test("rejects unknown event names and props", async () => {
    const t = convexTest(schema, modules);
    await expect(
      t.run((ctx) =>
        ctx.db.insert("activationEvents", { name: "prompt_typed", userId: ALICE, at: 0 } as never),
      ),
    ).rejects.toThrow();
    await expect(
      t.run((ctx) =>
        ctx.db.insert("activationEvents", {
          name: "project_created",
          userId: ALICE,
          at: 0,
          props: { source: "landing", prompt: "build me a todo app" },
        } as never),
      ),
    ).rejects.toThrow();
  });
});

describe("activation event writers", () => {
  test("a first build from a prompt records each step once", async () => {
    const t = convexTest(schema, modules);
    const ids = await createProject(t);

    const firstRun = await startRun(t, ids);
    const files = [
      { name: "package.json", content: "{}" },
      { name: "index.html", content: "" },
    ];
    await t.mutation(api.system.createFiles, { internalKey: INTERNAL_KEY, projectId: ids.projectId, files });
    // A nested package.json is not the project's root one.
    const folder = await t.mutation(api.system.createFolder, {
      internalKey: INTERNAL_KEY,
      projectId: ids.projectId,
      name: "server",
    });
    await t.mutation(api.system.createFile, {
      internalKey: INTERNAL_KEY,
      projectId: ids.projectId,
      parentId: folder,
      name: "package.json",
      content: "{}",
    });
    await t.mutation(api.system.updateMessageContent, {
      internalKey: INTERNAL_KEY,
      messageId: firstRun,
      content: "Done",
    });
    // A replayed final write ends no second run.
    await t.mutation(api.system.updateMessageContent, {
      internalKey: INTERNAL_KEY,
      messageId: firstRun,
      content: "Done",
    });
    await t.mutation(api.activationEvents.recordSandboxRunning, {
      internalKey: INTERNAL_KEY,
      projectId: ids.projectId,
      installMs: 4_000,
      bootMs: 1_500,
    });
    const alice = t.withIdentity({ subject: ALICE });
    await alice.mutation(api.activationEvents.recordFirstPreviewShown, { projectId: ids.projectId });
    await alice.mutation(api.activationEvents.recordFirstPreviewShown, { projectId: ids.projectId });

    const events = await listEvents(t);
    expect(events.map(({ name, props }) => ({ name, props }))).toEqual([
      { name: "project_created", props: { source: "landing" } },
      { name: "run_started", props: { firstBuild: true } },
      { name: "first_build_started", props: undefined },
      { name: "package_json_ready", props: undefined },
      { name: "run_finished", props: { outcome: "ok", firstBuild: true } },
      { name: "sandbox_running", props: { installMs: 4_000, bootMs: 1_500 } },
      { name: "first_preview_shown", props: undefined },
    ]);
    expect(events.every((event) => event.userId === ALICE && event.projectId === ids.projectId)).toBe(true);
  });

  test("later runs are not first builds, and record error and cancelled outcomes", async () => {
    const t = convexTest(schema, modules);
    const ids = await createProject(t);

    const failed = await startRun(t, ids);
    await t.mutation(api.system.updateMessageContent, {
      internalKey: INTERNAL_KEY,
      messageId: failed,
      content: "My apologies...",
      outcome: "error",
    });
    const cancelled = await startRun(t, ids);
    await t.mutation(api.system.updateMessageStatus, {
      internalKey: INTERNAL_KEY,
      messageId: cancelled,
      status: "cancelled",
    });
    // Already cancelled: the late reply of the stopped run records nothing.
    await t.mutation(api.system.updateMessageContent, {
      internalKey: INTERNAL_KEY,
      messageId: cancelled,
      content: "Late",
    });

    const runs = (await listEvents(t)).filter((event) => event.name.startsWith("run_"));
    expect(runs.map(({ name, props }) => ({ name, props }))).toEqual([
      { name: "run_started", props: { firstBuild: true } },
      { name: "run_finished", props: { outcome: "error", firstBuild: true } },
      { name: "run_started", props: { firstBuild: false } },
      { name: "run_finished", props: { outcome: "cancelled", firstBuild: false } },
    ]);
    expect((await names(t)).filter((name) => name === "first_build_started")).toHaveLength(1);
  });

  test("project_created names each source", async () => {
    const t = convexTest(schema, modules);
    const alice = t.withIdentity({ subject: ALICE });
    const projectId = await alice.mutation(api.projects.create, { name: "One" });
    await alice.mutation(api.projects.duplicate, { id: projectId });
    await t.mutation(api.system.createProject, { internalKey: INTERNAL_KEY, name: "repo", ownerId: ALICE });
    const showcaseProjectId = await alice.mutation(api.showcase.publish, {
      projectId,
      title: "Todo",
      description: "",
      techStack: [],
      designStyle: [],
      category: "tool",
    });
    await t.withIdentity({ subject: BOB }).mutation(api.showcase.importToWorkspace, { showcaseProjectId });

    const created = (await listEvents(t)).flatMap((event) =>
      event.name === "project_created" ? [[event.userId, event.props.source]] : [],
    );
    expect(created).toEqual([
      [ALICE, "dashboard"],
      [ALICE, "duplicate"],
      [ALICE, "import"],
      [BOB, "remix"],
    ]);
  });

  test("publish and export record first_publish_or_export once per project", async () => {
    const t = convexTest(schema, modules);
    const { projectId } = await createProject(t);
    const alice = t.withIdentity({ subject: ALICE });

    await alice.mutation(api.showcase.publish, {
      projectId,
      title: "Todo",
      description: "",
      techStack: [],
      designStyle: [],
      category: "tool",
    });
    for (const status of ["exporting", "completed", "completed"] as const) {
      await t.mutation(api.system.updateExportStatus, { internalKey: INTERNAL_KEY, projectId, status });
    }

    const shipped = (await listEvents(t)).filter((event) => event.name === "first_publish_or_export");
    expect(shipped).toMatchObject([{ props: { kind: "publish" } }]);
  });

  test("signed_up is recorded once, at Clerk's sign-up time", async () => {
    const t = convexTest(schema, modules);
    for (const updatedAt of [1_000, 2_000]) {
      await t.mutation(internal.users.upsertFromClerk, {
        clerkUserId: ALICE,
        updatedAt,
        createdAt: 900,
      });
    }

    expect(await listEvents(t)).toMatchObject([{ name: "signed_up", userId: ALICE, at: 900 }]);
  });

  test("a delayed sign-up webhook records the cohort after ensureCurrent wins the race", async () => {
    const t = convexTest(schema, modules);
    await t.withIdentity({ subject: ALICE, name: "Current profile" }).mutation(api.users.ensureCurrent, {});
    for (let i = 0; i < 2; i++) {
      await t.mutation(internal.users.upsertFromClerk, {
        clerkUserId: ALICE,
        name: "Old profile",
        updatedAt: 1_000,
        createdAt: 900,
      });
    }

    expect(await names(t)).toEqual(["signed_up"]);
    expect(await listEvents(t)).toMatchObject([{ userId: ALICE, at: 900 }]);
    expect(await t.withIdentity({ subject: ALICE }).query(api.users.current, {})).toMatchObject({
      name: "Current profile",
    });
  });

  test("a delayed sign-up webhook cannot recreate a deleted user's events", async () => {
    const t = convexTest(schema, modules);
    await t.run((ctx) => ctx.db.insert("users", {
      clerkUserId: ALICE,
      updatedAt: 2_000,
      deletedAt: 2_000,
    }));
    await t.mutation(internal.users.upsertFromClerk, {
      clerkUserId: ALICE,
      updatedAt: 1_000,
      createdAt: 900,
    });
    expect(await names(t)).toEqual([]);
  });

  test("first_preview_shown is owner-only", async () => {
    const t = convexTest(schema, modules);
    const { projectId } = await createProject(t);

    await expect(
      t.withIdentity({ subject: BOB }).mutation(api.activationEvents.recordFirstPreviewShown, { projectId }),
    ).rejects.toThrow("Unauthorized access to this project");
    await expect(
      t.mutation(api.activationEvents.recordFirstPreviewShown, { projectId }),
    ).rejects.toThrow("Unauthorized");

    expect(await names(t)).toEqual(["project_created"]);
  });

  test("sandbox_running needs the internal key", async () => {
    const t = convexTest(schema, modules);
    const { projectId } = await createProject(t);

    await expect(
      t.mutation(api.activationEvents.recordSandboxRunning, {
        internalKey: "wrong",
        projectId,
        installMs: 1,
        bootMs: 1,
      }),
    ).rejects.toThrow("Invalid internal key");
    expect(await names(t)).toEqual(["project_created"]);
  });
});

describe("activationEvents.report", () => {
  const WEEK_START = 10 * DAY;

  test("returns medians, p90s and the 7-day funnel for a sign-up cohort", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      const projectId = (ownerId: string) =>
        ctx.db.insert("projects", { name: "p", ownerId, updatedAt: 0 });

      // Ten users sign up an hour apart; user i sees a first preview i+1 minutes later.
      for (let i = 0; i < 10; i++) {
        const userId = `user_${i}`;
        const signedUpAt = WEEK_START + i * HOUR;
        const project = await projectId(userId);
        const base = { userId, projectId: project };
        await ctx.db.insert("activationEvents", { name: "signed_up", userId, at: signedUpAt });
        await ctx.db.insert("activationEvents", {
          ...base,
          name: "project_created",
          at: signedUpAt + 1,
          props: { source: "landing" },
        });
        await ctx.db.insert("activationEvents", {
          ...base,
          name: "first_build_started",
          at: signedUpAt + 2,
        });
        await ctx.db.insert("activationEvents", {
          ...base,
          name: "sandbox_running",
          at: signedUpAt + 2 + (i + 1) * 1_000,
          props: { installMs: 1, bootMs: 1 },
        });
        // Half finish ok; the rest error.
        await ctx.db.insert("activationEvents", {
          ...base,
          name: "run_finished",
          at: signedUpAt + 3,
          props: { outcome: i % 2 === 0 ? "ok" : "error", firstBuild: true },
        });
        // User 9 reaches a preview only after the 7-day window.
        const previewAt = i === 9 ? signedUpAt + 8 * DAY : signedUpAt + (i + 1) * 60_000;
        await ctx.db.insert("activationEvents", { ...base, name: "first_preview_shown", at: previewAt });
        if (i < 3) {
          await ctx.db.insert("activationEvents", {
            ...base,
            name: "first_publish_or_export",
            at: signedUpAt + DAY,
            props: { kind: "publish" },
          });
        }
      }
      // Outside the cohort.
      await ctx.db.insert("activationEvents", { name: "signed_up", userId: "user_old", at: WEEK_START - DAY });
    });

    const result = await t.query(internal.activationEvents.report, {
      from: WEEK_START,
      to: WEEK_START + 7 * DAY,
    });

    expect(result).toEqual({
      truncated: false,
      signupToFirstPreview: { count: 10, medianMs: 5 * 60_000, p90Ms: 9 * 60_000 },
      firstBuildToSandboxRunning: { count: 10, medianMs: 5_000, p90Ms: 9_000 },
      funnel: {
        signedUp: 10,
        projectCreated: 10,
        runFinishedOk: 5,
        firstPreviewShown: 9,
        publishedOrExported: 3,
      },
    });
  });

  test("is empty without events", async () => {
    const t = convexTest(schema, modules);
    const result = await t.query(internal.activationEvents.report, { from: 0, to: DAY });
    expect(result.signupToFirstPreview).toEqual({ count: 0, medianMs: null, p90Ms: null });
    expect(result.funnel.signedUp).toBe(0);
  });

  test("later runs do not consume the report's first-build limit", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      const projectId = await ctx.db.insert("projects", { name: "p", ownerId: ALICE, updatedAt: 0 });
      const base = { userId: ALICE, projectId };
      for (let i = 0; i < 501; i++) {
        await ctx.db.insert("activationEvents", {
          ...base, name: "run_started", at: i, props: { firstBuild: false },
        });
      }
      await ctx.db.insert("activationEvents", { ...base, name: "first_build_started", at: 1_000 });
      await ctx.db.insert("activationEvents", {
        ...base, name: "sandbox_running", at: 2_000, props: { installMs: 1, bootMs: 1 },
      });
    });

    const report = await t.query(internal.activationEvents.report, { from: 0, to: DAY });
    expect(report.truncated).toBe(false);
    expect(report.firstBuildToSandboxRunning).toEqual({ count: 1, medianMs: 1_000, p90Ms: 1_000 });
  });
});
