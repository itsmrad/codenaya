import { create } from "zustand";

interface ChatPanelStore {
  /** The desktop chat side panel is hidden ("Toggle chat panel"). */
  isHidden: boolean;
  setHidden: (isHidden: boolean) => void;
}

/** Shared by the IDE layout, its toolbar's Show chat button and the palette. */
export const useChatPanelStore = create<ChatPanelStore>()((set) => ({
  isHidden: false,
  setHidden: (isHidden) => set({ isHidden }),
}));
