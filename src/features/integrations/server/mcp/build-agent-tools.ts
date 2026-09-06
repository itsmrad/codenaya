/**
 * Assemble the MCP tools available to an agent run for one project.
 *
 * Sequences the whole pipeline: fetch links from Convex → open credentials and
 * apply scope → discover tools → gate on drift → record baselines → build adapter
 * tools.
 *
 * Kept separate from the Inngest function so the agent entry point stays readable
 * and so the same assembly can be reused by a second backend later without
 * duplicating the security decisions.
 *
 * ## Drift policy
 *
 * When a baseline exists and a tool's definition has changed, or a new tool has
 * appeared, the affected tools are **withheld from the model** and a warning is
 * recorded. The connection's other tools keep working.
 *
 * Withholding rather than warning-and-proceeding is the point: a changed
 * description is how a trusted server injects instructions the user never
 * reviewed, so continuing to offer it would make the baseline decorative. Dropping
 * only the affected tools rather than the whole connection keeps the blast radius
 * proportionate.
 *
 * A first connection has no baseline. Everything reads as "added", nothing is
 * withheld, and the baseline is recorded for next time.
 */

import type { Tool } from "@inngest/agent-kit";

import {
  createMcpToolsForAgentKit,
  type McpApprovalGate,
  type McpAuditSink,
} from "../../adapters/agentkit";
import { describeDrift } from "./fingerprint";
import { discoverTools, type DiscoveredTool } from "./discover-tools";
import {
  collectKnownSecrets,
  resolveMcpServers,
  type ConnectionRecord,
  type ProjectLinkRecord,
} from "./resolve-servers";
export interface McpToolBuildResult {
  tools: Tool.Any[];
  /** One line per provider, for the system prompt. */
  connectedSummaries: string[];
  /** Operator/user-facing problems worth surfacing. */
  warnings: string[];
  /** Baselines to persist, keyed by projectConnectionId. */
  baselinesToRecord: Array<{
    projectConnectionId: string;
    toolBaseline: Array<{ name: string; digest: string }>;
  }>;
}

export interface BuildMcpToolsOptions {
  entries: ReadonlyArray<{
    link: ProjectLinkRecord;
    connection: ConnectionRecord;
  }>;
  approvalGate?: McpApprovalGate;
  audit?: McpAuditSink;
}

/**
 * Ceiling on MCP tools across *all* of a project's connections.
 *
 * The per-connection cap in `discover-tools.ts` bounds one server; this bounds
 * their sum. Without it, five connections each just under their own limit would
 * together put ~200 tool schemas in front of the model on every request — which
 * either fails outright or silently evicts the conversation from context.
 *
 * The agent's own file tools also live in that budget, so this leaves room for
 * them and for the conversation history.
 */
export const MAX_TOOLS_PER_PROJECT = 80;

/**
 * Build the tool set for a project's enabled connections.
 *
 * Never throws: a project with broken integrations still gets an agent run with
 * its file tools intact. Problems surface as `warnings`.
 */
