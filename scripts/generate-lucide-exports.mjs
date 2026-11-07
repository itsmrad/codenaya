// Regenerate the names-only catalog used by project-checks.ts:
// node scripts/generate-lucide-exports.mjs 1.66.0
// Reads the published declarations (including type exports); never installs/runs the package.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import ts from "typescript";

const version = process.argv[2];
if (!/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(version ?? "")) throw new Error("Supply an exact lucide-react version");
const cache = join(homedir(), ".cache", "lucide-exports");
mkdirSync(cache, { recursive: true });
const scratch = mkdtempSync(join(cache, "generate-"));
try {
  const [pack] = JSON.parse(execFileSync("npm", ["pack", `lucide-react@${version}`, "--ignore-scripts", "--json", "--pack-destination", scratch], { encoding: "utf8" }));
  execFileSync("tar", ["-xzf", join(scratch, pack.filename), "-C", scratch]);
  const pkg = JSON.parse(readFileSync(join(scratch, "package/package.json"), "utf8"));
  const declarations = ts.createSourceFile("icons.d.ts", readFileSync(join(scratch, "package", pkg.typings), "utf8"), ts.ScriptTarget.Latest);
  const names = new Set();
  for (const statement of declarations.statements) {
    if (ts.isExportDeclaration(statement) && statement.exportClause && ts.isNamedExports(statement.exportClause)) {
      for (const entry of statement.exportClause.elements) names.add(entry.name.text);
    }
  }
  if (names.size < 1000) throw new Error("Unexpected lucide declaration shape; inspect before regenerating");
  const output = new URL(`../src/features/sandbox-preview/utils/lucide-exports.v${version.split(".")[0]}.json`, import.meta.url);
  writeFileSync(output, JSON.stringify([...names].sort(), null, 2) + "\n");
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
