import { createAgent, createNetwork, type Tool } from '@inngest/agent-kit';

import { inngest } from "@/inngest/client";
import { Id } from "../../../../convex/_generated/dataModel";
import { NonRetriableError } from "inngest";
import { convex } from "@/lib/convex-client";
import { api } from "../../../../convex/_generated/api";
import {
  CODING_AGENT_SYSTEM_PROMPT,
  TITLE_GENERATOR_SYSTEM_PROMPT
} from "./constants";
import { DEFAULT_CONVERSATION_TITLE } from "../constants";
import { createReadFilesTool } from './tools/read-files';
import { createListFilesTool } from './tools/list-files';
import { createUpdateFileTool } from './tools/update-file';
import { createCreateFilesTool } from './tools/create-files';
import { createCreateFolderTool } from './tools/create-folder';
import { createRenameFileTool } from './tools/rename-file';
import { createDeleteFilesTool } from './tools/delete-files';
import { createScrapeUrlsTool } from './tools/scrape-urls';
import { createSetEnvVarTool } from './tools/set-env-var';
import { createLoadSkillTool } from './tools/load-skill';
import { createScaffoldViteAppTool } from './tools/scaffold-vite-app';
import type { AgentModelChoice } from '../agent-models';
import {
  type RunModel,
  ProviderKeyError,
  isProviderKeyRejection,
  keyFailureMessage,
  resolveRunModel,
} from '@/features/ai-providers/server/resolve-run-model';
import {
  type AgentStep,
  buildPathIndex,
  clampStepText,
  describeToolCall,
  toolResultError,
} from '../agent-steps';
import {
  buildIntegrationsPromptSection,
  buildMcpAgentTools,
} from '@/features/integrations/server/mcp/build-agent-tools';
import {
  createConvexApprovalGate,
  createConvexAuditSink,
} from '@/features/integrations/server/mcp/convex-approval';
import {
  oauthConnectionNeedsRefresh,
  refreshExpiredOAuthConnections,
} from '@/features/integrations/server/oauth/refresh-connections';
import {
  resolveForcedSkills,
  resolveSkills,
} from '@/features/skills/server/resolve-skills';
import { buildSkillsPromptSection } from '@/features/skills/server/prompt';
import { parseSlashSkills } from '@/features/skills/parse-slash';
import { IMAGE_ONLY_PROMPT, withImageParts } from './lib/image-prompt';
import {
  type MessageMode,
  PLAN_MODE,
  PLAN_MODE_PROMPT,
  PLAN_MODE_TOOLS,
} from '../plan-mode';

interface MessageEvent {
  messageId: Id<"messages">;
  conversationId: Id<"conversations">;
  projectId: Id<"projects">;
  message: string;
  /**
   * Requested model, on the platform or one of the user's keys. Optional, and a
   * bare platform model id on events sent before BYOK.
   */
  model?: string | AgentModelChoice;
  /** Plan mode (#120): read-only tools, and the reply is a plan. */
  mode?: MessageMode;
};

/**
 * The model's reasoning, which AgentKit drops when it parses the response.
 * OpenRouter (and OpenAI-compatible endpoints) return it as `message.reasoning`;
 * other providers leave it out, so this is empty for them.
 */
const modelReasoning = (raw?: string): string => {
  try {
    const reasoning: unknown = JSON.parse(raw ?? "{}")?.choices?.[0]?.message?.reasoning;
    return typeof reasoning === "string" ? reasoning.trim() : "";
  } catch {
    return "";
  }
};

/** Streamed reply text is buffered and written at most this often / this large. */
const FLUSH_INTERVAL_MS = 100;
const FLUSH_CHARS = 60;

