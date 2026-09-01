/**
 * KEK migration: move a sealed record from one KEK provider to another.
 *
 * ## Why this is cheap
 *
 * The secret itself is encrypted under a DEK, and the DEK is what the KEK wraps.
 * Changing KEK provider therefore only requires re-wrapping the DEK — the
 * ciphertext, IV and auth tag are copied through untouched. There is no
 * decrypt-and-re-encrypt of credential material, so a migration is a pass over
 * one short column and can run incrementally while the application serves
 * traffic.
 *
 * `rewrapSealedSecret` never sees the plaintext credential. It handles key
 * material only, which means a migration cannot accidentally log or leak a
 * token.
 *
 * ## Running a migration
 *
 * 1. Configure the new provider's credentials alongside the current one.
 * 2. Re-wrap rows in batches. Rows already on the target provider are skipped,
 *    so the job is idempotent and safe to re-run after an interruption.
 * 3. Once no rows reference the old provider, switch
 *    `CODENAYA_KEK_PROVIDER` and retire the old key.
 *
 * Old and new rows stay readable throughout, because each row records the
 * provider and key id that sealed it.
 */

import type { KekProvider, SealedSecret } from "./types";

export interface RewrapResult {
  sealed: SealedSecret;
  /** False when the record already belonged to the target provider. */
  changed: boolean;
}

/**
 * Re-wrap one record's DEK from `from` to `to`.
 *
 * @throws when the record was not sealed by `from`, which would otherwise mean
 * unwrapping with the wrong key and producing a corrupt row.
 */
export async function rewrapSealedSecret(
  sealed: SealedSecret,
  from: KekProvider,
  to: KekProvider,
): Promise<RewrapResult> {
  // Idempotency: a re-run after a partial migration must not touch rows that
  // already moved.
  if (
    sealed.kekProvider === to.id &&
    sealed.kekKeyId === to.activeKeyId
  ) {
    return { sealed, changed: false };
  }

  if (sealed.kekProvider !== from.id) {
    throw new Error(
      `Cannot re-wrap: record was sealed by "${sealed.kekProvider}" but the source ` +
        `provider is "${from.id}".`,
    );
  }

  const dek = await from.unwrapDek(sealed.wrappedDek, sealed.kekKeyId);
  const wrappedDek = await to.wrapDek(dek);

  return {
    changed: true,
    sealed: {
      // Payload fields are carried over verbatim — this is the whole reason a
      // KEK migration is cheap.
      ciphertext: sealed.ciphertext,
      iv: sealed.iv,
      authTag: sealed.authTag,
      wrappedDek,
      kekProvider: to.id,
      kekKeyId: to.activeKeyId,
    },
  };
}
