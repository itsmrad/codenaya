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

/** Seals a key for storage. The result is safe to persist in Convex. */
export async function sealProviderKey(apiKey: string) {
  // Generated before the insert so it can anchor the AAD in a single write.
  const secretRef = nanoid();
  const sealed = await getSecretSealer().seal(apiKey, aadFor(secretRef));
  return { secretRef, maskedPreview: maskSecret(apiKey), ...sealed };
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
