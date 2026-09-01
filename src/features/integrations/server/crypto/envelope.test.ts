import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  AUTH_TAG_LENGTH,
  DEK_LENGTH,
  IV_LENGTH,
  decryptWithDek,
  encryptWithDek,
  generateDek,
  unwrapBytes,
  wrapBytes,
} from "./envelope";

const AAD = "codenaya:v1:userConnections:abc123:accessToken";

describe("generateDek", () => {
  it("returns 32 bytes", () => {
    expect(generateDek()).toHaveLength(DEK_LENGTH);
  });

  it("does not repeat", () => {
    const keys = new Set(
      Array.from({ length: 50 }, () => generateDek().toString("hex")),
    );
    expect(keys.size).toBe(50);
  });
});

describe("encryptWithDek / decryptWithDek", () => {
  it("round-trips a value", () => {
    const dek = generateDek();
    const secret = "sbp_1234567890abcdefghijklmnop";

    const sealed = encryptWithDek(secret, dek, AAD);
    expect(decryptWithDek(sealed, dek, AAD)).toBe(secret);
  });

  it("round-trips unicode and long values", () => {
    const dek = generateDek();
    for (const secret of [
      "",
      "a",
      "🔐 clé — ключ — 鍵",
      "x".repeat(100_000),
      JSON.stringify({ refresh_token: "rt_abc", scope: ["read", "write"] }),
    ]) {
      const sealed = encryptWithDek(secret, dek, AAD);
      expect(decryptWithDek(sealed, dek, AAD)).toBe(secret);
    }
  });

  it("never emits the plaintext in the payload", () => {
    const dek = generateDek();
    const secret = "SUPER_DISTINCTIVE_TOKEN_VALUE";
    const sealed = encryptWithDek(secret, dek, AAD);

    const serialized = JSON.stringify(sealed);
    expect(serialized).not.toContain(secret);
    expect(Buffer.from(sealed.ciphertext, "base64").toString("utf8")).not.toBe(
      secret,
    );
  });

  it("uses a fresh IV per call, so identical plaintexts differ", () => {
    const dek = generateDek();
    const a = encryptWithDek("same", dek, AAD);
    const b = encryptWithDek("same", dek, AAD);

    expect(a.iv).not.toBe(b.iv);
    expect(a.ciphertext).not.toBe(b.ciphertext);
  });

  it("emits correctly sized IV and auth tag", () => {
    const sealed = encryptWithDek("v", generateDek(), AAD);
    expect(Buffer.from(sealed.iv, "base64")).toHaveLength(IV_LENGTH);
    expect(Buffer.from(sealed.authTag, "base64")).toHaveLength(AUTH_TAG_LENGTH);
  });

  it("fails with the wrong DEK", () => {
    const sealed = encryptWithDek("secret", generateDek(), AAD);
    expect(() => decryptWithDek(sealed, generateDek(), AAD)).toThrow();
  });

  it("fails when the AAD does not match", () => {
    // This is what prevents a sealed blob from being moved between records.
    const dek = generateDek();
    const sealed = encryptWithDek("secret", dek, AAD);

    expect(() =>
      decryptWithDek(
        sealed,
        dek,
        "codenaya:v1:userConnections:DIFFERENT:accessToken",
      ),
    ).toThrow();
  });

  it("fails when the ciphertext is tampered with", () => {
    const dek = generateDek();
    const sealed = encryptWithDek("secret value here", dek, AAD);

    const bytes = Buffer.from(sealed.ciphertext, "base64");
    bytes[0] ^= 0xff;

    expect(() =>
      decryptWithDek(
        { ...sealed, ciphertext: bytes.toString("base64") },
        dek,
        AAD,
      ),
    ).toThrow();
  });

  it("fails when the auth tag is tampered with", () => {
    const dek = generateDek();
    const sealed = encryptWithDek("secret", dek, AAD);

    const tag = Buffer.from(sealed.authTag, "base64");
    tag[0] ^= 0xff;

    expect(() =>
      decryptWithDek({ ...sealed, authTag: tag.toString("base64") }, dek, AAD),
    ).toThrow();
  });

  it("fails when the IV is tampered with", () => {
    const dek = generateDek();
    const sealed = encryptWithDek("secret", dek, AAD);

    const iv = Buffer.from(sealed.iv, "base64");
    iv[0] ^= 0xff;

    expect(() =>
      decryptWithDek({ ...sealed, iv: iv.toString("base64") }, dek, AAD),
    ).toThrow();
  });

  it("rejects a malformed IV length before attempting decryption", () => {
    const dek = generateDek();
    const sealed = encryptWithDek("secret", dek, AAD);

    expect(() =>
      decryptWithDek(
        { ...sealed, iv: randomBytes(8).toString("base64") },
        dek,
        AAD,
      ),
    ).toThrow(/IV length/);
  });

  it("rejects a malformed auth tag length", () => {
    const dek = generateDek();
    const sealed = encryptWithDek("secret", dek, AAD);

    expect(() =>
      decryptWithDek(
        { ...sealed, authTag: randomBytes(4).toString("base64") },
        dek,
        AAD,
      ),
    ).toThrow(/auth tag length/);
  });

  it("rejects a DEK of the wrong size", () => {
    expect(() => encryptWithDek("v", randomBytes(16), AAD)).toThrow(
      /Invalid DEK length/,
    );
    expect(() => encryptWithDek("v", randomBytes(64), AAD)).toThrow(
      /Invalid DEK length/,
    );
  });
});

describe("wrapBytes / unwrapBytes", () => {
  it("round-trips a DEK", () => {
    const kek = generateDek();
    const dek = generateDek();

    const wrapped = wrapBytes(dek, kek, "codenaya:v1:dek-wrap");
    expect(unwrapBytes(wrapped, kek, "codenaya:v1:dek-wrap")).toEqual(dek);
  });

  it("produces a different token each time", () => {
    const kek = generateDek();
    const dek = generateDek();

    expect(wrapBytes(dek, kek, "aad")).not.toBe(wrapBytes(dek, kek, "aad"));
  });

  it("fails with the wrong KEK", () => {
    const wrapped = wrapBytes(generateDek(), generateDek(), "aad");
    expect(() => unwrapBytes(wrapped, generateDek(), "aad")).toThrow();
  });

  it("fails with a mismatched AAD", () => {
    const kek = generateDek();
    const wrapped = wrapBytes(generateDek(), kek, "codenaya:v1:dek-wrap");
    expect(() => unwrapBytes(wrapped, kek, "some-other-purpose")).toThrow();
  });

  it("rejects a truncated token", () => {
    const kek = generateDek();
    expect(() =>
      unwrapBytes(randomBytes(IV_LENGTH).toString("base64"), kek, "aad"),
    ).toThrow(/too short/);
  });

  it("fails when any byte of the token is flipped", () => {
    const kek = generateDek();
    const wrapped = wrapBytes(generateDek(), kek, "aad");
    const raw = Buffer.from(wrapped, "base64");

    // Flip a byte in each region: IV, tag, ciphertext.
    for (const index of [0, IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH]) {
      const mutated = Buffer.from(raw);
      mutated[index] ^= 0xff;
      expect(() =>
        unwrapBytes(mutated.toString("base64"), kek, "aad"),
      ).toThrow();
    }
  });
});
