import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  clearDekCache,
  resetSecretSealer,
} from "@/features/integrations/server/crypto";

import { openProviderKey, sealProviderKey } from "./sealed-key";

const API_KEY = "sk-proj-abcdefghijklmnopqrstuvwxyz0123456789wxyz";

beforeEach(() => {
  // A throwaway KEK: these tests never touch a real one.
  vi.stubEnv("CODENAYA_KEK_PROVIDER", "local");
  vi.stubEnv("CODENAYA_LOCAL_KEK", randomBytes(32).toString("base64"));
  resetSecretSealer();
  clearDekCache();
});

afterEach(() => {
  vi.unstubAllEnvs();
  resetSecretSealer();
});

describe("sealProviderKey", () => {
  it("round-trips through the envelope sealer", async () => {
    const sealed = await sealProviderKey(API_KEY);
    expect(await openProviderKey(sealed)).toBe(API_KEY);
  });

  it("stores no plaintext and previews only the last four characters", async () => {
    const sealed = await sealProviderKey(API_KEY);
    expect(sealed.maskedPreview).toBe("••••wxyz");
    for (const value of Object.values(sealed)) {
      expect(value).not.toContain(API_KEY.slice(0, 12));
    }
  });

  it("binds the ciphertext to its own row", async () => {
    const a = await sealProviderKey(API_KEY);
    const b = await sealProviderKey(API_KEY);
    expect(a.secretRef).not.toBe(b.secretRef);
    await expect(openProviderKey({ ...a, secretRef: b.secretRef })).rejects.toThrow();
  });

  it("will not open under a different KEK", async () => {
    const sealed = await sealProviderKey(API_KEY);
    vi.stubEnv("CODENAYA_LOCAL_KEK", randomBytes(32).toString("base64"));
    resetSecretSealer();
    clearDekCache();
    await expect(openProviderKey(sealed)).rejects.toThrow();
  });
});
