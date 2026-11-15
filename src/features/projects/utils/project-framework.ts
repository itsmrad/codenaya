export type ProjectFramework = "vite" | "next";

const KEY = "codenaya:projectFramework";

export const readProjectFramework = (): ProjectFramework => {
  try {
    return localStorage.getItem(KEY) === "next" ? "next" : "vite";
  } catch {
    return "vite";
  }
};

export const writeProjectFramework = (framework: ProjectFramework) => {
  try {
    localStorage.setItem(KEY, framework);
  } catch {
    // Best-effort, like the model and dashboard choices.
  }
};
