import { afterEach, describe, expect, it, vi } from "vitest";

import type { Sandbox } from "@/features/sandbox-preview/server/provider/types";

import {
  MAX_IMAGE_URLS,
  PROBE_SOURCE,
  brokenImagesWarning,
  brokenReason,
  brokenRemoteImages,
  remoteImageUrls,
} from "./remote-images";

const DEAD = "https://images.unsplash.com/photo-1579584425555-c3ce17fd4399?w=800";
const LIVE = "https://images.unsplash.com/photo-1579584425555-c3ce17fd4351?w=800";

describe("remoteImageUrls", () => {
  it("finds remote images in page sources, with every file using each", () => {
    const urls = remoteImageUrls([
      { path: "src/pages/Menu.tsx", content: `<img src="${DEAD}" alt="Sushi" /><img src="${LIVE}" />` },
      { path: "src/index.css", content: ".hero { background: url(https://cdn.example.com/hero.webp); }" },
      { path: "index.html", content: '<meta property="og:image" content="https://example.com/og.png">' },
      { path: "src/data.ts", content: `const srcSet = "https://picsum.photos/seed/a/400/300 1x, https://picsum.photos/seed/a/800/600 2x"; ${DEAD}` },
      { path: "src/data/team.json", content: `[{ "photo": "${DEAD}" }]` },
    ]);
    expect([...urls].map(([url, paths]) => [url, [...paths]])).toEqual([
      [DEAD, ["src/pages/Menu.tsx", "src/data.ts", "src/data/team.json"]],
      [LIVE, ["src/pages/Menu.tsx"]],
      ["https://cdn.example.com/hero.webp", ["src/index.css"]],
      ["https://example.com/og.png", ["index.html"]],
      ["https://picsum.photos/seed/a/400/300", ["src/data.ts"]],
      ["https://picsum.photos/seed/a/800/600", ["src/data.ts"]],
    ]);
  });

  it("skips links, runtime URLs and files that are not page sources", () => {
    const urls = remoteImageUrls([
      { path: "src/App.tsx", content: '<a href="https://unsplash.com/photos/abc">Credit</a> fetch("https://api.example.com/items")' },
      { path: "src/Card.tsx", content: "<img src={`https://images.unsplash.com/${id}`} />" },
      // Bare hosts and URLs that code completes at runtime.
      { path: "index.html", content: '<link rel="preconnect" href="https://images.unsplash.com"><link rel="dns-prefetch" href="https://picsum.photos/">' },
      { path: "src/photos.ts", content: 'const PICSUM = "https://picsum.photos"; const src = "https://images.unsplash.com/photo-" + id + "?w=" + width;' },
      { path: "src/sizes.ts", content: 'const url = "https://images.unsplash.com/photo-1579584425555-c3ce17fd4351?w=" + w; const q = "https://i.pravatar.cc/150?u=x&"' },
      { path: "README.md", content: "![shot](https://example.com/shot.png)" },
      { path: "package.json", content: '"homepage": "https://example.com/logo.png"' },
    ]);
    expect(urls.size).toBe(0);
  });

  it("caps the URLs it returns", () => {
    const content = Array.from({ length: MAX_IMAGE_URLS + 5 }, (_, i) => `"https://picsum.photos/seed/${i}/10/10"`).join(" ");
    expect(remoteImageUrls([{ path: "src/App.tsx", content }]).size).toBe(MAX_IMAGE_URLS);
  });
});

describe("the sandbox probe", () => {
  afterEach(() => vi.unstubAllGlobals());

  const probe = new Function(`return ${PROBE_SOURCE}`)() as (urls: string[]) => Promise<[string, number, string][]>;
  const response = (status: number, type = "") =>
    new Response(status === 204 || status === 405 ? null : "x", { status, headers: type ? { "content-type": type } : {} });

  it("uses HEAD, falls back to a one-byte GET, and reports failed requests as status 0", async () => {
    const fetch = vi.fn(async (url: string, init: RequestInit) => {
      if (url.endsWith("/ok.jpg")) return response(200, "image/jpeg");
      if (url.endsWith("/no-head.jpg")) return init.method === "HEAD" ? response(405) : response(206, "image/jpeg");
      if (url.endsWith("/gone.jpg")) return response(404, "text/html");
      throw new TypeError("fetch failed");
    });
    vi.stubGlobal("fetch", fetch);

    const results = await probe(["https://a.test/ok.jpg", "https://a.test/no-head.jpg", "https://a.test/gone.jpg", "https://a.test/down.jpg"]);

    expect(results.sort()).toEqual([
      ["https://a.test/down.jpg", 0, ""],
      ["https://a.test/gone.jpg", 404, "text/html"],
      ["https://a.test/no-head.jpg", 206, "image/jpeg"],
      ["https://a.test/ok.jpg", 200, "image/jpeg"],
    ]);
    expect(fetch.mock.calls.filter(([url]) => url.endsWith("/ok.jpg"))).toHaveLength(1);
    const [, get] = fetch.mock.calls.filter(([url]) => url.endsWith("/no-head.jpg"));
    expect(get[1]).toMatchObject({ method: "GET", headers: { range: "bytes=0-0" } });
  });
});

