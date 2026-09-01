/**
 * Local KEK provider: the key encryption key lives in an environment variable.
 *
 * ## The tradeoff, stated plainly
 *
 * With a hosted KMS, an attacker holding a database dump still cannot decrypt
 * anything, because unwrapping requires an API call they cannot make. With a
 * local KEK, an attacker who obtains **both** the database and the process
 * environment can decrypt everything. That is a genuine reduction in security,
 * accepted deliberately so the platform runs at zero cost.
 *
 * It is also cheap to walk back. Because the KEK only ever wraps DEKs, moving
 * to Cloud KMS is a pass over the `wrappedDek` column rather than a
 * re-encryption of every credential — see `scripts/rewrap-deks.ts`.
 *
 * ## Rotation
 *
 * `CODENAYA_LOCAL_KEK` is the active key and wraps all new DEKs.
 * `CODENAYA_LOCAL_KEK_RETIRED` optionally holds a comma-separated list of older
 * keys that are still accepted for unwrapping. That combination allows a
 * rotation with no downtime and no bulk migration: promote a new key, demote the
 * old one to the retired list, then re-wrap in the background at leisure.
 *
 * Keys are identified by a short fingerprint (a SHA-256 prefix) rather than by
 * position, so reordering the retired list cannot silently break decryption.
 */

import { createHash } from "node:crypto";

import { DEK_LENGTH, unwrapBytes, wrapBytes } from "../envelope";
import type { KekProvider } from "../types";

export const LOCAL_KEK_PROVIDER_ID = "local";

/**
 * Binds a wrapped DEK to its purpose. Without this, a KEK-encrypted blob from
 * some other context could be substituted in as a wrapped DEK.
 */
const DEK_WRAP_AAD = "codenaya:v1:dek-wrap";

/**
 * Derive a short, stable identifier for a key.
 *
 * A SHA-256 prefix is safe to persist and to log: it identifies which key
 * wrapped a given DEK without revealing key material, and it cannot be reversed
 * to recover the key.
 */
export function kekFingerprint(kek: Buffer): string {
  return createHash("sha256").update(kek).digest("hex").slice(0, 16);
}

function decodeKek(value: string, label: string): Buffer {
  const trimmed = value.trim();
  if (trimmed === "") {
    throw new Error(`${label} is empty.`);
  }

  let decoded: Buffer;
  try {
    decoded = Buffer.from(trimmed, "base64");
  } catch {
    throw new Error(`${label} is not valid base64.`);
  }

  if (decoded.length !== DEK_LENGTH) {
    // Guard against the common mistake of pasting a hex string, a truncated
    // value, or a passphrase. A short key would still "work" while providing far
    // less security than the algorithm name implies.
    throw new Error(
      `${label} must decode to exactly ${DEK_LENGTH} bytes (got ${decoded.length}). ` +
        `Generate one with: openssl rand -base64 32`,
    );
  }

  return decoded;
}

export interface LocalKekConfig {
  /** Base64 32-byte active key. */
  activeKek: string;
  /** Base64 32-byte keys accepted for unwrapping only. */
  retiredKeks?: readonly string[];
}

/**
 * Read the local KEK configuration from the environment.
 *
 * Throws with actionable guidance when unset, because starting the server with
 * no KEK would mean either crashing on first use or — far worse — silently
 * falling back to something insecure.
 */
export function readLocalKekConfigFromEnv(): LocalKekConfig {
  const activeKek = process.env.CODENAYA_LOCAL_KEK;
  if (!activeKek || activeKek.trim() === "") {
    throw new Error(
      "CODENAYA_LOCAL_KEK is not set. Generate one with: openssl rand -base64 32",
    );
  }

  const retired = process.env.CODENAYA_LOCAL_KEK_RETIRED;
  const retiredKeks = retired
    ? retired
        .split(",")
        .map((entry) => entry.trim())
        .filter((entry) => entry !== "")
    : [];

  return { activeKek, retiredKeks };
}

export function createLocalKekProvider(config: LocalKekConfig): KekProvider {
  const active = decodeKek(config.activeKek, "CODENAYA_LOCAL_KEK");
  const activeKeyId = kekFingerprint(active);

  // Fingerprint -> key, so unwrap is a lookup rather than a trial-and-error loop
  // over every candidate key.
  const byFingerprint = new Map<string, Buffer>([[activeKeyId, active]]);

  config.retiredKeks?.forEach((entry, index) => {
    const key = decodeKek(entry, `CODENAYA_LOCAL_KEK_RETIRED[${index}]`);
    const fingerprint = kekFingerprint(key);
    if (fingerprint === activeKeyId) {
      throw new Error(
        "CODENAYA_LOCAL_KEK_RETIRED contains the active key. Remove it from the retired list.",
      );
    }
    byFingerprint.set(fingerprint, key);
  });

  return {
    id: LOCAL_KEK_PROVIDER_ID,
    activeKeyId,

    async wrapDek(dek: Buffer): Promise<string> {
      return wrapBytes(dek, active, DEK_WRAP_AAD);
    },

    async unwrapDek(wrappedDek: string, keyId: string): Promise<Buffer> {
      const key = byFingerprint.get(keyId);
      if (!key) {
        throw new Error(
          `No local KEK matches key id "${keyId}". The key that sealed this record ` +
            `is neither CODENAYA_LOCAL_KEK nor listed in CODENAYA_LOCAL_KEK_RETIRED.`,
        );
      }
      return unwrapBytes(wrappedDek, key, DEK_WRAP_AAD);
    },
  };
}
