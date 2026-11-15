import { resetProjectHandoff } from "@/features/projects/utils/project-handoff";
import { clearPendingPrompt } from "@/features/projects/utils/pending-prompt";
import { clearPendingTemplate } from "@/features/templates/utils/pending-template";

/** Keep signed-out submissions on sign-in, but never carry them (stored or in memory) across sign-out/account changes. */
export const clearPendingStartsOnUserChange = (
  previous: string | null | undefined,
  current: string | null | undefined,
) => {
  if (current === undefined || !previous || previous === current) return;
  clearPendingPrompt();
  clearPendingTemplate();
  resetProjectHandoff();
};
