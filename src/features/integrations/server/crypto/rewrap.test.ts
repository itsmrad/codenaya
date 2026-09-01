import { randomBytes } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";

import { clearDekCache, createSecretSealer } from "./index";
import { createLocalKekProvider } from "./kek/local";
import { rewrapSealedSecret } from "./rewrap";
import { secretContext } from "./types";

const OLD_KEK = randomBytes(32).toString("base64");
const NEW_KEK = randomBytes(32).toString("base64");

const AAD = secretContext("userConnections", "conn_1", "accessToken");

// Two providers standing in for "old KMS" and "new KMS". Both are local, which
// is fine: the contract under test is the KekProvider interface, not any
// particular backend.
const oldProvider = createLocalKekProvider({ activeKek: OLD_KEK });
const newProvider = createLocalKekProvider({ activeKek: NEW_KEK });

beforeEach(() => {
  clearDekCache();
});

describe("rewrapSealedSecret", () => {
  it("leaves the encrypted payload byte-identical", async () => {
    // This is the property that makes a KEK migration cheap. If any of these
    // three fields changed, we would be re-encrypting credential data and the
    // migration story in the plan would be wrong.
    const sealed = await createSecretSealer(oldProvider).seal("token-abc", AAD);
    const { sealed: rewrapped } = await rewrapSealedSecret(
      sealed,
      oldProvider,
      newProvider,
    );

    expect(rewrapped.ciphertext).toBe(sealed.ciphertext);
    expect(rewrapped.iv).toBe(sealed.iv);
    expect(rewrapped.authTag).toBe(sealed.authTag);
  });

  it("changes only the wrapped DEK and its provider metadata", async () => {
    const sealed = await createSecretSealer(oldProvider).seal("token-abc", AAD);
    const { sealed: rewrapped } = await rewrapSealedSecret(
      sealed,
      oldProvider,
      newProvider,
    );

    expect(rewrapped.wrappedDek).not.toBe(sealed.wrappedDek);
    expect(rewrapped.kekProvider).toBe(newProvider.id);
    expect(rewrapped.kekKeyId).toBe(newProvider.activeKeyId);
  });

  it("still decrypts to the original plaintext under the new provider", async () => {
    const secret = "sbp_live_migration_check";
    const sealed = await createSecretSealer(oldProvider).seal(secret, AAD);

    const { sealed: rewrapped } = await rewrapSealedSecret(
      sealed,
      oldProvider,
      newProvider,
    );

    clearDekCache();
    expect(await createSecretSealer(newProvider).open(rewrapped, AAD)).toBe(
      secret,
    );
  });

  it("preserves AAD binding after migration", async () => {
    const sealed = await createSecretSealer(oldProvider).seal("secret", AAD);
    const { sealed: rewrapped } = await rewrapSealedSecret(
      sealed,
      oldProvider,
      newProvider,
    );

    clearDekCache();
    const wrongRow = secretContext("userConnections", "conn_2", "accessToken");
    await expect(
      createSecretSealer(newProvider).open(rewrapped, wrongRow),
    ).rejects.toThrow();
  });

  it("is idempotent for rows already on the target provider", async () => {
    const sealed = await createSecretSealer(newProvider).seal("secret", AAD);

    const result = await rewrapSealedSecret(sealed, oldProvider, newProvider);

    expect(result.changed).toBe(false);
    expect(result.sealed).toBe(sealed);
  });

  it("reports changed=true when a re-wrap actually happened", async () => {
    const sealed = await createSecretSealer(oldProvider).seal("secret", AAD);
    const result = await rewrapSealedSecret(sealed, oldProvider, newProvider);
    expect(result.changed).toBe(true);
  });

  it("refuses a row that was not sealed by the source provider", async () => {
    const sealed = await createSecretSealer(oldProvider).seal("secret", AAD);
    const mislabelled = { ...sealed, kekProvider: "gcp-kms" };

    // Unwrapping with the wrong key would corrupt the row, so this must throw
    // rather than proceed.
    await expect(
      rewrapSealedSecret(mislabelled, oldProvider, newProvider),
    ).rejects.toThrow(/was sealed by "gcp-kms"/);
  });

  it("supports a full batch migration, leaving every row readable", async () => {
    const oldSealer = createSecretSealer(oldProvider);
    const secrets = ["a-token", "b-token", "c-token"];
    const rows = await Promise.all(secrets.map((s) => oldSealer.seal(s, AAD)));

    const migrated = await Promise.all(
      rows.map((row) => rewrapSealedSecret(row, oldProvider, newProvider)),
    );

    clearDekCache();
    const newSealer = createSecretSealer(newProvider);
    const recovered = await Promise.all(
      migrated.map((m) => newSealer.open(m.sealed, AAD)),
    );

    expect(recovered).toEqual(secrets);
    expect(migrated.every((m) => m.changed)).toBe(true);
  });

  it("is safe to re-run over a partially migrated set", async () => {
    const oldSealer = createSecretSealer(oldProvider);
    const rowA = await oldSealer.seal("a", AAD);
    const rowB = await oldSealer.seal("b", AAD);

    // First pass migrates only rowA, simulating an interrupted job.
    const firstPass = await rewrapSealedSecret(rowA, oldProvider, newProvider);

    // Second pass sees a mixed set; rowA must be skipped, rowB migrated.
    const retryA = await rewrapSealedSecret(
      firstPass.sealed,
      oldProvider,
      newProvider,
    );
    const retryB = await rewrapSealedSecret(rowB, oldProvider, newProvider);

    expect(retryA.changed).toBe(false);
    expect(retryB.changed).toBe(true);

    clearDekCache();
    const newSealer = createSecretSealer(newProvider);
    expect(await newSealer.open(retryA.sealed, AAD)).toBe("a");
    expect(await newSealer.open(retryB.sealed, AAD)).toBe("b");
  });
});
