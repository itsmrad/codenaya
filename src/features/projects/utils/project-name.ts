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

/**
 * A project name from a generated conversation title (#288): trimmed, without
 * wrapping quotes or trailing punctuation, single-spaced and cut to the limit
 * on a word boundary. Null when nothing valid is left.
 */
export function projectNameFromTitle(title: string): string | null {
  let name = title
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^["'\u201c\u2018`\s]+/, "")
    .replace(/["'\u201d\u2019`.,;:!?\s]+$/, "");
  if (name.length > PROJECT_NAME_MAX_LENGTH) {
    const cut = name.slice(0, PROJECT_NAME_MAX_LENGTH + 1);
    const space = cut.lastIndexOf(" ");
    name = (space > 0 ? cut.slice(0, space) : cut.slice(0, PROJECT_NAME_MAX_LENGTH)).trimEnd();
  }
  return validateProjectName(name) === null ? name : null;
}

/** "<name> (copy)", shortening the original so the result stays valid. */
export function copyProjectName(name: string): string {
  const base = name.trim().slice(0, PROJECT_NAME_MAX_LENGTH - COPY_SUFFIX.length).trimEnd();
  return `${base || "Untitled"}${COPY_SUFFIX}`;
}
