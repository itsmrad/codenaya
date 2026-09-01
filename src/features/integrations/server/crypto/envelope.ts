/**
 * AES-256-GCM primitives for the envelope scheme.
 *
 * This module is deliberately free of any notion of where keys come from: it
 * takes a DEK and returns bytes. Key management lives in `./kek/*`, which keeps
 * the cryptography testable against fixed keys and vectors.
 */

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/** AES-256 requires a 32-byte key. */
export const DEK_LENGTH = 32;

/**
 * 96 bits is the GCM-recommended nonce length. Longer nonces are hashed down
 * internally, which buys nothing and costs interoperability.
 */
export const IV_LENGTH = 12;

/** Full-length GCM tag. Truncating it weakens integrity for no real saving. */
export const AUTH_TAG_LENGTH = 16;

const ALGORITHM = "aes-256-gcm";

export interface EncryptedPayload {
  ciphertext: string;
  iv: string;
  authTag: string;
}

/** Generate a fresh 256-bit data encryption key from the CSPRNG. */
export function generateDek(): Buffer {
  return randomBytes(DEK_LENGTH);
}

function assertDek(dek: Buffer): void {
  if (dek.length !== DEK_LENGTH) {
    throw new Error(
      `Invalid DEK length: expected ${DEK_LENGTH} bytes, got ${dek.length}.`,
    );
  }
}

/**
 * Encrypt `plaintext` under `dek`, authenticating `aad`.
 *
 * A fresh IV is generated per call. Reusing an IV under the same key is
 * catastrophic for GCM — it leaks the XOR of the plaintexts and enables forgery
 * — which is why no caller is given the option to supply one.
 */
export function encryptWithDek(
  plaintext: string,
  dek: Buffer,
  aad: string,
): EncryptedPayload {
  assertDek(dek);

  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, dek, iv, {
    authTagLength: AUTH_TAG_LENGTH,
  });
  cipher.setAAD(Buffer.from(aad, "utf8"));

  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);

  return {
    ciphertext: ciphertext.toString("base64"),
    iv: iv.toString("base64"),
    authTag: cipher.getAuthTag().toString("base64"),
  };
}

/**
 * Decrypt a payload produced by `encryptWithDek`.
 *
 * Throws when the DEK is wrong, the AAD does not match, or any byte of the
 * ciphertext, IV or tag has been altered. GCM verifies the tag inside `final()`,
 * so a tampered payload cannot return partial plaintext.
 */
export function decryptWithDek(
  payload: EncryptedPayload,
  dek: Buffer,
  aad: string,
): string {
  assertDek(dek);

  const iv = Buffer.from(payload.iv, "base64");
  if (iv.length !== IV_LENGTH) {
    throw new Error("Invalid IV length; refusing to decrypt.");
  }

  const authTag = Buffer.from(payload.authTag, "base64");
  if (authTag.length !== AUTH_TAG_LENGTH) {
    throw new Error("Invalid auth tag length; refusing to decrypt.");
  }

  const decipher = createDecipheriv(ALGORITHM, dek, iv, {
    authTagLength: AUTH_TAG_LENGTH,
  });
  decipher.setAAD(Buffer.from(aad, "utf8"));
  decipher.setAuthTag(authTag);

  return Buffer.concat([
    decipher.update(Buffer.from(payload.ciphertext, "base64")),
    decipher.final(),
  ]).toString("utf8");
}

/**
 * Wrap arbitrary bytes (in practice, a DEK) under a 256-bit key.
 *
 * The IV and tag are packed into a single opaque token as
 * `iv || authTag || ciphertext` so a wrapped DEK is one string to store and one
 * value to pass around. `aad` binds the wrap to its purpose, preventing a
 * wrapped DEK from being replayed as some other KEK-encrypted value.
 */
export function wrapBytes(
  plaintext: Buffer,
  kek: Buffer,
  aad: string,
): string {
  assertDek(kek);

  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, kek, iv, {
    authTagLength: AUTH_TAG_LENGTH,
  });
  cipher.setAAD(Buffer.from(aad, "utf8"));

  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);

  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString("base64");
}

/** Inverse of `wrapBytes`. Throws on any tampering or key mismatch. */
export function unwrapBytes(token: string, kek: Buffer, aad: string): Buffer {
  assertDek(kek);

  const raw = Buffer.from(token, "base64");
  const minimumLength = IV_LENGTH + AUTH_TAG_LENGTH;
  if (raw.length <= minimumLength) {
    throw new Error("Wrapped key token is too short to be valid.");
  }

  const iv = raw.subarray(0, IV_LENGTH);
  const authTag = raw.subarray(IV_LENGTH, minimumLength);
  const ciphertext = raw.subarray(minimumLength);

  const decipher = createDecipheriv(ALGORITHM, kek, iv, {
    authTagLength: AUTH_TAG_LENGTH,
  });
  decipher.setAAD(Buffer.from(aad, "utf8"));
  decipher.setAuthTag(authTag);

  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}
