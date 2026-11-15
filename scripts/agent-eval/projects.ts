import { validateProjectName } from "../../src/features/projects/utils/project-name";
import { MODELS } from "./cost";
import type { Mode } from "./types";

export const ADMIN_TITLE = "Night build — {app} — {config}";

/** Fills {app} (the prompt name) and {config} ("single Haiku 5.5", or "Swarm Sonnet 5.5 + Haiku 5.5": workers are always Haiku) in a project title template. */
export function projectTitle(template: string, app: string, model: string, mode: Mode = "build") {
  const config = mode === "swarm" ? `Swarm ${MODELS[model].label} + ${MODELS["claude-haiku-5-5"].label}` : `single ${MODELS[model].label}`;
  const title = template.replaceAll("{app}", app).replaceAll("{config}", config).trim();
  const error = validateProjectName(title);
  if (error) throw new Error(`--title: ${error}`);
  return title;
}

/** Admin builds are the user's to keep; eval-user builds are deleted once scored. */
export const deleteAfterScoring = (run: { asAdmin: boolean; keep: boolean; scored: boolean; followupPending: boolean }) =>
  run.scored && !run.asAdmin && !run.keep && !run.followupPending;
