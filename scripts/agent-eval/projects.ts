import { validateProjectName } from "../../src/features/projects/utils/project-name";
import { MODELS } from "./cost";

export const ADMIN_TITLE = "Night build — {app} — {config}";

/** Fills {app} (the prompt name) and {config} ("single Haiku 5.5") in a project title template. */
export function projectTitle(template: string, app: string, model: string) {
  const title = template.replaceAll("{app}", app).replaceAll("{config}", `single ${MODELS[model].label}`).trim();
  const error = validateProjectName(title);
  if (error) throw new Error(`--title: ${error}`);
  return title;
}

/** Admin builds are the user's to keep; eval-user builds are deleted once scored. */
export const deleteAfterScoring = (run: { asAdmin: boolean; keep: boolean; scored: boolean; followupPending: boolean }) =>
  run.scored && !run.asAdmin && !run.keep && !run.followupPending;
