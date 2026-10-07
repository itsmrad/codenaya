import { describe, expect, it } from "vitest";

import { nodeIncompatibility } from "./node-compat";

const pkg = (vite: string, field = "devDependencies") =>
  JSON.stringify({ [field]: { vite } });

describe("nodeIncompatibility", () => {
  it("flags Vite 7 on the E2B base image's Node 20.9", () => {
    const message = nodeIncompatibility("v20.9.0\n", pkg("^7.1.0"));
    expect(message).toContain("Vite 7");
    expect(message).toContain("Node v20.9.0");
  });

  it("allows Vite 7 on the Node versions it supports", () => {
    for (const node of ["v20.19.0", "v22.12.0", "v22.20.1", "v24.1.0"]) {
      expect(nodeIncompatibility(node, pkg("^7.0.0"))).toBeNull();
    }
  });

  it("flags Node 22 releases before 22.12", () => {
    expect(nodeIncompatibility("v22.11.0", pkg("~7.0.0"))).not.toBeNull();
  });

  it("allows Vite 6 and older on Node 20.9", () => {
    expect(nodeIncompatibility("v20.9.0", pkg("^6.0.0"))).toBeNull();
    expect(nodeIncompatibility("v20.9.0", pkg("5.4.2", "dependencies"))).toBeNull();
  });

  it("treats an unversioned range as the newest Vite", () => {
    expect(nodeIncompatibility("v20.9.0", pkg("latest"))).toContain("Vite 7+");
  });

  it("stays out of the way when it can't tell", () => {
    expect(nodeIncompatibility("v20.9.0", undefined)).toBeNull();
    expect(nodeIncompatibility("v20.9.0", "{ not json")).toBeNull();
    expect(nodeIncompatibility("v20.9.0", JSON.stringify({ dependencies: {} }))).toBeNull();
    expect(nodeIncompatibility("garbage", pkg("^7.0.0"))).toBeNull();
  });
});
