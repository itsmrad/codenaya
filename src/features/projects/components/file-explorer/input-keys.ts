/**
 * Enter submits, Escape cancels. Enter's default action is prevented first:
 * submitting moves focus to another button within the same keystroke, and the
 * Enter that is still being dispatched would otherwise activate that button
 * (toggling the parent folder shut, or opening a second create input).
 */
export const onEntryKeyDown = (
  event: { key: string; preventDefault: () => void },
  submit: () => void,
  cancel: () => void,
) => {
  if (event.key === "Enter") {
    event.preventDefault();
    submit();
  }
  if (event.key === "Escape") cancel();
};
