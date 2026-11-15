import ky from "ky";

/** What stopped a run, logged by the cancel route (#608). */
export type CancelSource = "esc" | "button";

/**
 * Send turns into Stop in place, so a Stop this soon after the run began is
 * the second click (or Enter) of a double-click on Send, not a decision.
 */
export const STOP_GRACE_MS = 1500;

/**
 * An open dialog, popover, menu or select (Radix marks each with its role and
 * `data-state="open"`). Esc belongs to it, not to the run.
 */
export const OPEN_OVERLAY =
  ":is([role=dialog],[role=alertdialog],[role=menu],[role=listbox])[data-state=open]";

/**
 * Whether this keydown should stop the running agent: a fresh Esc that nothing
 * else handled, with no overlay open to close first (#608). The overlay closes
 * on the same keydown, so it is still in the DOM when this runs.
 */
export const shouldEscapeCancelRun = (
  event: KeyboardEvent,
  root: { querySelector(selectors: string): Element | null } = document,
) =>
  event.key === "Escape" &&
  !event.defaultPrevented &&
  !event.repeat &&
  !root.querySelector(OPEN_OVERLAY);

/** Stops the project's run unless it's a too-early Stop; resolves to whether it asked. */
export const cancelRun = async (
  projectId: string,
  source: CancelSource,
  startedAt: number,
  now = Date.now(),
) => {
  if (source === "button" && now - startedAt < STOP_GRACE_MS) return false;
  await ky.post("/api/messages/cancel", { json: { projectId, source } });
  return true;
};
