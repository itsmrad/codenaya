/**
 * Convex-backed wiring for the approval gate and audit log.
 *
 * Keeps `approval.ts` free of Convex imports — that module is pure logic driven by
 * an injected transport, which is what makes its fail-closed behaviour testable
 * without a database.
 */

import { convex } from "@/lib/convex-client";

import { api } from "../../../../../convex/_generated/api";
import type { Id } from "../../../../../convex/_generated/dataModel";

import type { McpApprovalGate, McpAuditSink } from "../../adapters/agentkit";
import {
  digestArgs,
  refusalMessage,
  requestApproval,
  type ApprovalTransport,
} from "./approval";

export interface ConvexMcpContext {
  internalKey: string;
  projectId: Id<"projects">;
  ownerId: string;
  /** Links the approval prompt to the chat message that triggered it. */
  messageId?: Id<"messages">;
  /** Secrets to strip from the argument preview shown to the user. */
  knownSecrets?: readonly string[];
}

function createTransport(ctx: ConvexMcpContext): ApprovalTransport {
  return {
    async create(request) {
      const id = await convex.mutation(api.system.createMcpApproval, {
        internalKey: ctx.internalKey,
        projectId: ctx.projectId,
        ownerId: ctx.ownerId,
        messageId: ctx.messageId,
        projectConnectionId:
          request.projectConnectionId as Id<"projectConnections">,
        providerId: request.providerId,
        toolName: request.toolName,
        argsPreview: request.argsPreview,
        expiresAt: request.expiresAt,
      });
      return id;
    },

    async read(approvalId) {
      const row = await convex.query(api.system.getMcpApproval, {
        internalKey: ctx.internalKey,
        approvalId: approvalId as Id<"mcpApprovals">,
      });
      return row ? { status: row.status, expiresAt: row.expiresAt } : null;
    },

    async expire(approvalId) {
      await convex.mutation(api.system.expireMcpApproval, {
        internalKey: ctx.internalKey,
        approvalId: approvalId as Id<"mcpApprovals">,
      });
    },

    async sleep(ms) {
      await new Promise((resolve) => setTimeout(resolve, ms));
    },
  };
}

/**
 * Approval gate that creates a row and waits for the user's answer.
 */
export function createConvexApprovalGate(
  ctx: ConvexMcpContext,
): McpApprovalGate {
  const transport = createTransport(ctx);

  return async ({ server, toolName, args }) => {
    // A connection the user has explicitly marked write-approved still goes
    // through the gate for individual destructive calls. `writeApproved` grants
    // the *connection* permission to attempt writes; it is not blanket consent to
    // every irreversible action the provider offers.
    const decision = await requestApproval({
      transport,
      providerId: server.providerId,
      projectConnectionId: server.projectConnectionId,
      displayName: server.displayName,
      toolName,
      args,
      knownSecrets: ctx.knownSecrets ?? [],
    });

    return {
      approved: decision.approved,
      reason: decision.approved
        ? undefined
        : refusalMessage(server.displayName, toolName, decision.reason ?? "it was not approved"),
    };
  };
}

/**
 * Audit sink writing one row per tool invocation.
 *
 * Arguments are recorded as a digest rather than verbatim, so the log cannot
 * become a secondary store of whatever a call carried.
 */
export function createConvexAuditSink(ctx: ConvexMcpContext): McpAuditSink {
  return async (entry) => {
    await convex.mutation(api.system.recordMcpToolCall, {
      internalKey: ctx.internalKey,
      projectId: ctx.projectId,
      ownerId: ctx.ownerId,
      providerId: entry.providerId,
      toolName: entry.toolName,
      status: entry.status,
      // The adapter does not see raw arguments by the time it audits, so the
      // digest is computed from what it has. Recording the redaction summary
      // alongside is what makes "did a secret pass through here" answerable.
      argsDigest: digestArgs({
        tool: entry.toolName,
        redactions: entry.redactionCount,
        rules: entry.matchedRules,
      }),
      durationMs: entry.durationMs,
      errorMessage: entry.errorMessage,
    });
  };
}
