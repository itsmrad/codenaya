import { v } from "convex/values";

import type { Doc, Id } from "./_generated/dataModel";
import {
  mutation,
  query,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import { verifyAuth } from "./auth";
import { BUILTIN_SKILLS } from "../src/features/skills/builtin";
import { BUILTIN_SKILL_NAMES } from "../src/features/skills/builtin/names";
import {
  MAX_LIBRARY_SKILLS,
  MAX_PROJECT_SKILLS,
  validateSkill,
} from "../src/features/skills/limits";
import {
  builtinSkillKey,
  userSkillKey,
  type ProjectSkillSummary,
  type SkillScope,
} from "../src/features/skills/types";

/**
 * Agent Skills: a user-scoped library plus project-only skills, and the
 * per-project switches that decide which of them the agent sees.
 *
 * Library and built-in skills are disabled in a project until the owner turns
 * them on; project skills start enabled. See `projectSkillSettings`.
 */

type Ctx = QueryCtx | MutationCtx;

export type ResolvedProjectSkill = ProjectSkillSummary & { body: string };

// One setting per skill a project can see, so this never truncates.
const MAX_PROJECT_SETTINGS =
  BUILTIN_SKILLS.length + MAX_LIBRARY_SKILLS + MAX_PROJECT_SKILLS;

async function getOwnedProject(
  ctx: Ctx,
  projectId: Id<"projects">,
  ownerId: string,
) {
  const project = await ctx.db.get("projects", projectId);
  if (!project) {
    throw new Error("Project not found");
  }
  if (project.ownerId !== ownerId) {
    throw new Error("Unauthorized to access this project");
  }
  return project;
}

async function getOwnedSkill(ctx: Ctx, skillId: Id<"skills">, ownerId: string) {
  const skill = await ctx.db.get("skills", skillId);
  if (!skill || skill.ownerId !== ownerId) {
    throw new Error("Skill not found");
  }
  return skill;
}

const libraryQuery = (ctx: Ctx, ownerId: string) =>
  ctx.db
    .query("skills")
    .withIndex("by_owner_and_projectId", (q) =>
      q.eq("ownerId", ownerId).eq("projectId", undefined),
    );

const projectQuery = (ctx: Ctx, projectId: Id<"projects">) =>
  ctx.db
    .query("skills")
    .withIndex("by_project", (q) => q.eq("projectId", projectId));

function assertValid(fields: Pick<Doc<"skills">, "name" | "description" | "body">) {
  const error = validateSkill(fields);
  if (error) {
    throw new Error(error);
  }
}

/**
 * A library skill can be enabled next to any project skill, so its name must
 * be unique across all of the owner's skills. A project skill only has to
 * avoid the library and its own project.
 */
async function assertNameAvailable(
  ctx: MutationCtx,
  ownerId: string,
  name: string,
  projectId: Id<"projects"> | undefined,
  skillId?: Id<"skills">,
) {
  if (BUILTIN_SKILL_NAMES.includes(name)) {
    throw new Error(`"${name}" is the name of a built-in skill`);
  }

  const sameName = ctx.db
    .query("skills")
    .withIndex("by_owner_and_name", (q) =>
      q.eq("ownerId", ownerId).eq("name", name),
    );
  for await (const other of sameName) {
    if (other._id === skillId) continue;
    if (
      projectId === undefined ||
      other.projectId === undefined ||
      other.projectId === projectId
    ) {
      throw new Error(`You already have a skill named "${name}"`);
    }
  }
}

async function writeSetting(
  ctx: MutationCtx,
  project: Doc<"projects">,
  skillKey: string,
  enabled: boolean,
) {
  const existing = await ctx.db
    .query("projectSkillSettings")
    .withIndex("by_project_and_skillKey", (q) =>
      q.eq("projectId", project._id).eq("skillKey", skillKey),
    )
    .unique();
  const updatedAt = Date.now();

  if (existing) {
    await ctx.db.patch("projectSkillSettings", existing._id, {
      enabled,
      updatedAt,
    });
  } else {
    await ctx.db.insert("projectSkillSettings", {
      projectId: project._id,
      ownerId: project.ownerId,
      skillKey,
      enabled,
      updatedAt,
    });
  }
}

/**
 * Every skill the project can use (built-in, the owner's library, then the
 * project's own) with whether it is enabled there. Shared with
 * `system.getProjectSkills`.
 */
export async function resolveProjectSkills(
  ctx: Ctx,
  project: Doc<"projects">,
): Promise<ResolvedProjectSkill[]> {
  const settings = await ctx.db
    .query("projectSkillSettings")
    .withIndex("by_project", (q) => q.eq("projectId", project._id))
    .take(MAX_PROJECT_SETTINGS);
  const enabledByKey = new Map(settings.map((s) => [s.skillKey, s.enabled]));

  const library = await libraryQuery(ctx, project.ownerId).take(
    MAX_LIBRARY_SKILLS,
  );
  const projectOnly = await projectQuery(ctx, project._id).take(
    MAX_PROJECT_SKILLS,
  );

  const fromDoc = (skill: Doc<"skills">, scope: SkillScope) => {
    const key = userSkillKey(skill._id);
    return {
      key,
      name: skill.name,
      description: skill.description,
      body: skill.body,
      source: skill.source,
      scope,
      enabled: enabledByKey.get(key) ?? false,
    };
  };

  return [
    ...BUILTIN_SKILLS.map((skill) => {
      const key = builtinSkillKey(skill.name);
      return {
        key,
        ...skill,
        source: "builtin" as const,
        scope: "builtin" as const,
        enabled: enabledByKey.get(key) ?? false,
      };
    }),
    ...library.map((skill) => fromDoc(skill, "library")),
    ...projectOnly.map((skill) => fromDoc(skill, "project")),
  ];
}

/**
 * The signed-in user's library skills (not project-only ones), each with the
 * number of projects it is enabled in.
 */
export const listLibrary = query({
  args: {},
  handler: async (ctx) => {
    const identity = await verifyAuth(ctx);
    const skills = await libraryQuery(ctx, identity.subject).take(
      MAX_LIBRARY_SKILLS,
    );

    return await Promise.all(
      skills.map(async (skill) => {
        const settings = ctx.db
          .query("projectSkillSettings")
          .withIndex("by_owner_and_skillKey", (q) =>
            q.eq("ownerId", skill.ownerId).eq("skillKey", userSkillKey(skill._id)),
          );
        let projectCount = 0;
        for await (const setting of settings) {
          if (setting.enabled) projectCount++;
        }
        return { ...skill, projectCount };
      }),
    );
  },
});

/** Built-in, library and project skills for one project, without bodies. */
export const listProjectSkills = query({
  args: { projectId: v.id("projects") },
  handler: async (ctx, args): Promise<ProjectSkillSummary[]> => {
    const identity = await verifyAuth(ctx);
    const project = await getOwnedProject(ctx, args.projectId, identity.subject);

    const skills = await resolveProjectSkills(ctx, project);
    return skills.map(({ key, name, description, source, scope, enabled }) => ({
      key,
      name,
      description,
      source,
      scope,
      enabled,
    }));
  },
});

export const get = query({
  args: { skillId: v.id("skills") },
  handler: async (ctx, args) => {
    const identity = await verifyAuth(ctx);

    return await getOwnedSkill(ctx, args.skillId, identity.subject);
  },
});

/**
 * Creates a library skill, or a project skill when `projectId` is given.
 * Project skills are enabled in their project straight away.
 */
export const create = mutation({
  args: {
    name: v.string(),
    description: v.string(),
    body: v.string(),
    projectId: v.optional(v.id("projects")),
  },
  handler: async (ctx, args) => {
    const identity = await verifyAuth(ctx);
    const ownerId = identity.subject;
    assertValid(args);

    const project = args.projectId
      ? await getOwnedProject(ctx, args.projectId, ownerId)
      : null;

    const existing = project
      ? await projectQuery(ctx, project._id).take(MAX_PROJECT_SKILLS)
      : await libraryQuery(ctx, ownerId).take(MAX_LIBRARY_SKILLS);
    const max = project ? MAX_PROJECT_SKILLS : MAX_LIBRARY_SKILLS;
    if (existing.length >= max) {
      throw new Error(
        project
          ? `A project can have at most ${max} project skills`
          : `You can have at most ${max} skills in your library`,
      );
    }

    await assertNameAvailable(ctx, ownerId, args.name, args.projectId);

    const skillId = await ctx.db.insert("skills", {
      ownerId,
      projectId: args.projectId,
      name: args.name,
      description: args.description,
      body: args.body,
      source: "user",
      updatedAt: Date.now(),
    });

    if (project) {
      await writeSetting(ctx, project, userSkillKey(skillId), true);
    }

    return skillId;
  },
});

export const update = mutation({
  args: {
    skillId: v.id("skills"),
    name: v.optional(v.string()),
    description: v.optional(v.string()),
    body: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const identity = await verifyAuth(ctx);
    const skill = await getOwnedSkill(ctx, args.skillId, identity.subject);

    const fields = {
      name: args.name ?? skill.name,
      description: args.description ?? skill.description,
      body: args.body ?? skill.body,
    };
    assertValid(fields);

    if (fields.name !== skill.name) {
      await assertNameAvailable(
        ctx,
        skill.ownerId,
        fields.name,
        skill.projectId,
        skill._id,
      );
    }

    await ctx.db.patch("skills", skill._id, {
      ...fields,
      updatedAt: Date.now(),
    });
  },
});

/** Deletes a skill and its enabled/disabled setting in every project. */
export const remove = mutation({
  args: { skillId: v.id("skills") },
  handler: async (ctx, args) => {
    const identity = await verifyAuth(ctx);
    const skill = await getOwnedSkill(ctx, args.skillId, identity.subject);

    const settings = ctx.db
      .query("projectSkillSettings")
      .withIndex("by_owner_and_skillKey", (q) =>
        q.eq("ownerId", skill.ownerId).eq("skillKey", userSkillKey(skill._id)),
      );
    for await (const setting of settings) {
      await ctx.db.delete("projectSkillSettings", setting._id);
    }

    await ctx.db.delete("skills", skill._id);
  },
});

export const setProjectSkillEnabled = mutation({
  args: {
    projectId: v.id("projects"),
    skillKey: v.string(),
    enabled: v.boolean(),
  },
  handler: async (ctx, args) => {
    const identity = await verifyAuth(ctx);
    const project = await getOwnedProject(ctx, args.projectId, identity.subject);

    const skills = await resolveProjectSkills(ctx, project);
    if (!skills.some((skill) => skill.key === args.skillKey)) {
      throw new Error("Skill not found");
    }

    await writeSetting(ctx, project, args.skillKey, args.enabled);
  },
});

/** Enables or disables every skill the project can see. */
export const setAllProjectSkillsEnabled = mutation({
  args: {
    projectId: v.id("projects"),
    enabled: v.boolean(),
  },
  handler: async (ctx, args) => {
    const identity = await verifyAuth(ctx);
    const project = await getOwnedProject(ctx, args.projectId, identity.subject);

    for (const skill of await resolveProjectSkills(ctx, project)) {
      if (skill.enabled !== args.enabled) {
        await writeSetting(ctx, project, skill.key, args.enabled);
      }
    }
  },
});
