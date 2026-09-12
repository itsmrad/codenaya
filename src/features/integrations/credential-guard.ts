/**
 * High-confidence detection for credentials pasted into chat.
 *
 * This module is isomorphic so the browser can provide immediate feedback while
 * the API remains the authoritative boundary. It reports rule names only; callers
 * must never log or return the matched text.
 */

export const CREDENTIAL_TOKEN_PATTERNS: ReadonlyArray<{
  label: string;
  pattern: RegExp;
}> = [
  { label: "github", pattern: /\bgh[pousr]_[A-Za-z0-9]{16,}\b/g },
  { label: "github-pat", pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g },
  { label: "stripe", pattern: /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}\b/g },
  { label: "supabase-pat", pattern: /\bsbp_[A-Za-z0-9]{20,}\b/g },
  { label: "supabase-secret", pattern: /\bsb_secret_[A-Za-z0-9_-]{16,}\b/g },
  { label: "openai", pattern: /\bsk-[A-Za-z0-9_-]{20,}\b/g },
  { label: "slack", pattern: /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/g },
  { label: "google", pattern: /\bAIza[A-Za-z0-9_-]{30,}\b/g },
  { label: "aws", pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g },
  {
    label: "jwt",
    pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
  },
  {
    label: "bearer",
    pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}\b/gi,
  },
];

export const DSN_PASSWORD_PATTERN =
  /\b([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+):([^\s@/]+)@/gi;

/**
 * A generic token is only considered a credential when it follows an explicit
 * secret label. This catches custom MCP keys without flagging every long hash or
 * identifier in a coding prompt.
 */
const LABELED_SECRET_PATTERN =
  /\b(?:api[ _-]?key|access[ _-]?token|secret(?:[ _-]?key)?|auth(?:orization)?[ _-]?token)\b\s*(?:=|:)\s*["']?(?!process\.env\b|import\.meta\.env\b|\$\{|\[?redacted\b|your[ _-]|example\b|placeholder\b|<)[A-Za-z0-9_./+=~-]{16,}/gi;

const MCP_INTENT_PATTERN = /\b(?:mcp|model context protocol)\b/i;
const URL_PATTERN = /\b[a-z][a-z0-9+.-]*:\/\/\S+/gi;
const OPAQUE_TOKEN_PATTERN = /[A-Za-z0-9_+=./~-]{24,}/g;

export interface CredentialDetection {
  detected: boolean;
  /** Safe for telemetry and tests; never contains credential material. */
  matchedRules: string[];
}

export function detectCredential(text: string): CredentialDetection {
  const matchedRules = new Set<string>();

  for (const { label, pattern } of CREDENTIAL_TOKEN_PATTERNS) {
    const scoped = new RegExp(pattern.source, pattern.flags);
    if (scoped.test(text)) matchedRules.add(label);
  }

  const dsn = new RegExp(DSN_PASSWORD_PATTERN.source, DSN_PASSWORD_PATTERN.flags);
  if (dsn.test(text)) matchedRules.add("dsn-password");

  const labeled = new RegExp(
    LABELED_SECRET_PATTERN.source,
    LABELED_SECRET_PATTERN.flags,
  );
  if (labeled.test(text)) matchedRules.add("labeled-secret");

  // Custom MCP servers may use opaque keys with no provider prefix. When the
  // message explicitly concerns MCP setup, treat a long mixed letter/number
  // token as sensitive. URLs are removed first so an endpoint alone is allowed.
  if (MCP_INTENT_PATTERN.test(text)) {
    const withoutUrls = text.replace(URL_PATTERN, "");
    const opaqueCandidates = withoutUrls.match(OPAQUE_TOKEN_PATTERN) ?? [];
    if (
      opaqueCandidates.some(
        (candidate) => /[A-Za-z]/.test(candidate) && /\d/.test(candidate),
      )
    ) {
      matchedRules.add("mcp-opaque-token");
    }
  }

  return {
    detected: matchedRules.size > 0,
    matchedRules: [...matchedRules].sort(),
  };
}
