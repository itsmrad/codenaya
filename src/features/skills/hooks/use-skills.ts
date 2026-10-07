import { useMutation, useQuery } from "convex/react";

import { api } from "../../../../convex/_generated/api";
import { Id } from "../../../../convex/_generated/dataModel";

/** Built-in, library and project skills for a project, with their switches. */
export const useProjectSkills = (projectId: Id<"projects"> | undefined) => {
  return useQuery(
    api.skills.listProjectSkills,
    projectId ? { projectId } : "skip",
  );
};

/** One stored skill with its body, or skipped while `skillId` is unset. */
export const useSkill = (skillId: Id<"skills"> | undefined) => {
  return useQuery(api.skills.get, skillId ? { skillId } : "skip");
};

export const useSetProjectSkillEnabled = () => {
  return useMutation(api.skills.setProjectSkillEnabled).withOptimisticUpdate(
    (localStore, args) => {
      const skills = localStore.getQuery(api.skills.listProjectSkills, {
        projectId: args.projectId,
      });
      if (skills === undefined) return;

      localStore.setQuery(
        api.skills.listProjectSkills,
        { projectId: args.projectId },
        skills.map((skill) =>
          skill.key === args.skillKey
            ? { ...skill, enabled: args.enabled }
            : skill,
        ),
      );
    },
  );
};

export const useCreateSkill = () => useMutation(api.skills.create);

export const useUpdateSkill = () => useMutation(api.skills.update);

export const useRemoveSkill = () => useMutation(api.skills.remove);

/**
 * The reason a skills mutation failed. Convex wraps thrown errors as
 * "[CONVEX M(skills:create)] … Uncaught Error: <message>\n    at …"; keep only
 * the message, or fall back when the deployment hides it.
 */
export const skillErrorMessage = (error: unknown, fallback: string) => {
  const message = error instanceof Error ? error.message : "";
  const match = message.match(/Uncaught Error: (.+)/);
  return match?.[1]?.trim() ?? fallback;
};
