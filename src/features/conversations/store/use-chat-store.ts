import { create } from "zustand";

export interface ChatContext {
  id: string;
  fileName: string;
  content: string;
  startLine: number;
  endLine: number;
}

interface ChatStore {
  input: string;
  setInput: (input: string) => void;
  appendInput: (text: string) => void;
  contexts: ChatContext[];
  addContext: (context: Omit<ChatContext, "id">) => void;
  removeContext: (id: string) => void;
  clearContexts: () => void;
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
  clearContexts: () => set({ contexts: [] })
}));
