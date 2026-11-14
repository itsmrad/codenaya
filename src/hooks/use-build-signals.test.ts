import { describe, expect, it } from "vitest";
import { formatBuildTitle, getBuildStatus } from "./use-build-signals";

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

describe("getBuildStatus", () => {
  const run = { _id: "run-1" };

  it("stays building while a run is active, even if a previous run was done", () => {
    expect(getBuildStatus(run, false)).toBe("building");
    expect(getBuildStatus(run, true)).toBe("building");
  });

  it("shows done after a run until it is cleared", () => {
    expect(getBuildStatus(null, true)).toBe("done");
    expect(getBuildStatus(null, false)).toBe("idle");
  });

  it("does not invent a run while the query is loading", () => {
    expect(getBuildStatus(undefined, false)).toBe("idle");
    expect(getBuildStatus(undefined, true)).toBe("done");
  });
});
