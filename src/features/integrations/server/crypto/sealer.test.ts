import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  clearDekCache,
  createSecretSealer,
  getSecretSealer,
  resetSecretSealer,
  resolveKekProviderId,
} from "./index";
import {
  createLocalKekProvider,
  kekFingerprint,
  readLocalKekConfigFromEnv,
} from "./kek/local";
import { secretContext, type KekProvider } from "./types";

const KEK_A = randomBytes(32).toString("base64");
const KEK_B = randomBytes(32).toString("base64");

const AAD = secretContext("userConnections", "conn_1", "accessToken");

function localSealer(activeKek: string, retiredKeks: string[] = []) {
  return createSecretSealer(
    createLocalKekProvider({ activeKek, retiredKeks }),
  );
}

beforeEach(() => {
  resetSecretSealer();
  clearDekCache();
});

afterEach(() => {
  vi.unstubAllEnvs();
  resetSecretSealer();
});

describe("secretContext", () => {
  it("is stable and includes table, record and field", () => {
    expect(secretContext("userConnections", "abc", "accessToken")).toBe(
      "codenaya:v1:userConnections:abc:accessToken",
    );
  });

  it("differs per field so two secrets on one row are not interchangeable", () => {
    const access = secretContext("userConnections", "abc", "accessToken");
    const refresh = secretContext("userConnections", "abc", "refreshToken");
    expect(access).not.toBe(refresh);
  });
});

describe("seal / open with the local provider", () => {
  it("round-trips a credential", async () => {
    const sealer = localSealer(KEK_A);
    const secret = "sbp_live_abcdefghijklmnopqrstuvwxyz";

    const sealed = await sealer.seal(secret, AAD);
    expect(await sealer.open(sealed, AAD)).toBe(secret);
  });

  it("records the provider id and key fingerprint", async () => {
    const sealed = await localSealer(KEK_A).seal("v", AAD);

    expect(sealed.kekProvider).toBe("local");
    expect(sealed.kekKeyId).toBe(kekFingerprint(Buffer.from(KEK_A, "base64")));
  });

  it("never leaks plaintext into the persisted record", async () => {
    const secret = "UNIQUE_SENTINEL_TOKEN_98765";
    const sealed = await localSealer(KEK_A).seal(secret, AAD);

    // This is the property that matters most: whatever we hand to Convex must
    // not contain the secret in any field, in any encoding.
    expect(JSON.stringify(sealed)).not.toContain(secret);
    for (const value of Object.values(sealed)) {
      expect(Buffer.from(String(value), "base64").toString("utf8")).not.toContain(
        secret,
      );
    }
  });

  it("uses a distinct DEK per secret", async () => {
    const sealer = localSealer(KEK_A);
    const a = await sealer.seal("one", AAD);
    const b = await sealer.seal("two", AAD);

    expect(a.wrappedDek).not.toBe(b.wrappedDek);
  });

  it("fails to open under a different AAD", async () => {
    const sealer = localSealer(KEK_A);
    const sealed = await sealer.seal("secret", AAD);

    // Simulates a sealed blob copied into another user's row.
    const otherRow = secretContext("userConnections", "conn_2", "accessToken");
    await expect(sealer.open(sealed, otherRow)).rejects.toThrow();
  });

  it("fails to open with an unrelated KEK", async () => {
    const sealed = await localSealer(KEK_A).seal("secret", AAD);
    await expect(localSealer(KEK_B).open(sealed, AAD)).rejects.toThrow(
      /No local KEK matches key id/,
    );
  });

  it("rejects a record sealed by a different provider", async () => {
    const sealed = await localSealer(KEK_A).seal("secret", AAD);
    const foreign = { ...sealed, kekProvider: "gcp-kms" };

    await expect(localSealer(KEK_A).open(foreign, AAD)).rejects.toThrow(
      /CODENAYA_KEK_PROVIDER=gcp-kms/,
    );
  });

  it("detects tampering with the stored ciphertext", async () => {
    const sealer = localSealer(KEK_A);
    const sealed = await sealer.seal("secret value", AAD);

    const bytes = Buffer.from(sealed.ciphertext, "base64");
    bytes[0] ^= 0xff;

    await expect(
      sealer.open({ ...sealed, ciphertext: bytes.toString("base64") }, AAD),
    ).rejects.toThrow();
  });
});

describe("KEK rotation", () => {
  it("opens rows sealed by a retired key", async () => {
    const sealedUnderA = await localSealer(KEK_A).seal("old-secret", AAD);

    // KEK_B is now active; KEK_A is retained for decryption only.
    const rotated = localSealer(KEK_B, [KEK_A]);
    expect(await rotated.open(sealedUnderA, AAD)).toBe("old-secret");
  });

  it("seals new rows under the active key, not a retired one", async () => {
    const rotated = localSealer(KEK_B, [KEK_A]);
    const sealed = await rotated.seal("new-secret", AAD);

    expect(sealed.kekKeyId).toBe(kekFingerprint(Buffer.from(KEK_B, "base64")));
  });

  it("keeps old and new rows readable simultaneously", async () => {
    const sealedUnderA = await localSealer(KEK_A).seal("old", AAD);
    const rotated = localSealer(KEK_B, [KEK_A]);
    const sealedUnderB = await rotated.seal("new", AAD);

    expect(await rotated.open(sealedUnderA, AAD)).toBe("old");
    expect(await rotated.open(sealedUnderB, AAD)).toBe("new");
  });

  it("refuses a config where the active key is also listed as retired", () => {
    // Silently accepting this would make rotation look complete while the old
    // key was still in active use.
    expect(() => localSealer(KEK_A, [KEK_A])).toThrow(/contains the active key/);
  });
});

