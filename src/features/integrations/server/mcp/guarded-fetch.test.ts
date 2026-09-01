import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createGuardedFetch } from "./guarded-fetch";

/**
 * The guarded fetch is the transport-level half of the SSRF defence. The
 * connection-time check in `assertSafeMcpUrl` cannot see redirect targets or
 * later requests in a long-lived Streamable HTTP session, so these tests pin
 * that every request goes through validation and that redirects are refused.
 */

const { mockLookup } = vi.hoisted(() => ({ mockLookup: vi.fn() }));
vi.mock("node:dns/promises", () => ({ lookup: mockLookup }));

const originalFetch = globalThis.fetch;

beforeEach(() => {
  mockLookup.mockReset();
  mockLookup.mockResolvedValue([{ address: "104.18.32.7" }]);
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("createGuardedFetch", () => {
  it("passes through a safe https request", async () => {
    const spy = vi
      .fn()
      .mockResolvedValue(new Response("{}", { status: 200 }));
    globalThis.fetch = spy as unknown as typeof fetch;

    const guarded = createGuardedFetch();
    const response = await guarded("https://mcp.example.com/mcp", {
      method: "POST",
    });

    expect(response.status).toBe(200);
    expect(spy).toHaveBeenCalledOnce();
  });

  it("forces redirect:error so a 302 cannot escape validation", async () => {
    // Without this, a validated server could redirect to a private address and
    // fetch would follow it before anything re-checked the destination.
    const spy = vi
      .fn()
      .mockResolvedValue(new Response("{}", { status: 200 }));
    globalThis.fetch = spy as unknown as typeof fetch;

    const guarded = createGuardedFetch();
    await guarded("https://mcp.example.com/mcp", { method: "POST" });

    expect(spy.mock.calls[0][1]).toMatchObject({ redirect: "error" });
  });

  it("preserves caller headers and method", async () => {
    const spy = vi
      .fn()
      .mockResolvedValue(new Response("{}", { status: 200 }));
    globalThis.fetch = spy as unknown as typeof fetch;

    const guarded = createGuardedFetch();
    await guarded("https://mcp.example.com/mcp", {
      method: "POST",
      headers: { Authorization: "Bearer abc" },
    });

    expect(spy.mock.calls[0][1]).toMatchObject({
      method: "POST",
      headers: { Authorization: "Bearer abc" },
    });
  });

  it("refuses a request to a private address", async () => {
    const spy = vi.fn();
    globalThis.fetch = spy as unknown as typeof fetch;

    const guarded = createGuardedFetch();

    await expect(
      guarded("https://169.254.169.254/latest/meta-data/"),
    ).rejects.toThrow(/Blocked request to/);
    expect(spy).not.toHaveBeenCalled();
  });

  it("refuses a request whose host resolves privately", async () => {
    mockLookup.mockResolvedValue([{ address: "10.0.0.5" }]);
    const spy = vi.fn();
    globalThis.fetch = spy as unknown as typeof fetch;

    const guarded = createGuardedFetch();

    await expect(guarded("https://internal.example.com/mcp")).rejects.toThrow(
      /Blocked request to/,
    );
    expect(spy).not.toHaveBeenCalled();
  });

  it("re-validates on every call, not just the first", async () => {
    // Models the session case: request one is fine, request two resolves
    // somewhere private. A cached verdict would let the second through.
    const spy = vi
      .fn()
      .mockResolvedValue(new Response("{}", { status: 200 }));
    globalThis.fetch = spy as unknown as typeof fetch;

    const guarded = createGuardedFetch();

    await guarded("https://mcp.example.com/mcp");
    expect(spy).toHaveBeenCalledTimes(1);

    mockLookup.mockResolvedValue([{ address: "127.0.0.1" }]);
    await expect(guarded("https://mcp.example.com/mcp")).rejects.toThrow(
      /Blocked request to/,
    );
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("honours trustedHosts without a DNS lookup", async () => {
    const spy = vi
      .fn()
      .mockResolvedValue(new Response("{}", { status: 200 }));
    globalThis.fetch = spy as unknown as typeof fetch;

    const guarded = createGuardedFetch({
      trustedHosts: ["mcp.supabase.com"],
    });
    await guarded("https://mcp.supabase.com/mcp");

    expect(spy).toHaveBeenCalledOnce();
    expect(mockLookup).not.toHaveBeenCalled();
  });

  it("accepts a Request object as input", async () => {
    const spy = vi
      .fn()
      .mockResolvedValue(new Response("{}", { status: 200 }));
    globalThis.fetch = spy as unknown as typeof fetch;

    const guarded = createGuardedFetch();
    await guarded(new Request("https://mcp.example.com/mcp"));

    expect(spy).toHaveBeenCalledOnce();
  });

  it("rejects a plain http URL", async () => {
    const spy = vi.fn();
    globalThis.fetch = spy as unknown as typeof fetch;

    const guarded = createGuardedFetch();
    await expect(guarded("http://mcp.example.com/mcp")).rejects.toThrow(
      /Blocked request to/,
    );
    expect(spy).not.toHaveBeenCalled();
  });
});
