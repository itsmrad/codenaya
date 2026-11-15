"use client";

import type { Id } from "../../../../convex/_generated/dataModel";
import { useAgentTasks } from "../hooks/use-agent-tasks";
import { useConversations, useMessages } from "../hooks/use-conversations";
import { SwarmBoard } from "./swarm-board";

/**
 * The agent board workspace mode (#525): the swarm board of the latest swarm
 * run in the project's latest conversation, the one the chat opens on.
 */
export const ProjectSwarmBoard = ({ projectId }: { projectId: Id<"projects"> }) => {
  const conversations = useConversations(projectId);
  const messages = useMessages(conversations?.[0]?._id ?? null);
  const run = messages?.findLast((message) => message.role === "assistant" && message.mode === "swarm");
  const tasks = useAgentTasks(run?._id ?? null);
  const loading = conversations === undefined || (conversations.length > 0 && messages === undefined);
  return (
    <section
      aria-label="Agent board"
      className="h-full overflow-y-auto rounded-xl border border-border/60 bg-card p-3 shadow-[0_1px_3px_rgba(0,0,0,0.12),0_0_0_1px_rgba(0,0,0,0.04)] dark:shadow-[0_1px_3px_rgba(0,0,0,0.4),0_0_0_1px_rgba(255,255,255,0.03)]"
    >
      {run ? (
        <SwarmBoard message={run} tasks={tasks} />
      ) : (
        !loading && (
          <p className="p-6 text-center text-sm text-muted-foreground">
            No agent tasks yet. Send a message in Swarm mode and its workers show up here.
          </p>
        )
      )}
    </section>
  );
};