describe("DEK cache", () => {
  function countingProvider(): { provider: KekProvider; unwraps: () => number } {
    const inner = createLocalKekProvider({ activeKek: KEK_A });
    let unwraps = 0;
    return {
      unwraps: () => unwraps,
      provider: {
        id: inner.id,
        activeKeyId: inner.activeKeyId,
        wrapDek: (dek) => inner.wrapDek(dek),
        unwrapDek: (wrapped, keyId) => {
          unwraps += 1;
          return inner.unwrapDek(wrapped, keyId);
        },
      },
    };
  }

  it("unwraps once for repeated opens of the same record", async () => {
    const { provider, unwraps } = countingProvider();
    const sealer = createSecretSealer(provider);
    const sealed = await sealer.seal("secret", AAD);

    await sealer.open(sealed, AAD);
    await sealer.open(sealed, AAD);
    await sealer.open(sealed, AAD);

    expect(unwraps()).toBe(1);
  });

  it("unwraps again after the cache is cleared", async () => {
    const { provider, unwraps } = countingProvider();
    const sealer = createSecretSealer(provider);
    const sealed = await sealer.seal("secret", AAD);

    await sealer.open(sealed, AAD);
    clearDekCache();
    await sealer.open(sealed, AAD);

    expect(unwraps()).toBe(2);
  });

  it("unwraps again once the TTL has elapsed", async () => {
    vi.useFakeTimers();
    try {
      const { provider, unwraps } = countingProvider();
      const sealer = createSecretSealer(provider);
      const sealed = await sealer.seal("secret", AAD);

      await sealer.open(sealed, AAD);
      vi.advanceTimersByTime(5 * 60 * 1000 + 1);
      await sealer.open(sealed, AAD);

      expect(unwraps()).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not confuse two records with different DEKs", async () => {
    const sealer = localSealer(KEK_A);
    const first = await sealer.seal("first-secret", AAD);
    const second = await sealer.seal("second-secret", AAD);

    expect(await sealer.open(first, AAD)).toBe("first-secret");
    expect(await sealer.open(second, AAD)).toBe("second-secret");
  });
});

describe("resolveKekProviderId", () => {
  it("defaults to local when unset", () => {
    vi.stubEnv("CODENAYA_KEK_PROVIDER", "");
    expect(resolveKekProviderId()).toBe("local");
  });

  it("accepts local and gcp-kms, case-insensitively", () => {
    vi.stubEnv("CODENAYA_KEK_PROVIDER", "LOCAL");
    expect(resolveKekProviderId()).toBe("local");

    vi.stubEnv("CODENAYA_KEK_PROVIDER", " GCP-KMS ");
    expect(resolveKekProviderId()).toBe("gcp-kms");
  });

  it("throws on an unrecognised value rather than falling back", () => {
    // A typo must not silently seal data under an unintended key.
    vi.stubEnv("CODENAYA_KEK_PROVIDER", "vault");
    expect(() => resolveKekProviderId()).toThrow(/Unknown CODENAYA_KEK_PROVIDER/);
  });
});

describe("readLocalKekConfigFromEnv", () => {
  it("throws with actionable guidance when the KEK is missing", () => {
    vi.stubEnv("CODENAYA_LOCAL_KEK", "");
    expect(() => readLocalKekConfigFromEnv()).toThrow(/openssl rand -base64 32/);
  });

  it("parses a comma-separated retired list, ignoring blanks", () => {
    vi.stubEnv("CODENAYA_LOCAL_KEK", KEK_A);
    vi.stubEnv("CODENAYA_LOCAL_KEK_RETIRED", ` ${KEK_B} , , `);

    expect(readLocalKekConfigFromEnv()).toEqual({
      activeKek: KEK_A,
      retiredKeks: [KEK_B],
    });
  });

  it("rejects a KEK that is not 32 bytes", () => {
    // Catches the common mistakes: a hex string, a passphrase, a truncated key.
    vi.stubEnv("CODENAYA_LOCAL_KEK", randomBytes(16).toString("base64"));
    expect(() =>
      createLocalKekProvider(readLocalKekConfigFromEnv()),
    ).toThrow(/must decode to exactly 32 bytes/);
  });
});

describe("getSecretSealer", () => {
  it("memoises across calls", () => {
    vi.stubEnv("CODENAYA_KEK_PROVIDER", "local");
    vi.stubEnv("CODENAYA_LOCAL_KEK", KEK_A);

    expect(getSecretSealer()).toBe(getSecretSealer());
  });

  it("round-trips through the environment-configured provider", async () => {
    vi.stubEnv("CODENAYA_KEK_PROVIDER", "local");
    vi.stubEnv("CODENAYA_LOCAL_KEK", KEK_A);

    const sealer = getSecretSealer();
    const sealed = await sealer.seal("env-configured", AAD);
    expect(await sealer.open(sealed, AAD)).toBe("env-configured");
  });

  it("rebuilds when the configured provider changes", () => {
    vi.stubEnv("CODENAYA_KEK_PROVIDER", "local");
    vi.stubEnv("CODENAYA_LOCAL_KEK", KEK_A);
    const first = getSecretSealer();

    vi.stubEnv("CODENAYA_GCP_KMS_KEY", "not-a-valid-key-name");
    vi.stubEnv("CODENAYA_KEK_PROVIDER", "gcp-kms");

    // Proves the provider is re-resolved rather than served from cache: the
    // invalid GCP config surfaces instead of the previously built local sealer.
    expect(() => getSecretSealer()).toThrow(/valid crypto key resource name/);
    expect(first).toBeDefined();
  });
});
