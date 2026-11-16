import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ create: vi.fn(), list: vi.fn() }));

vi.mock("e2b", async (importOriginal) => ({
  ...(await importOriginal<typeof import("e2b")>()),
  Sandbox: { create: mocks.create, list: mocks.list },
}));

import { RateLimitError } from "e2b";

import { countLive, listAll } from "./fanout";
import { clientSandboxId } from "./ids";
import {
  createSandbox,
  getConfiguredProviders,
  getDefaultProvider,
  getDefaultProviderOrNull,
  getProvider,
  isMultiProvider,
} from "./registry";
import { SandboxConfigError, SandboxRateLimitError } from "./types";

const handle = (sandboxId: string) => ({ sandboxId });

describe("sandbox provider registry", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetAllMocks();
  });

  it("returns the E2B adapter when its key is set", () => {
    vi.stubEnv("E2B_API_KEY", " key_1 ");

    expect(getProvider("e2b").id).toBe("e2b");
    expect(getDefaultProvider().id).toBe("e2b");
    expect(getDefaultProviderOrNull()?.id).toBe("e2b");
  });

  it("treats a provider without a key as not configured", () => {
    vi.stubEnv("E2B_API_KEY", " ");

    expect(() => getDefaultProvider()).toThrow(SandboxConfigError);
    expect(() => getDefaultProvider()).toThrow("E2B_API_KEY is not set");
    expect(getDefaultProviderOrNull()).toBeNull();
    expect(getConfiguredProviders()).toEqual([]);
  });

  describe("with one provider and no fallbacks (today's production)", () => {
    it("keeps ids unprefixed and lists, counts and kills on that provider alone, as before", async () => {
      vi.stubEnv("E2B_API_KEY", "key_1");
      const providers = getConfiguredProviders();
      const running = [{ sandboxId: "sbx_1", metadata: { userId: "u1" }, endAt: new Date(0) }];
      mocks.list.mockReturnValue({ nextItems: async () => running });

      expect(providers.map(({ id }) => id)).toEqual(["e2b"]);
      expect(isMultiProvider()).toBe(false);
      expect(clientSandboxId({ provider: "e2b", id: "sbx_1" }, isMultiProvider())).toBe("sbx_1");
      expect(await listAll(providers, { metadata: { userId: "u1" }, limit: 3 })).toEqual(
        (await providers[0].list({ metadata: { userId: "u1" }, limit: 3 })).map((sandbox) => ({ ...sandbox, provider: "e2b" })),
      );
      expect(await countLive(providers, { userId: "u1" })).toBe(1);
      expect(mocks.list).toHaveBeenCalledWith(expect.objectContaining({ limit: 3, query: { metadata: { userId: "u1" }, state: ["running"] } }));
    });

    it("creates once on the primary, with no cooldown after a rate limit", async () => {
      vi.stubEnv("E2B_API_KEY", "key_1");
      mocks.create.mockRejectedValueOnce(new RateLimitError("slow down")).mockResolvedValue(handle("sbx_2"));
      const onNotice = vi.fn();

      await expect(createSandbox({ timeoutMs: 1, metadata: {} }, onNotice)).rejects.toBeInstanceOf(SandboxRateLimitError);
      expect((await createSandbox({ timeoutMs: 1, metadata: {} }, onNotice)).id).toBe("sbx_2");
      expect(mocks.create).toHaveBeenCalledTimes(2);
      expect(onNotice).not.toHaveBeenCalled();
    });
  });

  it("creates through failover and its cooldown once fallbacks are set", async () => {
    vi.stubEnv("E2B_API_KEY", "key_1");
    const config = { primary: "e2b" as const, fallbacks: ["e2b" as const], configured: { e2b: true } };
    mocks.create.mockRejectedValue(new RateLimitError("slow down"));

    expect(isMultiProvider(config)).toBe(true);
    expect(clientSandboxId({ provider: "e2b", id: "sbx_3" }, isMultiProvider(config))).toBe("e2b:sbx_3");
    await expect(createSandbox({ timeoutMs: 1, metadata: {} }, undefined, config)).rejects.toBeInstanceOf(SandboxRateLimitError);
    // The rate limit cooled E2B down, so the next boot doesn't hit it again.
    await expect(createSandbox({ timeoutMs: 1, metadata: {} }, undefined, config)).rejects.toBeInstanceOf(SandboxConfigError);
    expect(mocks.create).toHaveBeenCalledTimes(1);
  });
});
