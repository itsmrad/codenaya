import type { SkillFields } from "./limits";

type SkillDraft = SkillFields & { scope: "project" | "library" };

export const isSkillDraftDirty = (initial: SkillDraft, draft: SkillDraft) =>
  initial.name !== draft.name ||
  initial.description !== draft.description ||
  initial.body !== draft.body ||
  initial.scope !== draft.scope;
