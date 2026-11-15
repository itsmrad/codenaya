import { useEffect } from "react";

import type { Id } from "../../../../convex/_generated/dataModel";
import { clearProjectSessions, getProjectSessions, hasOpenConflict } from "../editor-session";

const LEAVE_MESSAGE = "A file changed elsewhere while you were editing it. Leave anyway and discard your edits?";

/** True when an in-app navigation to `href` may go ahead; asks first while a conflict is open (#604). */
export const confirmLeaveEditor = (href: string) => {
  const url = new URL(href, window.location.href);
  // Other sites leave through beforeunload; the same page doesn't leave at all.
  if (url.origin !== window.location.origin || url.pathname === window.location.pathname) return true;
  return !hasOpenConflict() || window.confirm(LEAVE_MESSAGE);
};

/** Guards leaving the project while drafts are unsaved, then drops its sessions once it is left. */
export const useEditorLeaveGuard = (projectId: Id<"projects">) => {
  useEffect(() => {
    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      for (const session of getProjectSessions(projectId).values()) {
        const state = session.getSnapshot();
        if (!state.dirty && !state.saving && !state.conflict) continue;
        void session.save();
        event.preventDefault();
      }
    };
    // Capture phase runs before Next's <Link> handler, so a declined leave never navigates.
    const handleClick = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const link = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>("a[href]") : null;
      if (!link || (link.target && link.target !== "_self") || link.hasAttribute("download")) return;
      if (confirmLeaveEditor(link.href)) return;
      event.preventDefault();
      event.stopPropagation();
    };
    window.addEventListener("beforeunload", handleBeforeUnload);
    document.addEventListener("click", handleClick, true);
    return () => {
      window.removeEventListener("beforeunload", handleBeforeUnload);
      document.removeEventListener("click", handleClick, true);
      clearProjectSessions(projectId);
    };
  }, [projectId]);
};
