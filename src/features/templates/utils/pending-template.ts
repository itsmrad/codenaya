import { getStarterTemplate, type StarterTemplate } from "../templates";

/**
 * A template picked on /showcase while signed out, kept across the sign-up
 * redirect so the dashboard can create its project once the user is signed
 * in. Storage can be unavailable (private mode, blocked site data), so every
 * access is best-effort, like the pending prompt in `features/projects`.
 */
export const PENDING_TEMPLATE_KEY = "codenaya:pendingTemplate";

export const savePendingTemplate = (templateId: string) => {
  try {
    localStorage.setItem(PENDING_TEMPLATE_KEY, templateId);
  } catch {
    // Without storage the template is simply not resumed.
  }
};

/** The saved template, left in place: the auth pages show it before sign-up (#252). */
export const peekPendingTemplate = (): StarterTemplate | null => {
  try {
    const templateId = localStorage.getItem(PENDING_TEMPLATE_KEY);
    return templateId ? (getStarterTemplate(templateId) ?? null) : null;
  } catch {
    return null;
  }
};

/** Returns the saved template at most once: reading it also clears it. */
export const takePendingTemplate = (): StarterTemplate | null => {
  const template = peekPendingTemplate();
  try {
    localStorage.removeItem(PENDING_TEMPLATE_KEY);
  } catch {
    // Storage is unavailable: there is nothing to clear.
  }
  return template;
};
