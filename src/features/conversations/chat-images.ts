/**
 * Limits on images attached to a chat message. Shared by the composer (which
 * filters what it accepts) and Convex (which enforces them on upload), so it
 * stays free of path aliases.
 */

export const MAX_CHAT_IMAGES = 4;
export const MAX_CHAT_IMAGE_BYTES = 5 * 1024 * 1024;

export const CHAT_IMAGE_TYPES = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
] as const;

export const isChatImageType = (type: string | undefined) =>
  CHAT_IMAGE_TYPES.some((allowed) => allowed === type);
