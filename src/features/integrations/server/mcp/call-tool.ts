/**
 * Invoke a single MCP tool on behalf of the agent.
 *
 * Every call opens a connection, calls, and closes. That is deliberately
 * stateless: agent turns are durable steps that can be retried or replayed, and a
 * client held across a step boundary would not survive. It costs a handshake per
 * call, which is a fair price for a tool path that behaves identically on a retry.
 *
 * ## The invariant this module owns
 *
 * **Nothing returned from a remote server reaches the model un-redacted.** Every
 * exit path — success, tool error, transport failure — goes through
 * `redactJsonValue` first. A single early `return` that skips it would put a
 * credential into the conversation permanently, so the redaction happens once, at
 * the boundary, rather than at each call site.
 */

import { redactJsonValue } from "./redact";
import { openMcpClient } from "./discover-tools";
import type { ResolvedMcpServer } from "./resolve-servers";

const CALL_TIMEOUT_MS = 60_000;

/**
 * Cap on the text handed back to the model.
 *
 * A tool can return an entire table. Without a ceiling one call could consume the
 * whole context window and evict the conversation. Truncation is announced so the
 * model knows to narrow its query rather than assuming it saw everything.
 */
const MAX_RESULT_CHARS = 24_000;

export interface CallToolOutcome {
  /** Text handed to the model. Always redacted. */
  text: string;
  /** False when the tool or transport reported failure. */
  ok: boolean;
  /** How many secret spans were removed, for the audit log. */
  redactionCount: number;
  /** Which redaction rules fired. Never contains values. */
  matchedRules: string[];
  truncated: boolean;
  durationMs: number;
}

function truncate(text: string): { text: string; truncated: boolean } {
  if (text.length <= MAX_RESULT_CHARS) {
    return { text, truncated: false };
  }
  return {
    text:
      text.slice(0, MAX_RESULT_CHARS) +
      `\n\n[Output truncated at ${MAX_RESULT_CHARS} characters. ` +
      `Narrow the request — for example add a limit or select fewer columns — ` +
      `to see the rest.]`,
    truncated: true,
  };
}

/**
 * Flatten an MCP tool result into text for the model.
 *
 * MCP returns an array of content blocks. Text blocks are concatenated; other
 * kinds are summarised by type rather than dumped, because a base64 image blob
 * would consume the context window to no benefit.
 */
function flattenContent(content: unknown): string {
  if (!Array.isArray(content)) {
    return typeof content === "string" ? content : JSON.stringify(content);
  }

  const parts: string[] = [];
  for (const block of content) {
    if (block && typeof block === "object" && "type" in block) {
      const typed = block as { type: string; text?: unknown };
      if (typed.type === "text" && typeof typed.text === "string") {
        parts.push(typed.text);
        continue;
      }
      parts.push(`[${typed.type} content omitted]`);
      continue;
    }
    parts.push(typeof block === "string" ? block : JSON.stringify(block));
  }

  return parts.join("\n");
}

export interface CallMcpToolOptions {
  server: ResolvedMcpServer;
  /** Unqualified tool name as the server knows it. */
  toolName: string;
  args: Record<string, unknown>;
  /** Secret values to strip from the result, from `collectKnownSecrets`. */
  knownSecrets: readonly string[];
  timeoutMs?: number;
}

/**
 * Call a tool and return redacted text.
 *
 * Never throws. A thrown error inside an agent tool tends to make the model give
 * up and report that the integration is broken, whereas a readable error string is
 * treated as a recoverable result it can react to — the same convention the
 * existing file tools use.
 */
export async function callMcpTool(
  options: CallMcpToolOptions,
): Promise<CallToolOutcome> {
  const {
    server,
    toolName,
    args,
    knownSecrets,
    timeoutMs = CALL_TIMEOUT_MS,
  } = options;

  const startedAt = Date.now();

  /** Single exit point, so no path can skip redaction. */
  const finish = (value: unknown, ok: boolean): CallToolOutcome => {
    const redacted = redactJsonValue(value, knownSecrets);
    const asText =
      typeof redacted.value === "string"
        ? redacted.value
        : JSON.stringify(redacted.value);
    const { text, truncated } = truncate(asText);

    return {
      text,
      ok,
      redactionCount: redacted.redactionCount,
      matchedRules: redacted.matchedRules,
      truncated,
      durationMs: Date.now() - startedAt,
    };
  };

  const opened = await openMcpClient(server, timeoutMs);
  if ("error" in opened) {
    return finish(
      `Error: could not reach ${server.displayName} (${opened.error}). ` +
        `This may be temporary — you can retry this tool on a later turn.`,
      false,
    );
  }

  const { client } = opened;

  try {
    const result = await client.callTool(
      { name: toolName, arguments: args },
      undefined,
      { timeout: timeoutMs },
    );

    const text = flattenContent(result.content);

    // MCP signals tool-level failure with isError rather than a transport error.
    // Surfaced as text so the model can adjust its arguments and try again.
    if (result.isError) {
      return finish(
        `Error from ${server.displayName} tool "${toolName}": ${text}`,
        false,
      );
    }

    // structuredContent is preferred when present — it is the machine-readable
    // form and avoids re-parsing prose.
    if (result.structuredContent !== undefined) {
      return finish(result.structuredContent, true);
    }

    return finish(text.length > 0 ? text : "(the tool returned no output)", true);
  } catch (error) {
    return finish(
      `Error: ${server.displayName} tool "${toolName}" failed ` +
        `(${error instanceof Error ? error.message : String(error)}). ` +
        `You may retry this tool on a later turn.`,
      false,
    );
  } finally {
    try {
      await client.close();
    } catch {
      // Nothing to release.
    }
  }
}
