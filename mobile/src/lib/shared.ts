// Web app code the phone reuses as is. Metro reaches it through `watchFolders`
// in metro.config.js.
export {
  type AgentStep,
  BUILD_VERIFIED,
  STALLED_RUN_MS,
  buildPathIndex,
  lastRunActivity,
  sanitizeAgentText,
} from "../../../src/features/conversations/agent-steps";
export {
  MAX_CHAT_IMAGE_BYTES,
  MAX_CHAT_IMAGES,
  isChatImageType,
} from "../../../src/features/conversations/chat-images";
export { PLAN_MODE, buildPlanMessage } from "../../../src/features/conversations/plan-mode";
export type { AgentModelChoice } from "../../../src/features/conversations/agent-models";
export {
  type ActivePlatform,
  platformConfigFrom,
  platformModels,
  platformProviderId,
  resolvePlatformModel,
} from "../../../src/features/ai-providers/platform";
export {
  AI_PROVIDER_IDS,
  AI_PROVIDERS,
  type AiProviderId,
  MAX_CUSTOM_MODEL_IDS,
  PLATFORM_PROVIDER,
  type ProviderModel,
  keyModels,
  modelAcceptsImages,
  modelIdsFor,
  runModelLabel,
} from "../../../src/features/ai-providers/registry";
export { splitSlashSkills } from "../../../src/features/skills/parse-slash";
export { getProvider, listProviders } from "../../../src/features/integrations/catalog";
export { classifyEnvKey, isValidEnvKey } from "../../../src/features/integrations/env-keys";
export { BUILTIN_SKILL_ATTRIBUTIONS, BUILTIN_SKILLS } from "../../../src/features/skills/builtin";
export { SKILL_BODY_MAX_LENGTH, validateSkill } from "../../../src/features/skills/limits";
export { STARTER_TEMPLATES } from "../../../src/features/templates/templates";
export { getFirstRunProgress } from "../../../src/features/projects/utils/first-run";
export { parseGithubRepo } from "../../../src/features/projects/utils/github-repo";

/** "12s", "1m 5s": same as the web's src/lib/format-duration.ts. */
export const formatDuration = (ms: number) => {
  const seconds = Math.max(1, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${seconds % 60}s`;
};
