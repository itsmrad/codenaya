import { useMutation, useQuery } from "convex/react";

import { api } from "../../../../convex/_generated/api";
import { Id } from "../../../../convex/_generated/dataModel";
import { useChatStore } from "../store/use-chat-store";

export const useConversation = (id: Id<"conversations"> | null) => {
  return useQuery(api.conversations.getById, id ? { id } : "skip");
};

export const useMessages = (conversationId: Id<"conversations"> | null) => {
  return useQuery(
    api.conversations.getMessages,
    conversationId ? { conversationId } : "skip"
  );
};

export const useConversations = (projectId: Id<"projects">) => {
  return useQuery(api.conversations.getByProject, { projectId });
};

export const useCreateConversation = () => {
  return useMutation(api.conversations.create);
};

export const useActiveRun = (projectId: Id<"projects">) => {
  return useQuery(api.conversations.getActiveRun, { projectId });
};

/** Sends a message from outside the chat panel, through the chat's own send path. */
export const useQueueChatMessage = () => useChatStore((state) => state.queueMessage);
