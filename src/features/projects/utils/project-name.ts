/**
 * Project name rules, shared by the Convex mutations and the rename inputs.
 *
 * Plain TS with no imports so the backend and the UI validate the same way.
 */

export const PROJECT_NAME_MAX_LENGTH = 100;

const COPY_SUFFIX = " (copy)";

/** Returns why `name` is invalid, or null when it is valid. Expects a trimmed name. */
export function validateProjectName(name: string): string | null {
  if (name.length === 0) {
    return "Project name can't be empty";
  }
  if (name.length > PROJECT_NAME_MAX_LENGTH) {
    return `Project name must be at most ${PROJECT_NAME_MAX_LENGTH} characters`;
  }
  return null;
}

/** "<name> (copy)", shortening the original so the result stays valid. */
export function copyProjectName(name: string): string {
  const base = name.trim().slice(0, PROJECT_NAME_MAX_LENGTH - COPY_SUFFIX.length).trimEnd();
  return `${base || "Untitled"}${COPY_SUFFIX}`;
}
