import { describe, expect, it } from "vitest";
import {
  hasPackageJson,
  hasIndexHtml,
  STATIC_SERVER_SCRIPT,
} from "./static-server";

describe("static-server utils (Issue #262)", () => {
  it("detects package.json correctly", () => {
    expect(hasPackageJson(["package.json"])).toBe(true);
    expect(hasPackageJson(["/package.json"])).toBe(true);
    expect(hasPackageJson(["packages/app/package.json"])).toBe(true);
    expect(hasPackageJson(["index.html", "style.css"])).toBe(false);
  });

  it("detects index.html correctly", () => {
    expect(hasIndexHtml(["index.html"])).toBe(true);
    expect(hasIndexHtml(["/index.html"])).toBe(true);
    expect(hasIndexHtml(["index.htm"])).toBe(true);
    expect(hasIndexHtml(["src/index.html"])).toBe(false);
    expect(hasIndexHtml(["package.json", "src/main.ts"])).toBe(false);
  });

  it("provides valid JavaScript for STATIC_SERVER_SCRIPT", () => {
    expect(STATIC_SERVER_SCRIPT).toContain("http.createServer");
    expect(STATIC_SERVER_SCRIPT).toContain("server.listen(PORT, '0.0.0.0'");
    expect(STATIC_SERVER_SCRIPT).toContain("index.html");
  });
});
