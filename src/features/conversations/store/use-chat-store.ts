import { create } from "zustand";

export interface ChatContext {
  id: string;
  fileName: string;
  content: string;
  startLine: number;
  endLine: number;
}

/** How a send ended; see `sendMessage` in conversation-sidebar.tsx. */
export type SendResult = "sent" | "failed" | "blocked";

/**
 * A message to send once the agent is free, from outside the chat: "Ask agent
 * to fix" (#300), the preview's "Fix with AI" (#223).
 */
export interface QueuedMessage {
  projectId: string;
  text: string;
  /** Runs once the message is sent, not when it is refused or fails. */
  onSent?: () => void;
  /** Taken and in flight; it stays queued until the send settles. */
  sending?: boolean;
}

interface ChatStore {
  input: string;
  setInput: (input: string) => void;
  appendInput: (text: string) => void;
  contexts: ChatContext[];
  addContext: (context: Omit<ChatContext, "id">) => void;
  removeContext: (id: string) => void;
  clearContexts: () => void;
  queuedMessage: QueuedMessage | null;
  /** Ignored while a message is sending, so a click mid-send doesn't send again. */
  queueMessage: (message: QueuedMessage) => void;
  /**
   * The queued text for `projectId`, now marked as sending; null when none, or
   * when it is already sending. Call `finishQueuedMessage` once the send settles.
   */
  takeQueuedMessage: (projectId: string) => string | null;
  /** Clears the taken message; its `onSent` runs only when it was sent. */
  finishQueuedMessage: (result: SendResult) => void;
  /** Drops `message` if it is still waiting, e.g. when the panel that queued it closes. */
  unqueueMessage: (message: QueuedMessage) => void;
  /** The chat is sending a message (typed or queued); mirrored from its pending state. */
  sendPending: boolean;
}

export const useChatStore = create<ChatStore>()((set, get) => ({
  input: "",
  setInput: (input) => set({ input }),
  appendInput: (text) => set((state) => ({ 
    input: state.input ? `${state.input}\n${text}` : text 
  })),
  contexts: [],
  addContext: (context) => set((state) => {
    const id = crypto.randomUUID();
    return { contexts: [...state.contexts, { ...context, id }] };
  }),
  removeContext: (id) => set((state) => ({
    contexts: state.contexts.filter((c) => c.id !== id)
  })),
  clearContexts: () => set({ contexts: [] }),
  queuedMessage: null,
  queueMessage: (message) => {
    if (!get().queuedMessage?.sending) set({ queuedMessage: message });
  },
  // Only the chat of the project it was queued for may send it.
  takeQueuedMessage: (projectId) => {
    const queued = get().queuedMessage;
    if (queued?.projectId !== projectId || queued.sending) return null;
    set({ queuedMessage: { ...queued, sending: true } });
    return queued.text;
  },
  finishQueuedMessage: (result) => {
    const queued = get().queuedMessage;
    set({ queuedMessage: null });
    if (result === "sent") queued?.onSent?.();
  },
  // Once taken, the message is a new object marked sending, so this leaves it be.
  unqueueMessage: (message) => {
    if (get().queuedMessage === message) set({ queuedMessage: null });
  },
  sendPending: false,
}));

/** Sends the message queued for `projectId` once through `send`, if there is one. */
export const sendQueuedMessage = async (
  projectId: string,
  send: (text: string) => Promise<SendResult>,
) => {
  const { takeQueuedMessage, finishQueuedMessage } = useChatStore.getState();
  const text = takeQueuedMessage(projectId);
  if (text === null) return;
  let result: SendResult = "blocked";
  try {
    result = await send(text);
  } finally {
    finishQueuedMessage(result);
  }
};
