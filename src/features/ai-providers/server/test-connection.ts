import type { FetchLike } from "@/features/integrations/server/mcp/guarded-fetch";

import { AI_PROVIDERS, baseUrlFor, type AiProviderId } from "../registry";
import { providerFetch } from "./base-url";

/**
 * Checks that an API key works by calling a cheap, read-only endpoint on the
 * provider: OpenRouter's `/key`, everyone else's `/models`. No tokens are
 * generated, so testing costs the user nothing.
 *
 * Error messages never include the response body, which some providers echo
 * the submitted key into.
 */

const TEST_TIMEOUT_MS = 10_000;

const ANTHROPIC_VERSION = "2023-06-01";

export interface ProviderCredential {
  provider: AiProviderId;
  apiKey: string;
  /** Custom endpoints only. */
  baseUrl?: string;
}

export type TestConnectionFailureKind =
  | "unauthorized"
  | "blocked"
  | "timeout"
  | "network"
  | "error";

export type TestConnectionResult =
  | { ok: true }
  | { ok: false; kind: TestConnectionFailureKind; error: string };

export interface TestConnectionOptions {
  /** Overrides the guarded fetch. For tests. */
  fetchFn?: FetchLike;
  timeoutMs?: number;
}

function testRequest(
  { provider, apiKey }: ProviderCredential,
  baseUrl: string,
): { url: string; headers: Record<string, string> } {
  if (provider === "anthropic") {
    return {
      url: `${baseUrl}/models`,
      headers: { "x-api-key": apiKey, "anthropic-version": ANTHROPIC_VERSION },
    };
  }
  return {
    url: `${baseUrl}/${provider === "openrouter" ? "key" : "models"}`,
    headers: { Authorization: `Bearer ${apiKey}` },
  };
}

export async function testConnection(
  credential: ProviderCredential,
  { fetchFn, timeoutMs = TEST_TIMEOUT_MS }: TestConnectionOptions = {},
): Promise<TestConnectionResult> {
  const label = AI_PROVIDERS[credential.provider].label;
  const baseUrl = baseUrlFor(credential);
  const { url, headers } = testRequest(credential, baseUrl);
  const doFetch = fetchFn ?? providerFetch(baseUrl);

  let response: Response;
  try {
    response = await doFetch(url, {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    const name = error instanceof Error ? error.name : "";
    const message = error instanceof Error ? error.message : "";
    if (name === "TimeoutError" || name === "AbortError") {
      return { ok: false, kind: "timeout", error: `${label} did not respond in time.` };
    }
    if (message.startsWith("Blocked request")) {
      return { ok: false, kind: "blocked", error: message };
    }
    return { ok: false, kind: "network", error: `Could not reach ${label}.` };
  }

  // The body is never read; release the connection.
  await response.body?.cancel().catch(() => {});

  if (response.ok) return { ok: true };

  if (response.status === 401 || response.status === 403) {
    return {
      ok: false,
      kind: "unauthorized",
      error: `${label} rejected the API key.`,
    };
  }

  return {
    ok: false,
    kind: "error",
    error: `${label} responded with HTTP ${response.status}.`,
  };
}

/**
 * Response for a failed test: a rejected key or blocked URL is the caller's
 * to fix (400); anything else is the provider's side (502).
 */
export function testFailureResponse(
  result: Extract<TestConnectionResult, { ok: false }>,
): Response {
  const status = result.kind === "unauthorized" || result.kind === "blocked" ? 400 : 502;
  return Response.json(
    { ok: false, error: result.error, kind: result.kind },
    { status },
  );
}
