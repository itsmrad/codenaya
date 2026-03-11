import { ConvexHttpClient } from "convex/browser";

export const convex = new ConvexHttpClient(
  process.env.NEXT_PUBLIC_CONVEX_URL!
);
