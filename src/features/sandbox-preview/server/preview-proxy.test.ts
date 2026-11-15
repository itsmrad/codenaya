import { describe, expect, it } from "vitest";

import { createBridgeInjector, rewriteProxyHeaders, shouldInjectBridge } from "./preview-proxy";

describe("rewriteProxyHeaders", () => {
  // The proxy serializes this helper into the sandbox's standalone script.
  const rewrite = new Function(`return (${String(rewriteProxyHeaders)});`)() as typeof rewriteProxyHeaders;

  it("rewrites Host and an existing Origin together for HTTP and websocket requests", () => {
    const headers = { host: "4000-sbx.e2b.app", origin: "https://4000-sbx.e2b.app", upgrade: "websocket" };
    expect(rewrite(headers, 3000)).toEqual({ host: "localhost:3000", origin: "http://localhost:3000", upgrade: "websocket" });
    expect(headers.origin).toBe("https://4000-sbx.e2b.app");
  });

  it("does not invent Origin for requests without one", () => {
    expect(rewrite({ host: "4000-sbx.e2b.app" }, 5173)).toEqual({ host: "localhost:5173" });
  });

  it("removes edge forwarding headers so Server Actions compare Origin with the rewritten Host", () => {
    const headers = {
      host: "4000-sbx.e2b.app",
      origin: "https://4000-sbx.e2b.app",
      "x-forwarded-host": "4000-sbx.e2b.app",
      "x-forwarded-proto": "https",
    };
    expect(rewrite(headers, 3000)).toEqual({ host: "localhost:3000", origin: "http://localhost:3000" });
    expect(headers["x-forwarded-host"]).toBe("4000-sbx.e2b.app");
    expect(rewrite({ "x-forwarded-host": "edge.example", "x-forwarded-proto": "https" }, 5173)).toEqual({ host: "localhost:5173" });
  });
});

describe("shouldInjectBridge", () => {
  const inject = new Function(`return (${String(shouldInjectBridge)});`)() as typeof shouldInjectBridge;
  const html = { "content-type": "text/html; charset=utf-8" };

  it.each([200, 404, 500])("injects the bridge into a %i HTML response", (status) => {
    expect(inject("GET", status, html)).toBe(true);
  });

  it.each([101, 204, 205, 301, 302, 304, 307, 308])("leaves status %i headers and body unchanged", (status) => {
    expect(inject("GET", status, html)).toBe(false);
  });

  it("skips HEAD, non-HTML, compressed, and missing-status responses", () => {
    expect(inject("HEAD", 200, html)).toBe(false);
    expect(inject("GET", 200, { "content-type": "application/javascript" })).toBe(false);
    expect(inject("GET", 500, { ...html, "content-encoding": "gzip" })).toBe(false);
    expect(inject("GET", undefined, html)).toBe(false);
  });

  it.each(["application/javascript", "application/json", "text/x-component"])(
    "leaves %s responses on the untouched passthrough path",
    (contentType) => {
      expect(inject("GET", 200, { "content-type": contentType })).toBe(false);
    },
  );
});

