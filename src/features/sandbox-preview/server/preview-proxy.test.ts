import { describe, expect, it } from "vitest";

import { rewriteProxyHeaders } from "./preview-proxy";

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
});
