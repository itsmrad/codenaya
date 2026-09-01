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
        model: openai({
          model: "gpt-3.5-turbo",
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

    try {
      const entries = await convex.query(api.system.getProjectMcpConnections, {
        internalKey,
        projectId,
      });

      if (entries.length > 0) {
        // The project owner is needed for approval rows and audit entries. It is
        // read from the project rather than trusted from anywhere else, so an
        // approval prompt can only ever be shown to the person who owns the work.
        const project = await convex.query(api.system.getProjectById, {
          internalKey,
          projectId,
        });

        const mcpContext = project
          ? {
              internalKey,
              projectId,
              ownerId: project.ownerId,
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
      model: openai({
        model: "gpt-5.4",
        defaultParameters: { temperature: 0.3 }
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

    // Run the agent
    const result = await network.run(message);

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

