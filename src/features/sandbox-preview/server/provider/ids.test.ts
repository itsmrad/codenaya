import { describe, expect, it } from "vitest";

import { canonicalSandboxIdOrNull, clientSandboxId, parsePublicSandboxIdOrNull, toPublicSandboxId } from "./ids";
import { PROVIDER_IDS } from "./types";

describe("public sandbox ids", () => {
  it.each(PROVIDER_IDS)("round-trips a prefixed %s id", (provider) => {
    expect(parsePublicSandboxIdOrNull(toPublicSandboxId(provider, "i3ab9xk2"))).toEqual({ provider, nativeId: "i3ab9xk2" });
  });

  it("round-trips a Blaxel sandbox name, which the client always gets prefixed", () => {
    const name = "cn-a1b2c3d4e5f6g7h8i9j0";
    expect(parsePublicSandboxIdOrNull(`blaxel:${name}`)).toEqual({ provider: "blaxel", nativeId: name });
    expect(canonicalSandboxIdOrNull(`blaxel:${name}`)).toBe(`blaxel:${name}`);
    expect(clientSandboxId({ provider: "blaxel", id: name }, false)).toBe(`blaxel:${name}`);
    expect(clientSandboxId({ provider: "blaxel", id: name }, true)).toBe(`blaxel:${name}`);
  });

  it("reads an unprefixed id as E2B's, so open previews keep working", () => {
    expect(parsePublicSandboxIdOrNull("i3ab9xk2")).toEqual({ provider: "e2b", nativeId: "i3ab9xk2" });
  });

  it.each([
    "",
    "other:abc", // unknown provider
    "E2B:abc", // providers are matched exactly
    "Blaxel:cn-abc",
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
    expect(canonicalSandboxIdOrNull("other:abc")).toBeNull();
  });
});
