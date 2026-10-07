import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// DNS is mocked so hostname checks are deterministic and offline.
const { mockLookup } = vi.hoisted(() => ({ mockLookup: vi.fn() }));
vi.mock("node:dns/promises", () => ({ lookup: mockLookup }));

import {
  assertSafeProviderBaseUrl,
  normalizedBaseUrl,
  providerFetch,
} from "./base-url";

beforeEach(() => {
  mockLookup.mockReset();
  mockLookup.mockResolvedValue([{ address: "93.184.215.14", family: 4 }]);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

const reasonFor = async (url: string) => {
  const verdict = await assertSafeProviderBaseUrl(url);
  return verdict.ok ? null : verdict.reason;
};

describe("assertSafeProviderBaseUrl", () => {
  it("accepts a public https endpoint and normalises it", async () => {
    const verdict = await assertSafeProviderBaseUrl(" https://llm.example.com/v1/ ");
    expect(verdict.ok).toBe(true);
    if (verdict.ok) {
      expect(normalizedBaseUrl(verdict.url)).toBe("https://llm.example.com/v1");
    }
  });

  it.each([
    ["http://10.0.0.1", /https/],
    ["https://10.0.0.1/v1", /private network/],
    ["https://169.254.169.254", /link-local/],
    ["https://[::ffff:169.254.169.254]/v1", /link-local/],
    ["https://192.168.1.10/v1", /private network/],
    ["https://localhost:11434/v1", /loopback/],
    ["https://user:pass@llm.example.com/v1", /credentials/],
    ["https://llm.example.com/v1?key=1", /query/],
    ["ftp://llm.example.com", /https/],
    ["not a url", /valid URL/],
  ])("rejects %s", async (url, reason) => {
    vi.stubEnv("NODE_ENV", "production");
    expect(await reasonFor(url)).toMatch(reason);
  });

  it("rejects a hostname that resolves to a private address", async () => {
    mockLookup.mockResolvedValue([{ address: "10.1.2.3", family: 4 }]);
    expect(await reasonFor("https://internal.example.com/v1")).toMatch(/private network/);
  });

  it("rejects http://localhost in production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    expect(await reasonFor("http://localhost:11434/v1")).toMatch(/https/);
  });

  it("ignores the MCP guard's insecure-http opt-in", async () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("CODENAYA_ALLOW_INSECURE_MCP_URLS", "1");
    expect(await reasonFor("http://llm.example.com/v1")).toMatch(/https/);
  });

  it("allows http://localhost only under next dev", async () => {
    vi.stubEnv("NODE_ENV", "development");
    expect(await reasonFor("http://localhost:11434/v1")).toBeNull();
    expect(await reasonFor("http://127.0.0.1:1234/v1")).toBeNull();
    // Other private addresses stay blocked in development.
    expect(await reasonFor("http://10.0.0.1/v1")).toMatch(/https/);
  });
});

describe("providerFetch", () => {
  it("blocks requests to private addresses and refuses redirects", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("{}"));
    vi.stubGlobal("fetch", fetchMock);

    const guarded = providerFetch("https://llm.example.com/v1");
    await expect(guarded("https://169.254.169.254/models")).rejects.toThrow(/Blocked/);
    expect(fetchMock).not.toHaveBeenCalled();

    await guarded("https://llm.example.com/v1/models");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://llm.example.com/v1/models",
      expect.objectContaining({ redirect: "error" }),
    );
  });

  it("trusts the fixed provider hosts without a DNS lookup", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{}")));
    await providerFetch("https://api.openai.com/v1")("https://api.openai.com/v1/models");
    expect(mockLookup).not.toHaveBeenCalled();
  });
});
