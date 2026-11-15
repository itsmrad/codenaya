export type ProjectFramework = "vite" | "next";
/** "auto" sends no framework, so the server detects it from the prompt. */
export type FrameworkChoice = "auto" | ProjectFramework;

const KEY = "codenaya:projectFramework";

export const readProjectFramework = (): FrameworkChoice => {
  try {
    const saved = localStorage.getItem(KEY);
    return saved === "next" || saved === "vite" ? saved : "auto";
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
