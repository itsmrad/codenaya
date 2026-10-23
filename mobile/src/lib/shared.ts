// Web app code the phone reuses as is. Metro reaches it through `watchFolders`
// in metro.config.js.
export {
  type AgentStep,
  BUILD_VERIFIED,
  buildPathIndex,
  sanitizeAgentText,
} from "../../../src/features/conversations/agent-steps";

/** "12s", "1m 5s": same as the web's src/lib/format-duration.ts. */
export const formatDuration = (ms: number) => {
  const seconds = Math.max(1, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${seconds % 60}s`;
};
