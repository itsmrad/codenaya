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
