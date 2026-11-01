/**
 * Static Supabase data-exposure checks for the pre-export scan (#300, step 3).
 * Reads the project's SQL files only; never calls Supabase.
 */

import type { ScanFile, ScanFinding } from "./scan-project";

// shortcut: only `.sql` under a `supabase/` folder (the CLI's layout), so Prisma or
// plain Postgres migrations aren't flagged; widen if the agent writes SQL elsewhere.
const SUPABASE_SQL = /(?:^|\/)supabase\/.*\.sql$/i;

// Temporary tables never match: `temp` sits between `create` and `table`.
const CREATE_TABLE = /\bcreate\s+(?:unlogged\s+)?table\s+(?:if\s+not\s+exists\s+)?([\w."]+)/gi;
const ENABLE_RLS =
  /\balter\s+table\s+(?:if\s+exists\s+)?(?:only\s+)?([\w."]+)\s+enable\s+row\s+level\s+security/gi;
const CREATE_POLICY = /\bcreate\s+policy\s+(?:"[^"]*"|\w+)([^;]*)/gi;
const ALLOW_ALL = /\b(?:using|with\s+check)\s*\(\s*true\s*\)/i;
const POLICY_ROLES = /\bto\s+([\w\s,]+?)\s*(?:\busing\b|\bwith\b|$)/i;
const OPEN_ROLES = new Set(["public", "anon"]);

/** `public.todos`, `"todos"` -> `todos`; null for other schemas, which the API doesn't expose. */
const tableName = (raw: string) => {
  const name = raw.replace(/"/g, "").toLowerCase().replace(/^public\./, "");
  return name.includes(".") ? null : name;
};

/** Drops `--` comments but keeps every newline, so line numbers still hold. */
const stripComments = (sql: string) => sql.replace(/--[^\n]*/g, "");

const lineAt = (text: string, index: number) => text.slice(0, index).split("\n").length;

export function scanSupabaseSql(files: readonly ScanFile[]): ScanFinding[] {
  const sqlFiles = files.flatMap(({ path, content }) =>
    content !== undefined && SUPABASE_SQL.test(path) ? [{ path, sql: stripComments(content) }] : [],
  );

  // A later migration may turn RLS on, so collect it across every file first.
  const withRls = new Set(
    sqlFiles.flatMap(({ sql }) => [...sql.matchAll(ENABLE_RLS)].map(([, raw]) => tableName(raw))),
  );

  return sqlFiles.flatMap(({ path, sql }) => [
    ...[...sql.matchAll(CREATE_TABLE)]
      .filter(([, raw]) => {
        const name = tableName(raw);
        return name !== null && !withRls.has(name);
      })
      .map(({ index }) => ({
        file: path,
        line: lineAt(sql, index),
        rule: "supabase-no-rls",
        severity: "high" as const,
      })),
    ...[...sql.matchAll(CREATE_POLICY)]
      .filter(([, body]) => {
        if (!ALLOW_ALL.test(body)) return false;
        const roles = body.match(POLICY_ROLES)?.[1];
        // No `to` clause means the policy applies to every role.
        return !roles || roles.split(",").some((role) => OPEN_ROLES.has(role.trim().toLowerCase()));
      })
      .map(({ index }) => ({
        file: path,
        line: lineAt(sql, index),
        rule: "supabase-open-policy",
        severity: "medium" as const,
      })),
  ]);
}
