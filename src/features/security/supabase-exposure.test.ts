import { describe, expect, it } from "vitest";

import { detectCredential } from "@/features/integrations/credential-guard";

import { fixRequestMessage, scanProject } from "./scan-project";
import { scanSupabaseSql } from "./supabase-exposure";

const MIGRATION = "supabase/migrations/20260101000000_init.sql";

const scan = (content: string, path = MIGRATION) =>
  scanSupabaseSql([{ path, content }]).map((f) => `${f.line}:${f.rule}`);

describe("scanSupabaseSql: tables without RLS", () => {
  it("flags a public table created without enabling RLS", () => {
    expect(
      scan("-- todos\ncreate table public.todos (\n  id uuid primary key\n);"),
    ).toEqual(["2:supabase-no-rls"]);
  });

  it("matches quoted, unqualified and `if not exists` table names", () => {
    expect(
      scan(
        [
          'CREATE TABLE IF NOT EXISTS "Profiles" (id uuid);',
          "create table notes(id uuid);",
          'alter table public."profiles" enable row level security;',
        ].join("\n"),
      ),
    ).toEqual(["2:supabase-no-rls"]);
  });

  it("accepts RLS enabled on a later line or in a later migration", () => {
    const findings = scanSupabaseSql([
      {
        path: MIGRATION,
        content: "create table todos (id uuid);\nalter table only todos\n  enable row level security;\ncreate table posts (id uuid);",
      },
      {
        path: "supabase/migrations/20260102000000_rls.sql",
        content: "alter table if exists public.posts enable row level security;",
      },
    ]);

    expect(findings).toEqual([]);
  });

  it("skips other schemas, temp tables and commented-out SQL", () => {
    expect(
      scan(
        [
          "create table private.audit (id uuid);",
          "create temp table scratch (id int);",
          "-- create table old_todos (id uuid);",
          "create table todos (id uuid); -- alter table todos enable row level security;",
        ].join("\n"),
      ),
    ).toEqual(["4:supabase-no-rls"]);
  });

  it("ignores block comments and keeps line numbers right", () => {
    expect(
      scan(
        [
          "/* create table old_todos (id uuid);",
          "   still a comment */",
          "create table todos (id uuid); /* alter table todos enable row level security; */",
        ].join("\n"),
      ),
    ).toEqual(["3:supabase-no-rls"]);
  });

  it("keeps comment markers inside strings, quoted names and dollar bodies from hiding SQL", () => {
    expect(
      scan(
        [
          "insert into notes (body) values ('-- not a comment'); create table todos (id uuid);",
          "insert into notes (body) values ('/* not a comment'); create table tags (id uuid);",
          'create table "a--b" (id uuid);',
          "do $$ begin perform 1; -- note $$; create table posts (id uuid);",
          "do $fn$ select '/*' $fn$; create table drafts (id uuid);",
          "/* it's */ create table links (id uuid);",
        ].join("\n"),
      ),
    ).toEqual([1, 2, 3, 4, 5, 6].map((line) => `${line}:supabase-no-rls`));
  });

  it("ignores commented-out statements inside dollar-quoted bodies", () => {
    expect(scan("create table a (id int);\ndo $$ begin -- drop table a;\n end $$;")).toEqual([
      "1:supabase-no-rls",
    ]);
    expect(
      scan(
        "create table a (id int); create function f() returns void as $$\n -- alter table a enable row level security;\n$$ language sql;",
      ),
    ).toEqual(["1:supabase-no-rls"]);
  });

  it("flags a table whose RLS is disabled again after being enabled", () => {
    expect(
      scan(
        [
          "create table todos (id uuid);",
          "alter table todos enable row level security;",
          "alter table public.todos disable row level security;",
        ].join("\n"),
      ),
    ).toEqual(["3:supabase-no-rls"]);
  });

  it("keeps RLS on when `create table if not exists` hits an existing table", () => {
    expect(
      scanSupabaseSql([
        {
          path: MIGRATION,
          content: "create table todos (id uuid);\nalter table todos enable row level security;",
        },
        {
          path: "supabase/migrations/20260102000000_again.sql",
          content: "create table if not exists todos (id uuid);",
        },
      ]),
    ).toEqual([]);
  });

  it("clears dropped tables and flags a re-create without RLS", () => {
    expect(
      scanSupabaseSql([
        {
          path: "supabase/migrations/20260101000000_init.sql",
          content: "create table todos (id uuid);\ncreate table notes (id uuid);\ncreate table tags (id uuid);",
        },
        {
          path: "supabase/migrations/20260102000000_cleanup.sql",
          content: "drop table if exists public.notes, tags cascade;",
        },
      ]).map((f) => `${f.line}:${f.rule}`),
    ).toEqual(["1:supabase-no-rls"]);

    expect(
      scan(
        [
          "create table todos (id uuid);",
          "alter table todos enable row level security;",
          "drop table todos;",
          "create table todos (id uuid, title text);",
        ].join("\n"),
      ),
    ).toEqual(["4:supabase-no-rls"]);
  });

  it("only reads .sql files under supabase/", () => {
    const content = "create table todos (id uuid);";

    expect(scan(content, "prisma/migrations/1_init/migration.sql")).toEqual([]);
    expect(scan(content, "supabase/functions/seed.ts")).toEqual([]);
    expect(scan(content, "supabase/schema.sql")).toEqual(["1:supabase-no-rls"]);
    expect(scanSupabaseSql([{ path: "supabase/dump.sql" }])).toEqual([]);
  });
});

