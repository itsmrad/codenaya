import { describe, it, expect } from "vitest";
import { nextConfig } from "../../../next.config";

describe("Security Headers Configuration (Issue #240)", () => {
  it("defines comprehensive security headers and disables poweredByHeader", async () => {
    expect(nextConfig.poweredByHeader).toBe(false);

    if (typeof nextConfig.headers === "function") {
      interface HeaderEntry {
        key: string;
        value: string;
      }
      interface HeaderRule {
        source: string;
        headers: HeaderEntry[];
      }
      const headersList = (await nextConfig.headers()) as HeaderRule[];
      const globalRule = headersList.find((h) => h.source === "/:path*");
      expect(globalRule).toBeDefined();
      if (!globalRule) {
        throw new Error("Expected globalRule to be defined");
      }

      const headerMap = Object.fromEntries(
        globalRule.headers.map((h) => [h.key, h.value])
      );

      expect(headerMap["X-Frame-Options"]).toBe("DENY");
      expect(headerMap["Content-Security-Policy"]).toContain("frame-ancestors 'none'");
      expect(headerMap["X-Content-Type-Options"]).toBe("nosniff");
      expect(headerMap["Referrer-Policy"]).toBe("strict-origin-when-cross-origin");
      expect(headerMap["Permissions-Policy"]).toContain("camera=()");
    }
  });
});
