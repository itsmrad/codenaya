import { createAgent, openai, createNetwork, type Tool } from '@inngest/agent-kit';

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
import {
  buildIntegrationsPromptSection,
  buildMcpAgentTools,
} from '@/features/integrations/server/mcp/build-agent-tools';
import {
  createConvexApprovalGate,
  createConvexAuditSink,
} from '@/features/integrations/server/mcp/convex-approval';

interface MessageEvent {
  messageId: Id<"messages">;
  conversationId: Id<"conversations">;
  projectId: Id<"projects">;
  message: string;
};

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
  async ({ event, step }) => {
    const {
      messageId,
      conversationId,
      projectId,
      message
    } = event.data as MessageEvent;

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

    // Fetch recent messages for conversation context
    const recentMessages = await step.run("get-recent-messages", async () => {
      return await convex.query(api.system.getRecentMessages, {
        internalKey,
        conversationId,
        limit: 10,
      });
    });

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
        // ─── OPENROUTER (local dev) — original below, restore to revert ───
        // model: openai({
        //   model: "gpt-3.5-turbo",
        //   defaultParameters: { temperature: 0 },
        // }),
        model: openai({
          model: process.env.OPENROUTER_MODEL ?? "cohere/north-mini-code:free",
          baseUrl: process.env.OPENROUTER_BASE_URL,
          apiKey: process.env.OPENROUTER_API_KEY,
          defaultParameters: { temperature: 0 },
        }),
      });

      const { output } = await titleAgent.run(message, { step });

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

      const entries = await convex.query(api.system.getProjectMcpConnections, {
        internalKey,
        projectId,
      });

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
        });

        mcpTools = built.tools;
        mcpSummaries = built.connectedSummaries;
        mcpWarnings = built.warnings;
        mcpBaselines = built.baselinesToRecord;
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

    // Create the coding agent with file tools
    const codingAgent = createAgent({
      name: "codenaya",
      description: "An expert AI coding assistant",
      system: systemPrompt,
      // ─── OPENROUTER (local dev) — original below, restore to revert ───
      // model: openai({
      //   model: "gpt-5.4",
      //   defaultParameters: { temperature: 0.3 }
      // }),
      model: openai({
        model: process.env.OPENROUTER_MODEL ?? "cohere/north-mini-code:free",
        baseUrl: process.env.OPENROUTER_BASE_URL,
        apiKey: process.env.OPENROUTER_API_KEY,
        defaultParameters: { temperature: 0.3 },
      }),
      tools: [
        createListFilesTool({ internalKey, projectId }),
        createReadFilesTool({ internalKey }),
        createUpdateFileTool({ internalKey }),
        createCreateFilesTool({ projectId, internalKey }),
        createCreateFolderTool({ projectId, internalKey }),
        createRenameFileTool({ internalKey }),
        createDeleteFilesTool({ internalKey }),
        createScrapeUrlsTool(),
        ...(mcpOwnerId
          ? [createSetEnvVarTool({ projectId, ownerId: mcpOwnerId, internalKey })]
          : []),
        ...mcpTools,
      ],
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

    // ─── Streaming ───
    //
    // AgentKit emits typed chunks throughout the run; `publish` is ours to
    // implement. Text deltas are accumulated and flushed on a timer rather than
    // written per token, because every write is a Convex mutation and a
    // token-rate write loop would be pathologically chatty for no visible gain.
    //
    // These writes are intentionally outside `step.run`. A durable step
    // memoises its result and replays it wholesale, which would collapse the
    // incremental writes that are the entire point here. `appendMessageChunk`
    // carries its own sequence guard instead, so a retried run cannot
    // double-append.
    // Time alone is not enough to pace this. A fast model can emit its whole
    // response inside one interval, which collapses the stream back into a
    // single write; a size trigger keeps long answers visibly progressive.
    const FLUSH_INTERVAL_MS = 100;
    const FLUSH_CHARS = 60;

    let pending = "";
    let seq = 0;
    let lastFlush = Date.now();

    // partId -> tool name and the JSON arguments streamed so far.
    const toolParts = new Map<string, { name: string; args: string }>();
    // partIds already shown as running, so the timeline is written once per
    // call rather than on every argument delta.
    const announced = new Set<string>();

    /**
     * Best-effort human label from a tool's streamed arguments.
     *
     * The arguments arrive as a JSON string built up across many deltas, so it
     * is usually truncated mid-token while the call is in flight and cannot be
     * parsed. A regex for the fields that actually identify the work — a file
     * name or path — degrades gracefully where JSON.parse would throw.
     */
    const labelFromArgs = (args: string): string | undefined => {
      const match =
        args.match(/"(?:name|path|fileName|filePath)"\s*:\s*"([^"]{1,120})"/) ??
        args.match(/"url"\s*:\s*"([^"]{1,120})"/);

      return match?.[1];
    };

    const publishPart = async (
      partId: string,
      toolName: string,
      status: "running" | "done" | "error",
      label?: string,
    ) => {
      try {
        await convex.mutation(api.system.upsertMessagePart, {
          internalKey,
          messageId,
          partId,
          toolName,
          status,
          label,
        });
      } catch {
        // Activity display is cosmetic; never fail the run over it.
      }
    };

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
        // A dropped chunk must not abort the run: the authoritative full
        // response is written once the agent finishes.
      }
    };

    // Run the agent
    const result = await network.run(message, {
      streaming: {
        simulateChunking: true,
        publish: async (chunk) => {
          // ─── Tool activity ───
          //
          //
          // The tool's name arrives on the first `tool_call.arguments.delta`
          // for a part, not on `part.created`, so names are remembered per
          // partId and reused when the part later completes.
          if (chunk.event === "tool_call.arguments.delta") {
            const data = chunk.data as {
              partId?: string;
              delta?: string;
              toolName?: string;
            };

            if (data.partId) {
              const entry = toolParts.get(data.partId) ?? { name: "", args: "" };

              if (data.toolName) {
                entry.name = data.toolName;
              }

              entry.args += data.delta ?? "";
              toolParts.set(data.partId, entry);

              if (entry.name && !announced.has(data.partId)) {
                announced.add(data.partId);
                await publishPart(data.partId, entry.name, "running");
              }
            }

            return;
          }

          if (chunk.event === "part.completed" || chunk.event === "part.failed") {
            const data = chunk.data as { partId?: string; type?: string };

            if (data.partId && data.type === "tool-call") {
              const entry = toolParts.get(data.partId);

              if (entry?.name) {
                await publishPart(
                  data.partId,
                  entry.name,
                  chunk.event === "part.failed" ? "error" : "done",
                  labelFromArgs(entry.args),
                );
              }
            }

            return;
          }

          if (chunk.event !== "text.delta") {
            return;
          }

          const delta = (chunk.data as { delta?: string } | undefined)?.delta;

          if (!delta) {
            return;
          }

          pending += delta;

          if (
            pending.length >= FLUSH_CHARS ||
            Date.now() - lastFlush >= FLUSH_INTERVAL_MS
          ) {
            await flush();
          }
        },
      },
    });

    await flush();

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

