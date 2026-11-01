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

/** A message another panel asked the chat to send, e.g. "Fix with AI" (#223). */
export interface QueuedMessage {
  text: string;
  /** Runs once the message is sent, not when it is refused or fails. */
  onSent?: () => void;
  /** Set while the send is in flight; the message stays queued until it settles. */
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
  /** Ignored while another message is queued or sending, so a double click sends once. */
  queueMessage: (message: QueuedMessage) => void;
}

export const useChatStore = create<ChatStore>()((set) => ({
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
  queueMessage: (message) =>
    set((state) => (state.queuedMessage ? state : { queuedMessage: message })),
}));

/**
 * Sends the queued message once through `send`. It stays queued, blocking any
 * other, until the send settles; `onSent` runs only when it was sent.
 */
export const sendQueuedMessage = async (send: (text: string) => Promise<SendResult>) => {
  const queued = useChatStore.getState().queuedMessage;
  if (!queued || queued.sending) return;
  useChatStore.setState({ queuedMessage: { ...queued, sending: true } });
  let result: SendResult = "blocked";
  try {
    result = await send(queued.text);
  } finally {
    useChatStore.setState({ queuedMessage: null });
  }
  if (result === "sent") queued.onSent?.();
};
