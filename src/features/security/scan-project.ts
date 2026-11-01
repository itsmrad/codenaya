/**
 * Pre-export secret scan (#300).
 *
 * Runs before code leaves Codenaya (ZIP download, GitHub export, showcase
 * publish) and is meant to be reused by live-URL publish (#224). Pure and
 * isomorphic. Findings name the file, line and rule, never the matched text.
 */

import { CREDENTIAL_TOKEN_PATTERNS } from "@/features/integrations/credential-guard";
import { PUBLIC_KEY_PREFIXES, isPublicByConvention } from "@/features/integrations/env-keys";

import { scanSupabaseSql } from "./supabase-exposure";

export type ScanSeverity = "high" | "medium";

export interface ScanFinding {
  /** Project-relative path, or `env:<KEY>` for a stored environment variable. */
  file: string;
  /** 1-based; null for environment variables. */
  line: number | null;
  rule: string;
  severity: ScanSeverity;
}

export interface ScanFile {
  path: string;
  /** Undefined for binary files, which are skipped. */
  content?: string;
}

export interface ScanEnvVar {
  key: string;
  value: string;
  visibility: "public" | "secret";
}

/** Shorter stored values ("true", "3000") would match all over the code. */
const MIN_STORED_SECRET_LENGTH = 8;

const SECRET_NAME = /SECRET|SERVICE_ROLE|PRIVATE/;
const PUBLIC_SECRET_NAME = new RegExp(
  `\\b(?:${PUBLIC_KEY_PREFIXES.join("|")})\\w*(?:SECRET|SERVICE_ROLE|PRIVATE)\\w*`,
);
const SERVICE_ROLE = /service_role|SUPABASE_SERVICE/i;
const CLIENT_SOURCE = /(?:^|\/)src\//;

const RULE_LABELS: Record<string, string> = {
  "stored-secret": "Value of a stored secret env var",
  "public-env-secret": "Secret-looking value in a public env var",
  "public-secret-name": "Secret-looking name with a public prefix",
  "service-role-in-client": "Supabase service role referenced in client code",
  "supabase-no-rls": "Supabase table without row level security: anyone with the public key can read and change every row",
  "supabase-open-policy": "Supabase policy that lets everyone through (using true)",
};

export const describeRule = (rule: string) =>
  RULE_LABELS[rule] ?? `Hard-coded ${rule} credential`;

/** Groups the dialog and the fix message, each with its plain-English fix. */
export const SCAN_CATEGORIES = [
  {
    id: "secrets",
    title: "Exposed secrets",
    fix:
      "Move each secret into a server-side environment variable (never one with a " +
      "public prefix such as VITE_ or NEXT_PUBLIC_) and remove it from the code.",
  },
  {
    id: "supabase",
    title: "Supabase data exposure",
    fix:
      "Enable row level security on every Supabase table, give each one policies that " +
      "only allow a user their own rows (for example auth.uid() = user_id), and keep " +
      "the service role key in server code only.",
  },
] as const;

const SUPABASE_RULES = new Set(["service-role-in-client", "supabase-no-rls", "supabase-open-policy"]);

export const ruleCategory = (rule: string): (typeof SCAN_CATEGORIES)[number]["id"] =>
  SUPABASE_RULES.has(rule) ? "supabase" : "secrets";

/** Supabase anon keys are JWTs meant for the browser; RLS protects the data. */
const isSupabaseAnonJwt = (token: string) => {
  try {
    const payload = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    return JSON.parse(atob(payload)).role === "anon";
  } catch {
    return false;
  }
};

/** `sk_live_xxxxxxxxxxxxxxxx` and the like in `.env.example` files. */
const isPlaceholder = (token: string) => new Set(token.slice(-16)).size < 6;

/** Labels of the credential patterns in `text`, ignoring anon JWTs and placeholders. */
const credentialRules = (text: string): string[] =>
  CREDENTIAL_TOKEN_PATTERNS.filter(({ label, pattern }) =>
    [...text.matchAll(new RegExp(pattern.source, pattern.flags))].some(
      ([token]) =>
        !isPlaceholder(token) && !(label === "jwt" && isSupabaseAnonJwt(token)),
    ),
  ).map(({ label }) => label);

export function scanProject(
  files: readonly ScanFile[],
  envVars: readonly ScanEnvVar[],
): ScanFinding[] {
  const findings = new Map<string, ScanFinding>();
  const add = (finding: ScanFinding) =>
    findings.set(`${finding.file}:${finding.line}:${finding.rule}`, finding);

  const storedSecrets = envVars
    .filter((v) => v.visibility === "secret" && v.value.length >= MIN_STORED_SECRET_LENGTH)
    .map((v) => v.value);

  for (const { path, content } of files) {
    if (content === undefined) continue;
    const inClientSource = CLIENT_SOURCE.test(path);

    content.split("\n").forEach((text, index) => {
      const line = index + 1;
      for (const rule of credentialRules(text)) {
        add({ file: path, line, rule, severity: "high" });
      }
      if (storedSecrets.some((secret) => text.includes(secret))) {
        add({ file: path, line, rule: "stored-secret", severity: "high" });
      }
      if (PUBLIC_SECRET_NAME.test(text)) {
        add({ file: path, line, rule: "public-secret-name", severity: "medium" });
      }
      if (inClientSource && SERVICE_ROLE.test(text)) {
        add({ file: path, line, rule: "service-role-in-client", severity: "medium" });
      }
    });
  }

  scanSupabaseSql(files).forEach(add);

  for (const { key, value } of envVars) {
    if (!isPublicByConvention(key)) continue;
    if (SECRET_NAME.test(key) || credentialRules(value).length > 0) {
      add({ file: `env:${key}`, line: null, rule: "public-env-secret", severity: "high" });
    }
  }

  return [...findings.values()].sort(
    (a, b) => Number(a.severity === "medium") - Number(b.severity === "medium"),
  );
}

/** The chat message "Ask agent to fix" sends: locations and rules, no values. */
export const fixRequestMessage = (findings: readonly ScanFinding[]) =>
  [
    "The pre-export security scan found possible secrets or exposed data.",
    ...SCAN_CATEGORIES.flatMap(({ id, fix }) => {
      const inCategory = findings.filter((f) => ruleCategory(f.rule) === id);
      if (inCategory.length === 0) return [];
      return [
        `${fix} Fix these:`,
        // `KEY: rule` would trip the chat credential guard's labeled-secret rule.
        ...inCategory.map(
          (f) => `- ${f.line === null ? f.file : `${f.file}:${f.line}`} (${f.rule})`,
        ),
      ];
    }),
  ].join("\n");
