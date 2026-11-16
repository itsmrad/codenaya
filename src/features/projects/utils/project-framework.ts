export type ProjectFramework = "vite" | "next" | "tanstack-start";
export const isProjectFramework = (value: unknown): value is ProjectFramework =>
  value === "vite" || value === "next" || value === "tanstack-start";
