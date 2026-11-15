import { beforeEach, describe, expect, it, vi } from "vitest";

import { cancelRun, OPEN_OVERLAY, shouldEscapeCancelRun, STOP_GRACE_MS } from "./run-cancel";

const kyPost = vi.hoisted(() => vi.fn());
vi.mock("ky", () => ({ default: { post: kyPost } }));

const esc = (init: Partial<KeyboardEvent> = {}) =>
  ({ key: "Escape", defaultPrevented: false, repeat: false, ...init }) as KeyboardEvent;
// Stands in for the document: holds an open overlay or doesn't.
const page = (overlayOpen: boolean) => ({
  querySelector: (selector: string) =>
    overlayOpen && selector === OPEN_OVERLAY ? ({} as Element) : null,
});

describe("shouldEscapeCancelRun", () => {
  it("cancels when nothing is open", () => {
    expect(shouldEscapeCancelRun(esc(), page(false))).toBe(true);
  });

  it("leaves the run alone when Esc closes an open overlay (#608)", () => {
    expect(shouldEscapeCancelRun(esc(), page(true))).toBe(false);
  });

  it("leaves the run alone when something else handled Esc, or the key is held", () => {
    expect(shouldEscapeCancelRun(esc({ defaultPrevented: true }), page(false))).toBe(false);
    expect(shouldEscapeCancelRun(esc({ repeat: true }), page(false))).toBe(false);
  });

  it("ignores other keys", () => {
    expect(shouldEscapeCancelRun(esc({ key: "Enter" }), page(false))).toBe(false);
  });
});

describe("cancelRun", () => {
  const startedAt = 10_000;

  beforeEach(() => kyPost.mockReset());

  it("ignores Stop right after the run starts: the second click of a double-click on Send", async () => {
    expect(await cancelRun("p1", "button", startedAt, startedAt + 200)).toBe(false);
    expect(await cancelRun("p1", "button", startedAt, startedAt + STOP_GRACE_MS - 1)).toBe(false);
    expect(kyPost).not.toHaveBeenCalled();
  });

  it("cancels on a deliberate Stop after the grace period, naming the button", async () => {
    expect(await cancelRun("p1", "button", startedAt, startedAt + STOP_GRACE_MS)).toBe(true);
    expect(kyPost).toHaveBeenCalledWith("/api/messages/cancel", {
      json: { projectId: "p1", source: "button" },
    });
  });

  it("cancels on Esc at once, naming Esc", async () => {
    expect(await cancelRun("p1", "esc", startedAt, startedAt + 200)).toBe(true);
    expect(kyPost).toHaveBeenCalledWith("/api/messages/cancel", {
      json: { projectId: "p1", source: "esc" },
    });
  });
});
