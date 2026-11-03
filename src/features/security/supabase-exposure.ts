/**
 * Static Supabase data-exposure checks for the pre-export scan (#300, step 3).
 * Reads the project's SQL files only; never calls Supabase.
 */

import type { ScanFile, ScanFinding } from "./scan-project";

// shortcut: only `.sql` under a `supabase/` folder (the CLI's layout), so Prisma or
// plain Postgres migrations aren't flagged; widen if the agent writes SQL elsewhere.
const SUPABASE_SQL = /(?:^|\/)supabase\/.*\.sql$/i;

// One pattern, so statements come back in file order: create (1 `if not exists`, 2 table),
// enable/disable RLS (3 table, 4 enable|disable), drop (5).
// Temporary tables never match: `temp` sits between `create` and `table`.
const TABLE_STATEMENT = new RegExp(
  [
    String.raw`\bcreate\s+(?:unlogged\s+)?table\s+(if\s+not\s+exists\s+)?([\w."]+)`,
    String.raw`\balter\s+table\s+(?:if\s+exists\s+)?(?:only\s+)?([\w."]+)\s+(enable|disable)\s+row\s+level\s+security`,
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

// One left-to-right pass: string literals, quoted identifiers and dollar-quoted bodies
// are matched first and kept whole, so comment markers inside them are not comments.
// shortcut: E'..' backslash escapes and nested block comments aren't modelled; add if seen.
const SQL_TOKEN = /'(?:[^']|'')*'|"(?:[^"]|"")*"|(\$(?:[A-Za-z_]\w*)?\$)[\s\S]*?\1|--[^\n]*|\/\*[\s\S]*?(?:\*\/|$)/g;

/** Drops `--` and block comments but keeps every newline, so line numbers still hold. */
const stripComments = (sql: string): string =>
  sql.replace(SQL_TOKEN, (token, tag?: string) => {
    if (token.startsWith("--") || token.startsWith("/*")) return token.replace(/[^\n]/g, "");
    // A DO block or function body is SQL too: strip its comments, keep the $tag$ quotes.
    if (tag) return tag + stripComments(token.slice(tag.length, -tag.length)) + tag;
    return token;
  });

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

  // Known public tables replayed in run order: a finding while RLS is off, null once it's on.
  // A later `enable` or `drop` clears a table; `disable` or a re-create flags it again.
  const tables = new Map<string, ScanFinding | null>();
  for (const { path, sql } of sqlFiles) {
    for (const {
      1: ifNotExists,
      2: created,
      3: altered,
      4: toggle,
      5: dropped,
      index,
    } of sql.matchAll(TABLE_STATEMENT)) {
      const noRls = (): ScanFinding => ({
        file: path,
        line: lineAt(sql, index),
        rule: "supabase-no-rls",
        severity: "high",
      });
      if (created && isExposed(created)) {
        // `if not exists` on a table that's already there is a no-op: it keeps its RLS state.
        if (!(ifNotExists && tables.has(tableName(created)))) tables.set(tableName(created), noRls());
      } else if (altered && isExposed(altered)) {
        tables.set(tableName(altered), toggle.toLowerCase() === "enable" ? null : noRls());
      } else if (dropped) {
        dropped.split(",").forEach((raw) => tables.delete(tableName(raw.trim())));
      }
    }
  }
  const withoutRls = [...tables.values()].filter((finding) => finding !== null);

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

  return [...withoutRls, ...openPolicies];
}
