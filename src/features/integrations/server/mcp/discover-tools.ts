/**
 * Tool discovery for a resolved MCP server.
 *
 * Connects, lists tools, applies the connection's allowlist, enforces the context
 * budget, and checks the result against the approved baseline.
 *
 * ## Why the tool cap is not optional
 *
 * Tool schemas are sent to the model on every request. Cloudflare published the
 * arithmetic for their own API: 2,594 tools as native MCP definitions costs roughly
 * 1.17 million tokens of schema — more than most context windows — which is why
 * their server exposes two tools instead. A user who connects five wide-open
 * servers can silently make every turn fail, or quietly evict the actual
 * conversation from context. Capping is a correctness requirement, not tidiness.
 *
 * ## Drift is reported, not enforced here
 *
 * This module returns what changed against the baseline. The caller decides what
 * to do, because the right response differs by context: a first connection has no
 * baseline and should simply record one, whereas a changed description on an
 * established connection should stop the tool being offered until re-approved.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import { assertSafeMcpUrl } from "../url-guard";
import {
  detectToolDrift,
  fingerprintTools,
  hasDrift,
  type McpToolDefinition,
  type ToolDrift,
  type ToolFingerprint,
} from "./fingerprint";
import { createGuardedFetch } from "./guarded-fetch";
import type { ResolvedMcpServer } from "./resolve-servers";

const CLIENT_INFO = { name: "codenaya", version: "1.0.0" } as const;

const DISCOVERY_TIMEOUT_MS = 15_000;

/**
 * Per-connection tool ceiling.
 *
 * Chosen so several connected providers still fit a normal context window
 * alongside the conversation and the file tools the agent already has.
 */
export const MAX_TOOLS_PER_CONNECTION = 40;

export interface DiscoveredTool extends McpToolDefinition {
  /** Name the model sees, namespaced by provider. */
  qualifiedName: string;
  /** True when this tool mutates state and needs an approval gate. */
  destructive: boolean;
}

export interface DiscoveryResult {
  ok: true;
  tools: DiscoveredTool[];
  fingerprints: ToolFingerprint[];
  drift: ToolDrift;
  /** True when a baseline existed and something changed or was added. */
  driftDetected: boolean;
  /** True when the server offered more tools than the cap allows. */
  capped: boolean;
  /** How many the server offered in total, before the cap. */
  offeredCount: number;
  serverName?: string;
}

export interface DiscoveryFailure {
  ok: false;
  error: string;
}

/**
 * Build the model-facing tool name.
 *
 * Namespacing prevents two providers that both expose `list_projects` from
 * colliding, and tells the model which service it is talking to. The separator is
 * a double underscore so it survives providers that restrict tool names to
 * `[A-Za-z0-9_-]`.
 */
export function qualifyToolName(namespace: string, toolName: string): string {
  return `${namespace}__${toolName}`;
}

/** Split a qualified name back into its parts. */
export function parseQualifiedToolName(
  qualified: string,
): { namespace: string; toolName: string } | null {
  const index = qualified.indexOf("__");
  if (index <= 0 || index + 2 >= qualified.length) return null;
  return {
    namespace: qualified.slice(0, index),
    toolName: qualified.slice(index + 2),
  };
}

/**
 * Open a client against a resolved server.
 *
 * Shared with `call-tool.ts` so both paths get identical SSRF treatment and
 * identical credential handling.
 */
export async function openMcpClient(
  server: ResolvedMcpServer,
  timeoutMs: number,
): Promise<{ client: Client } | { error: string }> {
  const verdict = await assertSafeMcpUrl(server.url, {
    trustedHosts: server.trustedHostnames,
  });

  if (!verdict.ok) {
    return { error: `Blocked: ${verdict.reason}` };
  }

  const client = new Client(CLIENT_INFO);
  const transport = new StreamableHTTPClientTransport(verdict.url, {
    requestInit: { headers: server.headers },
    fetch: createGuardedFetch({ trustedHosts: server.trustedHostnames }),
  });

  try {
    await client.connect(transport, { timeout: timeoutMs });
    return { client };
  } catch (error) {
    // Release the half-open client before reporting, so a failed connect does
    // not leak a session.
    try {
      await client.close();
    } catch {
      // Nothing to release.
    }
    return {
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * List the tools a server offers, filtered, capped and diffed against baseline.
 */
export async function discoverTools(
  server: ResolvedMcpServer,
  options: { timeoutMs?: number } = {},
): Promise<DiscoveryResult | DiscoveryFailure> {
  const timeoutMs = options.timeoutMs ?? DISCOVERY_TIMEOUT_MS;

  const opened = await openMcpClient(server, timeoutMs);
  if ("error" in opened) {
    return { ok: false, error: opened.error };
  }

  const { client } = opened;

  try {
    const listed = await client.listTools(undefined, { timeout: timeoutMs });
    const offered = listed.tools ?? [];

    const definitions: McpToolDefinition[] = offered.map((tool) => ({
      name: tool.name,
      description:
        typeof tool.description === "string" ? tool.description : undefined,
      title: typeof tool.title === "string" ? tool.title : undefined,
      inputSchema: tool.inputSchema,
    }));

    // The allowlist is applied before the cap, so an explicit selection is never
    // truncated by tools the user did not ask for.
    const allowed = server.allowedTools
      ? definitions.filter((tool) => server.allowedTools?.includes(tool.name))
      : definitions;

    // Fingerprints cover the allowed set, which is what the model will actually
    // see. Digesting tools we filter out would produce drift alarms for
    // definitions that can never reach the model.
    const fingerprints = fingerprintTools(allowed);

    const baseline = server.toolBaseline ?? [];
    const drift = detectToolDrift(fingerprints, baseline);

    // A first connection has no baseline, so everything reads as "added". That is
    // not drift — there was nothing to drift from.
    const driftDetected = baseline.length > 0 && hasDrift(drift);

    // Sorted before capping so which tools survive is deterministic rather than
    // dependent on server ordering.
    const sorted = [...allowed].sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    );
    const capped = sorted.length > MAX_TOOLS_PER_CONNECTION;
    const kept = sorted.slice(0, MAX_TOOLS_PER_CONNECTION);

    const tools: DiscoveredTool[] = kept.map((tool) => ({
      ...tool,
      qualifiedName: qualifyToolName(server.namespace, tool.name),
      destructive: server.destructiveTools.includes(tool.name),
    }));

    const info = client.getServerVersion();

    return {
      ok: true,
      tools,
      fingerprints,
      drift,
      driftDetected,
      capped,
      offeredCount: offered.length,
      serverName: typeof info?.name === "string" ? info.name : undefined,
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    try {
      await client.close();
    } catch {
      // Closing a connection that already failed is expected.
    }
  }
}
