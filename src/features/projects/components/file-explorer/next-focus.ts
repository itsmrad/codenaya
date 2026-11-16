/** Use the displayed sibling order; null falls back to Create file in the header. */
export function nextFocusAfterDelete(siblings: readonly { _id: string }[], id: string): string | null {
  const index = siblings.findIndex((item) => item._id === id);
  if (index === -1) return null;
  return siblings[index + 1]?._id ?? siblings[index - 1]?._id ?? null;
}
