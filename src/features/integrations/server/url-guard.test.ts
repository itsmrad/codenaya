import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

import { assertSafeMcpUrl, checkIp, parseIp } from "./url-guard";

// DNS is mocked so hostname-resolution behaviour can be tested deterministically
// and offline. Tests that exercise literal IPs never reach the resolver.
const { mockLookup } = vi.hoisted(() => ({ mockLookup: vi.fn() }));

vi.mock("node:dns/promises", () => ({ lookup: mockLookup }));

describe("parseIp", () => {
  it("parses dotted-quad IPv4", () => {
    expect(parseIp("192.0.2.1")).toEqual({
      family: 4,
      bytes: new Uint8Array([192, 0, 2, 1]),
    });
  });

  it("folds IPv4-mapped IPv6 down to IPv4", () => {
    const parsed = parseIp("::ffff:169.254.169.254");
    expect(parsed?.family).toBe(4);
    expect(parsed?.bytes).toEqual(new Uint8Array([169, 254, 169, 254]));
  });

  it("expands compressed IPv6", () => {
    const parsed = parseIp("fe80::1");
    expect(parsed?.family).toBe(6);
    expect(parsed?.bytes[0]).toBe(0xfe);
    expect(parsed?.bytes[1]).toBe(0x80);
    expect(parsed?.bytes[15]).toBe(1);
  });

  it("rejects zero-padded octets that some resolvers read as octal", () => {
    // "0177.0.0.1" is 127.0.0.1 to an octal-aware resolver. Refusing to parse
    // it means it can never be compared as a distinct, allowed string.
    expect(parseIp("0177.0.0.1")).toBeNull();
    expect(parseIp("010.0.0.1")).toBeNull();
  });

  it("rejects malformed input", () => {
    expect(parseIp("999.1.1.1")).toBeNull();
    expect(parseIp("1.2.3")).toBeNull();
    expect(parseIp("::1::2")).toBeNull();
    expect(parseIp("not-an-ip")).toBeNull();
  });
});

describe("checkIp blocks reserved ranges", () => {
  const blocked: Array<[string, string]> = [
    ["0.0.0.0", "current network"],
    ["10.1.2.3", "private 10/8"],
    ["100.64.0.1", "carrier-grade NAT"],
    ["127.0.0.1", "loopback"],
    ["169.254.169.254", "cloud metadata endpoint"],
    ["169.254.0.1", "link-local"],
    ["172.16.0.1", "private 172.16/12"],
    ["172.31.255.254", "private 172.16/12 upper bound"],
    ["192.168.1.1", "private 192.168/16"],
    ["198.18.0.1", "benchmarking"],
    ["224.0.0.1", "multicast"],
    ["240.0.0.1", "reserved"],
    ["::1", "IPv6 loopback"],
    ["::", "IPv6 unspecified"],
    ["fe80::1", "IPv6 link-local"],
    ["fc00::1", "IPv6 unique local"],
    ["fd00::1", "IPv6 unique local (fd prefix)"],
    ["ff02::1", "IPv6 multicast"],
    ["::ffff:127.0.0.1", "IPv4-mapped loopback"],
    ["::ffff:169.254.169.254", "IPv4-mapped metadata endpoint"],
    ["::ffff:10.0.0.1", "IPv4-mapped private"],
  ];

  it.each(blocked)("blocks %s (%s)", (ip) => {
    const result = checkIp(ip);
    expect(result.blocked).toBe(true);
    expect(result.reason).toBeTruthy();
  });
});

describe("checkIp allows public addresses", () => {
  const allowed = [
    "1.1.1.1",
    "8.8.8.8",
    "104.18.32.7",
    "172.15.255.255", // just below the private 172.16/12 boundary
    "172.32.0.1", // just above it
    "100.63.255.255", // just below CGNAT
    "100.128.0.1", // just above CGNAT
    "2606:4700::1111",
  ];

  it.each(allowed)("allows %s", (ip) => {
    expect(checkIp(ip).blocked).toBe(false);
  });
});

