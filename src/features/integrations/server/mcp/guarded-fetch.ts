/**
 * A `fetch` wrapper for MCP transports that re-validates every outbound request.
 *
 * ## Why the transport needs its own guard
 *
 * `assertSafeMcpUrl` is called once when a connection is configured. That leaves
 * two gaps the transport itself has to close:
 *
 * 1. **Redirects.** A server that passes validation can reply `302` pointing at
 *    `http://169.254.169.254/`. The initial check never sees that URL.
 * 2. **Re-resolution.** Streamable HTTP makes many requests over a session's
 *    lifetime, and DNS answers can change between them.
 *
 * So every request through this wrapper is re-checked, and redirects are refused
 * outright rather than followed. MCP has no legitimate need to redirect: the
 * endpoint is a fixed JSON-RPC URL.
 *
 * ## What this still does not fix
 *
 * There remains a small window between our DNS lookup and the one `fetch`
 * performs internally. Closing it completely requires resolving the host
 * ourselves and connecting to a pinned address via an `undici` dispatcher with a
 * custom `lookup`, which also means managing TLS SNI by hand. That is a
 * meaningful amount of machinery for a residual risk that requires an attacker to
 * control DNS for a host the user deliberately added, so it is documented rather
 * than implemented. `checkIp` is exported from `../url-guard` when we want it.
 */

import { assertSafeMcpUrl } from "../url-guard";

export type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface GuardedFetchOptions {
  /** Catalog hostnames that skip DNS validation. */
  trustedHosts?: readonly string[];
}

function urlOf(input: string | URL | Request): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

/**
 * Build a `fetch` that validates each request URL before issuing it.
 *
 * Passed to `StreamableHTTPClientTransport` via its `fetch` option so the guard
 * covers every request the transport makes, not just the first.
 */
export function createGuardedFetch(
  options: GuardedFetchOptions = {},
): FetchLike {
  return async function guardedFetch(input, init) {
    const target = urlOf(input);

    const verdict = await assertSafeMcpUrl(target, {
      trustedHosts: options.trustedHosts,
    });

    if (!verdict.ok) {
      throw new Error(`Blocked request to ${target}: ${verdict.reason}`);
    }

    return fetch(input as Parameters<typeof fetch>[0], {
      ...init,
      // Following a redirect would bypass validation entirely, since the
      // destination is chosen by the remote server. MCP endpoints are fixed
      // JSON-RPC URLs and have no reason to redirect.
      redirect: "error",
    });
  };
}
