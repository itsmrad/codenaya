// @vitest-environment edge-runtime
/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import {
  PROMO_ENDS_AT,
  PROMO_OPUS_RUN_LIMIT,
} from "../src/features/promotions/github-promo";
import { api } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

const INTERNAL_KEY = "test-internal-key";
const ALICE = "user_alice";
const BOB = "user_bob";
const DAY = 24 * 60 * 60 * 1000;

/** Two days before the end; GitHub accounts are aged from here. */
const NOW = PROMO_ENDS_AT - 2 * DAY;

const setup = () => convexTest(schema, modules);
type TestConvex = ReturnType<typeof setup>;

const claim = (
  t: TestConvex,
  userId: string,
  github: { id?: number; createdAt?: number } = {},
) =>
  t.mutation(api.promoClaims.claim, {
    internalKey: INTERNAL_KEY,
    userId,
    githubUserId: github.id ?? 1,
    githubLogin: "octocat",
    githubCreatedAt: github.createdAt ?? NOW - 400 * DAY,
  });

const takeRun = (t: TestConvex, userId: string, kind: "opus" | "sonnet") =>
  t.mutation(api.promoClaims.takeRun, { internalKey: INTERNAL_KEY, userId, kind });

const reasonOf = (promise: Promise<unknown>) =>
  promise.then(
    () => null,
    (error: { data?: { reason?: string } }) => error.data?.reason,
  );

beforeEach(() => {
  vi.stubEnv("CODENAYA_CONVEX_INTERNAL_KEY", INTERNAL_KEY);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("claim", () => {
  test("records the claim, which the user then reads", async () => {
    const t = setup();
    await claim(t, ALICE);

    expect(await t.withIdentity({ subject: ALICE }).query(api.promoClaims.getMine, {})).toEqual({
      githubLogin: "octocat",
      opusRunsUsed: 0,
      claimedAt: NOW,
    });
    expect(await t.withIdentity({ subject: BOB }).query(api.promoClaims.getMine, {})).toBeNull();
  });

  test("refuses a second claim by the same user", async () => {
    const t = setup();
    await claim(t, ALICE);
    expect(await reasonOf(claim(t, ALICE, { id: 2 }))).toBe("already_claimed");
  });

  test("refuses a GitHub account another user already claimed with", async () => {
    const t = setup();
    await claim(t, ALICE);
    expect(await reasonOf(claim(t, BOB))).toBe("github_already_used");
  });

  test("refuses GitHub accounts younger than a year, and allows exactly a year", async () => {
    const t = setup();
    expect(await reasonOf(claim(t, ALICE, { createdAt: NOW - 364 * DAY }))).toBe("github_too_new");
    expect(await reasonOf(claim(t, ALICE, { createdAt: NOW - 365 * DAY }))).toBeNull();
  });

  test("refuses claims once the promotion has ended", async () => {
    const t = setup();
    vi.setSystemTime(PROMO_ENDS_AT);
    expect(await reasonOf(claim(t, ALICE))).toBe("promo_ended");
  });

  test("needs the internal key", async () => {
    const t = setup();
    await expect(
      t.mutation(api.promoClaims.claim, {
        internalKey: "wrong",
        userId: ALICE,
        githubUserId: 1,
        githubLogin: "octocat",
        githubCreatedAt: 0,
      }),
    ).rejects.toThrow();
  });
});

describe("takeRun", () => {
  test("refuses users without a claim", async () => {
    const t = setup();
    expect(await takeRun(t, ALICE, "sonnet")).toBe("not_claimed");
  });

  test("counts Opus runs up to the limit, and Sonnet stays free after", async () => {
    const t = setup();
    await claim(t, ALICE);

    for (let i = 0; i < PROMO_OPUS_RUN_LIMIT; i++) {
      expect(await takeRun(t, ALICE, "opus")).toBeNull();
    }
    expect(await takeRun(t, ALICE, "opus")).toBe("opus_used_up");
    expect(await takeRun(t, ALICE, "sonnet")).toBeNull();

    const mine = await t.withIdentity({ subject: ALICE }).query(api.promoClaims.getMine, {});
    expect(mine?.opusRunsUsed).toBe(PROMO_OPUS_RUN_LIMIT);
  });

  test("gives the last Opus run to only one of two parallel sends", async () => {
    const t = setup();
    await claim(t, ALICE);
    for (let i = 0; i < PROMO_OPUS_RUN_LIMIT - 1; i++) await takeRun(t, ALICE, "opus");

    const results = await Promise.all([takeRun(t, ALICE, "opus"), takeRun(t, ALICE, "opus")]);
    expect(results.sort()).toEqual(["opus_used_up", null].sort());
  });

  test("refuses every promo run once the promotion has ended", async () => {
    const t = setup();
    await claim(t, ALICE);
    vi.setSystemTime(PROMO_ENDS_AT);
    expect(await takeRun(t, ALICE, "sonnet")).toBe("ended");
    expect(await takeRun(t, ALICE, "opus")).toBe("ended");
  });
});

describe("getForServer and refundRun", () => {
  test("report the count, and a refund gives back one Opus run", async () => {
    const t = setup();
    const read = () =>
      t.query(api.promoClaims.getForServer, { internalKey: INTERNAL_KEY, userId: ALICE });
    const refund = (kind: "opus" | "sonnet") =>
      t.mutation(api.promoClaims.refundRun, { internalKey: INTERNAL_KEY, userId: ALICE, kind });

    expect(await read()).toBeNull();
    await claim(t, ALICE);
    await takeRun(t, ALICE, "opus");
    await takeRun(t, ALICE, "opus");
    expect(await read()).toEqual({ opusRunsUsed: 2 });

    await refund("sonnet");
    expect(await read()).toEqual({ opusRunsUsed: 2 });
    await refund("opus");
    await refund("opus");
    await refund("opus");
    expect(await read()).toEqual({ opusRunsUsed: 0 });
  });
});

describe("hasClaimForProjectOwner", () => {
  test("answers for the project's owner", async () => {
    const t = setup();
    await claim(t, ALICE);
    const [aliceProject, bobProject] = await t.run(async (ctx) => {
      const project = (ownerId: string) =>
        ctx.db.insert("projects", { name: "p", ownerId, updatedAt: NOW });
      return [await project(ALICE), await project(BOB)];
    });

    const has = (projectId: typeof aliceProject) =>
      t.query(api.promoClaims.hasClaimForProjectOwner, { internalKey: INTERNAL_KEY, projectId });
    expect(await has(aliceProject)).toBe(true);
    expect(await has(bobProject)).toBe(false);
  });
});
