import { auth } from "@clerk/nextjs/server";
import { z } from "zod";

import { convex } from "@/lib/convex-client";
import { parseJsonBody } from "@/lib/parse-json-body";
import { WAITLIST_RATE_LIMIT, checkRateLimit, rateLimitedResponse } from "@/lib/rate-limit";

import { api } from "../../../../convex/_generated/api";

const requestSchema = z.object({
  email: z.string().trim().toLowerCase().pipe(z.email().max(254)),
});

/**
 * POST /api/waitlist: "Notify me when Pro launches" (#250). Signed-out
 * visitors can join, so it is rate-limited by client IP; a signed-in user's
 * id is stored with the email.
 */
export async function POST(request: Request) {
  // The first `x-forwarded-for` hop is the client, as the platform's proxy sets it.
  const ip = request.headers.get("x-forwarded-for")?.split(",")[0].trim() || "unknown";
  const rateLimit = checkRateLimit(ip, WAITLIST_RATE_LIMIT);
  if (!rateLimit.allowed) return rateLimitedResponse(rateLimit);

  const { data, invalid } = await parseJsonBody(request, requestSchema);
  if (invalid) return invalid;

  const internalKey = process.env.CODENAYA_CONVEX_INTERNAL_KEY;
  if (!internalKey) {
    console.error("[waitlist] CODENAYA_CONVEX_INTERNAL_KEY is not set");
    return Response.json({ error: "Server is not configured" }, { status: 500 });
  }

  const { userId } = await auth();
  await convex.mutation(api.waitlist.join, {
    internalKey,
    email: data.email,
    ...(userId ? { userId } : {}),
  });
  return Response.json({ ok: true });
}
