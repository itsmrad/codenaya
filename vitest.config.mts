import { defineConfig } from "vitest/config";

/**
 * Vitest configuration.
 *
 * Tests run in the Node environment because everything under test is
 * server-side: crypto, SSRF validation, MCP transport handling, and Convex
 * access rules. `resolve.tsconfigPaths` picks up the `@/*` alias from
 * tsconfig.json so test files import modules exactly the way application code
 * does.
 *
 * The `.mts` extension keeps this file ESM under Vite's native config loader.
 */
export default defineConfig({
  resolve: {
    tsconfigPaths: true,
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    // Convex codegen output and Next build artifacts contain no tests.
    exclude: ["node_modules/**", ".next/**", "convex/_generated/**"],
  },
});
