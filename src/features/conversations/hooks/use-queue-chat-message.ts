import { useChatStore } from "../store/use-chat-store";

/** Sends `{ projectId, text }` to that project's chat once its agent is free. */
export const useQueueChatMessage = () => useChatStore((state) => state.queueMessage);

/** A message is queued or sending, so a Fix button waits (#223). */
export const useChatMessageQueued = () => useChatStore((state) => state.queuedMessage !== null);
