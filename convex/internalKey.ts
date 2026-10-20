import { appError } from "./errors";

/**
 * Shared check for the internal key that Next.js and Inngest use to call
 * `api.system.*` (#105). Extracted from `system.ts` so domain files can gate
 * their own internal-key functions without importing the 1,800-line module.
 */
export const validateInternalKey = (key: string) => {
  const internalKey = process.env.CODENAYA_CONVEX_INTERNAL_KEY;

  if (!internalKey) {
    throw new Error("CODENAYA_CONVEX_INTERNAL_KEY is not configured");
  }

  if (!keysMatch(key, internalKey)) {
    throw appError("UNAUTHENTICATED", "Invalid internal key");
  }
};

/**
 * Constant-time string compare, so response timing doesn't reveal how much of
 * a guessed key was right (#211). The Convex runtime has no
 * `crypto.timingSafeEqual`. Only the secret's length can leak.
 */
export const keysMatch = (given: string, secret: string) => {
  const a = new TextEncoder().encode(given);
  const b = new TextEncoder().encode(secret);
  let diff = a.length ^ b.length;
  for (let i = 0; i < b.length; i++) {
    diff |= (a[i] ?? 0) ^ b[i];
  }
  return diff === 0;
};
