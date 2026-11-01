import { create } from "zustand";

export interface ChatContext {
  id: string;
  fileName: string;
  content: string;
  startLine: number;
  endLine: number;
}

interface QueuedMessage {
  projectId: string;
  text: string;
}

interface ChatStore {
  input: string;
  setInput: (input: string) => void;
  appendInput: (text: string) => void;
  contexts: ChatContext[];
  addContext: (context: Omit<ChatContext, "id">) => void;
  removeContext: (id: string) => void;
  clearContexts: () => void;
  /** A message to send once the agent is free, from outside the chat (#300). */
  queuedMessage: QueuedMessage | null;
  queueMessage: (message: QueuedMessage) => void;
  /** The queued text for `projectId`, removed from the queue; null when none. */
  takeQueuedMessage: (projectId: string) => string | null;
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
  queueMessage: (queuedMessage) => set({ queuedMessage }),
  // Only the chat of the project it was queued for may send it.
  takeQueuedMessage: (projectId) => {
    const queued = get().queuedMessage;
    if (queued?.projectId !== projectId) return null;
    set({ queuedMessage: null });
    return queued.text;
  },
}));
