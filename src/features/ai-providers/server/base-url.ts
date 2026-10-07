import {
  createGuardedFetch,
  type FetchLike,
} from "@/features/integrations/server/mcp/guarded-fetch";
import {
  assertSafeMcpUrl,
  type UrlGuardResult,
} from "@/features/integrations/server/url-guard";

import { AI_PROVIDERS } from "../registry";

/**
 * SSRF rules for a custom (OpenAI-compatible) endpoint, reusing the MCP URL
 * guard: https only, no credentials in the URL, and every resolved address must
 * be public. The one exception is `http(s)://localhost` while running
 * `next dev`, so a local model server can be tried out.
 */

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** Hosts of the fixed provider APIs. Operator-chosen, so DNS checks are skipped. */
const PROVIDER_HOSTS = Object.values(AI_PROVIDERS).flatMap((provider) =>
  provider.baseUrl ? [new URL(provider.baseUrl).hostname] : [],
);

/** True for a loopback URL while `NODE_ENV` is `development`. */
export function isDevLocalhostUrl(url: URL): boolean {
  return (
    process.env.NODE_ENV === "development" &&
    (url.protocol === "http:" || url.protocol === "https:") &&
    LOOPBACK_HOSTS.has(url.hostname)
  );
}

/**
 * Validate a user-supplied base URL. On success the URL is normalised to
 * origin + path without a trailing slash, ready to store.
 */
export async function assertSafeProviderBaseUrl(
  raw: string,
): Promise<UrlGuardResult> {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return { ok: false, reason: "Not a valid URL." };
  }

  if (url.username !== "" || url.password !== "") {
    return { ok: false, reason: "URLs must not embed credentials." };
  }
  if (url.search !== "" || url.hash !== "") {
    return { ok: false, reason: "Base URLs must not include a query or fragment." };
  }

  url.pathname = url.pathname.replace(/\/+$/, "");

  if (isDevLocalhostUrl(url)) {
    return { ok: true, url };
  }

  // Checked here so the MCP guard's dev-only http opt-in does not apply.
  if (url.protocol !== "https:") {
    return { ok: false, reason: "Custom endpoints must use https." };
  }

  const verdict = await assertSafeMcpUrl(url.toString());
  return verdict.ok ? { ok: true, url } : verdict;
}

/** Base URL string without a trailing slash, as stored on a custom key. */
export function normalizedBaseUrl(url: URL): string {
  return url.toString().replace(/\/+$/, "");
}

/**
 * `fetch` for requests to a provider API from our server. Every request is
 * re-validated and redirects are refused (see `createGuardedFetch`); the
 * dev-only loopback endpoint skips the IP checks that would otherwise block it.
 */
export function providerFetch(baseUrl: string): FetchLike {
  if (isDevLocalhostUrl(new URL(baseUrl))) {
    return (input, init) =>
      fetch(input as Parameters<typeof fetch>[0], { ...init, redirect: "error" });
  }
  return createGuardedFetch({ trustedHosts: PROVIDER_HOSTS });
}
