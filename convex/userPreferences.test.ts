// @vitest-environment edge-runtime
/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";

import { api } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

const ALICE = "user_alice";
const BOB = "user_bob";

const setup = () => convexTest(schema, modules);
const as = (t: ReturnType<typeof setup>, userId: string) => t.withIdentity({ subject: userId });

describe("workspace mode", () => {
  test("requires auth to read or write", async () => {
    const t = setup();
    await expect(t.query(api.userPreferences.getWorkspaceMode, {})).rejects.toThrow(/Unauthorized/);
    await expect(
      t.mutation(api.userPreferences.setWorkspaceMode, { workspaceMode: "chat" }),
    ).rejects.toThrow(/Unauthorized/);
  });

  test("defaults to ide and keeps one row per user", async () => {
    const t = setup();
    expect(await as(t, ALICE).query(api.userPreferences.getWorkspaceMode, {})).toBe("ide");

    await as(t, ALICE).mutation(api.userPreferences.setWorkspaceMode, { workspaceMode: "chat" });
    await as(t, ALICE).mutation(api.userPreferences.setWorkspaceMode, { workspaceMode: "ide" });
    await as(t, ALICE).mutation(api.userPreferences.setWorkspaceMode, { workspaceMode: "chat" });

    expect(await as(t, ALICE).query(api.userPreferences.getWorkspaceMode, {})).toBe("chat");
    const rows = await t.run((ctx) => ctx.db.query("userWorkspacePreferences").collect());
    expect(rows).toMatchObject([{ userId: ALICE, workspaceMode: "chat" }]);
  });

  test("reads and writes only the caller's own row", async () => {
    const t = setup();
    await as(t, ALICE).mutation(api.userPreferences.setWorkspaceMode, { workspaceMode: "chat" });

    expect(await as(t, BOB).query(api.userPreferences.getWorkspaceMode, {})).toBe("ide");
    await as(t, BOB).mutation(api.userPreferences.setWorkspaceMode, { workspaceMode: "ide" });

    expect(await as(t, ALICE).query(api.userPreferences.getWorkspaceMode, {})).toBe("chat");
    const rows = await t.run((ctx) => ctx.db.query("userWorkspacePreferences").collect());
    expect(rows.map((row) => [row.userId, row.workspaceMode]).sort()).toEqual([
      [ALICE, "chat"],
      [BOB, "ide"],
    ]);
  });

  test("rejects an unknown mode", async () => {
    const t = setup();
    await expect(
      as(t, ALICE).mutation(api.userPreferences.setWorkspaceMode, {
        workspaceMode: "board" as "chat",
      }),
    ).rejects.toThrow();
  });
});
