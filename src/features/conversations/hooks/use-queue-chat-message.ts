import { useChatStore } from "../store/use-chat-store";

export type { QueuedMessage } from "../store/use-chat-store";

/** Sends `{ projectId, text }` to that project's chat once its agent is free. */
export const useQueueChatMessage = () => useChatStore((state) => state.queueMessage);

/** See `unqueueMessage` in the chat store. */
export const useUnqueueChatMessage = () => useChatStore((state) => state.unqueueMessage);

/** The chat is sending, or has a message queued, so a Fix button waits (#223). */
export const useChatSendBusy = () =>
  useChatStore((state) => state.sendPending || state.queuedMessage !== null);