describe("scanSupabaseSql: open policies", () => {
  it("flags using (true) or with check (true) for every role, public or anon", () => {
    expect(
      scan(
        [
          'create policy "Anyone can read" on todos',
          "  for select using (true);",
          "create policy anon_insert on todos for insert to anon with check ( true );",
          'create policy "Mixed roles" on todos to authenticated, public using (true);',
        ].join("\n"),
      ),
    ).toEqual([
      "1:supabase-open-policy",
      "3:supabase-open-policy",
      "4:supabase-open-policy",
    ]);
  });

  it("reads quoted role names", () => {
    expect(
      scan(
        [
          'create policy "Signed in" on todos to "authenticated" using (true);',
          'create policy "Anon" on todos to "anon" using (true);',
        ].join("\n"),
      ),
    ).toEqual(["2:supabase-open-policy"]);
  });

  it("skips open policies on tables outside the public schema", () => {
    expect(
      scan(
        [
          'create policy "Audit" on private.audit using (true);',
          'create policy "Todos" on "public"."todos" using (true);',
        ].join("\n"),
      ),
    ).toEqual(["2:supabase-open-policy"]);
  });

  it("allows policies scoped to a role or to the row owner", () => {
    expect(
      scan(
        [
          // A policy name containing "to" is not a role clause.
          'create policy "Owners can talk to the table" on todos to authenticated using (true);',
          'create policy "Own rows" on todos using (auth.uid() = user_id);',
          'create policy "Own inserts" on todos for insert with check (auth.uid() = user_id);',
        ].join("\n"),
      ),
    ).toEqual([]);
  });
});

describe("scanProject with Supabase findings", () => {
  it("includes them alongside the secret findings", () => {
    const findings = scanProject(
      [
        { path: MIGRATION, content: "create table todos (id uuid);" },
        { path: "src/lib/admin.ts", content: "process.env.SUPABASE_SERVICE_ROLE_KEY" },
      ],
      [],
    );

    expect(findings.map((f) => `${f.file}:${f.line}:${f.rule}`)).toEqual([
      `${MIGRATION}:1:supabase-no-rls`,
      "src/lib/admin.ts:1:service-role-in-client",
    ]);
  });

  it("groups the fix message by category and passes the chat credential guard", () => {
    const message = fixRequestMessage([
      { file: MIGRATION, line: 1, rule: "supabase-no-rls", severity: "high" },
      { file: "src/pay.ts", line: 2, rule: "stripe", severity: "high" },
    ]);
    const lines = message.split("\n");

    expect(lines.indexOf("- src/pay.ts:2 (stripe)")).toBeLessThan(
      lines.findIndex((line) => line.startsWith("Enable row level security")),
    );
    expect(message).toContain(`- ${MIGRATION}:1 (supabase-no-rls)`);
    expect(detectCredential(message).detected).toBe(false);
  });
});
