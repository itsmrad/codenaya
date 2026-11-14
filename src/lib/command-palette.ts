import { useEffect, useRef } from "react";
import { create } from "zustand";

/**
 * IDE actions the command palette can run, in display order. The component
 * that owns each toolbar button registers its handler with
 * `useProjectCommands`, so the palette runs exactly what the button does and
 * only lists actions the current page offers.
 */
export const PROJECT_COMMANDS = [
  { id: "show-code", label: "Show code" },
  { id: "show-preview", label: "Show preview" },
  { id: "toggle-chat", label: "Toggle chat panel" },
  { id: "new-conversation", label: "New conversation" },
  { id: "past-conversations", label: "Past conversations" },
  { id: "version-history", label: "Version history" },
  { id: "publish", label: "Publish" },
  { id: "download-zip", label: "Export ZIP" },
  { id: "integrations", label: "Integrations" },
  { id: "skills", label: "Skills" },
  { id: "env-vars", label: "Environment variables" },
] as const;

export type ProjectCommandId = (typeof PROJECT_COMMANDS)[number]["id"];
type Run = () => void;

interface CommandPaletteStore {
  open: boolean;
  setOpen: (open: boolean) => void;
  commands: Partial<Record<ProjectCommandId, Run>>;
}

/** Open state of the command palette and the IDE actions it can run. */
export const useCommandPalette = create<CommandPaletteStore>()((set) => ({
  open: false,
  setOpen: (open) => set({ open }),
  commands: {},
}));

type Handlers = Partial<Record<ProjectCommandId, Run | null>>;

/**
 * Registers the actions in `handlers` that have one (a `null` handler hides
 * its action). Each looks its handler up in `getHandlers()` at run time, so it
 * always runs the latest. Returns the unregister, which leaves an id alone if
 * another component has registered it since.
 */
export const registerProjectCommands = (
  handlers: Handlers,
  getHandlers: () => Handlers,
) => {
  const registered = new Map<ProjectCommandId, Run>();
  for (const id of Object.keys(handlers) as ProjectCommandId[]) {
    if (handlers[id]) registered.set(id, () => getHandlers()[id]?.());
  }
  useCommandPalette.setState((state) => ({
    commands: { ...state.commands, ...Object.fromEntries(registered) },
  }));
  return () =>
    useCommandPalette.setState((state) => {
      const commands = { ...state.commands };
      for (const [id, run] of registered) if (commands[id] === run) delete commands[id];
      return { commands };
    });
};

/**
 * Offers IDE actions in the command palette while the calling component is
 * mounted. A `null` handler hides the action (e.g. Publish once published).
 */
export const useProjectCommands = (handlers: Handlers) => {
  // Read at run time, so a re-render's new closures never re-register.
  const latest = useRef(handlers);
  useEffect(() => {
    latest.current = handlers;
  });

  // Re-register only when the set of available actions changes.
  const ids = (Object.keys(handlers) as ProjectCommandId[])
    .filter((id) => handlers[id])
    .join(",");

  useEffect(() => {
    if (!ids) return;
    // The effect above has already stored this render's handlers.
    return registerProjectCommands(latest.current, () => latest.current);
  }, [ids]);
};
