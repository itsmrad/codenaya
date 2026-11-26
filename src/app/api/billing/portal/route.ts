import { auth } from "@clerk/nextjs/server";
import { fetchMutation } from "convex/nextjs";
import { z } from "zod";
import { api } from "../../../../../convex/_generated/api";
import { requireUserId } from "@/features/auth/server/require-user-id";
import { readDodoConfig, type DodoDeployment } from "@/features/billing/server/dodo-config";
import { createDodoPortal } from "@/features/billing/server/dodo-subscription";
import { getAppError } from "@/lib/convex-error";
import { parseJsonBody } from "@/lib/parse-json-body";
import { BILLING_MANAGEMENT_RATE_LIMIT, checkRateLimit, rateLimitedResponse } from "@/lib/rate-limit";
import { isJson, isSameOrigin } from "@/lib/request-guards";

export const maxDuration = 60;
const bodySchema = z.object({}).strict();
const reply = (status: number, body: Record<string, string>) => Response.json(body, { status });
const unavailable = () => reply(503, { code: "portal_unavailable" });

async function portal(request: Request): Promise<Response> {
  const { userId, unauthorized } = await requireUserId();
  if (unauthorized) return unauthorized;
  if (!isSameOrigin(request)) return reply(403, { code: "cross_origin" });
  if (!isJson(request)) return reply(415, { code: "unsupported_media_type" });
  const limit = checkRateLimit(userId, BILLING_MANAGEMENT_RATE_LIMIT);
  if (!limit.allowed) return rateLimitedResponse(limit);
  const { invalid } = await parseJsonBody(request, bodySchema);
  if (invalid) return invalid;
  const deployment = process.env.CODENAYA_DEPLOYMENT;
  if (!deployment || !["development", "preview", "staging", "production"].includes(deployment)) return unavailable();
  const config = readDodoConfig("next-management", deployment as DodoDeployment);
  const internalKey = process.env.CODENAYA_CONVEX_INTERNAL_KEY;
  if (!internalKey) return unavailable();
  const { getToken } = await auth();
  const token = await getToken({ template: "convex" });
  if (!token) return reply(401, { error: "Unauthorized" });
  const next = await fetchMutation(api.billingLifecycle.prepareControl, {
    internalKey, mode: config.environment, operation: "portal",
  }, { token });
  if (next.kind !== "portal") return unavailable();
  const result = await createDodoPortal(config, next.customerId);
  return result ? reply(200, result) : unavailable();
}

export async function POST(request: Request): Promise<Response> {
  let response;
  try { response = await portal(request); } catch (error) {
    response = getAppError(error)?.code === "UNAUTHENTICATED"
      ? reply(401, { error: "Unauthorized" }) : unavailable();
  }
  response.headers.set("Cache-Control", "no-store");
  return response;
}
