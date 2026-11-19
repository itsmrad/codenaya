import { describe, expect, it, vi } from "vitest";
import { parseProviderConfig, sandboxTimeoutMs, type SandboxProviderConfig } from "./config";
import { createProviderCooldown, createWithFailover } from "./failover";
import { countLive, FALLBACK_LIST_TIMEOUT_MS, listAll } from "./fanout";
import { selectProviders } from "./select";
import {
  type CreateOptions, type ProviderId, type Sandbox, type SandboxProvider,
  SandboxConfigError, SandboxRateLimitError, SandboxTimeoutError,
} from "./types";

// Fictional ids exercise future multi-provider behavior without adding production ids.
const second = "test-second" as ProviderId;
const third = "test-third" as ProviderId;
const opts: CreateOptions = { timeoutMs: 3_600_000, metadata: { userId: "alice", projectId: "p" } };
const sandbox = { id: "native", provider: "e2b" } as Sandbox;
const fakeProvider = (id: ProviderId = "e2b"): SandboxProvider => ({
  id, maxSessionMs: 3_600_000,
  create: vi.fn().mockResolvedValue(sandbox),
  connect: vi.fn().mockResolvedValue(sandbox),
  list: vi.fn().mockResolvedValue([]),
  kill: vi.fn().mockResolvedValue(true),
});
const config: SandboxProviderConfig = {
  primary: "e2b", fallbacks: [second, third],
  configured: { e2b: true, ...Object.fromEntries([second, third].map((id) => [id, true])) },
};

describe("provider config and selection", () => {
  it("defaults to E2B, skips missing keys, and retains no credentials", () => {
    const empty = parseProviderConfig({});
    expect(empty).toEqual({ primary: "e2b", fallbacks: [], configured: { e2b: false } });
    expect(selectProviders(empty, createProviderCooldown())).toEqual([]);
    expect(parseProviderConfig({ E2B_API_KEY: "  " }).configured.e2b).toBe(false);
    const enabled = parseProviderConfig({ E2B_API_KEY: "secret" });
    expect(JSON.stringify(enabled)).not.toContain("secret");
    expect(selectProviders(enabled, createProviderCooldown())).toEqual(["e2b"]);
  });

  it("ignores unknown ids, warns once per variable, and never logs env values", () => {
    const warn = vi.fn();
    const env = { SANDBOX_PROVIDER: "secret-in-invalid-id", SANDBOX_PROVIDER_FALLBACKS: "unknown,unknown", E2B_API_KEY: "key-secret" };
    expect(parseProviderConfig(env, warn)).toEqual({ primary: "e2b", fallbacks: [], configured: { e2b: true } });
    parseProviderConfig(env, warn);
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls.flat().join(" ")).not.toMatch(/secret|unknown,unknown/);
  });

  it("trims, removes duplicates and leaves empty fallbacks disabled", () => {
    for (const value of [undefined, "", " , ", " e2b,e2b, "]) {
      expect(parseProviderConfig({ SANDBOX_PROVIDER: " e2b ", SANDBOX_PROVIDER_FALLBACKS: value }).fallbacks).toEqual([]);
    }
  });

  it("orders fallbacks and prefers only an enabled healthy sticky provider", () => {
    const cooldown = createProviderCooldown();
    expect(selectProviders(config, cooldown)).toEqual(["e2b", second, third]);
    expect(selectProviders(config, cooldown, second)).toEqual([second, "e2b", third]);
    cooldown.failed(second, new SandboxRateLimitError());
    expect(selectProviders(config, cooldown, second)).toEqual(["e2b", third]);
    expect(selectProviders({ ...config, fallbacks: [] }, cooldown, third)).toEqual(["e2b"]);
    expect(selectProviders({ ...config, configured: { ...config.configured, [third]: false } }, cooldown, third)).toEqual(["e2b"]);
  });

  it("caps lifetime at one hour or the provider's limit", () => {
    expect(sandboxTimeoutMs({ maxSessionMs: 7_200_000 })).toBe(3_600_000);
    expect(sandboxTimeoutMs({ maxSessionMs: 900_000 })).toBe(900_000);
  });
});

