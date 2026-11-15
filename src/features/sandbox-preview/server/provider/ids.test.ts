import { describe, expect, it } from "vitest";

import { parsePublicSandboxIdOrNull, toPublicSandboxId } from "./ids";

describe("public sandbox ids", () => {
  it("round-trips a prefixed id", () => {
    expect(parsePublicSandboxIdOrNull(toPublicSandboxId("e2b", "i3ab9xk2"))).toEqual({ provider: "e2b", nativeId: "i3ab9xk2" });
  });

  it("reads an unprefixed id as E2B's, so open previews keep working", () => {
    expect(parsePublicSandboxIdOrNull("i3ab9xk2")).toEqual({ provider: "e2b", nativeId: "i3ab9xk2" });
  });

  it.each([
    "",
    "blaxel:abc", // unknown provider
    "E2B:abc", // providers are matched exactly
    "e2b:",
    ":abc",
    "e2b:a:b",
    "e2b:../etc",
    "e2b:abc def",
    `e2b:${"a".repeat(129)}`,
  ])("rejects %j", (id) => {
    expect(parsePublicSandboxIdOrNull(id)).toBeNull();
  });
});
