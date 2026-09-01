/**
 * Public entry point for credential encryption.
 *
 * Application code should use `getSecretSealer()` and never touch DEKs, KEKs or
 * the envelope primitives directly.
 *
 * ```ts
 * const sealer = getSecretSealer();
 * const aad = secretContext("userConnections", connectionId, "accessToken");
 * const sealed = await sealer.seal(token, aad);   // persist `sealed`
 * const token  = await sealer.open(sealed, aad);  // recover it
 * ```
 */

import { createHash } from "node:crypto";

import {
  decryptWithDek,
  encryptWithDek,
  generateDek,
} from "./envelope";
import {
  createGcpKmsProvider,
  GCP_KMS_PROVIDER_ID,
  readGcpKmsConfigFromEnv,
} from "./kek/gcp-kms";
import {
  createLocalKekProvider,
  LOCAL_KEK_PROVIDER_ID,
  readLocalKekConfigFromEnv,
} from "./kek/local";
import type { KekProvider, SealedSecret, SecretSealer } from "./types";

export { secretContext } from "./types";
export type { SealedSecret, SecretSealer, KekProvider } from "./types";

/**
 * How long an unwrapped DEK may stay resident.
 *
 * This trades a little exposure for a large reduction in KMS calls: with a
 * network-backed KEK, an uncached unwrap would add a round trip to every agent
 * turn and every sandbox boot. Five minutes comfortably covers a single agent
 * run while keeping the window short. The `local` provider does not benefit —
 * unwrapping there is pure CPU — but sharing one path keeps behaviour identical
 * across providers, which is what makes the migration safe.
 */
const DEK_CACHE_TTL_MS = 5 * 60 * 1000;

/**
 * Bounds memory and, more importantly, bounds how many plaintext DEKs exist in
 * the process at once.
 */
const DEK_CACHE_MAX_ENTRIES = 500;

interface CacheEntry {
  dek: Buffer;
  expiresAt: number;
}

const dekCache = new Map<string, CacheEntry>();

/**
 * Cache key derived by hashing, so the cache never holds the wrapped DEK itself
 * and every key is a fixed, bounded length.
 */
function cacheKeyFor(sealed: SealedSecret): string {
  return createHash("sha256")
    .update(sealed.kekProvider)
    .update("\u0000")
    .update(sealed.kekKeyId)
    .update("\u0000")
    .update(sealed.wrappedDek)
    .digest("base64");
}

function readCache(key: string): Buffer | undefined {
  const entry = dekCache.get(key);
  if (!entry) return undefined;

  if (entry.expiresAt <= Date.now()) {
    dekCache.delete(key);
    return undefined;
  }

  // Refresh insertion order so eviction approximates least-recently-used. Map
  // preserves insertion order, so re-inserting moves this entry to the newest
  // position.
  dekCache.delete(key);
  dekCache.set(key, entry);
  return entry.dek;
}

function writeCache(key: string, dek: Buffer): void {
  if (dekCache.size >= DEK_CACHE_MAX_ENTRIES) {
    // Map iteration order is insertion order, so the first key is the oldest.
    const oldest = dekCache.keys().next();
    if (!oldest.done) {
      dekCache.delete(oldest.value);
    }
  }
  dekCache.set(key, { dek, expiresAt: Date.now() + DEK_CACHE_TTL_MS });
}

/** Drop all cached DEKs. Exported for tests and for use after a KEK rotation. */
export function clearDekCache(): void {
  dekCache.clear();
}

export type KekProviderId =
  | typeof LOCAL_KEK_PROVIDER_ID
  | typeof GCP_KMS_PROVIDER_ID;

/**
 * Which KEK provider to use, from `CODENAYA_KEK_PROVIDER`.
 *
 * Defaults to `local` so a fresh checkout works with only
 * `CODENAYA_LOCAL_KEK` set. An unrecognised value throws rather than silently
 * falling back — a typo here would otherwise seal data under a key the operator
 * did not intend.
 */
