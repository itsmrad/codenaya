import { createHmac } from "node:crypto";

import { nanoid } from "nanoid";

import { maskSecret } from "@/features/integrations/env-keys";
import {
  deriveLocalKekSubkey,
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
 * First 12 hex chars of an HMAC-SHA256 of the key under a KEK-derived subkey,
 * so a database dump alone cannot confirm a guessed key (#614). Lets pickers
 * tell apart keys that share their last four characters. Undefined without a
 * local KEK; pickers then fall back to the masked preview.
 * shortcut: a KEK rotation changes new fingerprints, so a key re-added after
 * one is not deduped against its older copy; re-fingerprint on rewrap if that matters.
 */
function fingerprintKey(apiKey: string): string | undefined {
  const subkey = deriveLocalKekSubkey("codenaya:v1:aiProviderKeys:fingerprint");
  return subkey ? createHmac("sha256", subkey).update(apiKey).digest("hex").slice(0, 12) : undefined;
}

/** Seals a key for storage. The result is safe to persist in Convex. */
export async function sealProviderKey(apiKey: string) {
  // Generated before the insert so it can anchor the AAD in a single write.
  const secretRef = nanoid();
  const sealed = await getSecretSealer().seal(apiKey, aadFor(secretRef));
  return { secretRef, maskedPreview: maskSecret(apiKey), fingerprint: fingerprintKey(apiKey), ...sealed };
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
