import { describe, expect, it } from "vitest";

import { canonicalSandboxIdOrNull, clientSandboxId, parsePublicSandboxIdOrNull, toPublicSandboxId } from "./ids";

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

  it("gives the client E2B's id unprefixed until another provider can host a sandbox", () => {
    expect(clientSandboxId({ provider: "e2b", id: "abc" }, false)).toBe("abc");
    expect(clientSandboxId({ provider: "e2b", id: "abc" }, true)).toBe("e2b:abc");
  });

  it("keys a sandbox the same with or without its prefix, and nothing for a malformed id", () => {
    expect(canonicalSandboxIdOrNull("abc")).toBe("e2b:abc");
    expect(canonicalSandboxIdOrNull("e2b:abc")).toBe("e2b:abc");
    expect(canonicalSandboxIdOrNull("blaxel:abc")).toBeNull();
  });
});