export const processMessage = inngest.createFunction(
  {
    id: "process-message",
    cancelOn: [
      {
        event: "message/cancel",
        if: "event.data.messageId == async.data.messageId",
      },
    ],
    triggers: [{ event: "message/sent" }],
    onFailure: async ({ event, step }) => {
      const { messageId } = event.data.event.data as MessageEvent;
      const internalKey = process.env.CODENAYA_CONVEX_INTERNAL_KEY;

      // Update the message with error content
      if (internalKey) {
        await step.run("update-message-on-failure", async () => {
          await convex.mutation(api.system.updateMessageContent, {
            internalKey,
            messageId,
            content:
              "My apologies, I encountered an error while processing your request. Let me know if you need anything else!",
          });
        });
      }
    }
  },
  async ({ event, step, runId }) => {
    const {
      messageId,
      conversationId,
      projectId,
      message,
      model,
      mode,
    } = event.data as MessageEvent;
    const planMode = mode === PLAN_MODE;

    const internalKey = process.env.CODENAYA_CONVEX_INTERNAL_KEY;

    if (!internalKey) {
      throw new NonRetriableError("CODENAYA_CONVEX_INTERNAL_KEY is not configured");
    }

    // TODO: Check if this is needed
    await step.sleep("wait-for-db-sync", "1s");

    // Get conversation for title generation check
    const conversation = await step.run("get-conversation", async () => {
      return await convex.query(api.system.getConversationById, {
        internalKey,
        conversationId,
      });
    });

    if (!conversation) {
      throw new NonRetriableError("Conversation not found");
    }

    // ─── Model and key ───
    //
    // Resolved in the function body, never in a step: a BYOK model closes over
    // the decrypted key, and Inngest persists step results. A key that cannot be
    // used ends the run with a pointer to settings; there is no fallback to the
    // platform key.
    let runModel: RunModel;
    try {
      runModel = await resolveRunModel({
        internalKey,
        projectId,
        choice: model && typeof model === "object" ? model : { modelId: model ?? "" },
      });
    } catch (error) {
      if (!(error instanceof ProviderKeyError)) {
        throw error;
      }
      await step.run("ai-provider-key-unavailable", async () => {
        await convex.mutation(api.system.updateMessageContent, {
          internalKey,
          messageId,
          content: error.message,
        });
      });
      return { success: false, messageId, conversationId };
    }

    const runKey = runModel.key;
    if (runKey) {
      await step.run("mark-ai-provider-key-used", async () => {
        await convex.mutation(api.system.markAiProviderKeyUsed, {
          internalKey,
          keyId: runKey._id,
        });
      });
    }

    // The provider refusing the user's key (401/402/quota) marks it invalid and
    // ends the run with a clear reply. Anything else fails the run as before.
    const rejectKey = async (key: NonNullable<RunModel["key"]>) => {
      await step.run("ai-provider-key-rejected", async () => {
        await convex.mutation(api.system.updateAiProviderKeyStatus, {
          internalKey,
          keyId: key._id,
          userId: key.userId,
          status: "invalid",
          statusMessage: "The provider rejected this key during an agent run.",
        });
        await convex.mutation(api.system.updateMessageContent, {
          internalKey,
          messageId,
          content: keyFailureMessage(
            `Your ${key.label} key was rejected by the provider.`,
          ),
        });
      });
      return { success: false, messageId, conversationId };
    };

    const endRunOnKeyRejection = async (error: unknown) => {
      if (!runKey || !isProviderKeyRejection(error)) {
        throw error;
      }
      return await rejectKey(runKey);
    };

    const { checkKey } = runModel;
    if (runKey && checkKey) {
      const { rejected } = await step.run("check-ai-provider-key", checkKey);
      if (rejected) {
        return await rejectKey(runKey);
      }
    }

    // Fetch recent messages for conversation context
    const recentMessages = await step.run("get-recent-messages", async () => {
      return await convex.query(api.system.getRecentMessages, {
        internalKey,
        conversationId,
        limit: 10,
      });
    });

    // Images on the user message this run answers: the last one before it.
    const imageUrls =
      recentMessages
        .slice(0, recentMessages.findIndex((msg) => msg._id === messageId))
        .findLast((msg) => msg.role === "user")?.imageUrls ?? [];
    // A message can be images alone; the agents still need a request to answer.
    const request =
      imageUrls.length > 0 && !message.trim() ? IMAGE_ONLY_PROMPT : message;

    // Build system prompt with conversation history (exclude the current processing message)
    let systemPrompt = CODING_AGENT_SYSTEM_PROMPT;

    // Filter out the current processing message and empty messages
    const contextMessages = recentMessages.filter(
      (msg) => msg._id !== messageId && msg.content.trim() !== ""
    );

    if (contextMessages.length > 0) {
      const historyText = contextMessages
        .map((msg) => `${msg.role.toUpperCase()}: ${msg.content}`)
        .join("\n\n");

      systemPrompt += `\n\n## Previous Conversation (for context only - do NOT repeat these responses):\n${historyText}\n\n## Current Request:\nRespond ONLY to the user's new message below. Do not repeat or reference your previous responses.`;
    }

    // Generate conversation title if it's still the default
    const shouldGenerateTitle =
      conversation.title === DEFAULT_CONVERSATION_TITLE;

    if (shouldGenerateTitle) {
      const titleAgent = createAgent({
        name: "title-generator",
        system: TITLE_GENERATOR_SYSTEM_PROMPT,
        model: runModel.title(0),
      });

      let output;
      try {
        ({ output } = await titleAgent.run(request, { step }));
      } catch (error) {
        return await endRunOnKeyRejection(error);
      }

      const textMessage = output.find(
        (m) => m.type === "text" && m.role === "assistant"
      );

      if (textMessage?.type === "text") {
        const title =
          typeof textMessage.content === "string"
            ? textMessage.content.trim()
            : textMessage.content
              .map((c) => c.text)
              .join("")
              .trim();

        if (title) {
          await step.run("update-conversation-title", async () => {
            await convex.mutation(api.system.updateConversationTitle, {
              internalKey,
              conversationId,
              title,
            });
          });
        }
      }
    }

    // ─── MCP integrations ───
    //
    // Resolved before the agent is created so discovered tools can be handed to it
    // and the connected services described in the system prompt.
    //
    // Deliberately *not* wrapped in a step. AgentKit tools are closures holding
    // live credentials, so they cannot be serialised as a step result — they have
    // to be built in the function body regardless. Wrapping only the discovery
    // would mean doing every MCP handshake twice: once inside the step for the
    // cached summary, once outside to rebuild the closures. Discovery is read-only
    // and idempotent, so re-running it on a retry is harmless; the individual tool
    // *calls* are what need step isolation, and the adapter wraps each of those.
    //
    // Non-fatal by design. A project with a broken integration still gets a working
    // agent run with its file tools intact — the alternative is that one expired
    // token makes the product unusable.
    let mcpTools: Tool.Any[] = [];
    let mcpSummaries: string[] = [];
    let mcpWarnings: string[] = [];
    let mcpBaselines: Array<{
      projectConnectionId: string;
      toolBaseline: Array<{ name: string; digest: string }>;
    }> = [];
    // Project owner, needed by setEnvVar and the approval gate. Resolved from the
    // project row so those act on behalf of whoever owns the work.
    let mcpOwnerId: string | undefined;

    try {
      // Fetched unconditionally: the owner is needed by setEnvVar, which is useful
      // whether or not this project has any MCP connections.
      const project = await convex.query(api.system.getProjectById, {
        internalKey,
        projectId,
      });
      mcpOwnerId = project?.ownerId;

      let entries = await convex.query(api.system.getProjectMcpConnections, {
        internalKey,
        projectId,
      });

      const hasExpiringOAuthConnection = entries.some(
        ({ connection }) => oauthConnectionNeedsRefresh(connection),
      );

      if (hasExpiringOAuthConnection) {
        const refreshReport = await step.run(
          "refresh-expired-oauth-connections",
          async () => {
            // Re-read inside the durable step. Another run may have refreshed the
            // connection after the outer query, and the Convex lease below makes
            // refresh-token rotation single-writer across workers.
            const freshEntries = await convex.query(
              api.system.getProjectMcpConnections,
              { internalKey, projectId },
            );

            return await refreshExpiredOAuthConnections(
              freshEntries.map(({ connection }) => connection),
              {
                claim: async (args) =>
                  await convex.mutation(
                    api.system.claimUserConnectionRefresh,
                    {
                      internalKey,
                      connectionId: args.connectionId as Id<"userConnections">,
                      leaseId: args.leaseId,
                      refreshSkewMs: args.refreshSkewMs,
                      leaseDurationMs: args.leaseDurationMs,
                    },
                  ),
                complete: async (args) =>
                  await convex.mutation(
                    api.system.completeUserConnectionRefresh,
                    {
                      internalKey,
                      connectionId: args.connectionId as Id<"userConnections">,
                      leaseId: args.leaseId,
                      maskedPreview: args.maskedPreview,
                      scopes: args.scopes,
                      tokenExpiresAt: args.tokenExpiresAt,
                      ...args.sealed,
                    },
                  ),
                fail: async (args) =>
                  await convex.mutation(api.system.failUserConnectionRefresh, {
                    internalKey,
                    connectionId: args.connectionId as Id<"userConnections">,
                    leaseId: args.leaseId,
                    reauthRequired: args.reauthRequired,
                  }),
              },
            );
          },
        );

        mcpWarnings.push(...refreshReport.warnings);

        // Never hand the stale access token from the first query to discovery.
        // A failed terminal refresh is now needs_reauth and is excluded here.
        entries = await convex.query(api.system.getProjectMcpConnections, {
          internalKey,
          projectId,
        });

        // A transient refresh failure deliberately keeps the connection active
        // so a later run can retry. It must still be excluded from this run:
        // handing discovery the known-expired token would only produce another
        // Unauthorized request and could incorrectly turn a temporary outage
        // into a permanent needs_reauth state.
        entries = entries.filter(
          ({ connection }) => !oauthConnectionNeedsRefresh(connection),
        );
      }

      if (entries.length > 0) {
        const mcpContext = mcpOwnerId
          ? {
              internalKey,
              projectId,
              ownerId: mcpOwnerId,
              messageId,
            }
          : undefined;

        const built = await buildMcpAgentTools({
          entries,
          // Without a resolvable owner there is nobody to ask, so no gate is
          // passed and destructive tools refuse rather than run unreviewed.
          approvalGate: mcpContext
            ? createConvexApprovalGate(mcpContext)
            : undefined,
          audit: mcpContext ? createConvexAuditSink(mcpContext) : undefined,
          // Correlates the `[mcp]` log lines with this Inngest run.
          runId,
        });

        mcpTools = built.tools;
        mcpSummaries = built.connectedSummaries;
        mcpWarnings.push(...built.warnings);
        mcpBaselines = built.baselinesToRecord;

        if (built.reauthConnectionIds.length > 0) {
          await step.run("mark-rejected-oauth-connections", async () => {
            for (const connectionId of built.reauthConnectionIds) {
              await convex.mutation(api.system.updateUserConnectionStatus, {
                internalKey,
                connectionId: connectionId as Id<"userConnections">,
                status: "needs_reauth",
                statusMessage:
                  "The provider rejected this OAuth authorization. Reconnect the integration.",
              });
            }
          });
        }
      }
    } catch (error) {
      console.error("[process-message] MCP resolution failed", error);
      mcpWarnings = ["Integrations could not be loaded for this run."];
    }

    // Persist newly-trusted baselines so the next run can detect drift. In a step
    // because it is a write with side effects, unlike discovery.
    if (mcpBaselines.length > 0) {
      await step.run("record-mcp-tool-baselines", async () => {
        for (const baseline of mcpBaselines) {
          await convex.mutation(api.system.setProjectConnectionToolBaseline, {
            internalKey,
            projectConnectionId:
              baseline.projectConnectionId as Id<"projectConnections">,
            toolBaseline: baseline.toolBaseline,
          });
        }
      });
    }

    systemPrompt += buildIntegrationsPromptSection(mcpSummaries, mcpWarnings);

    // ─── Skills ───
    //
    // Only names and descriptions go in the prompt; loadSkill hands the agent a
    // body from this step's result, with no further Convex call. Bodies are not
    // secret, so persisting them is fine. Non-fatal, like MCP: a run without
    // skills still works. Skills the message forces with leading `/name`
    // tokens go in up-front with their bodies; the message is left as sent.
    const { skills, forced, unavailable } = await step.run("resolve-skills", async () => {
      try {
        const projectSkills = await convex.query(api.system.getProjectSkills, {
          internalKey,
          projectId,
        });
        return {
          skills: resolveSkills(projectSkills),
          ...resolveForcedSkills(projectSkills, parseSlashSkills(message)),
        };
      } catch (error) {
        console.error("[process-message] skills resolution failed", error);
        return { skills: [], forced: [], unavailable: [] };
      }
    });

    systemPrompt += buildSkillsPromptSection(skills, forced, unavailable);

    if (planMode) {
      systemPrompt += PLAN_MODE_PROMPT;
    }

    // Display only: mirrors the agent's tool calls onto the assistant message
    // for the chat panel's activity block. Each write is its own step, so replays
    // reuse the recorded result instead of writing again, and it never throws:
    // a failed write must not fail the agent run.
    const recordSteps = (
      id: string,
      build: (pathOf: (fileId: string) => string | undefined) => AgentStep[],
      withPaths: boolean,
    ) =>
      step.run(id, async () => {
        try {
          const pathOf = withPaths
            ? buildPathIndex(
                await convex.query(api.system.getProjectFiles, {
                  internalKey,
                  projectId,
                }),
              )
            : () => undefined;
          await convex.mutation(api.system.upsertMessageSteps, {
            internalKey,
            messageId,
            steps: build(pathOf),
          });
        } catch (error) {
          console.error("[agent-steps] failed to record steps", error);
        }
      });

    // Forced skills show in the run block as used, like a loadSkill call.
    if (forced.length > 0) {
      await recordSteps(
        "record-forced-skills",
        () =>
          forced.map(({ name }) => ({
            id: `forced-skill:${name}`,
            kind: "tool",
            tool: "loadSkill",
            targets: [name],
            status: "done",
            startedAt: Date.now(),
            endedAt: Date.now(),
          })),
        false,
      );
    }

    // Checkpoint (#43): the files as they are before the agent touches them,
    // so the run can be restored from the chat. Best effort: a failed snapshot
    // must not fail the run. A plan-mode run changes nothing to restore.
    if (!planMode) {
      await step.run("create-checkpoint", async () => {
        try {
          await convex.mutation(api.system.createProjectCheckpoint, {
            internalKey,
            projectId,
            messageId,
            label: message,
          });
        } catch (error) {
          console.error("[checkpoints] failed to snapshot project", error);
        }
      });
    }

    const tools: Tool.Any[] = [
      createListFilesTool({ internalKey, projectId }),
      createReadFilesTool({ projectId, internalKey }),
      createUpdateFileTool({ projectId, internalKey }),
      createCreateFilesTool({ projectId, internalKey }),
      createCreateFolderTool({ projectId, internalKey }),
      createScaffoldViteAppTool({ projectId, internalKey }),
      createRenameFileTool({ projectId, internalKey }),
      createDeleteFilesTool({ projectId, internalKey }),
      createScrapeUrlsTool(),
      ...(mcpOwnerId
        ? [createSetEnvVarTool({ projectId, ownerId: mcpOwnerId, internalKey })]
        : []),
      ...(skills.length > 0 ? [createLoadSkillTool({ skills })] : []),
      ...mcpTools,
    ];

    // Reply streaming: text deltas are buffered and appended to the message so
    // the chat shows the answer as it arrives. `seq` restarts on every Inngest
    // replay, so replayed chunks carry already-applied numbers and are ignored.
    let suppressText = false;
    let pending = "";
    let seq = 0;
    let lastFlush = Date.now();

    const flush = async () => {
      if (!pending) {
        return;
      }
      const delta = pending;
      pending = "";
      lastFlush = Date.now();
      try {
        await convex.mutation(api.system.appendMessageChunk, {
          internalKey,
          messageId,
          delta,
          seq: seq++,
        });
      } catch {
        // A dropped chunk must not abort the run: the full reply is written
        // once the agent finishes.
      }
    };

    // Create the coding agent with file tools
    const codingAgent = createAgent({
      name: "codenaya",
      description: "An expert AI coding assistant",
      system: systemPrompt,
      // Re-validated by resolveRunModel: the event is the boundary this function
      // trusts, and anything holding the event key can send one.
      model: runModel.coding(0.3),
      // Plan mode is enforced here, not just asked for in the prompt.
      tools: planMode
        ? tools.filter((tool) => PLAN_MODE_TOOLS.has(tool.name))
        : tools,
      lifecycle: {
        onStart: ({ prompt, history }) => ({
          prompt: withImageParts(prompt, imageUrls),
          history: history ?? [],
          stop: false,
        }),
        onResponse: async ({ result }) => {
          const calls = result.output.flatMap((m) =>
            m.type === "tool_call" ? m.tools : [],
          );
          // Text sent with tool calls is narration, not the answer: it goes
          // in the thinking step, not the streamed reply. Streaming for this
          // inference runs after onResponse, so the flag covers its deltas.
          suppressText = calls.length > 0;
          const reasoning = modelReasoning(result.raw);
          if (calls.length === 0) {
            if (reasoning) {
              await recordSteps("record-final-thinking", () => [{
                id: "thinking-final",
                kind: "thinking" as const,
                text: clampStepText(reasoning),
                status: "done" as const,
                startedAt: Date.now(),
              }], false);
            }
            return result;
          }
          const thought = clampStepText(
            [
              reasoning,
              ...result.output.map((m) =>
                m.type === "text" && m.role === "assistant"
                  ? typeof m.content === "string"
                    ? m.content
                    : m.content.map((c) => c.text).join("")
                  : "",
              ),
            ]
              .filter(Boolean)
              .join("\n\n"),
          );
          await recordSteps("record-agent-steps", (pathOf) => {
            const startedAt = Date.now();
            return [
              ...(thought
                ? [{
                    id: `thinking-${calls[0].id}`,
                    kind: "thinking" as const,
                    text: thought,
                    status: "done" as const,
                    startedAt,
                  }]
                : []),
              ...calls.map((call) => ({
                id: call.id,
                kind: "tool" as const,
                tool: call.name,
                targets: describeToolCall(call, pathOf),
                status: "running" as const,
                startedAt,
              })),
            ];
          }, true);
          return result;
        },
        onFinish: async ({ result }) => {
          if (result.toolCalls.length === 0) {
            return result;
          }
          // Targets are left out so the merge keeps the ones recorded before
          // the call ran (a renamed or deleted file no longer resolves).
          await recordSteps("finish-agent-steps", () => {
            const endedAt = Date.now();
            return result.toolCalls.map(({ tool, content }) => {
              const error = toolResultError(content);
              return {
                id: tool.id,
                kind: "tool" as const,
                tool: tool.name,
                status: error ? ("error" as const) : ("done" as const),
                ...(error ? { error } : {}),
                startedAt: endedAt,
                endedAt,
              };
            });
          }, false);
          return result;
        },
      },
    });

    // Create network with single agent
    const network = createNetwork({
      name: "codenaya-network",
      agents: [codingAgent],
      maxIter: 20,
      router: ({ network }) => {
        const lastResult = network.state.results.at(-1);
        const hasTextResponse = lastResult?.output.some(
          (m) => m.type === "text" && m.role === "assistant"
        );
        const hasToolCalls = lastResult?.output.some(
          (m) => m.type === "tool_call"
        );

        // Stop routing to this agent if there's a final text response without tool calls
        if (hasTextResponse && !hasToolCalls) {
          return undefined;
        }
        return codingAgent;
      }
    });

    // Run the agent
    let result;
    try {
      result = await network.run(request, {
        streaming: {
          simulateChunking: true,
          publish: async (chunk) => {
            if (chunk.event !== "text.delta" || suppressText) {
              return;
            }
            pending += (chunk.data as { delta?: string } | undefined)?.delta ?? "";
            if (pending.length >= FLUSH_CHARS || Date.now() - lastFlush >= FLUSH_INTERVAL_MS) {
              await flush();
            }
          },
        },
      });
      await flush();
    } catch (error) {
      return await endRunOnKeyRejection(error);
    }

    // Extract the assistant's text response from the last agent result
    const lastResult = result.state.results.at(-1);
    const textMessage = lastResult?.output.find(
      (m) => m.type === "text" && m.role === "assistant"
    );

    let assistantResponse =
      "I processed your request. Let me know if you need anything else!";

    if (textMessage?.type === "text") {
      assistantResponse =
        typeof textMessage.content === "string"
          ? textMessage.content
          : textMessage.content.map((c) => c.text).join("");
    }

    // Update the assistant message with the response (this also sets status to completed)
    await step.run("update-assistant-message", async () => {
      await convex.mutation(api.system.updateMessageContent, {
        internalKey,
        messageId,
        content: assistantResponse,
      })
    });

    return { success: true, messageId, conversationId };
  }
);
