/**
 * Env refs: opaque stand-ins for values redacted from MCP tool results.
 *
 * The model sees `[env-ref:ref_<hex> public|secret]` where a credential or
 * public config value was, and can pass the ref to `setEnvVarFromRef`. The value
 * itself is sealed server-side and never enters the conversation, tool args,
 * step output or logs.
 *
 * Visibility is decided here, from the redaction rule and the value, never by
 * the model. Public is an allowlist; anything else is secret.
 */

import { randomBytes } from "node:crypto";

import { jwtClaims } from "../../credential-guard";
import type { RefMinter } from "./redact";

export type EnvRefVisibility = "public" | "secret";

export interface PendingEnvRef {
  refId: string;
  value: string;
  rule: string;
  visibility: EnvRefVisibility;
}

/** Persists minted refs; throws when it cannot, so the caller falls back. */
export type EnvRefStore = (
  refs: readonly PendingEnvRef[],
  source: { providerId: string; toolName: string },
) => Promise<void>;

export function envRefVisibility(value: string, rule: string): EnvRefVisibility {
  if (rule === "supabase-url" || rule === "supabase-publishable") return "public";
  if (rule === "jwt") {
    // Only a Supabase anon key; every other JWT (no role, third-party, malformed) stays secret.
    const claims = jwtClaims(value);
    if (claims?.iss === "supabase" && claims.role === "anon") return "public";
  }
  return "secret";
}

/** 128 random bits, hex so no redaction pattern can match inside the token. */
export const newEnvRefId = () => `ref_${randomBytes(16).toString("hex")}`;

/** One minter per tool result; the same value gets the same ref within it. */
export function createEnvRefMinter(): { toRef: RefMinter; refs: PendingEnvRef[] } {
  const refs: PendingEnvRef[] = [];
  const tokens = new Map<string, string>();

  const toRef: RefMinter = (value, rule) => {
    let token = tokens.get(value);
    if (!token) {
      const ref = { refId: newEnvRefId(), value, rule, visibility: envRefVisibility(value, rule) };
      refs.push(ref);
      token = `[env-ref:${ref.refId} ${ref.visibility}]`;
      tokens.set(value, token);
    }
    return token;
  };

  return { toRef, refs };
}
