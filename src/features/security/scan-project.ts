/**
 * Pre-export secret scan (#300).
 *
 * Runs before code leaves Codenaya (ZIP download, GitHub export, showcase
 * publish) and is meant to be reused by live-URL publish (#224). Pure and
 * isomorphic. Findings name the file, line and rule, never the matched text.
 */

import {
  CREDENTIAL_TOKEN_PATTERNS,
  DSN_PASSWORD_PATTERN,
} from "@/features/integrations/credential-guard";
import { PUBLIC_KEY_PREFIXES, isPublicByConvention } from "@/features/integrations/env-keys";

export type ScanSeverity = "high" | "medium";

export interface ScanFinding {
  /** Project-relative path, or `env:<KEY>` for a stored environment variable. */
  file: string;
  /** 1-based; null for stored env vars and whole-file findings. */
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
const PRIVATE_KEY = /-----BEGIN [A-Z ]*PRIVATE KEY-----/;
/** `postgres://user:${DB_PASSWORD}@`, `<password>`, `%s`: not a literal password. */
const TEMPLATED_PASSWORD = /^[$<{%*[]/;
const ENV_FILE = /(?:^|\/)\.env(?:\.[\w.-]+)?$/;
/** `.env.example`, `config.sample`: meant to be shared, so only real-looking keys count. */
const EXAMPLE_FILE = /\.(?:example|sample)$/i;

const RULE_LABELS: Record<string, string> = {
  "stored-secret": "Value of a stored secret env var",
  "public-env-secret": "Secret-looking value in a public env var",
  "public-secret-name": "Secret-looking name with a public prefix",
  "service-role-in-client": "Supabase service role referenced in client code",
  "private-key": "Private key",
  "dsn-password": "Password in a connection string",
  "env-file": "Environment file included in the export",
  "sk-api-key": "Hard-coded API key (sk-…)",
};

export const describeRule = (rule: string) =>
  RULE_LABELS[rule] ?? `Hard-coded ${rule} credential`;

/** Supabase anon keys are JWTs meant for the browser; RLS protects the data. */
const isSupabaseAnonJwt = (token: string) => {
  try {
    const payload = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    return JSON.parse(atob(payload)).role === "anon";
  } catch {
    return false;
  }
};

/**
 * `sk_live_xxxxxxxxxxxxxxxx`, `sk-your-openai-api-key-here` and the like.
 * Real generated keys virtually always contain a digit.
 */
const isPlaceholder = (token: string) =>
  !/\d/.test(token) || new Set(token.slice(-16)).size < 6;

/** Labels of the credential patterns in `text`, ignoring anon JWTs and placeholders. */
const credentialRules = (text: string): string[] =>
  CREDENTIAL_TOKEN_PATTERNS.filter(({ label, pattern }) =>
    // matchAll iterates a copy, so the shared global regexes keep no state.
    [...text.matchAll(pattern)].some(
      ([token]) =>
        !isPlaceholder(token) && !(label === "jwt" && isSupabaseAnonJwt(token)),
    ),
  )
    // The `sk-` pattern also matches Anthropic and OpenRouter keys.
    .map(({ label }) => (label === "openai" ? "sk-api-key" : label));

const hasDsnPassword = (text: string) =>
  [...text.matchAll(DSN_PASSWORD_PATTERN)].some(
    ([, , password]) => !TEMPLATED_PASSWORD.test(password),
  );

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
    const isExample = EXAMPLE_FILE.test(path);
    if (ENV_FILE.test(path) && !isExample) {
      add({ file: path, line: null, rule: "env-file", severity: "high" });
    }

    content.split("\n").forEach((text, index) => {
      const line = index + 1;
      for (const rule of credentialRules(text)) {
        add({ file: path, line, rule, severity: "high" });
      }
      if (PRIVATE_KEY.test(text)) {
        add({ file: path, line, rule: "private-key", severity: "high" });
      }
      if (!isExample && hasDsnPassword(text)) {
        add({ file: path, line, rule: "dsn-password", severity: "high" });
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
    "The pre-export security scan found possible secrets or exposed data. " +
      "Move each secret into a server-side environment variable (never one with a " +
      "public prefix such as VITE_ or NEXT_PUBLIC_) and remove it from the code:",
    // `KEY: rule` would trip the chat credential guard's labeled-secret rule.
    ...findings.map(
      (f) => `- ${f.line === null ? f.file : `${f.file}:${f.line}`} (${f.rule})`,
    ),
  ].join("\n");
