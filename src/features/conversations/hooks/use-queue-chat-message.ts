import { chatSendBlock, useChatStore } from "../store/use-chat-store";

export type { QueuedMessage } from "../store/use-chat-store";

/** Sends `{ projectId, text }` to that project's chat once its agent is free. */
export const useQueueChatMessage = () => useChatStore((state) => state.queueMessage);

/** See `unqueueMessage` in the chat store. */
export const useUnqueueChatMessage = () => useChatStore((state) => state.unqueueMessage);

/** Why a Fix button in `projectId` waits, or null (#223); see `chatSendBlock`. */
export const useChatSendBlock = (projectId: string) =>
  useChatStore((state) => chatSendBlock(state, projectId));
