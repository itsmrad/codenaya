/**
 * Whether a click inside an input-group addon should focus the group's input.
 * Radix radios/checkboxes in a form dispatch an untrusted, bubbling `click` on a
 * hidden input whenever their value changes (e.g. the composer's Alt+M); that
 * must not move focus out of the textarea.
 */
export const shouldFocusGroupInput = (
  event: Pick<Event, "isTrusted">,
  target: Pick<Element, "closest">,
): boolean => event.isTrusted && !target.closest("button");
