export type ProjectFramework = "vite" | "next" | "tanstack-start";
export const isProjectFramework = (value: unknown): value is ProjectFramework =>
  value === "vite" || value === "next" || value === "tanstack-start";

/** "auto" sends no framework, so the server detects it from the prompt. */
export type FrameworkChoice = "auto" | ProjectFramework;

const KEY = "codenaya:projectFramework";

export const readProjectFramework = (): FrameworkChoice => {
  try {
    const saved = localStorage.getItem(KEY);
    return saved === "next" || saved === "vite" || saved === "tanstack-start" ? saved : "auto";
  } catch {
    return "auto";
  }
};

export const writeProjectFramework = (framework: FrameworkChoice) => {
  try {
    localStorage.setItem(KEY, framework);
  } catch {
    // Best-effort, like the model and dashboard choices.
  }
};
