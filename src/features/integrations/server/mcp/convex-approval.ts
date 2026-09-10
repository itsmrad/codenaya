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
        mcpInvocationId: request.invocationId,
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

  return async ({ server, toolName, args, invocation, runner }) => {
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
      invocationId: invocation.invocationId,
      runner,
    });

    if (!decision.approved) {
      return {
        approved: false,
        approvalId: decision.approvalId,
        reason: refusalMessage(
          server.displayName,
          toolName,
          decision.reason ?? "it was not approved",
        ),
      };
    }

    const approvalId = decision.approvalId;

    return {
      approved: true,
      approvalId,
      /**
       * Single-use claim on this approval.
       *
       * Deliberately *not* wrapped in a step by the caller: it has to be the
       * uncached first act inside the call step, so that a step re-run after a
       * lost checkpoint sees the claim already taken. A memoized claim would
       * always report success and defeat the purpose.
       */
      claim: approvalId
        ? async () => {
            try {
              return await convex.mutation(api.system.claimMcpApproval, {
                internalKey: ctx.internalKey,
                approvalId: approvalId as Id<"mcpApprovals">,
              });
            } catch (error) {
              // Cannot establish whether this call already went out. Refusing is
              // the safe direction for a mutating tool: a false "already applied"
              // costs the user a retry, a false "go ahead" costs them their data.
              console.error("[mcp/approval] claim failed", error);
              return false;
            }
          }
        : undefined,
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
      // Digest of the actual arguments, supplied by the adapter, plus the
      // redaction summary. Recording both is what makes "did a secret pass
      // through here" answerable without storing the payload.
      argsDigest: entry.argsDigest,
      redactionSummary: digestArgs({
        redactions: entry.redactionCount,
        rules: entry.matchedRules,
      }),
      durationMs: entry.durationMs,
      errorMessage: entry.errorMessage,
      // The join key back to the approval row, the step ids and the log lines.
      mcpInvocationId: entry.invocationId,
    });
  };
}
