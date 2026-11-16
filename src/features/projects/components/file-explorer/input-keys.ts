/**
 * Enter submits, Escape cancels. Enter's default action is prevented first:
 * submitting moves focus to another button within the same keystroke, and the
 * Enter that is still being dispatched would otherwise activate that button
 * (toggling the parent folder shut, or opening a second create input).
 */
export const onEntryKeyDown = (
  event: { key: string; preventDefault: () => void; isComposing?: boolean; keyCode?: number; nativeEvent?: { isComposing?: boolean } },
  submit: (restoreFocus: boolean) => void,
  cancel: (restoreFocus: boolean) => void,
) => {
  if (event.key === "Enter") {
    if (event.isComposing || event.nativeEvent?.isComposing || event.keyCode === 229) return;
    event.preventDefault();
    submit(true);
  }
  if (event.key === "Escape") cancel(true);
};
