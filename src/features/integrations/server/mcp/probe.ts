/**
 * Connection probe: verify an MCP server is reachable and the credential works.
 *
 * ## Why we probe before persisting
 *
 * A credential that fails is far cheaper to diagnose at the moment the user
 * pastes it than three screens later when the agent reports it "cannot access
 * your database". Probing also means a stored connection is one that has
 * demonstrably completed an MCP handshake, so `status: "active"` is a fact rather
 * than an assumption.
 *
 * The probe doubles as tool discovery for the connection UI: `tools/list` is the
 * same call the agent will make, so what the user sees is what the model will get.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import { assertSafeMcpUrl } from "../url-guard";
import { createGuardedFetch } from "./guarded-fetch";

/** Identifies us to MCP servers. Some log or gate on client identity. */
const CLIENT_INFO = { name: "codenaya", version: "1.0.0" } as const;

/**
 * A handshake plus one `tools/list` should be fast. Ten seconds is generous for a
 * healthy server and short enough that a user pasting a key is not left waiting
 * on something that will never answer.
 */
const PROBE_TIMEOUT_MS = 10_000;

/**
 * Guards against a server advertising an unreasonable number of tools. Beyond
 * this we stop counting rather than hold it all in memory; the real context-budget
 * enforcement happens when tools are exposed to the model.
 */
const MAX_TOOLS_REPORTED = 200;

export interface McpToolInfo {
  name: string;
  description?: string;
}

export type McpProbeFailureKind =
  | "blocked"
  | "unauthorized"
  | "timeout"
  | "network"
  | "protocol";

export type McpProbeResult =
  | {
      ok: true;
      tools: McpToolInfo[];
      /** True when the server reported more tools than we recorded. */
      truncated: boolean;
      serverName?: string;
      serverVersion?: string;
    }
  | { ok: false; kind: McpProbeFailureKind; error: string };

export interface ProbeMcpServerOptions {
  url: string;
  /** Merged into every request. Carries `Authorization` for API-key auth. */
  headers?: Record<string, string>;
  /**
   * Hostnames allowed to skip DNS validation.
   *
   * Pass the provider's `trustedHostnames` for a catalog entry. Omit it for a
   * user-supplied custom server so the URL gets full DNS validation — a custom
   * URL is untrusted input and should not inherit the catalog's allowlist.
   */
  trustedHosts?: readonly string[];
  timeoutMs?: number;
}

/**
 * Map a thrown error onto a failure kind and a message safe to show a user.
 *
 * Kinds matter because the remedies differ: `unauthorized` means fix the
 * credential, `network` means check the URL, `protocol` means the endpoint is not
 * an MCP server. Collapsing them into "failed" leaves the user guessing.
 */
function classifyError(error: unknown): {
  kind: McpProbeFailureKind;
  error: string;
} {
  const raw = error instanceof Error ? error.message : String(error);

  // The SDK surfaces HTTP failures with the status embedded in the message.
  if (/\b401\b|unauthoriz/i.test(raw)) {
    return {
      kind: "unauthorized",
      error:
        "The server rejected these credentials. Check the key is correct and has not been revoked.",
    };
  }

  if (/\b403\b|forbidden/i.test(raw)) {
    return {
      kind: "unauthorized",
      error:
        "The server accepted the credentials but refused access. The key may lack the required scopes.",
    };
  }

  if (/abort|timeout|ETIMEDOUT/i.test(raw)) {
    return {
      kind: "timeout",
      error: `The server did not respond within ${PROBE_TIMEOUT_MS / 1000} seconds.`,
    };
  }

  if (/^Blocked request to/i.test(raw)) {
    return { kind: "blocked", error: raw };
  }

  if (/ENOTFOUND|ECONNREFUSED|ECONNRESET|EAI_AGAIN|fetch failed/i.test(raw)) {
    return {
      kind: "network",
      error: "Could not reach the server. Check the URL is correct.",
    };
  }

  // A plain web page or REST endpoint typically fails here: it answers, but not
  // with JSON-RPC.
  return {
    kind: "protocol",
    error: `The endpoint did not complete an MCP handshake: ${raw}`,
  };
}

/**
 * Connect to an MCP server, list its tools, and disconnect.
 *
 * Never throws — every failure is returned as `{ ok: false }` so callers can
 * surface the reason to the user or the model instead of producing a 500.
 */
export async function probeMcpServer(
  options: ProbeMcpServerOptions,
): Promise<McpProbeResult> {
  const { url, headers, trustedHosts, timeoutMs = PROBE_TIMEOUT_MS } = options;

  // Validate before constructing a transport, so a hostile URL never reaches the
  // network stack at all.
  const verdict = await assertSafeMcpUrl(url, { trustedHosts });
  if (!verdict.ok) {
    return { ok: false, kind: "blocked", error: verdict.reason };
  }

  const client = new Client(CLIENT_INFO);
  const transport = new StreamableHTTPClientTransport(verdict.url, {
    requestInit: headers ? { headers } : undefined,
    fetch: createGuardedFetch({ trustedHosts }),
  });

  try {
    await client.connect(transport, { timeout: timeoutMs });

    const listed = await client.listTools(undefined, { timeout: timeoutMs });
    const all = listed.tools ?? [];

    const tools: McpToolInfo[] = all
      .slice(0, MAX_TOOLS_REPORTED)
      .map((tool) => ({
        name: tool.name,
        description:
          typeof tool.description === "string" ? tool.description : undefined,
      }));

    const info = client.getServerVersion();

    return {
      ok: true,
      tools,
      truncated: all.length > MAX_TOOLS_REPORTED,
      serverName: typeof info?.name === "string" ? info.name : undefined,
      serverVersion:
        typeof info?.version === "string" ? info.version : undefined,
    };
  } catch (error) {
    return { ok: false, ...classifyError(error) };
  } finally {
    // Always release the session. Leaking sessions would eventually exhaust
    // server-side limits for the user's account, which is a failure mode they
    // could not diagnose from our side.
    try {
      await client.close();
    } catch {
      // Closing a connection that never opened is expected; nothing to do.
    }
  }
}