export function resolveKekProviderId(): KekProviderId {
  const raw = process.env.CODENAYA_KEK_PROVIDER?.trim().toLowerCase();
  if (!raw || raw === LOCAL_KEK_PROVIDER_ID) return LOCAL_KEK_PROVIDER_ID;
  if (raw === GCP_KMS_PROVIDER_ID) return GCP_KMS_PROVIDER_ID;

  throw new Error(
    `Unknown CODENAYA_KEK_PROVIDER "${raw}". Expected "${LOCAL_KEK_PROVIDER_ID}" or "${GCP_KMS_PROVIDER_ID}".`,
  );
}

export function createKekProvider(id: KekProviderId): KekProvider {
  switch (id) {
    case GCP_KMS_PROVIDER_ID:
      return createGcpKmsProvider(readGcpKmsConfigFromEnv());
    case LOCAL_KEK_PROVIDER_ID:
      return createLocalKekProvider(readLocalKekConfigFromEnv());
  }
}

/**
 * Build a sealer over an explicit KEK provider.
 *
 * Exported separately from `getSecretSealer` so tests and the re-wrap script can
 * drive a specific provider without touching the environment or the singleton.
 */
export function createSecretSealer(provider: KekProvider): SecretSealer {
  return {
    async seal(plaintext: string, aad: string): Promise<SealedSecret> {
      // A fresh DEK per secret: a compromised DEK reveals exactly one value.
      const dek = generateDek();
      const wrappedDek = await provider.wrapDek(dek);
      const payload = encryptWithDek(plaintext, dek, aad);

      return {
        kekProvider: provider.id,
        kekKeyId: provider.activeKeyId,
        wrappedDek,
        ciphertext: payload.ciphertext,
        iv: payload.iv,
        authTag: payload.authTag,
      };
    },

    async open(sealed: SealedSecret, aad: string): Promise<string> {
      if (sealed.kekProvider !== provider.id) {
        // Rows sealed by a different provider need that provider configured.
        // Failing loudly beats attempting an unwrap that cannot succeed.
        throw new Error(
          `Record was sealed with KEK provider "${sealed.kekProvider}" but "${provider.id}" is configured. ` +
            `Set CODENAYA_KEK_PROVIDER=${sealed.kekProvider}, or re-wrap with scripts/rewrap-deks.ts.`,
        );
      }

      const key = cacheKeyFor(sealed);
      let dek = readCache(key);

      if (!dek) {
        dek = await provider.unwrapDek(sealed.wrappedDek, sealed.kekKeyId);
        writeCache(key, dek);
      }

      return decryptWithDek(
        {
          ciphertext: sealed.ciphertext,
          iv: sealed.iv,
          authTag: sealed.authTag,
        },
        dek,
        aad,
      );
    },
  };
}

let cachedSealer: SecretSealer | undefined;
let cachedSealerProviderId: KekProviderId | undefined;

/**
 * Process-wide sealer, created on first use.
 *
 * Initialisation is lazy rather than at module load so that importing this
 * module during `next build` — where credentials are absent — does not fail the
 * build. The cost of a missing key surfaces at the first actual encrypt or
 * decrypt, with a message naming the variable to set.
 */
export function getSecretSealer(): SecretSealer {
  const providerId = resolveKekProviderId();

  if (!cachedSealer || cachedSealerProviderId !== providerId) {
    cachedSealer = createSecretSealer(createKekProvider(providerId));
    cachedSealerProviderId = providerId;
    // A provider switch invalidates every cached DEK: entries are keyed by
    // provider, but holding keys unwrapped by a provider we are no longer using
    // serves no purpose.
    clearDekCache();
  }

  return cachedSealer;
}

/** Reset the memoised sealer. For tests that change environment variables. */
export function resetSecretSealer(): void {
  cachedSealer = undefined;
  cachedSealerProviderId = undefined;
  clearDekCache();
}
