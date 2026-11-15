import { describe, expect, it } from "vitest";

import { appendHostFlag, detectFrameworkFromFiles } from "./dev-command";

describe("appendHostFlag", () => {
  it("forwards Next's hostname flag through npm's script separator", () => {
    expect(appendHostFlag("npm run dev", "next")).toBe("npm run dev -- -H 0.0.0.0");
    expect(appendHostFlag("npm run dev -- --turbo", "next")).toBe("npm run dev -- --turbo -H 0.0.0.0");
    expect(appendHostFlag("next dev")).toBe("next dev -H 0.0.0.0");
    expect(appendHostFlag("pnpm run dev", "next")).toBe("pnpm run dev -H 0.0.0.0");
    expect(appendHostFlag("yarn dev", "next")).toBe("yarn dev -H 0.0.0.0");
  });

  it("replaces a stale Vite host flag and preserves Next hostname flags", () => {
    expect(appendHostFlag("npm run dev -- --host 0.0.0.0", "next")).toBe("npm run dev -- -H 0.0.0.0");
    for (const command of ["next dev -H 0.0.0.0", "next dev --hostname=0.0.0.0"]) {
      expect(appendHostFlag(command, "next")).toBe(command);
    }
  });

  it("keeps Vite and other commands working as before", () => {
    expect(appendHostFlag("npm run dev", "vite")).toBe("npm run dev -- --host 0.0.0.0");
    expect(appendHostFlag("vite")).toBe("vite --host 0.0.0.0");
    expect(appendHostFlag("vite --host 0.0.0.0")).toBe("vite --host 0.0.0.0");
    expect(appendHostFlag("node server.js")).toBe("node server.js");
  });

  it("gives TanStack Start Vite's host flag", () => {
    expect(appendHostFlag("npm run dev", "tanstack-start")).toBe("npm run dev -- --host 0.0.0.0");
    expect(appendHostFlag("vite dev --port 3000", "tanstack-start")).toBe("vite dev --port 3000 --host 0.0.0.0");
  });
});

describe("detectFrameworkFromFiles", () => {
  const manifest = (content: string) => ({ path: "package.json", content });

  it("reads dependencies, configs, and Next dev scripts", () => {
    expect(detectFrameworkFromFiles([manifest('{"dependencies":{"next":"15"}}')])).toBe("next");
    expect(detectFrameworkFromFiles([manifest("{}"), { path: "next.config.ts", content: "" }])).toBe("next");
    expect(detectFrameworkFromFiles([manifest('{"scripts":{"dev":"next dev --turbo"}}')])).toBe("next");
    expect(detectFrameworkFromFiles([manifest("{}")], "npx next dev")).toBe("next");
    expect(detectFrameworkFromFiles([manifest("{}"), { path: "vite.config.ts", content: "" }])).toBe("vite");
  });

  it("detects TanStack Start, even while package.json is half-written", () => {
    const config = { path: "vite.config.ts", content: "" };
    const start = manifest('{"scripts":{"dev":"vite dev --port 3000"},"dependencies":{"@tanstack/react-start":"1"}}');
    expect(detectFrameworkFromFiles([start, config])).toBe("tanstack-start");
    expect(detectFrameworkFromFiles([manifest("{"), config, { path: "src/routes/__root.tsx", content: "" }])).toBe(
      "tanstack-start",
    );
  });

  it("tolerates a half-written or non-object manifest", () => {
    for (const content of ["{", "null", "[]", "42"]) {
      expect(detectFrameworkFromFiles([manifest(content)])).toBeNull();
      expect(detectFrameworkFromFiles([manifest(content), { path: "next.config.js", content: "" }])).toBe("next");
    }
    expect(detectFrameworkFromFiles([])).toBeNull();
  });
});
