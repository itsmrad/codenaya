import { createAgent, createNetwork, type Tool } from '@inngest/agent-kit';

import { inngest } from "@/inngest/client";
import { Id } from "../../../../convex/_generated/dataModel";
import { NonRetriableError } from "inngest";
import { convex } from "@/lib/convex-client";
import { api } from "../../../../convex/_generated/api";
import {
  CODING_AGENT_SYSTEM_PROMPT,
  MAX_AGENT_STEPS,
  STARTER_IN_PLACE_NOTE,
  STEP_BUDGET_NOTE,
} from "./constants";
import { DEFAULT_CONVERSATION_TITLE } from "../constants";
import { createSearchFilesTool } from './tools/search-files';
import { createReadFilesTool } from './tools/read-files';
import { createListFilesTool } from './tools/list-files';
import { createUpdateFileTool } from './tools/update-file';
import { createEditFileTool } from './tools/edit-file';
import { createCreateFilesTool } from './tools/create-files';
import { createCreateFolderTool } from './tools/create-folder';
import { createRenameFileTool } from './tools/rename-file';
import { createDeleteFilesTool } from './tools/delete-files';
import { createWriteFilesTool } from './tools/write-files';
import { buildProjectTreePromptSection, getProjectFiles } from './tools/paths';
import { createScrapeUrlsTool } from './tools/scrape-urls';
import { createSetEnvVarTool } from './tools/set-env-var';
import { createLoadSkillTool } from './tools/load-skill';
import { createScaffoldViteAppTool } from './tools/scaffold-vite-app';
import { createCheckBuildTool } from './tools/check-build';
import { createBuildCheckGate, wroteFiles } from './build-check-gate';
import type { AgentModelChoice } from '../agent-models';
import {
  type RunModel,
  ProviderKeyError,
  isProviderKeyRejection,
  keyFailureMessage,
  resolveRunModel,
} from '@/features/ai-providers/server/resolve-run-model';
import { withoutToolCalls } from '@/features/ai-providers/server/agentkit-model';
import type { ModelPricing } from '@/features/ai-providers/catalog';
import { costUsd, usageOfResponse } from '@/features/billing/credits';
import {
  type AgentStep,
  buildCheckLabel,
  buildPathIndex,
  clampStepText,
  describeToolCall,
  sanitizeAgentText,
  toolResultError,
  toolResultRecipeIds,
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
import { isStarterOnly } from './starter-only';
import { generateConversationTitle } from './generate-title';
import { parseSlashSkills } from '@/features/skills/parse-slash';
import { IMAGE_ONLY_PROMPT, withImageParts } from './lib/image-prompt';
import { trimFileHistory } from "./lib/trim-file-history";
import { AGENT_FAILURE_MESSAGE, DEFAULT_REPLY_MESSAGE, priorTurns } from './lib/conversation-history';
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
  /** Project owner. Optional only on events sent before #242. */
  ownerId?: string;
  message: string;
  /**
   * Requested model, on the platform or one of the user's keys. Optional, and a
   * bare platform model id on events sent before BYOK.
   */
  model?: string | AgentModelChoice;
  /** Plan mode (#120): read-only tools, and the reply is a plan. */
  mode?: MessageMode;
};

/** The agent that runs the last step, with tools off. */
const SUMMARY_AGENT_NAME = "codenaya-summary";

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

