import { describe, expect, it } from "vitest";

import { classifySandboxError } from "./sandbox-error";

describe("classifySandboxError", () => {
  it("uses the code the route sends", () => {
    expect(classifySandboxError({ code: "config", status: 200 })).toBe("config");
    expect(classifySandboxError({ code: "rate_limit" })).toBe("rate_limit");
    expect(classifySandboxError({ code: "transient", status: 503 })).toBe(
      "transient",
    );
  });

  it("treats a missing or rejected E2B key as a config error", () => {
    expect(classifySandboxError({ status: 503 })).toBe("config");
    expect(classifySandboxError({ status: 401 })).toBe("config");
  });

  it("treats 429 as a rate limit, not a config error", () => {
    expect(classifySandboxError({ status: 429 })).toBe("rate_limit");
  });

  it("falls back to transient for unknown codes and other failures", () => {
    expect(classifySandboxError({ code: "bogus", status: 500 })).toBe(
      "transient",
    );
    expect(classifySandboxError({})).toBe("transient");
  });
});