describe("assertSafeMcpUrl", () => {
  beforeEach(() => {
    mockLookup.mockReset();
    delete process.env.CODENAYA_ALLOW_INSECURE_MCP_URLS;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("rejects non-https schemes by default", async () => {
    const result = await assertSafeMcpUrl("http://mcp.example.com/mcp");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/https/);
  });

  it("rejects unsupported schemes outright", async () => {
    for (const raw of [
      "file:///etc/passwd",
      "ftp://example.com/x",
      "gopher://example.com/",
    ]) {
      const result = await assertSafeMcpUrl(raw);
      expect(result.ok).toBe(false);
    }
  });

  it("rejects embedded credentials", async () => {
    mockLookup.mockResolvedValue([{ address: "1.1.1.1" }]);
    const result = await assertSafeMcpUrl("https://user:pass@mcp.example.com/mcp");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/credentials/i);
  });

  it("rejects the cloud metadata endpoint as a literal IP", async () => {
    const result = await assertSafeMcpUrl(
      "https://169.254.169.254/latest/meta-data/",
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/metadata/i);
    expect(mockLookup).not.toHaveBeenCalled();
  });

  it("rejects localhost hostnames without a lookup", async () => {
    for (const raw of [
      "https://localhost/mcp",
      "https://api.localhost/mcp",
    ]) {
      const result = await assertSafeMcpUrl(raw);
      expect(result.ok).toBe(false);
    }
    expect(mockLookup).not.toHaveBeenCalled();
  });

  it("rejects a hostname that resolves to a private address", async () => {
    mockLookup.mockResolvedValue([{ address: "192.168.1.10" }]);
    const result = await assertSafeMcpUrl("https://internal.example.com/mcp");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/private network/);
  });

  it("rejects when any resolved address is private, even if others are public", async () => {
    // We cannot control which address fetch selects, so one bad answer is fatal.
    mockLookup.mockResolvedValue([
      { address: "104.18.32.7" },
      { address: "169.254.169.254" },
    ]);
    const result = await assertSafeMcpUrl("https://rebind.example.com/mcp");
    expect(result.ok).toBe(false);
  });

  it("accepts a hostname that resolves to public addresses", async () => {
    mockLookup.mockResolvedValue([{ address: "104.18.32.7" }]);
    const result = await assertSafeMcpUrl("https://mcp.example.com/mcp");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.url.hostname).toBe("mcp.example.com");
  });

  it("rejects hosts that fail to resolve", async () => {
    mockLookup.mockRejectedValue(new Error("ENOTFOUND"));
    const result = await assertSafeMcpUrl("https://nope.example.com/mcp");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/resolve/i);
  });

  it("rejects hosts that resolve to an empty address list", async () => {
    mockLookup.mockResolvedValue([]);
    const result = await assertSafeMcpUrl("https://empty.example.com/mcp");
    expect(result.ok).toBe(false);
  });

  it("skips DNS validation for catalog-trusted hosts", async () => {
    const result = await assertSafeMcpUrl("https://mcp.supabase.com/mcp", {
      trustedHosts: ["mcp.supabase.com"],
    });
    expect(result.ok).toBe(true);
    expect(mockLookup).not.toHaveBeenCalled();
  });

  it("still enforces https for trusted hosts", async () => {
    const result = await assertSafeMcpUrl("http://mcp.supabase.com/mcp", {
      trustedHosts: ["mcp.supabase.com"],
    });
    expect(result.ok).toBe(false);
  });

  it("rejects malformed URLs", async () => {
    const result = await assertSafeMcpUrl("not a url");
    expect(result.ok).toBe(false);
  });

  describe("insecure-scheme escape hatch", () => {
    it("allows http in development when explicitly enabled", async () => {
      vi.stubEnv("NODE_ENV", "development");
      vi.stubEnv("CODENAYA_ALLOW_INSECURE_MCP_URLS", "1");
      mockLookup.mockResolvedValue([{ address: "104.18.32.7" }]);

      const result = await assertSafeMcpUrl("http://mcp.example.com/mcp");
      expect(result.ok).toBe(true);
    });

    it("ignores the flag in production", async () => {
      vi.stubEnv("NODE_ENV", "production");
      vi.stubEnv("CODENAYA_ALLOW_INSECURE_MCP_URLS", "1");

      const result = await assertSafeMcpUrl("http://mcp.example.com/mcp");
      expect(result.ok).toBe(false);
    });

    it("does not allow the flag to bypass the IP blocklist", async () => {
      vi.stubEnv("NODE_ENV", "development");
      vi.stubEnv("CODENAYA_ALLOW_INSECURE_MCP_URLS", "1");

      const result = await assertSafeMcpUrl("http://169.254.169.254/");
      expect(result.ok).toBe(false);
    });
  });
});
