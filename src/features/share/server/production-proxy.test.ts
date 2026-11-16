import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { afterEach, expect, test, vi } from "vitest";
import { publicFrameHeaders, productionProxy } from "./production-proxy";
import { publicPreviewOrigins } from "./frame-origins";

afterEach(() => vi.unstubAllEnvs());
const origins = ["http://localhost:3100", "https://codenaya.tech"];

test("public proxy replaces frame restrictions while preserving other CSP directives", () => {
  const headers = publicFrameHeaders({ "x-frame-options": "DENY", "content-security-policy": ["default-src 'self'; frame-ancestors 'none'", "script-src 'self'"] }, origins);
  expect(headers["x-frame-options"]).toBeUndefined();
  expect(headers["content-security-policy"]).toEqual([
    "default-src 'self'; frame-ancestors http://localhost:3100 https://codenaya.tech",
    "script-src 'self'; frame-ancestors http://localhost:3100 https://codenaya.tech",
  ]);
});

test("embedding origins come from validated deployment configuration, not the request", () => {
  vi.stubEnv("CODENAYA_PUBLIC_PREVIEW_ORIGINS", "http://localhost:3100, https://codenaya.tech,http://localhost:3216");
  expect(publicPreviewOrigins()).toEqual([...origins, "http://localhost:3216"]);
  for (const value of ["", "*", "null", "https://site.example/path", "https://site.example/", "https://site.example?x=1", "https://user:pass@site.example", "https://site.example;script-src *", "http://untrusted.example"]) {
    expect(() => publicPreviewOrigins(value)).toThrow();
  }
});

test("the serialized proxy serves real HTTP frame headers and body", async () => {
  const upstream = createServer((_request, response) => {
    response.writeHead(200, { "x-frame-options": "DENY", "content-security-policy": "default-src 'self'; frame-ancestors 'none'", "content-type": "text/html" });
    response.end("<h1>Public production site</h1>");
  }).listen(0, "127.0.0.1");
  await once(upstream, "listening");
  const port = (upstream.address() as AddressInfo).port;
  // Only the two listener bindings change; execute the actual serialized proxy body.
  const script = productionProxy(origins).replace("port: 3000", `port: ${port}`)
    .replace(".listen(4000, '0.0.0.0');", ".listen(0, '127.0.0.1', function () { console.log(this.address().port); });");
  const child = spawn(process.execPath, ["--input-type=module", "-"], { stdio: ["pipe", "pipe", "pipe"] });
  const closed = once(child, "exit");
  try {
    const listening = once(child.stdout, "data");
    child.stdin.end(script);
    const [line] = await listening;
    const response = await fetch(`http://127.0.0.1:${Number(String(line).trim())}/`, { headers: { Origin: "http://untrusted.example", "X-Forwarded-Host": "0.0.0.0:3100" } });
    expect(response.status).toBe(200);
    expect(response.headers.get("x-frame-options")).toBeNull();
    expect(response.headers.get("content-security-policy")).toBe("default-src 'self'; frame-ancestors http://localhost:3100 https://codenaya.tech");
    expect(await response.text()).toContain("Public production site");
  } finally {
    child.kill("SIGTERM");
    await closed;
    upstream.closeAllConnections();
    await new Promise<void>(resolve => upstream.close(() => resolve()));
  }
});