describe("create failover", () => {
  it.each([SandboxConfigError, SandboxRateLimitError])("cools down immediately on %s, notices once, then succeeds", async (ErrorKind) => {
    const primary = fakeProvider();
    const fallback = fakeProvider(second);
    const cooldown = createProviderCooldown();
    const onNotice = vi.fn();
    vi.mocked(primary.create).mockRejectedValue(new ErrorKind("do not print this secret"));
    await expect(createWithFailover(opts, { providers: [primary, fallback], cooldown, onNotice })).resolves.toBe(sandbox);
    expect(cooldown.isCoolingDown("e2b")).toBe(true);
    expect(onNotice).toHaveBeenCalledExactlyOnceWith(`E2B unavailable, continuing on ${second}...`);
    expect(fallback.create).toHaveBeenCalledExactlyOnceWith(opts);
  });

  it("counts transient failures across boots; expiry resets with an injected clock", async () => {
    let now = 100;
    const cooldown = createProviderCooldown(() => now);
    const primary = fakeProvider();
    const fallback = fakeProvider(second);
    const error = new SandboxTimeoutError("network timeout");
    vi.mocked(primary.create).mockRejectedValue(error);
    const deps = { providers: [primary, fallback], cooldown };
    await expect(createWithFailover(opts, deps)).rejects.toBe(error);
    expect(fallback.create).not.toHaveBeenCalled();
    expect(cooldown.isCoolingDown("e2b")).toBe(false);
    await expect(createWithFailover(opts, deps)).resolves.toBe(sandbox);
    expect(cooldown.isCoolingDown("e2b")).toBe(true);
    now += 599_999;
    expect(cooldown.isCoolingDown("e2b")).toBe(true);
    now += 1;
    expect(cooldown.isCoolingDown("e2b")).toBe(false);
    await expect(createWithFailover(opts, deps)).rejects.toBe(error);
    expect(cooldown.isCoolingDown("e2b")).toBe(false);
  });

  it("resets consecutive failures on success and bounds create lifetime", async () => {
    const primary = { ...fakeProvider(), maxSessionMs: 900_000 };
    const cooldown = createProviderCooldown();
    cooldown.failed("e2b", new SandboxTimeoutError("transient"));
    await createWithFailover(opts, { providers: [primary], cooldown });
    expect(primary.create).toHaveBeenLastCalledWith({ ...opts, timeoutMs: 900_000 });
    expect(cooldown.failed("e2b", new SandboxTimeoutError("transient"))).toBe(false);
    await createWithFailover({ ...opts, timeoutMs: 1_000 }, { providers: [primary], cooldown });
    expect(primary.create).toHaveBeenLastCalledWith({ ...opts, timeoutMs: 1_000 });
  });

  it.each([SandboxConfigError, SandboxRateLimitError, SandboxTimeoutError])("preserves the first %s instance when fallback also fails; never tries a third", async (ErrorKind) => {
    const providers = [fakeProvider(), fakeProvider(second), fakeProvider(third)];
    const error = new ErrorKind("first");
    const cooldown = createProviderCooldown();
    cooldown.failed("e2b", new SandboxTimeoutError("previous transient"));
    vi.mocked(providers[0].create).mockRejectedValue(error);
    vi.mocked(providers[1].create).mockRejectedValue(new SandboxRateLimitError("second"));
    await expect(createWithFailover(opts, { providers, cooldown })).rejects.toBe(error);
    expect(providers[1].create).toHaveBeenCalledTimes(1);
    expect(providers[2].create).not.toHaveBeenCalled();
  });

  it("permanent errors neither cool nor prevent the next healthy create", async () => {
    const primary = fakeProvider();
    const fallback = fakeProvider(second);
    const cooldown = createProviderCooldown();
    const error = new Error("invalid image");
    vi.mocked(primary.create).mockRejectedValueOnce(error).mockRejectedValueOnce(error);
    const deps = { providers: [primary, fallback], cooldown };
    await expect(createWithFailover(opts, deps)).rejects.toBe(error);
    await expect(createWithFailover(opts, deps)).rejects.toBe(error);
    expect(cooldown.isCoolingDown("e2b")).toBe(false);
    expect(fallback.create).not.toHaveBeenCalled();
    await expect(createWithFailover(opts, deps)).resolves.toBe(sandbox);
    expect(primary.create).toHaveBeenCalledTimes(3);
  });

  it("permanent errors preserve a prior transient failure without adding one", () => {
    const cooldown = createProviderCooldown();
    expect(cooldown.failed("e2b", new SandboxTimeoutError())).toBe(false);
    expect(cooldown.failed("e2b", new Error("invalid request"))).toBe(false);
    expect(cooldown.isCoolingDown("e2b")).toBe(false);
    expect(cooldown.failed("e2b", new SandboxTimeoutError())).toBe(true);
  });

  it.each([false, true])("throwing notices cannot block fallback (fallback fails: %s)", async (fails) => {
    const primary = fakeProvider();
    const fallback = fakeProvider(second);
    const firstError = new SandboxRateLimitError("first");
    vi.mocked(primary.create).mockRejectedValue(firstError);
    if (fails) vi.mocked(fallback.create).mockRejectedValue(new SandboxConfigError("second"));
    const onNotice = vi.fn(() => { throw new Error("notice secret"); });
    const result = createWithFailover(opts, {
      providers: [primary, fallback], cooldown: createProviderCooldown(), onNotice,
    });
    if (fails) await expect(result).rejects.toBe(firstError);
    else await expect(result).resolves.toBe(sandbox);
    expect(onNotice).toHaveBeenCalledTimes(1);
    expect(fallback.create).toHaveBeenCalledTimes(1);
  });

  it("empty fallbacks make one create attempt and preserve today's error", async () => {
    const primary = fakeProvider();
    const error = new SandboxRateLimitError("quota");
    vi.mocked(primary.create).mockRejectedValue(error);
    const cooldown = createProviderCooldown();
    const providers = selectProviders(parseProviderConfig({ E2B_API_KEY: "fake" }), cooldown).map(() => primary);
    const onNotice = vi.fn();
    await expect(createWithFailover(opts, { providers, cooldown, onNotice })).rejects.toBe(error);
    expect(primary.create).toHaveBeenCalledTimes(1);
    expect(onNotice).not.toHaveBeenCalled();
  });

  it("skips cooling candidates and reports no available provider as config", async () => {
    const primary = fakeProvider();
    const fallback = fakeProvider(second);
    const cooldown = createProviderCooldown();
    cooldown.failed("e2b", new SandboxConfigError());
    await createWithFailover(opts, { providers: [primary, fallback], cooldown });
    expect(primary.create).not.toHaveBeenCalled();
    await expect(createWithFailover(opts, { providers: [primary], cooldown })).rejects.toBeInstanceOf(SandboxConfigError);
    await expect(createWithFailover(opts, { providers: [], cooldown })).rejects.toBeInstanceOf(SandboxConfigError);
  });
});

