/**
 * Static Supabase data-exposure checks for the pre-export scan (#300, step 3).
 * Reads the project's SQL files only; never calls Supabase.
 */

import type { ScanFile, ScanFinding } from "./scan-project";

// shortcut: only `.sql` under a `supabase/` folder (the CLI's layout), so Prisma or
// plain Postgres migrations aren't flagged; widen if the agent writes SQL elsewhere.
const SUPABASE_SQL = /(?:^|\/)supabase\/.*\.sql$/i;

// One pattern, so statements come back in file order: create (1), enable RLS (2), drop (3).
// Temporary tables never match: `temp` sits between `create` and `table`.
const TABLE_STATEMENT = new RegExp(
  [
    String.raw`\bcreate\s+(?:unlogged\s+)?table\s+(?:if\s+not\s+exists\s+)?([\w."]+)`,
    String.raw`\balter\s+table\s+(?:if\s+exists\s+)?(?:only\s+)?([\w."]+)\s+enable\s+row\s+level\s+security`,
    String.raw`\bdrop\s+table\s+(?:if\s+exists\s+)?([\w."]+(?:\s*,\s*[\w."]+)*)`,
  ].join("|"),
  "gi",
);
const CREATE_POLICY = /\bcreate\s+policy\s+(?:"[^"]*"|\w+)\s+on\s+([\w."]+)([^;]*)/gi;
const ALLOW_ALL = /\b(?:using|with\s+check)\s*\(\s*true\s*\)/i;
const POLICY_ROLES = /\bto\s+([\w\s,"]+?)\s*(?:\busing\b|\bwith\b|$)/i;
const OPEN_ROLES = new Set(["public", "anon"]);

/** `public.todos`, `"todos"` -> `todos`; other schemas keep their prefix. */
const tableName = (raw: string) => raw.replace(/"/g, "").toLowerCase().replace(/^public\./, "");

/** Only the public schema is served by Supabase's API. */
const isExposed = (raw: string) => !tableName(raw).includes(".");

/** Drops `--` and block comments but keeps every newline, so line numbers still hold. */
const stripComments = (sql: string) =>
  sql
    .replace(/--[^\n]*/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ""));

const lineAt = (text: string, index: number) => text.slice(0, index).split("\n").length;

/** No `to` clause means the policy applies to every role. */
const isOpenToAll = (body: string) => {
  const roles = body.match(POLICY_ROLES)?.[1];
  return (
    !roles ||
    roles.split(",").some((role) => OPEN_ROLES.has(role.replace(/"/g, "").trim().toLowerCase()))
  );
};

export function scanSupabaseSql(files: readonly ScanFile[]): ScanFinding[] {
  const sqlFiles = files
    .flatMap(({ path, content }) =>
      content !== undefined && SUPABASE_SQL.test(path) ? [{ path, sql: stripComments(content) }] : [],
    )
    // Migration file names start with a timestamp, so path order is run order.
    .sort((a, b) => a.path.localeCompare(b.path));

  // Public tables created and not (yet) given RLS, replayed in run order so a
  // later `enable` or `drop` clears a table and a re-create counts again.
  const withoutRls = new Map<string, ScanFinding>();
  for (const { path, sql } of sqlFiles) {
    for (const { 1: created, 2: secured, 3: dropped, index } of sql.matchAll(TABLE_STATEMENT)) {
      if (created && isExposed(created)) {
        withoutRls.set(tableName(created), {
          file: path,
          line: lineAt(sql, index),
          rule: "supabase-no-rls",
          severity: "high",
        });
      } else if (secured) {
        withoutRls.delete(tableName(secured));
      } else if (dropped) {
        dropped.split(",").forEach((raw) => withoutRls.delete(tableName(raw.trim())));
      }
    }
  }

  const openPolicies = sqlFiles.flatMap(({ path, sql }) =>
    [...sql.matchAll(CREATE_POLICY)]
      .filter(([, table, body]) => isExposed(table) && ALLOW_ALL.test(body) && isOpenToAll(body))
      .map(({ index }) => ({
        file: path,
        line: lineAt(sql, index),
        rule: "supabase-open-policy",
        severity: "medium" as const,
      })),
  );

  return [...withoutRls.values(), ...openPolicies];
}