describe("brokenReason", () => {
  it("counts only definite failures as broken", () => {
    expect(brokenReason([DEAD, 404, "text/html"])).toBe("HTTP 404");
    expect(brokenReason([DEAD, 410, ""])).toBe("HTTP 410");
    expect(brokenReason([DEAD, 200, "text/html; charset=utf-8"])).toBe("not an image (text/html; charset=utf-8)");
    expect(brokenReason([DEAD, 200, "application/json"])).toBe("not an image (application/json)");
    // Served as a download or untyped: a browser may still show it.
    for (const type of ["application/octet-stream", "binary/octet-stream", ""]) expect(brokenReason([LIVE, 200, type])).toBeUndefined();
    expect(brokenReason([LIVE, 206, "image/jpeg"])).toBeUndefined();
    // Network failures, timeouts, server errors and refusals may be flakiness or bot blocking.
    for (const status of [0, 403, 429, 500, 503]) expect(brokenReason([LIVE, status, ""])).toBeUndefined();
  });
});

describe("brokenRemoteImages", () => {
  const files = (...paths: string[]) => new Set(paths);
  const sandboxAnswering = (run: Sandbox["run"]) => ({ run: vi.fn(run) }) as unknown as Sandbox & { run: ReturnType<typeof vi.fn> };

  it("probes in the sandbox and lists the broken images with their files", async () => {
    const sandbox = sandboxAnswering(async () => ({
      exitCode: 0,
      stderr: "",
      stdout: `${JSON.stringify([[DEAD, 404, "text/html"], [LIVE, 200, "image/jpeg"]])}\n`,
    }));
    const urls = new Map([
      [DEAD, files("src/pages/Menu.tsx", "src/data/menu.json")],
      [LIVE, files("src/pages/Menu.tsx")],
      ["https://source.unsplash.com/800x600/?sushi", files("src/pages/Home.tsx")],
    ]);

    const broken = await brokenRemoteImages(sandbox, urls, 60_000);

    expect(broken).toEqual([
      "src/pages/Home.tsx: https://source.unsplash.com/800x600/?sushi (the host is shut down)",
      `src/pages/Menu.tsx: ${DEAD} (HTTP 404)`,
      `src/data/menu.json: ${DEAD} (HTTP 404)`,
    ]);
    const [command, opts] = sandbox.run.mock.calls[0];
    expect(command).toMatch(/^node -e '/);
    expect(command).toContain(JSON.stringify([DEAD, LIVE]));
    expect(command).not.toContain("source.unsplash.com");
    expect(opts.timeoutMs).toBeLessThanOrEqual(25_000);
  });

  it("reports nothing when the probe fails or times out", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const sandbox = sandboxAnswering(async () => {
      throw new Error("command timed out");
    });
    expect(await brokenRemoteImages(sandbox, new Map([[DEAD, files("src/App.tsx")]]), 60_000)).toEqual([]);
  });

  it("quotes URLs safely for the shell", async () => {
    const sandbox = sandboxAnswering(async () => ({ exitCode: 0, stderr: "", stdout: "[]" }));
    await brokenRemoteImages(sandbox, new Map([["https://a.test/it's.png", files("src/App.tsx")]]), 60_000);
    expect(sandbox.run.mock.calls[0][0]).toContain(`it'\\''s.png`);
  });
});

it("brokenImagesWarning is a labelled warning, never an error", () => {
  const warning = brokenImagesWarning([`src/App.tsx: ${DEAD} (HTTP 404)`]);
  expect(warning).toMatch(/^\nWarning: broken remote images/);
  expect(warning).not.toMatch(/\bError\b/);
  expect(warning).toContain(`- src/App.tsx: ${DEAD} (HTTP 404)`);
  expect(warning).toContain("picsum.photos/seed/");
});