export const processMessage = inngest.createFunction(
  {
    id: "process-message",
    // At most two agent runs per user at once; more wait in the queue (#242).
    // One per project already holds: a new message cancels the running one.
    concurrency: [{ key: "event.data.ownerId", limit: 2 }],
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
            content: AGENT_FAILURE_MESSAGE,
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

    // ─── Usage (ADR 0011) ───
    //
    // Running totals, rebuilt from the memoized inferences on every replay, so
    // each record step sends the run's total so far: a retried step changes
    // nothing, and one that failed is caught up by the next (or the final one).
    const usage = { inputTokens: 0, outputTokens: 0, costUsd: 0 };
    let usageRecords = 0;
    const sendUsage = (id: string) => {
      const totals = { ...usage };
      return step.run(id, async () => {
        try {
          await convex.mutation(api.credits.recordRunUsage, {
            internalKey,
            messageId,
            source: runModel.metering.source,
            ...totals,
          });
        } catch (error) {
          console.error("[credits] failed to record run usage", error);
        }
      });
    };
    const recordUsage = async (
      raw: string | undefined,
      pricing: ModelPricing | undefined,
      // The title runs alongside the coding agent, so it gets a fixed id.
      id = `record-usage-${++usageRecords}`,
    ) => {
      const tokens = usageOfResponse(raw);
      usage.inputTokens += tokens.inputTokens;
      usage.outputTokens += tokens.outputTokens;
      usage.costUsd += pricing ? costUsd(pricing, tokens) : 0;
      await sendUsage(id);
    };

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

    // Earlier turns go to the model as chat messages, never in the system prompt.
    const earlierTurns = priorTurns(recentMessages, messageId);

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
                      projectId,
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
                      projectId,
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
                    projectId,
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
                projectId,
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

    // The project's paths at run start (#292), so the agent addresses files by
    // path without a listFiles call. Non-fatal: listFiles still works.
    const projectTree = await step.run("get-project-tree", async () => {
      try {
        return buildProjectTreePromptSection(await getProjectFiles(internalKey, projectId));
      } catch (error) {
        console.error("[process-message] project tree failed", error);
        return "";
      }
    });

    // Most stable first, so the cacheable prefix is shared across runs (#295):
    // base, skill index and integrations, then the project tree, forced
    // skills and plan mode.
    // Conversation goes in messages (see onStart).
    const systemPrompt = [
      CODING_AGENT_SYSTEM_PROMPT,
      buildSkillsPromptSection(skills),
      buildIntegrationsPromptSection(mcpSummaries, mcpWarnings),
      projectTree,
      buildSkillsPromptSection([], forced, unavailable),
      planMode ? PLAN_MODE_PROMPT : "",
    ].join("");

    // A project seeded with the starter says so in the request, not the
    // system prompt, so the first turn builds on it (#338).
    const starterOnly = await step.run("check-starter-only", async () =>
      isStarterOnly(
        await convex.query(api.system.getProjectFiles, { internalKey, projectId }),
      ),
    );


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
      createSearchFilesTool({ projectId, internalKey }),
      createWriteFilesTool({ projectId, internalKey }),
      createUpdateFileTool({ projectId, internalKey }),
      createEditFileTool({ projectId, internalKey }),
      createCreateFilesTool({ projectId, internalKey }),
      createCreateFolderTool({ projectId, internalKey }),
      createScaffoldViteAppTool({ projectId, internalKey }),
      createRenameFileTool({ projectId, internalKey }),
      createDeleteFilesTool({ projectId, internalKey }),
      createCheckBuildTool({ projectId, internalKey }),
      createScrapeUrlsTool(),
      ...(mcpOwnerId
        ? [createSetEnvVarTool({ projectId, ownerId: mcpOwnerId, internalKey })]
        : []),
      ...(skills.length > 0 ? [createLoadSkillTool({ skills })] : []),
      ...mcpTools,
    ];

    // Plan-mode runs write nothing, so the gate never fires for them.
    const buildCheckGate = createBuildCheckGate();

    // Re-validated by resolveRunModel: the event is the boundary this function
    // trusts, and anything holding the event key can send one.
    const codingModel = runModel.coding(0.3);

    // Create the coding agent with file tools
    const agentOptions: Parameters<typeof createAgent>[0] = {
      name: "codenaya",
      description: "An expert AI coding assistant",
      system: systemPrompt,
      model: codingModel,
      // Plan mode is enforced here, not just asked for in the prompt.
      tools: planMode
        ? tools.filter((tool) => PLAN_MODE_TOOLS.has(tool.name))
        : tools,
      lifecycle: {
        onStart: ({ agent, prompt, history }) => {
          const trimmed = trimFileHistory([...earlierTurns, ...(history ?? [])]);
          const nudge =
            agent.name === SUMMARY_AGENT_NAME ? STEP_BUDGET_NOTE : buildCheckGate.takeNudge();
          // AgentKit sends prompt ([system, request]) before history (this
          // run's turns), so earlier conversation turns go between the two.
          // Relies on network calls using maxIter: 0; direct agent.run with maxIter > 1 would prepend history each pass.
          const [system, ...current] = withImageParts(prompt, imageUrls);
          return {
            prompt: [system, ...trimmed.slice(0, earlierTurns.length), ...current],
            history: [
              ...trimmed.slice(earlierTurns.length),
              ...(nudge ? [{ type: "text" as const, role: "user" as const, content: nudge }] : []),
            ],
            stop: false,
          };
        },
        onResponse: async ({ agent, result, network }) => {
          await recordUsage(result.raw, runModel.metering.coding);
          // The last step must not write without a build check left to run;
          // this holds when a provider ignores tool_choice "none".
          if (agent.name === SUMMARY_AGENT_NAME) {
            result.output = result.output.filter((m) => m.type !== "tool_call");
          }
          const calls = result.output.flatMap((m) =>
            m.type === "tool_call" ? m.tools : [],
          );
          // Raw reasoning can echo tool markup, model tokens and document ids.
          const reasoning = sanitizeAgentText(modelReasoning(result.raw));
          if (calls.length === 0) {
            if (reasoning) {
              // A run routed back by the build-check gate has two final turns.
              const turn = network?.state.results.length ?? 0;
              await recordSteps("record-final-thinking", () => [{
                id: `thinking-final-${turn}`,
                kind: "thinking" as const,
                text: clampStepText(reasoning),
                status: "done" as const,
                startedAt: Date.now(),
              }], false);
            }
            return result;
          }
          // Narration first: it is one line, and must survive the clamp when
          // the reasoning is long.
          const thought = clampStepText(
            [
              ...result.output.map((m) =>
                m.type === "text" && m.role === "assistant"
                  ? typeof m.content === "string"
                    ? m.content
                    : m.content.map((c) => c.text).join("")
                  : "",
              ),
              reasoning,
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
          // the call ran (a renamed or deleted file no longer resolves). Ids in
          // error messages resolve to paths where the file still exists (#219);
          // the path index is only read when a call failed.
          await recordSteps("finish-agent-steps", (pathOf) => {
            const endedAt = Date.now();
            return result.toolCalls.map(({ tool, content }) => {
              const error = toolResultError(content, pathOf);
              const label = !error && tool.name === "checkBuild" ? buildCheckLabel(content) : undefined;
              const recipeIds = toolResultRecipeIds(content);
              return {
                id: tool.id,
                kind: "tool" as const,
                tool: tool.name,
                status: error ? ("error" as const) : ("done" as const),
                ...(error ? { error } : {}),
                ...(label ? { text: label } : {}),
                ...(recipeIds.length > 0 ? { recipeIds } : {}),
                startedAt: endedAt,
                endedAt,
              };
            });
          }, result.toolCalls.some(({ content }) => toolResultError(content) !== undefined));
          return result;
        },
      },
    };
    const codingAgent = createAgent(agentOptions);
    // The run's last step: the same agent with tools off, so it ends with a summary.
    const summaryAgent = createAgent({
      ...agentOptions,
      name: SUMMARY_AGENT_NAME,
      model: withoutToolCalls(codingModel),
    });

    const network = createNetwork({
      name: "codenaya-network",
      agents: [codingAgent, summaryAgent],
      maxIter: MAX_AGENT_STEPS,
      router: ({ network, callCount }) => {
        const { results } = network.state;
        const lastResult = results.at(-1);
        const hasTextResponse = lastResult?.output.some(
          (m) => m.type === "text" && m.role === "assistant"
        );
        const hasToolCalls = lastResult?.output.some(
          (m) => m.type === "tool_call"
        );

        // callCount, not results: seeded history would count as steps.
        const lastStep = callCount >= MAX_AGENT_STEPS - 1;

        // Stop routing to this agent if there's a final text response without
        // tool calls, unless files changed since the last passing build check
        // and there are steps left for it.
        if (hasTextResponse && !hasToolCalls) {
          return !lastStep && buildCheckGate.shouldContinue(results)
            ? codingAgent
            : undefined;
        }
        return lastStep ? summaryAgent : codingAgent;
      }
    });

    // The title runs alongside the coding agent, never before it (#338).
    // Started here: earlier, Inngest would plan every step in between as a
    // parallel step, one extra round trip each. It never throws.
    let titleUsageRecorded = false;
    const titleDone =
      conversation.title === DEFAULT_CONVERSATION_TITLE
        ? generateConversationTitle({
            step,
            runModel,
            request,
            recordUsage: (raw) => {
              titleUsageRecorded = true;
              return recordUsage(raw, runModel.metering.title, "record-usage-title");
            },
            internalKey,
            conversationId,
          })
        : undefined;
    // Every way out of the run waits for the title and flushes usage once: a
    // failed last record has no later one to catch it up. A cancelled run
    // stops between steps; its per-inference records are its flush.
    const settleRun = async (id: string) => {
      await titleDone;
      if (usageRecords > 0 || titleUsageRecorded) {
        await sendUsage(id);
      }
    };

    // Run the agent
    let result;
    try {
      result = await network.run(
        starterOnly ? `${request}\n\n${STARTER_IN_PLACE_NOTE}` : request,
      );
    } catch (error) {
      await settleRun("record-usage-on-error");
      return await endRunOnKeyRejection(error);
    }

    // Extract the assistant's text response from the last agent result
    const lastResult = result.state.results.at(-1);
    const textMessage = lastResult?.output.find(
      (m) => m.type === "text" && m.role === "assistant"
    );

    let assistantResponse = DEFAULT_REPLY_MESSAGE;

    if (textMessage?.type === "text") {
      assistantResponse =
        typeof textMessage.content === "string"
          ? textMessage.content
          : textMessage.content.map((c) => c.text).join("");
    }

    await settleRun("record-usage-final");

    // Update the assistant message with the response (this also sets status to completed)
    await step.run("update-assistant-message", async () => {
      await convex.mutation(api.system.updateMessageContent, {
        internalKey,
        messageId,
        content: assistantResponse,
      })
    });

    // The first run that wrote files ends a seeded project's first build (#338).
    if (wroteFiles(result.state.results)) {
      await step.run("complete-first-build", async () => {
        await convex.mutation(api.projects.completeFirstBuild, { internalKey, projectId });
      });
    }

    return { success: true, messageId, conversationId };
  }
);
