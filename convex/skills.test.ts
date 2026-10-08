// @vitest-environment edge-runtime
/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { MAX_LIBRARY_SKILLS } from "../src/features/skills/limits";
import { api } from "./_generated/api";
import { deleteProjectBatch } from "./projectCascade";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

const ALICE = "user_alice";
const BOB = "user_bob";
const INTERNAL_KEY = "test-internal-key";

const skill = (name: string) => ({
  name,
  description: `Use for ${name}.`,
  body: `# ${name}`,
});

function setup() {
  const t = convexTest(schema, modules);
  return {
    t,
    alice: t.withIdentity({ subject: ALICE }),
    bob: t.withIdentity({ subject: BOB }),
  };
}

const createProject = (t: ReturnType<typeof convexTest>, ownerId: string) =>
  t.run((ctx) =>
    ctx.db.insert("projects", { name: "App", ownerId, updatedAt: Date.now() }),
  );

const countSettings = (t: ReturnType<typeof convexTest>) =>
  t.run(async (ctx) => (await ctx.db.query("projectSkillSettings").collect()).length);

describe("skills", () => {
  beforeEach(() => {
    vi.stubEnv("CODENAYA_CONVEX_INTERNAL_KEY", INTERNAL_KEY);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  test("rejects invalid skills server-side", async () => {
    const { alice } = setup();

    await expect(
      alice.mutation(api.skills.create, skill("Bad--Name")),
    ).rejects.toThrow(/Skill name/);
    await expect(
      alice.mutation(api.skills.create, { ...skill("long"), body: "b".repeat(20_001) }),
    ).rejects.toThrow(/20,000/);

    const id = await alice.mutation(api.skills.create, skill("ok"));
    await expect(
      alice.mutation(api.skills.update, { skillId: id, name: "Bad--Name" }),
    ).rejects.toThrow(/Skill name/);
  });

  test("stores imported skills as GitHub skills with their source URL", async () => {
    const { t, alice } = setup();
    const sourceUrl = "https://github.com/o/r/tree/main/skills/imported";

    const id = await alice.mutation(api.skills.create, {
      ...skill("imported"),
      sourceUrl,
    });

    const stored = await t.run((ctx) => ctx.db.get(id));
    expect(stored).toMatchObject({ source: "github", sourceUrl });
    await expect(
      alice.mutation(api.skills.create, {
        ...skill("elsewhere"),
        sourceUrl: "https://example.com/SKILL.md",
      }),
    ).rejects.toThrow(/GitHub source/);
  });

  test("requires sign-in", async () => {
    const { t } = setup();

    await expect(t.query(api.skills.listLibrary, {})).rejects.toThrow("Unauthorized");
  });

  test("caps the library at 50 skills", async () => {
    const { t, alice } = setup();
    await t.run(async (ctx) => {
      for (let i = 0; i < MAX_LIBRARY_SKILLS; i++) {
        await ctx.db.insert("skills", {
          ownerId: ALICE,
          ...skill(`skill-${i}`),
          source: "user",
          updatedAt: Date.now(),
        });
      }
    });

    await expect(alice.mutation(api.skills.create, skill("one-more"))).rejects.toThrow(
      /at most 50/,
    );
  });

  test("rejects names that collide", async () => {
    const { t, alice, bob } = setup();
    const p1 = await createProject(t, ALICE);
    const p2 = await createProject(t, ALICE);

    await expect(alice.mutation(api.skills.create, skill("find-skills"))).rejects.toThrow(
      /built-in/,
    );

    await alice.mutation(api.skills.create, skill("shared"));
    await expect(alice.mutation(api.skills.create, skill("shared"))).rejects.toThrow(
      /already have/,
    );
    await expect(
      alice.mutation(api.skills.create, { ...skill("shared"), projectId: p1 }),
    ).rejects.toThrow(/already have/);

    // Project skills only clash within their project; other users never clash.
    await alice.mutation(api.skills.create, { ...skill("local"), projectId: p1 });
    await alice.mutation(api.skills.create, { ...skill("local"), projectId: p2 });
    await expect(
      alice.mutation(api.skills.create, { ...skill("local"), projectId: p1 }),
    ).rejects.toThrow(/already have/);
    await expect(alice.mutation(api.skills.create, skill("local"))).rejects.toThrow(
      /already have/,
    );
    await bob.mutation(api.skills.create, skill("shared"));
  });

  test("a new project lists the built-in and library skills as disabled", async () => {
    const { t, alice } = setup();
    await alice.mutation(api.skills.create, skill("alpha"));
    await alice.mutation(api.skills.create, skill("beta"));
    const projectId = await createProject(t, ALICE);

    const skills = await alice.query(api.skills.listProjectSkills, { projectId });

    expect(skills.map(({ name, scope, enabled }) => ({ name, scope, enabled }))).toEqual([
      { name: "find-skills", scope: "builtin", enabled: false },
      { name: "alpha", scope: "library", enabled: false },
      { name: "beta", scope: "library", enabled: false },
    ]);
    expect(skills[0]).not.toHaveProperty("body");
  });

  test("a project skill is enabled in its project and absent elsewhere", async () => {
    const { t, alice } = setup();
    const p1 = await createProject(t, ALICE);
    const p2 = await createProject(t, ALICE);

    await alice.mutation(api.skills.create, { ...skill("local"), projectId: p1 });

    const inP1 = await alice.query(api.skills.listProjectSkills, { projectId: p1 });
    expect(inP1.find((s) => s.name === "local")).toMatchObject({
      scope: "project",
      enabled: true,
    });
    const inP2 = await alice.query(api.skills.listProjectSkills, { projectId: p2 });
    expect(inP2.map((s) => s.name)).toEqual(["find-skills"]);
    expect(await alice.query(api.skills.listLibrary, {})).toEqual([]);
  });

  test("toggles one skill or all of them", async () => {
    const { t, alice } = setup();
    const projectId = await createProject(t, ALICE);
    await alice.mutation(api.skills.create, skill("alpha"));
    await alice.mutation(api.skills.create, { ...skill("local"), projectId });

    await alice.mutation(api.skills.setProjectSkillEnabled, {
      projectId,
      skillKey: "builtin:find-skills",
      enabled: true,
    });
    let skills = await alice.query(api.skills.listProjectSkills, { projectId });
    expect(skills.map((s) => [s.name, s.enabled])).toEqual([
      ["find-skills", true],
      ["alpha", false],
      ["local", true],
    ]);

    await alice.mutation(api.skills.setAllProjectSkillsEnabled, { projectId, enabled: true });
    skills = await alice.query(api.skills.listProjectSkills, { projectId });
    expect(skills.every((s) => s.enabled)).toBe(true);

    await alice.mutation(api.skills.setAllProjectSkillsEnabled, { projectId, enabled: false });
    skills = await alice.query(api.skills.listProjectSkills, { projectId });
    expect(skills.every((s) => !s.enabled)).toBe(true);
    // One row per skill, updated in place.
    expect(await countSettings(t)).toBe(3);

    await expect(
      alice.mutation(api.skills.setProjectSkillEnabled, {
        projectId,
        skillKey: "builtin:nope",
        enabled: true,
      }),
    ).rejects.toThrow("Skill not found");
  });

  test("refuses another user's project and skills", async () => {
    const { t, alice, bob } = setup();
    const aliceProject = await createProject(t, ALICE);
    const aliceSkill = await alice.mutation(api.skills.create, skill("mine"));
    const localSkill = await alice.mutation(api.skills.create, {
      ...skill("local"),
      projectId: aliceProject,
    });
    const bobProject = await createProject(t, BOB);

    await expect(
      bob.query(api.skills.listProjectSkills, { projectId: aliceProject }),
    ).rejects.toThrow(/Unauthorized/);
    await expect(
      bob.mutation(api.skills.create, { ...skill("sneaky"), projectId: aliceProject }),
    ).rejects.toThrow(/Unauthorized/);
    await expect(
      bob.mutation(api.skills.setAllProjectSkillsEnabled, {
        projectId: aliceProject,
        enabled: true,
      }),
    ).rejects.toThrow(/Unauthorized/);
    await expect(bob.query(api.skills.get, { skillId: aliceSkill })).rejects.toThrow(
      "Skill not found",
    );
    await expect(
      bob.mutation(api.skills.update, { skillId: aliceSkill, body: "pwned" }),
    ).rejects.toThrow("Skill not found");
    await expect(bob.mutation(api.skills.remove, { skillId: aliceSkill })).rejects.toThrow(
      "Skill not found",
    );
    // Bob cannot enable Alice's skills in his own project either.
    for (const id of [aliceSkill, localSkill]) {
      await expect(
        bob.mutation(api.skills.setProjectSkillEnabled, {
          projectId: bobProject,
          skillKey: `user:${id}`,
          enabled: true,
        }),
      ).rejects.toThrow("Skill not found");
    }
  });

  test("update edits fields and keeps the name rules", async () => {
    const { alice } = setup();
    const id = await alice.mutation(api.skills.create, skill("alpha"));
    await alice.mutation(api.skills.create, skill("beta"));

    await alice.mutation(api.skills.update, { skillId: id, description: "New." });
    expect(await alice.query(api.skills.get, { skillId: id })).toMatchObject({
      name: "alpha",
      description: "New.",
      body: "# alpha",
    });
    await expect(
      alice.mutation(api.skills.update, { skillId: id, name: "beta" }),
    ).rejects.toThrow(/already have/);
  });

  test("removing a skill deletes its settings in every project", async () => {
    const { t, alice } = setup();
    const p1 = await createProject(t, ALICE);
    const p2 = await createProject(t, ALICE);
    const id = await alice.mutation(api.skills.create, skill("alpha"));
    for (const projectId of [p1, p2]) {
      await alice.mutation(api.skills.setProjectSkillEnabled, {
        projectId,
        skillKey: `user:${id}`,
        enabled: true,
      });
    }
    await alice.mutation(api.skills.setProjectSkillEnabled, {
      projectId: p1,
      skillKey: "builtin:find-skills",
      enabled: true,
    });

    await alice.mutation(api.skills.remove, { skillId: id });

    expect(await countSettings(t)).toBe(1);
    expect(await alice.query(api.skills.listLibrary, {})).toEqual([]);
  });

  test("listLibrary counts the projects each skill is enabled in", async () => {
    const { t, alice } = setup();
    const p1 = await createProject(t, ALICE);
    const p2 = await createProject(t, ALICE);
    const id = await alice.mutation(api.skills.create, skill("alpha"));
    for (const projectId of [p1, p2]) {
      await alice.mutation(api.skills.setProjectSkillEnabled, {
        projectId,
        skillKey: `user:${id}`,
        enabled: true,
      });
    }
    await alice.mutation(api.skills.setProjectSkillEnabled, {
      projectId: p2,
      skillKey: `user:${id}`,
      enabled: false,
    });

    expect(await alice.query(api.skills.listLibrary, {})).toEqual([
      expect.objectContaining({ name: "alpha", projectCount: 1 }),
    ]);
  });

  test("system.getProjectSkills returns only enabled skills, with bodies", async () => {
    const { t, alice } = setup();
    const projectId = await createProject(t, ALICE);
    await alice.mutation(api.skills.create, skill("alpha"));
    await alice.mutation(api.skills.create, skill("beta"));
    const betaId = (await alice.query(api.skills.listLibrary, {}))[1]._id;
    await alice.mutation(api.skills.setProjectSkillEnabled, {
      projectId,
      skillKey: `user:${betaId}`,
      enabled: true,
    });

    const skills = await t.query(api.system.getProjectSkills, {
      internalKey: INTERNAL_KEY,
      projectId,
    });

    expect(skills).toEqual([
      expect.objectContaining({
        name: "beta",
        body: "# beta",
        enabled: true,
        updatedAt: expect.any(Number),
      }),
    ]);
    await expect(
      t.query(api.system.getProjectSkills, { internalKey: "wrong", projectId }),
    ).rejects.toThrow("Invalid internal key");
  });

  test("deleting a project removes its skills and settings", async () => {
    const { t, alice } = setup();
    const projectId = await createProject(t, ALICE);
    await alice.mutation(api.skills.create, skill("alpha"));
    await alice.mutation(api.skills.create, { ...skill("local"), projectId });
    await alice.mutation(api.skills.setAllProjectSkillsEnabled, { projectId, enabled: true });

    await t.run(async (ctx) => {
      while (!(await deleteProjectBatch(ctx, projectId))) {
        // Keep deleting batches until the project row is gone.
      }
    });

    expect(await countSettings(t)).toBe(0);
    expect((await alice.query(api.skills.listLibrary, {})).map((s) => s.name)).toEqual([
      "alpha",
    ]);
  });
});
