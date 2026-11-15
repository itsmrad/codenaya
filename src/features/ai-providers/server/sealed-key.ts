import { createHash } from "node:crypto";

import { nanoid } from "nanoid";

import { maskSecret } from "@/features/integrations/env-keys";
import {
  getSecretSealer,
  secretContext,
  type SealedSecret,
} from "@/features/integrations/server/crypto";

/**
 * Envelope encryption for BYOK API keys, using the same sealer as integration
 * credentials. Each ciphertext is bound by AAD to its row's immutable
 * `secretRef`, so a ciphertext copied onto another row will not open.
 */

const aadFor = (secretRef: string) =>
  secretContext("aiProviderKeys", secretRef, "apiKey");

/**
 * Seals a key for storage. The result is safe to persist in Convex. The
 * fingerprint (first 12 hex chars of its SHA-256) lets pickers tell apart two
 * keys that share their last four characters (#614).
 */
export async function sealProviderKey(apiKey: string) {
  // Generated before the insert so it can anchor the AAD in a single write.
  const secretRef = nanoid();
  const sealed = await getSecretSealer().seal(apiKey, aadFor(secretRef));
  const fingerprint = createHash("sha256").update(apiKey).digest("hex").slice(0, 12);
  return { secretRef, maskedPreview: maskSecret(apiKey), fingerprint, ...sealed };
}

/** Recovers the plaintext key from a stored row. Server-side only. */
export function openProviderKey(
  row: SealedSecret & { secretRef: string },
): Promise<string> {
  const { kekProvider, kekKeyId, wrappedDek, ciphertext, iv, authTag } = row;
  return getSecretSealer().open(
    { kekProvider, kekKeyId, wrappedDek, ciphertext, iv, authTag },
    aadFor(row.secretRef),
  );
}
