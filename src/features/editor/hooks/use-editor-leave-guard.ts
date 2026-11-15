import { useEffect } from "react";

import type { Id } from "../../../../convex/_generated/dataModel";
import { clearProjectSessions, getProjectSessions, hasOpenConflict, retainProjectSessions } from "../editor-session";

const LEAVE_MESSAGE = "A file changed elsewhere while you were editing it. Leave anyway and discard your edits?";

const projectOf = (pathname: string) => pathname.match(/^\/projects\/([^/]+)/)?.[1] as Id<"projects"> | undefined;

/** True when an in-app navigation to `href` may go ahead; asks before leaving a project with an open conflict (#604). */
export const confirmLeaveEditor = (href: string) => {
  const url = new URL(href, window.location.href);
  const from = projectOf(window.location.pathname);
  // Other sites leave through beforeunload; links inside the project don't leave it (#618).
  if (url.origin !== window.location.origin || !from || projectOf(url.pathname) === from) return true;
  if (!hasOpenConflict(from)) return true;
  if (!window.confirm(LEAVE_MESSAGE)) return false;
  clearProjectSessions(from);
  return true;
};

/** Capture phase runs before Next's <Link> handler, so a declined leave never navigates. */
export const guardLeaveClick = (event: MouseEvent) => {
  if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  const link = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>("a[href]") : null;
  if (!link || (link.target && link.target !== "_self") || link.hasAttribute("download")) return;
  if (confirmLeaveEditor(link.href)) return;
  event.preventDefault();
  event.stopPropagation();
};

/** Guards leaving the project while drafts are unsaved. Drafts outlive unmounts until another project opens (#618). */
export const useEditorLeaveGuard = (projectId: Id<"projects">) => {
  useEffect(() => {
    retainProjectSessions(projectId);
    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      for (const session of getProjectSessions(projectId).values()) {
        const state = session.getSnapshot();
        if (!state.dirty && !state.saving && !state.conflict) continue;
        void session.save();
        event.preventDefault();
      }
    };
    window.addEventListener("beforeunload", handleBeforeUnload);
    document.addEventListener("click", guardLeaveClick, true);
    return () => {
      window.removeEventListener("beforeunload", handleBeforeUnload);
      document.removeEventListener("click", guardLeaveClick, true);
    };
  }, [projectId]);
};
