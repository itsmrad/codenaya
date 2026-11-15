import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  connect: vi.fn(),
  listTools: vi.fn(),
  close: vi.fn(),
}));

vi.mock("../url-guard", () => ({
  assertSafeMcpUrl: async (url: string) =>
    url.includes("169.254")
      ? { ok: false, reason: "Blocked request to a private address" }
      : { ok: true, url: new URL(url) },
}));
vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: class {
    connect = mocks.connect;
    listTools = mocks.listTools;
    close = mocks.close;
    getServerVersion = () => ({ name: "demo", version: "1.2.3" });
  },
}));

import { probeMcpServer } from "./probe";
import { REDACTION_PLACEHOLDER } from "./redact";

const probe = () => probeMcpServer({ url: "https://mcp.example.com/mcp" });

describe("probeMcpServer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.connect.mockResolvedValue(undefined);
    mocks.listTools.mockResolvedValue({ tools: [] });
  });

  it("does not echo the remote response in a protocol failure", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    mocks.connect.mockRejectedValue(
      new Error("Unexpected token '<', \"<html>internal admin secret\" is not valid JSON")
    );

    const result = await probe();

    expect(result).toMatchObject({ ok: false, kind: "protocol" });
    expect(JSON.stringify(result)).not.toContain("secret");
  });

  it("redacts a key echoed in a non-JSON handshake body before logging", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const apiKey = "custom-probe-key-abcdefghij";
    // Assembled so the source is not a credential literal push protection flags.
    const echoedToken = ["sk", "-", "abcdefghijklmnopqrstuvwxyz012345"].join("");
    mocks.connect.mockRejectedValue(
      new Error(
        `Unexpected token '<', "<html>${apiKey} ${echoedToken}" is not valid JSON`,
      ),
    );

    const result = await probeMcpServer({
      url: "https://mcp.example.com/mcp",
      headers: { Authorization: `Bearer ${apiKey}` },
    });

    expect(result).toEqual({
      ok: false,
      kind: "protocol",
      error:
        "The endpoint did not complete an MCP handshake. Check the URL points to an MCP server.",
    });
    const logged = JSON.stringify(warn.mock.calls);
    expect(logged).not.toContain(apiKey);
    expect(logged).not.toContain(echoedToken);
    expect(logged).toContain(REDACTION_PLACEHOLDER);
    expect(JSON.stringify(result)).not.toContain(apiKey);
    expect(JSON.stringify(result)).not.toContain(echoedToken);
  });

  it.each([
    ["HTTP 401 from server", "unauthorized", "rejected these credentials"],
    ["Forbidden (403)", "unauthorized", "refused access"],
    ["The operation was aborted", "timeout", "did not respond within 10 seconds"],
    ["getaddrinfo ENOTFOUND mcp.example.com", "network", "Could not reach the server"],
    ["connect ECONNREFUSED 1.2.3.4:443", "network", "Could not reach the server"],
    // A redirect the guarded fetch refused mid-handshake.
    ["Blocked request to 10.0.0.1", "blocked", "Blocked request to 10.0.0.1"],
  ])("classifies %j as %s", async (message, kind, error) => {
    mocks.connect.mockRejectedValue(new Error(message));

    const result = await probe();

    expect(result).toMatchObject({ ok: false, kind, error: expect.stringContaining(error) });
    expect(mocks.close).toHaveBeenCalled();
  });

  it("blocks an unsafe URL before connecting", async () => {
    const result = await probeMcpServer({ url: "http://169.254.169.254/mcp" });

    expect(result).toEqual({
      ok: false,
      kind: "blocked",
      error: "Blocked request to a private address",
    });
    expect(mocks.connect).not.toHaveBeenCalled();
  });

  it("caps the reported tools at 200 and flags the rest as truncated", async () => {
    const tools = Array.from({ length: 201 }, (_, i) => ({ name: `t${i}`, description: 7 }));
    mocks.listTools.mockResolvedValue({ tools });

    const result = await probe();

    expect(result).toMatchObject({ ok: true, truncated: true, serverName: "demo", serverVersion: "1.2.3" });
    if (!result.ok) throw new Error("expected ok");
    expect(result.tools).toHaveLength(200);
    // A non-string description is dropped rather than passed through.
    expect(result.tools[0]).toEqual({ name: "t0", description: undefined });
  });
});
