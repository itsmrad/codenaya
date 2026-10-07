import { ConvexHttpClient } from "convex/browser";

let client: ConvexHttpClient | null = null;

function getConvexClient(): ConvexHttpClient {
  if (!client) {
    const url = process.env.NEXT_PUBLIC_CONVEX_URL;
    if (!url) {
      throw new Error(
        "NEXT_PUBLIC_CONVEX_URL is not set. Configure it to call Convex from the server."
      );
    }
    client = new ConvexHttpClient(url);
  }
  return client;
}

/**
 * Server-side Convex client. It is created on first property access rather
 * than at import time, so importing this module never requires
 * NEXT_PUBLIC_CONVEX_URL (e.g. during `next build` page-data collection).
 */
export const convex = new Proxy({} as ConvexHttpClient, {
  get(_target, prop) {
    const target = getConvexClient();
    const value = Reflect.get(target, prop, target);
    return typeof value === "function" ? value.bind(target) : value;
  },
});
