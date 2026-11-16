export const PREVIEW_IDLE_MS = 10 * 60_000;
export const PREVIEW_BOOT_MS = 5 * 60_000;
export const MAX_PUBLIC_PREVIEWS = 2;
export const validShareToken = (token: string) => /^[0-9a-f]{32}$/.test(token);
export const previewDeadline = (now: number, keepLiveUntil = 0) => Math.max(now + PREVIEW_IDLE_MS, keepLiveUntil);
export const safePreviewPath = (path: string) => !path.startsWith("/") &&
  !path.includes("\\") && path.split("/").every((part) => part && part !== "." && part !== "..") &&
  !path.split("/").some((part) => part === "node_modules" || part === ".git");