export async function buildMcpAgentTools(
  options: BuildMcpToolsOptions,
): Promise<McpToolBuildResult> {
  const { entries, approvalGate, audit } = options;

  const warnings: string[] = [];
  const connectedSummaries: string[] = [];
  const baselinesToRecord: McpToolBuildResult["baselinesToRecord"] = [];

  if (entries.length === 0) {
    return { tools: [], connectedSummaries, warnings, baselinesToRecord };
  }

  const { servers, problems } = await resolveMcpServers(entries);

  for (const problem of problems) {
    warnings.push(`${problem.providerId}: ${problem.reason}`);
  }

  if (servers.length === 0) {
    return { tools: [], connectedSummaries, warnings, baselinesToRecord };
  }

  const knownSecrets = collectKnownSecrets(servers);
  const toolsByConnection = new Map<string, DiscoveredTool[]>();
  const usableServers: typeof servers = [];
  let totalToolCount = 0;

  // Sequential rather than parallel: each discovery is a full MCP handshake, and
  // a user with several connections would otherwise open them all at once against
  // providers that rate-limit per account.
  for (const server of servers) {
    const discovery = await discoverTools(server);

    if (!discovery.ok) {
      warnings.push(
        `${server.displayName}: could not list tools (${discovery.error}).`,
      );
      continue;
    }

    let offered = discovery.tools;

    if (discovery.driftDetected) {
      const withheld = new Set([
        ...discovery.drift.changed,
        ...discovery.drift.added,
      ]);

      offered = offered.filter((tool) => !withheld.has(tool.name));

      warnings.push(
        `${server.displayName}: tool definitions changed since you approved this ` +
          `connection (${describeDrift(discovery.drift)}). ` +
          `${withheld.size} tool(s) withheld until you review the connection again.`,
      );
    } else {
      // Only record a baseline when the current set is trusted. Recording during
      // drift would silently bless the change we just refused.
      baselinesToRecord.push({
        projectConnectionId: server.projectConnectionId,
        toolBaseline: discovery.fingerprints,
      });
    }

    if (discovery.capped) {
      warnings.push(
        `${server.displayName}: offers ${discovery.offeredCount} tools; only the ` +
          `first 40 are available. Narrow the connection's scope or set an allowed ` +
          `tool list to choose which.`,
      );
    }

    if (offered.length === 0) {
      continue;
    }

    // Enforce the project-wide budget. Applied as connections are processed, so
    // earlier ones keep their full allocation rather than every connection being
    // thinned — a partially useful integration beats several crippled ones.
    const remaining = MAX_TOOLS_PER_PROJECT - totalToolCount;

    if (remaining <= 0) {
      warnings.push(
        `${server.displayName}: skipped — this project already exposes ` +
          `${MAX_TOOLS_PER_PROJECT} integration tools, the maximum that fits the ` +
          `model's context. Disable another connection or narrow its scope to make ` +
          `room.`,
      );
      continue;
    }

    if (offered.length > remaining) {
      warnings.push(
        `${server.displayName}: only ${remaining} of ${offered.length} tools ` +
          `included — the project-wide limit of ${MAX_TOOLS_PER_PROJECT} was ` +
          `reached. Narrow this connection's scope to choose which tools matter.`,
      );
      offered = offered.slice(0, remaining);
    }

    totalToolCount += offered.length;

    toolsByConnection.set(server.projectConnectionId, offered);
    usableServers.push(server);

    const posture = server.readOnly ? "read-only" : "read-write";
    connectedSummaries.push(
      `${server.displayName} (${posture}): ${offered
        .map((t) => t.qualifiedName)
        .join(", ")}`,
    );
  }

  const tools = createMcpToolsForAgentKit({
    servers: usableServers,
    toolsByConnection,
    knownSecrets,
    approvalGate,
    audit,
  });

  return { tools, connectedSummaries, warnings, baselinesToRecord };
}

/**
 * System-prompt section describing the connected integrations.
 *
 * The model is told which external services it can reach and, critically, that
 * these act on real infrastructure — unlike the file tools, where a mistake is
 * just an edit. It is also told never to copy a returned secret into a file, since
 * the most likely way a credential leaks into the repo is the model helpfully
 * inlining one it just read.
 */
export function buildIntegrationsPromptSection(
  connectedSummaries: readonly string[],
  warnings: readonly string[],
): string {
  if (connectedSummaries.length === 0 && warnings.length === 0) {
    return "";
  }

  const lines: string[] = ["\n\n## Connected integrations"];

  if (connectedSummaries.length > 0) {
    lines.push(
      "These tools reach real external services on the user's account. Unlike the " +
        "file tools, their effects are outside this project and cannot be undone by " +
        "editing a file. Prefer reading before writing, and tell the user what you " +
        "are about to change.",
      "",
      ...connectedSummaries.map((summary) => `- ${summary}`),
      "",
      "Never copy a credential, connection string or API key returned by these " +
        "tools into a project file. Store it with setEnvVar and reference it via " +
        "process.env instead. Values shown as " +
        "[redacted-by-codenaya] were removed for safety — do not attempt to " +
        "reconstruct or guess them.",
      "",
      "After provisioning something, store its configuration with setEnvVar so the " +
        "preview can connect. Use a NEXT_PUBLIC_ / VITE_ prefix only for values that " +
        "are genuinely safe in a browser bundle (a project URL, an anon key); " +
        "everything else — service-role keys, database URLs, secret API keys — must " +
        "use an unprefixed name so it is encrypted and withheld from the in-browser " +
        "preview.",
    );
  }

  if (warnings.length > 0) {
    lines.push(
      "",
      "Integration issues to be aware of (mention them if relevant):",
      ...warnings.map((warning) => `- ${warning}`),
    );
  }

  return lines.join("\n");
}
