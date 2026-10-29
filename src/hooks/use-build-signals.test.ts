import { describe, expect, it } from "vitest";
import { formatBuildTitle } from "./use-build-signals";

describe("formatBuildTitle", () => {
  const base = "my-next-app · Codenaya";

  it("returns the untouched base title when idle", () => {
    expect(formatBuildTitle(base, "idle")).toBe("my-next-app · Codenaya");
  });

  it("prefixes document title with ● Building during an active run", () => {
    expect(formatBuildTitle(base, "building")).toBe("● Building · my-next-app · Codenaya");
  });

  it("prefixes document title with ✓ Done when the run finishes", () => {
    expect(formatBuildTitle(base, "done")).toBe("✓ Done · my-next-app · Codenaya");
  });

  it("handles fallback Codenaya base title gracefully", () => {
    expect(formatBuildTitle("Codenaya", "building")).toBe("● Building · Codenaya");
    expect(formatBuildTitle("Codenaya", "done")).toBe("✓ Done · Codenaya");
    expect(formatBuildTitle("Codenaya", "idle")).toBe("Codenaya");
  });
});
