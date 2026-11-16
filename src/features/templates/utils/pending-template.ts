import { readPendingStart, savePendingStart } from "@/lib/pending-intent";
import { isProjectFramework, type ProjectFramework } from "@/features/projects/utils/project-framework";
import { getStarterTemplate, type StarterTemplate } from "../templates";

/**
 * A template picked on /showcase while signed out, kept across the sign-up
 * redirect so the dashboard can create its project once the user is signed
 * in. Storage can be unavailable (private mode, blocked site data), so every
 * access is best-effort, like the pending prompt in `features/projects`.
 */
export const PENDING_TEMPLATE_KEY = "codenaya:pendingTemplate";

// No saved framework choice: the prompt (or an explicit pick) decides.
export const savePendingTemplate = (templateId: string, framework?: ProjectFramework) => {
  try {
    savePendingStart(PENDING_TEMPLATE_KEY, templateId, { framework });
  } catch {
    // Without storage the template is simply not resumed.
  }
};

/** The saved template, left in place: the auth pages show it before sign-up (#252). */
export const peekPendingTemplate = (): StarterTemplate | null => {
  try {
    const templateId = readPendingStart(PENDING_TEMPLATE_KEY)?.value;
    return templateId ? (getStarterTemplate(templateId) ?? null) : null;
  } catch {
    return null;
  }
};

/** Returns the saved template at most once: reading it also clears it. */
export const takePendingTemplate = (): (StarterTemplate & { framework?: ProjectFramework }) | null => {
  try {
    const template = peekPendingTemplate();
    const framework = readPendingStart(PENDING_TEMPLATE_KEY)?.framework;
    localStorage.removeItem(PENDING_TEMPLATE_KEY);
    return template ? { ...template, ...(isProjectFramework(framework) ? { framework } : {}) } : null;
  } catch {
    return null;
  }
};

export const clearPendingTemplate = () => {
  try {
    localStorage.removeItem(PENDING_TEMPLATE_KEY);
  } catch {
    // Storage remains best-effort.
  }
};
