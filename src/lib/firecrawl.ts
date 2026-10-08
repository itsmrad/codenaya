import Firecrawl from "@mendable/firecrawl-js";

export const FIRECRAWL_NOT_CONFIGURED_MESSAGE =
  "URL scraping is unavailable: FIRECRAWL_API_KEY is not configured.";

let client: Firecrawl | null = null;

/**
 * Returns a shared Firecrawl client, or `null` when FIRECRAWL_API_KEY is unset.
 * Firecrawl is optional, so callers must skip scraping when this returns null.
 * The client is created on first use, never at import time, so `next build`
 * works without the key.
 */
export function getFirecrawl(): Firecrawl | null {
  const apiKey = process.env.FIRECRAWL_API_KEY;
  if (!apiKey) return null;
  client ??= new Firecrawl({ apiKey });
  return client;
}