describe("createBridgeInjector", () => {
  // Exercise the same standalone function source installed in the sandbox.
  const create = new Function(`return (${String(createBridgeInjector)});`)() as typeof createBridgeInjector;
  const bridge = "<script data-codenaya-preview></script>";

  it("injects after head and emits the shell before the response ends", () => {
    const injector = create(bridge);
    expect(Buffer.concat(injector.push(Buffer.from("<html><head><title>shell</title>"))).toString())
      .toBe(`<html><head>${bridge}<title>shell</title>`);
    expect(Buffer.concat(injector.push(Buffer.from("</head><body>later"))).toString())
      .toBe("</head><body>later");
    expect(injector.flush()).toEqual([]);
  });

  it("retains a head tag split across chunks", () => {
    const injector = create(bridge);
    expect(injector.push(Buffer.from("<html><he"))).toEqual([]);
    expect(Buffer.concat(injector.push(Buffer.from("ad><title>x"))).toString())
      .toBe(`<html><head>${bridge}<title>x`);
  });

  it.each([
    '<head lang="en">',
    '<head data-label="a>b" lang=\'en\'>',
    "<HEAD>",
    "<HeAd\nlang='en'>",
  ])("inserts after the complete opening tag: %s", (head) => {
    const injector = create(bridge);
    expect(Buffer.concat(injector.push(Buffer.from(head + "<title>x"))).toString())
      .toBe(head + bridge + "<title>x");
  });

  it("waits for split attributes and does not match header elements", () => {
    const injector = create(bridge);
    expect(injector.push(Buffer.from('<header>x</header><head lang="'))).toEqual([]);
    expect(Buffer.concat(injector.push(Buffer.from('en">'))).toString())
      .toBe(`<header>x</header><head lang="en">${bridge}`);
  });

  it("injects at end when a short document has no head", () => {
    const injector = create(bridge);
    expect(injector.push(Buffer.from("<html><body>hello"))).toEqual([]);
    expect(Buffer.concat(injector.flush()).toString()).toBe("<html>" + bridge + "<body>hello");
    expect(injector.flush()).toEqual([]);
    expect(Buffer.concat(create(bridge).flush()).toString()).toBe(bridge);
  });

  it("never places the bridge before the doctype when there is no head", () => {
    const flushed = create(bridge);
    expect(flushed.push(Buffer.from("<!DOCTYPE html><html lang=en><body>hi"))).toEqual([]);
    expect(Buffer.concat(flushed.flush()).toString()).toBe(`<!DOCTYPE html><html lang=en>${bridge}<body>hi`);
    const doctypeOnly = create(bridge);
    doctypeOnly.push(Buffer.from("<!doctype html>hi"));
    expect(Buffer.concat(doctypeOnly.flush()).toString()).toBe(`<!doctype html>${bridge}hi`);
    const capped = create(bridge);
    const filler = Buffer.alloc(16384, 120);
    expect(Buffer.concat(capped.push(Buffer.concat([Buffer.from("<!DOCTYPE html><html>"), filler]))).toString())
      .toBe(`<!DOCTYPE html><html>${bridge}${filler}`);
  });

  it("does not inject twice when the page already has the bridge", () => {
    const page = `<html><head>${bridge}</head>`;
    const injector = create(bridge);
    expect(Buffer.concat(injector.push(Buffer.from(page))).toString()).toBe(page);
    const noHead = create(bridge);
    noHead.push(Buffer.from(`<html>${bridge}<body>`));
    expect(Buffer.concat(noHead.flush()).toString()).toBe(`<html>${bridge}<body>`);
  });

  it("flushes at 16 KiB without waiting for a head or the end", () => {
    const injector = create(bridge);
    expect(injector.push(Buffer.alloc(16383, 120))).toEqual([]);
    expect(Buffer.concat(injector.push(Buffer.from("y"))))
      .toEqual(Buffer.concat([Buffer.from(bridge), Buffer.alloc(16383, 120), Buffer.from("y")]));
    const lateHead = Buffer.from("<head>late</head>");
    expect(injector.push(lateHead)).toEqual([lateHead]);
    expect(injector.flush()).toEqual([]);
  });

  it("passes through a large first chunk after a bounded prefix", () => {
    const chunk = Buffer.alloc(65536, 120);
    const injector = create(bridge);
    expect(Buffer.concat(injector.push(chunk))).toEqual(Buffer.concat([Buffer.from(bridge), chunk]));
    expect(injector.flush()).toEqual([]);
  });

  it("still inserts after a head ending exactly at the carry limit", () => {
    const prefix = Buffer.alloc(16378, 120);
    const injector = create(bridge);
    expect(injector.push(prefix)).toEqual([]);
    expect(Buffer.concat(injector.push(Buffer.from("<head>tail"))))
      .toEqual(Buffer.concat([prefix, Buffer.from("<head>" + bridge + "tail")]));
  });

  it("preserves UTF-8 split across chunks, including around the injection point", () => {
    const html = Buffer.from('<html>🙂<head lang="日本語"><title>café</title></head>');
    const injector = create(bridge);
    const output: Buffer[] = [];
    for (const byte of html) output.push(...injector.push(Buffer.from([byte])));
    output.push(...injector.flush());
    expect(Buffer.concat(output)).toEqual(Buffer.from(
      `<html>🙂<head lang="日本語">${bridge}<title>café</title></head>`,
    ));
  });

  it("preserves UTF-8 split at the carry limit", () => {
    const html = Buffer.concat([Buffer.alloc(16383, 120), Buffer.from("🙂tail")]);
    const injector = create(bridge);
    expect(injector.push(html.subarray(0, 16383))).toEqual([]);
    const output = injector.push(html.subarray(16383, 16384));
    output.push(...injector.push(html.subarray(16384)), ...injector.flush());
    expect(Buffer.concat(output)).toEqual(Buffer.concat([Buffer.from(bridge), html]));
  });

  it("passes every chunk byte-for-byte after injection, without decoding it", () => {
    const injector = create(bridge);
    injector.push(Buffer.from("<head>"));
    for (const chunk of [Buffer.from([0xf0, 0x9f]), Buffer.from([0x99, 0x82, 0xff, 0x00]), Buffer.from("<head>")]) {
      const output = injector.push(chunk);
      expect(output).toHaveLength(1);
      expect(output[0]).toBe(chunk);
    }
  });
});
