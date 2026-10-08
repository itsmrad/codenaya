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
 * Provider wording for an account that cannot pay for inference: OpenAI's
 * `insufficient_quota`, Anthropic's low credit balance, OpenRouter's and
 * DeepSeek's out-of-credit replies.
 */
export const OUT_OF_CREDIT_PATTERN =
  /insufficient[_ ]quota|exceeded your current quota|insufficient (credits|balance)|credit balance is too low|requires more credits/i;

/** Smallest completion request a provider accepts: one output token, no tools. */
function probeRequest(
  { provider, apiKey, model }: ProviderCredential & { model: string },
  baseUrl: string,
): { url: string; headers: Record<string, string>; body: unknown } {
  const messages = [{ role: "user", content: "hi" }];
  if (provider === "anthropic") {
    return {
      url: `${baseUrl}/messages`,
      headers: { "x-api-key": apiKey, "anthropic-version": ANTHROPIC_VERSION },
      body: { model, max_tokens: 1, messages },
    };
  }
  return {
    url: `${baseUrl}/chat/completions`,
    headers: { Authorization: `Bearer ${apiKey}` },
    // OpenAI's current models refuse `max_tokens`.
    body:
      provider === "openai"
        ? { model, max_completion_tokens: 1, messages }
        : { model, max_tokens: 1, messages },
  };
}

/** OpenRouter's free `/key` endpoint answers for keys with a spending limit. */
async function openRouterLimitSpent(
  credential: ProviderCredential,
  baseUrl: string,
  doFetch: FetchLike,
  timeoutMs: number,
): Promise<boolean> {
  const { url, headers } = testRequest(credential, baseUrl);
  const response = await doFetch(url, {
    method: "GET",
    headers,
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) return false;
  const body = (await response.json()) as { data?: { limit_remaining?: number | null } };
  const remaining = body.data?.limit_remaining;
  return typeof remaining === "number" && remaining <= 0;
}

/**
 * Whether the account behind a working key is out of credit or quota.
 *
 * Inngest retries a failed `step.ai.infer` with backoff on its own side, so a
 * 402 from the real inference reaches the run only minutes later. This asks
 * first, with a one-token completion (a fraction of a cent on the user's key);
 * OpenRouter keys whose spending limit is used up are caught by the free
 * `/key` call instead. Only a definite out-of-credit answer counts: rate
 * limits, server errors and unreachable providers are left to the inference.
 * The response body is matched, never returned or logged.
 */
export async function isOutOfCredit(
  credential: ProviderCredential & { model: string },
  { fetchFn, timeoutMs = TEST_TIMEOUT_MS }: TestConnectionOptions = {},
): Promise<boolean> {
  const baseUrl = baseUrlFor(credential);
  const doFetch = fetchFn ?? providerFetch(baseUrl);
  try {
    if (
      credential.provider === "openrouter" &&
      (await openRouterLimitSpent(credential, baseUrl, doFetch, timeoutMs))
    ) {
      return true;
    }
    const { url, headers, body } = probeRequest(credential, baseUrl);
    const response = await doFetch(url, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (response.ok) {
      await response.body?.cancel().catch(() => {});
      return false;
    }
    return response.status === 402 || OUT_OF_CREDIT_PATTERN.test(await response.text());
  } catch {
    return false;
  }
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
