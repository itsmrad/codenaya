import { useChatStore } from "../store/use-chat-store";

/** Sends `{ projectId, text }` to that project's chat once its agent is free. */
export const useQueueChatMessage = () => useChatStore((state) => state.queueMessage);
