import { useChatStore } from "../store/use-chat-store";

/** Sends a message to the project's chat once the agent is free. */
export const useQueueChatMessage = () => useChatStore((state) => state.queueMessage);
