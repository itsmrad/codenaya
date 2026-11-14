import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import jsQR from "jsqr";
import { describe, expect, it } from "vitest";

import { PreviewQrCode } from "./qr-code";

const SCALE = 4;

/**
 * Renders the QR SVG, rasterizes its dark-module path into RGBA pixels and
 * decodes it with jsQR, so the test checks what a phone camera would read.
 */
const renderAndDecode = (url: string) => {
  const svg = renderToStaticMarkup(createElement(PreviewQrCode, { url }));
  const modules = Number(/viewBox="0 0 (\d+) \1"/.exec(svg)?.[1]);
  const darkPath = /<path fill="#000000" d="([^"]+)"/.exec(svg)?.[1] ?? "";

  const px = modules * SCALE;
  const rgba = new Uint8ClampedArray(px * px * 4).fill(255);
  // qrcode.react draws each horizontal run of dark modules as `M<x> <y>h<len>v1...`.
  for (const [, x, y, len] of darkPath.matchAll(/M(\d+)[ ,](\d+) ?h(\d+)/g)) {
    for (let row = +y * SCALE; row < (+y + 1) * SCALE; row++) {
      for (let col = +x * SCALE; col < (+x + +len) * SCALE; col++) {
        rgba.fill(0, (row * px + col) * 4, (row * px + col) * 4 + 3);
      }
    }
  }
  return { modules, decoded: jsQR(rgba, px, px)?.data };
};

describe("PreviewQrCode", () => {
  it("encodes a typical E2B preview URL into a scannable code", () => {
    const url = "https://4000-i8xk2m9q7w3v5b1n6z0c.e2b.app";
    const { modules, decoded } = renderAndDecode(url);
    expect(decoded).toBe(url);
    // Small version (≤ 3, 29 modules) plus the 4-module quiet zone on each side.
    expect(modules).toBeLessThanOrEqual(29 + 8);
  });

  it("encodes a long URL with a path and query", () => {
    const url = `https://4000-i8xk2m9q7w3v5b1n6z0c.e2b.app/products/42?${"ref=phone&".repeat(25)}`;
    expect(url.length).toBeGreaterThan(250);
    expect(renderAndDecode(url).decoded).toBe(url);
  });
});
