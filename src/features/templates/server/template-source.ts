import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

import type { SeedFile } from "../seed-files";

// shortcut: CI doesn't run tsc/vite build on templates/<id> yet; add that job (#362).
/** Where instant templates' reviewed sources live (#362), traced into the create route. */
export const TEMPLATES_DIR = path.join(process.cwd(), "templates");

/** An instant template's source files, as paths relative to its folder. */
export const readTemplateSource = async (templateId: string): Promise<SeedFile[]> => {
  const root = path.join(TEMPLATES_DIR, templateId);
  // Relative path strings, not Dirent.parentPath, which needs Node 20.12.
  const entries = await readdir(root, { recursive: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const full = path.join(root, entry);
      if (!(await stat(full)).isFile()) return null;
      return { path: entry.split(path.sep).join("/"), content: await readFile(full, "utf8") };
    }),
  );
  return files.filter((file) => file !== null);
};
