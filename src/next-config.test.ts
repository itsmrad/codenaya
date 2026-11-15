import { describe, expect, it } from "vitest";

import nextConfig from "../next.config";

describe("next.config security headers", () => {
  it("sends the security headers on every route and hides X-Powered-By", async () => {
    expect(nextConfig.poweredByHeader).toBe(false);
    const rules = (await nextConfig.headers?.()) ?? [];
    const catchAll = rules.find((rule) => rule.source === "/:path*" && !rule.has);
    const headers = Object.fromEntries(
      (catchAll?.headers ?? []).map(({ key, value }) => [key, value]),
    );
    expect(headers).toMatchObject({
      "X-Frame-Options": "DENY",
      "Content-Security-Policy": "frame-ancestors 'none'",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "strict-origin-when-cross-origin",
    });
    expect(headers["Permissions-Policy"]).toBe("camera=(), microphone=(self), geolocation=()");
  });
});
