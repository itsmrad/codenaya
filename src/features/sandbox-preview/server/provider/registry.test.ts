import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ create: vi.fn(), list: vi.fn(), createBlaxelProvider: vi.fn() }));

vi.mock("e2b", async (importOriginal) => ({
  ...(await importOriginal<typeof import("e2b")>()),
  Sandbox: { create: mocks.create, list: mocks.list },
}));

// The adapter's own tests mock @blaxel/core; here only its wiring matters.
vi.mock("./blaxel", () => ({ createBlaxelProvider: mocks.createBlaxelProvider }));

import { RateLimitError } from "e2b";

import { PROVIDER_KEYS, parseProviderConfig } from "./config";
import { createProviderCooldown, createWithFailover } from "./failover";
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
import { selectProviders } from "./select";
import { type SandboxProvider, SandboxConfigError, SandboxRateLimitError } from "./types";

const handle = (sandboxId: string) => ({ sandboxId });
const blaxelSandbox = { provider: "blaxel" as const, id: "cn-a1b2c3d4e5f6g7h8i9j0" };
const fakeBlaxel = (): SandboxProvider => ({
  id: "blaxel", maxSessionMs: 3_600_000,
  create: vi.fn().mockResolvedValue(blaxelSandbox),
  connect: vi.fn(),
  list: vi.fn().mockResolvedValue([{ id: blaxelSandbox.id, metadata: { userId: "u1" }, endAt: new Date(0) }]),
  kill: vi.fn(),
});
const stubKeys = (...ids: (keyof typeof PROVIDER_KEYS)[]) => {
  for (const id of ids) for (const key of PROVIDER_KEYS[id]) vi.stubEnv(key, `${key}_value`);
};

describe("sandbox provider registry", () => {
  // No key or provider choice leaks in from the shell (infisical run sets real ones).
  beforeEach(() => {
    for (const key of Object.values(PROVIDER_KEYS).flat()) vi.stubEnv(key, "");
    vi.stubEnv("SANDBOX_PROVIDER", "");
    vi.stubEnv("SANDBOX_PROVIDER_FALLBACKS", "");
  });

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

  it("keeps Blaxel dark unless both BL_API_KEY and BL_WORKSPACE are set", () => {
    vi.stubEnv("BL_API_KEY", "bl_key");

    expect(() => getProvider("blaxel")).toThrow(SandboxConfigError);
    expect(getConfiguredProviders()).toEqual([]);
    expect(mocks.createBlaxelProvider).not.toHaveBeenCalled();

    vi.stubEnv("BL_WORKSPACE", "workspace");
    mocks.createBlaxelProvider.mockReturnValue(fakeBlaxel());
    stubKeys("e2b");
    expect(getProvider("blaxel").id).toBe("blaxel");
    expect(getConfiguredProviders().map(({ id }) => id)).toEqual(["e2b", "blaxel"]);
  });

  it("fails over from an E2B rate limit to Blaxel, and counts sandboxes on both", async () => {
    stubKeys("e2b", "blaxel");
    vi.stubEnv("SANDBOX_PROVIDER_FALLBACKS", "blaxel");
    const blaxel = fakeBlaxel();
    mocks.createBlaxelProvider.mockReturnValue(blaxel);
    mocks.create.mockRejectedValue(new RateLimitError("slow down"));
    mocks.list.mockReturnValue({ nextItems: async () => [{ sandboxId: "sbx_1", metadata: { userId: "u1" }, endAt: new Date(0) }] });
    const onNotice = vi.fn();
    // createSandbox's own path, with a fresh cooldown so later tests still reach E2B.
    const config = parseProviderConfig();
    const cooldown = createProviderCooldown();
    const providers = selectProviders(config, cooldown).map(getProvider);

    const sandbox = await createWithFailover({ timeoutMs: 1, metadata: {} }, { providers, cooldown, onNotice });
    expect(sandbox).toBe(blaxelSandbox);
    expect(mocks.create).toHaveBeenCalledTimes(1);
    expect(cooldown.isCoolingDown("e2b")).toBe(true);
    expect(onNotice).toHaveBeenCalledExactlyOnceWith("E2B unavailable, continuing on blaxel...");
    expect(isMultiProvider(config)).toBe(true);
    expect(clientSandboxId(sandbox, isMultiProvider(config))).toBe(`blaxel:${blaxelSandbox.id}`);
    expect(await countLive(getConfiguredProviders(config), { userId: "u1" })).toBe(2);
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
