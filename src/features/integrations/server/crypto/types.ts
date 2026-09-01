/**
 * Types for envelope encryption of integration credentials.
 *
 * ## The scheme
 *
 * Every secret gets its own randomly generated 256-bit data encryption key
 * (DEK). The secret is encrypted locally with AES-256-GCM under that DEK, and
 * the DEK itself is wrapped by a long-lived key encryption key (KEK). Only the
 * wrapped DEK and the ciphertext are persisted; the KEK never touches the
 * database.
 *
 * ## Why envelope encryption rather than encrypting directly with the KEK
 *
 * Three reasons, in order of importance:
 *
 * 1. **Cheap KEK migration.** Moving from a local KEK to a hosted KMS means
 *    re-wrapping DEKs — a pass over one small column — instead of decrypting
 *    and re-encrypting every stored credential. See `scripts/rewrap-deks.ts`.
 * 2. **Bounded KMS traffic.** A network-backed KEK provider is called once per
 *    DEK unwrap, not once per byte, and unwraps are cacheable because a DEK is
 *    immutable for the life of its row.
 * 3. **Blast radius.** A leaked DEK exposes exactly one credential.
 */

/**
 * The persisted form of one encrypted secret. Every field is safe to store in
 * Convex; none of them is sufficient to recover the plaintext without the KEK.
 *
 * All binary fields are base64.
 */
export interface SealedSecret {
  /** Which KEK provider wrapped the DEK, e.g. `"local"` or `"gcp-kms"`. */
  kekProvider: string;
  /**
   * Identifies the specific key (and version) that wrapped this DEK, so a
   * rotated KEK can still decrypt rows sealed by its predecessor.
   */
  kekKeyId: string;
  /** The DEK, encrypted under the KEK. */
  wrappedDek: string;
  /** The secret, encrypted under the DEK with AES-256-GCM. */
  ciphertext: string;
  /** 96-bit GCM nonce, unique per seal operation. */
  iv: string;
  /** 128-bit GCM authentication tag. */
  authTag: string;
}

/**
 * Wraps and unwraps DEKs. Implementations are the swappable part of the
 * scheme: `local` keeps the KEK in an environment variable, `gcp-kms` delegates
 * to Cloud KMS.
 */
export interface KekProvider {
  /** Stable provider discriminator persisted in `SealedSecret.kekProvider`. */
  readonly id: string;
  /**
   * Identifier of the key currently used for *new* wraps. Unwrapping may still
   * accept older key ids to support rotation.
   */
  readonly activeKeyId: string;
  wrapDek(dek: Buffer): Promise<string>;
  unwrapDek(wrappedDek: string, keyId: string): Promise<Buffer>;
}

/**
 * Application-facing API. Callers deal in plaintext strings and `SealedSecret`
 * records and never see DEKs.
 */
export interface SecretSealer {
  /**
   * Encrypt `plaintext`, binding the result to `aad`.
   *
   * @param aad Additional authenticated data. Not secret and not stored — it is
   * recomputed from the row's own identity at open time. This binds a
   * ciphertext to the record that owns it, so relocating a sealed blob to a
   * different row makes it undecryptable rather than silently valid. See
   * `secretContext` for the canonical format.
   */
  seal(plaintext: string, aad: string): Promise<SealedSecret>;
  open(sealed: SealedSecret, aad: string): Promise<string>;
}

/**
 * Build the AAD string that binds a ciphertext to one field of one record.
 *
 * Must be derivable from data the caller already has at open time, and must not
 * include anything that legitimately changes while the ciphertext stays the
 * same (a mutable label, for instance) or decryption would break on rename.
 *
 * @example secretContext("userConnections", connectionId, "accessToken")
 */
export function secretContext(
  table: string,
  recordId: string,
  field: string,
): string {
  return `codenaya:v1:${table}:${recordId}:${field}`;
}
