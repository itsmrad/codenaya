import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  cancelRun,
  ESC_CONFIRM_MS,
  escapeToStop,
  OPEN_OVERLAY,
  shouldEscapeCancelRun,
  STOP_GRACE_MS,
} from "./run-cancel";

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

describe("escapeToStop", () => {
  it("asks for a second Esc before stopping (#608: one Esc stopped a first build)", () => {
    const press = escapeToStop();
    expect(press(esc(), 1_000, page(false))).toBe("confirm");
    expect(press(esc(), 1_000 + ESC_CONFIRM_MS - 1, page(false))).toBe("stop");
  });

  it("treats an Esc after the window as a new first press", () => {
    const press = escapeToStop();
    expect(press(esc(), 1_000, page(false))).toBe("confirm");
    expect(press(esc(), 1_000 + ESC_CONFIRM_MS, page(false))).toBe("confirm");
    expect(press(esc(), 1_000 + ESC_CONFIRM_MS + 500, page(false))).toBe("stop");
  });

  it("starts over after a stop", () => {
    const press = escapeToStop();
    press(esc(), 1_000, page(false));
    expect(press(esc(), 1_100, page(false))).toBe("stop");
    expect(press(esc(), 1_200, page(false))).toBe("confirm");
  });

  it("never counts a held key or an Esc that closes an overlay as the second press", () => {
    const press = escapeToStop();
    expect(press(esc(), 1_000, page(false))).toBe("confirm");
    expect(press(esc({ repeat: true }), 1_100, page(false))).toBeNull();
    expect(press(esc(), 1_200, page(true))).toBeNull();
    expect(press(esc({ defaultPrevented: true }), 1_300, page(false))).toBeNull();
    expect(press(esc(), 1_400, page(false))).toBe("stop");
  });

  it("never counts an Esc that closes an overlay as the first press", () => {
    const press = escapeToStop();
    expect(press(esc(), 1_000, page(true))).toBeNull();
    expect(press(esc(), 1_100, page(false))).toBe("confirm");
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
