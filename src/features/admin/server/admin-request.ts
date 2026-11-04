import { auth, reverificationError } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";

import { type RateLimitConfig, checkRateLimit, rateLimitedResponse } from "@/lib/rate-limit";

import { adminOrNull } from "./require-admin";

/**
 * The checks every admin write route runs before it reads the body (ADR 0010):
 * admin (404 for anyone else, like a missing route), same origin (403), a JSON
 * body (415), the rate limit (429) and a fresh step-up (403
 * `reverification_required`, which Clerk's `useReverification` answers by
 * asking the admin to verify again, then retrying). Only the admin gets past
 * the first check, so the order leaks nothing to anyone else.
 */

/** Step-up within the last 10 minutes, second factor when the admin has one. */
const REVERIFICATION = "strict" as const;

/** Bounds what the audit row keeps of a header the caller controls. */
const MAX_USER_AGENT_LENGTH = 512;

/** Saving the catalog is one write; admin only. */
export const ADMIN_CATALOG_SAVE_RATE_LIMIT: RateLimitConfig = {
  scope: "admin-catalog-save",
  limit: 10,
  windowMs: 60_000,
};

/** Testing a route is one tiny request on our key; admin only. */
export const ADMIN_CATALOG_TEST_RATE_LIMIT: RateLimitConfig = {
  scope: "admin-catalog-test",
  limit: 20,
  windowMs: 60_000,
};

/** The request behind an admin change, for the audit row. */
export interface AdminRequestMeta {
  requestId: string;
  ip?: string;
  userAgent?: string;
}

type AdminRequestResult =
  | { admin: { userId: string; token: string }; meta: AdminRequestMeta; denied: undefined }
  | { admin: undefined; meta: undefined; denied: Response };

const deny = (denied: Response): AdminRequestResult => ({ admin: undefined, meta: undefined, denied });

/**
 * A cross-site page can't make the browser send either: `Origin` names the
 * calling page, and `Sec-Fetch-Site` is set by the browser alone.
 */
const isSameOrigin = (request: Request) =>
  request.headers.get("origin") === new URL(request.url).origin ||
  request.headers.get("sec-fetch-site") === "same-origin";

const isJson = (request: Request) =>
  request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() === "application/json";

export const requestMeta = (request: Request): AdminRequestMeta => {
  // The first `x-forwarded-for` hop is the client, as the platform's proxy sets it.
  const ip =
    request.headers.get("x-forwarded-for")?.split(",")[0].trim() ||
    request.headers.get("x-real-ip")?.trim();
  const userAgent = request.headers.get("user-agent")?.slice(0, MAX_USER_AGENT_LENGTH);
  return {
    requestId: crypto.randomUUID(),
    ...(ip ? { ip } : {}),
    ...(userAgent ? { userAgent } : {}),
  };
};

/**
 *   const { admin, meta, denied } = await requireAdminWrite(request, ADMIN_CATALOG_SAVE_RATE_LIMIT);
 *   if (denied) return denied;
 */
export async function requireAdminWrite(
  request: Request,
  rateLimitConfig: RateLimitConfig,
): Promise<AdminRequestResult> {
  const session = await auth();
  const admin = await adminOrNull(session);
  if (!admin) return deny(NextResponse.json({ error: "Not found" }, { status: 404 }));

  if (!isSameOrigin(request)) {
    return deny(NextResponse.json({ error: "Cross-site request refused", code: "cross_origin" }, { status: 403 }));
  }
  if (!isJson(request)) {
    return deny(NextResponse.json({ error: "Send JSON", code: "unsupported_media_type" }, { status: 415 }));
  }

  const rateLimit = checkRateLimit(admin.userId, rateLimitConfig);
  if (!rateLimit.allowed) return deny(rateLimitedResponse(rateLimit));

  if (!session.has({ reverification: REVERIFICATION })) {
    // Clerk's hint (`clerk_error`) is what `useReverification` looks for; `code` is ours.
    return deny(
      NextResponse.json(
        { ...reverificationError(REVERIFICATION), error: "Verify it's you to continue", code: "reverification_required" },
        { status: 403 },
      ),
    );
  }

  return { admin, meta: requestMeta(request), denied: undefined };
}
