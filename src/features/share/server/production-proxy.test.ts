import { expect, test } from "vitest";
import { publicFrameHeaders } from "./production-proxy";

test("public proxy replaces frame restrictions while preserving other CSP directives", () => {
  const headers = publicFrameHeaders({ "x-frame-options": "DENY", "content-security-policy": ["default-src 'self'; frame-ancestors 'none'", "script-src 'self'"] }, "http://localhost:3100");
  expect(headers["x-frame-options"]).toBeUndefined();
  expect(headers["content-security-policy"]).toEqual([
    "default-src 'self'; frame-ancestors http://localhost:3100",
    "script-src 'self'; frame-ancestors http://localhost:3100",
  ]);
  expect(publicFrameHeaders({}, "https://codenaya.tech")["content-security-policy"]).toEqual(["frame-ancestors https://codenaya.tech"]);
});