describe("enabled provider fanout", () => {
  it("sums listings, preserves provider provenance and forwards the query exactly", async () => {
    const providers = [fakeProvider(), fakeProvider(second)];
    const entry = { id: "same-native-id", metadata: opts.metadata, endAt: new Date(1000) };
    for (const provider of providers) vi.mocked(provider.list).mockResolvedValue([entry]);
    const query = { metadata: opts.metadata, limit: 3, requestTimeoutMs: 123 };
    expect(await listAll([providers[0]], query)).toEqual([{ ...entry, provider: "e2b" }]);
    expect(await listAll(providers, query)).toEqual(providers.map((provider) => ({ ...entry, provider: provider.id })));
    for (const provider of providers) expect(provider.list).toHaveBeenLastCalledWith(query);
    expect(await countLive(providers, opts.metadata)).toBe(2);
    expect(await countLive([providers[0]], opts.metadata)).toBe(1);
    expect(await countLive([], opts.metadata)).toBe(0);
  });

  it("propagates a list failure rather than silently undercounting the cap", async () => {
    const provider = fakeProvider();
    const error = new SandboxTimeoutError("list failed");
    vi.mocked(provider.list).mockRejectedValue(error);
    await expect(countLive([provider], opts.metadata)).rejects.toBe(error);
  });
});

