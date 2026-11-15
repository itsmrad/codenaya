import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import type { SeedFile } from "../seed-files";

// shortcut: CI doesn't run tsc/vite build on templates/<id> yet; add that job with the other 4 templates (#362).
/** Where instant templates' reviewed sources live (#362), traced into the create route. */
export const TEMPLATES_DIR = path.join(process.cwd(), "templates");

/** An instant template's source files, as paths relative to its folder. */
export const readTemplateSource = async (templateId: string): Promise<SeedFile[]> => {
  const root = path.join(TEMPLATES_DIR, templateId);
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  return Promise.all(
    entries
      .filter((entry) => entry.isFile())
      .map(async (entry) => {
        const full = path.join(entry.parentPath, entry.name);
        return { path: path.relative(root, full).split(path.sep).join("/"), content: await readFile(full, "utf8") };
      }),
  );
};
