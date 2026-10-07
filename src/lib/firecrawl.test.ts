import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Firecrawl is optional. These tests pin the not-configured path: importing
 * the module must not construct a client (that broke `next build`), and the
 * scrape tool must report a clear error instead of throwing.
 */

describe("getFirecrawl", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns null when FIRECRAWL_API_KEY is unset", async () => {
    vi.stubEnv("FIRECRAWL_API_KEY", "");
    const { getFirecrawl } = await import("./firecrawl");

    expect(getFirecrawl()).toBeNull();
  });

  it("creates the client once when the key is set", async () => {
    vi.stubEnv("FIRECRAWL_API_KEY", "fc-test");
    const { getFirecrawl } = await import("./firecrawl");

    const client = getFirecrawl();
    expect(client).not.toBeNull();
    expect(getFirecrawl()).toBe(client);
  });
});

describe("scrapeUrls tool without FIRECRAWL_API_KEY", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns a not-configured error instead of scraping", async () => {
    vi.stubEnv("FIRECRAWL_API_KEY", "");
    const { FIRECRAWL_NOT_CONFIGURED_MESSAGE } = await import("./firecrawl");
    const { createScrapeUrlsTool } = await import(
      "@/features/conversations/inngest/tools/scrape-urls"
    );
    const step = { run: vi.fn() };

    const tool = createScrapeUrlsTool();
    const result = await tool.handler(
      { urls: ["https://example.com"] },
      // Only `step` is read by the handler.
      { step } as unknown as Parameters<typeof tool.handler>[1]
    );

    expect(result).toBe(`Error: ${FIRECRAWL_NOT_CONFIGURED_MESSAGE}`);
    expect(step.run).not.toHaveBeenCalled();
  });
});
