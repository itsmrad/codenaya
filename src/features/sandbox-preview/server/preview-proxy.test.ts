import { describe, expect, it } from "vitest";

import { rewriteProxyHeaders, shouldInjectBridge } from "./preview-proxy";

describe("rewriteProxyHeaders", () => {
  // The proxy serializes this helper into the sandbox's standalone script.
  const rewrite = new Function(`return (${String(rewriteProxyHeaders)});`)() as typeof rewriteProxyHeaders;

  it("rewrites Host and an existing Origin together for HTTP and websocket requests", () => {
    const headers = { host: "4000-sbx.e2b.app", origin: "https://4000-sbx.e2b.app", upgrade: "websocket" };
    expect(rewrite(headers, 3000)).toEqual({ host: "localhost:3000", origin: "http://localhost:3000", upgrade: "websocket" });
    expect(headers.origin).toBe("https://4000-sbx.e2b.app");
  });

  it("does not invent Origin for requests without one", () => {
    expect(rewrite({ host: "4000-sbx.e2b.app" }, 5173)).toEqual({ host: "localhost:5173" });
  });

  it("removes edge forwarding headers so Server Actions compare Origin with the rewritten Host", () => {
    const headers = {
      host: "4000-sbx.e2b.app",
      origin: "https://4000-sbx.e2b.app",
      "x-forwarded-host": "4000-sbx.e2b.app",
      "x-forwarded-proto": "https",
    };
    expect(rewrite(headers, 3000)).toEqual({ host: "localhost:3000", origin: "http://localhost:3000" });
    expect(headers["x-forwarded-host"]).toBe("4000-sbx.e2b.app");
    expect(rewrite({ "x-forwarded-host": "edge.example", "x-forwarded-proto": "https" }, 5173)).toEqual({ host: "localhost:5173" });
  });
});

describe("shouldInjectBridge", () => {
  const inject = new Function(`return (${String(shouldInjectBridge)});`)() as typeof shouldInjectBridge;
  const html = { "content-type": "text/html; charset=utf-8" };

  it.each([200, 404, 500])("injects the bridge into a %i HTML response", (status) => {
    expect(inject("GET", status, html)).toBe(true);
  });

  it.each([101, 204, 205, 301, 302, 304, 307, 308])("leaves status %i headers and body unchanged", (status) => {
    expect(inject("GET", status, html)).toBe(false);
  });

  it("skips HEAD, non-HTML, compressed, and missing-status responses", () => {
    expect(inject("HEAD", 200, html)).toBe(false);
    expect(inject("GET", 200, { "content-type": "application/javascript" })).toBe(false);
    expect(inject("GET", 500, { ...html, "content-encoding": "gzip" })).toBe(false);
    expect(inject("GET", undefined, html)).toBe(false);
  });
});