describe("fanout with a failing non-primary provider", () => {
  const entry = { id: "e1", metadata: opts.metadata, endAt: new Date(1000) };
  const setup = (now?: () => number) => {
    const primary = fakeProvider();
    vi.mocked(primary.list).mockResolvedValue([entry]);
    const failing = fakeProvider(second);
    vi.mocked(failing.list).mockRejectedValue(new Error("fallback down"));
    return { providers: [primary, failing], health: { primary: "e2b" as ProviderId, cooldown: createProviderCooldown(now) } };
  };

  it("lookups skip it and cool it down", async () => {
    const { providers, health } = setup();
    expect(await listAll(providers, { metadata: opts.metadata }, { ...health, skip: "failing" })).toEqual([{ ...entry, provider: "e2b" }]);
    expect(health.cooldown.isCoolingDown(second)).toBe(true);
    expect(selectProviders(config, health.cooldown)).toEqual(["e2b", third]);
  });

  it("the cap fails closed until it is cooling, skips it while cooling, and fails closed after expiry", async () => {
    let now = 0;
    const { providers, health } = setup(() => now);
    const cap = { ...health, skip: "cooling" as const };
    await expect(countLive(providers, opts.metadata, cap)).rejects.toThrow("fallback down");
    expect(health.cooldown.isCoolingDown(second)).toBe(true);
    expect(await countLive(providers, opts.metadata, cap)).toBe(1);
    now += 600_000;
    await expect(countLive(providers, opts.metadata, cap)).rejects.toThrow("fallback down");
    expect(await countLive(providers, opts.metadata, cap)).toBe(1);
  });

  it("gives a hanging fallback 5 s, passed down as requestTimeoutMs, then skips and cools it", async () => {
    vi.useFakeTimers();
    try {
      const { providers, health } = setup();
      vi.mocked(providers[1].list).mockReturnValue(new Promise(() => {}));
      const query = { metadata: opts.metadata, limit: 3, requestTimeoutMs: 10_000 };
      const lookup = listAll(providers, query, { ...health, skip: "failing" });
      await vi.advanceTimersByTimeAsync(FALLBACK_LIST_TIMEOUT_MS);
      expect(await lookup).toEqual([{ ...entry, provider: "e2b" }]);
      expect(providers[0].list).toHaveBeenCalledWith(query);
      expect(providers[1].list).toHaveBeenCalledWith({ ...query, requestTimeoutMs: FALLBACK_LIST_TIMEOUT_MS });
      expect(health.cooldown.isCoolingDown(second)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(["failing", "cooling"] as const)("the primary still fails closed and is not cooled by a list (%s)", async (skip) => {
    const { providers, health } = setup();
    const error = new SandboxTimeoutError("primary down");
    vi.mocked(providers[0].list).mockRejectedValue(error);
    vi.mocked(providers[1].list).mockResolvedValue([]);
    await expect(listAll(providers, {}, { ...health, skip })).rejects.toBe(error);
    expect(health.cooldown.isCoolingDown("e2b")).toBe(false);
    health.cooldown.coolDown("e2b");
    await expect(listAll(providers, {}, { ...health, skip })).rejects.toBe(error);
  });
});
