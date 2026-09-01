import { describe, expect, it } from "vitest";

import { shouldAcceptCallbackMessage } from "./use-oauth-popup";

/**
 * The popup flow's security boundary.
 *
 * The OAuth callback reports its result by `postMessage` to `window.opener`.
 * Without an origin check, any page that can reach our window could post a
 * forged `{ status: "success" }` and make the UI report a connection that never
 * happened — or suppress a real failure.
 *
 * Only the predicate is tested here, not the full hook: this repo's vitest setup
 * is node-only, and adding jsdom for one hook would mean new devDependencies and
 * config churn on this branch. Extracting the decision as a pure function gets the
 * security-relevant logic under test without that. The remaining lifecycle
 * behaviour (popup blocking, manual close polling, teardown) is not covered by an
 * automated test.
 */

const ORIGIN = "https://codenaya.com";

const validSuccess = { source: "codenaya-oauth", status: "success" } as const;
const validError = {
  source: "codenaya-oauth",
  status: "error",
  message: "nope",
} as const;

describe("shouldAcceptCallbackMessage", () => {
  it("accepts a well-formed success from our own origin", () => {
    expect(
      shouldAcceptCallbackMessage({
        eventOrigin: ORIGIN,
        expectedOrigin: ORIGIN,
        data: validSuccess,
      }),
    ).toBe(true);
  });

  it("accepts a well-formed error from our own origin", () => {
    expect(
      shouldAcceptCallbackMessage({
        eventOrigin: ORIGIN,
        expectedOrigin: ORIGIN,
        data: validError,
      }),
    ).toBe(true);
  });

  it("rejects a forged success from a different origin", () => {
    // The core attack: correct payload shape, wrong sender.
    expect(
      shouldAcceptCallbackMessage({
        eventOrigin: "https://evil.example.com",
        expectedOrigin: ORIGIN,
        data: validSuccess,
      }),
    ).toBe(false);
  });

  it("rejects a lookalike origin", () => {
    for (const eventOrigin of [
      "https://codenaya.com.evil.io",
      "https://evil-codenaya.com",
      "http://codenaya.com",
      "https://codenaya.com:8443",
      "https://sub.codenaya.com",
    ]) {
      expect(
        shouldAcceptCallbackMessage({
          eventOrigin,
          expectedOrigin: ORIGIN,
          data: validSuccess,
        }),
      ).toBe(false);
    }
  });

  it("ignores messages without our source marker", () => {
    // Extensions, embeds and dev tooling all post into the page. These must be
    // ignored, not treated as failures.
    for (const data of [
      { status: "success" },
      { source: "other-app", status: "success" },
      { source: "CODENAYA-OAUTH", status: "success" },
      { source: "codenaya-oauth-x", status: "success" },
    ]) {
      expect(
        shouldAcceptCallbackMessage({
          eventOrigin: ORIGIN,
          expectedOrigin: ORIGIN,
          data,
        }),
      ).toBe(false);
    }
  });

  it("ignores an unrecognised status", () => {
    for (const status of ["pending", "ok", "", null, undefined, 1, true]) {
      expect(
        shouldAcceptCallbackMessage({
          eventOrigin: ORIGIN,
          expectedOrigin: ORIGIN,
          data: { source: "codenaya-oauth", status },
        }),
      ).toBe(false);
    }
  });

  it("ignores non-object payloads without throwing", () => {
    for (const data of [null, undefined, "codenaya-oauth", 42, true, []]) {
      expect(() =>
        shouldAcceptCallbackMessage({
          eventOrigin: ORIGIN,
          expectedOrigin: ORIGIN,
          data,
        }),
      ).not.toThrow();
      expect(
        shouldAcceptCallbackMessage({
          eventOrigin: ORIGIN,
          expectedOrigin: ORIGIN,
          data,
        }),
      ).toBe(false);
    }
  });

  it("checks origin before payload shape", () => {
    // A malformed payload from a foreign origin is rejected on both counts;
    // asserting it here documents that neither check alone is load-bearing.
    expect(
      shouldAcceptCallbackMessage({
        eventOrigin: "https://evil.example.com",
        expectedOrigin: ORIGIN,
        data: { nonsense: true },
      }),
    ).toBe(false);
  });
});
