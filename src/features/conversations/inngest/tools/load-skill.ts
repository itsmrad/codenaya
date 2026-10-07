import { z } from "zod";
import { createTool } from "@inngest/agent-kit";

import { formatSkill } from "@/features/skills/server/prompt";
import type { AgentSkill } from "@/features/skills/server/resolve-skills";

interface LoadSkillToolOptions {
  /** The run's resolved skills, bodies included; no Convex call is made. */
  skills: readonly AgentSkill[];
}

export const createLoadSkillTool = ({ skills }: LoadSkillToolOptions) => {
  return createTool({
    name: "loadSkill",
    description:
      "Load the full instructions of a skill listed under 'Available skills'. Call it before starting a task that matches the skill's description.",
    parameters: z.object({
      name: z.string().describe("The skill's name, exactly as listed"),
    }),
    handler: async ({ name }) => {
      const skill = skills.find((s) => s.name === name.trim());
      if (!skill) {
        const valid = skills.map((s) => s.name).join(", ") || "none";
        return `Error: Unknown skill "${name}". Available skills: ${valid}`;
      }
      return formatSkill(skill);
    },
  });
};
