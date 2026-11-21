import { auth } from "@clerk/nextjs/server";
import { fetchMutation } from "convex/nextjs";
import { z } from "zod";
import { api } from "../../../../../convex/_generated/api";
import { requireUserId } from "@/features/auth/server/require-user-id";
import { getAppError } from "@/lib/convex-error";
import { parseJsonBody } from "@/lib/parse-json-body";
import { BILLING_MANAGEMENT_RATE_LIMIT, checkRateLimit, rateLimitedResponse } from "@/lib/rate-limit";
import { isJson, isSameOrigin } from "@/lib/request-guards";
import { readDodoConfig, type DodoDeployment } from "./dodo-config";
import { setDodoCancellation } from "./dodo-subscription";

const bodySchema = z.object({}).strict();
const reply = (status: number, body: Record<string, string>) => Response.json(body, { status });
const unavailable = () => reply(503, { error: "Billing management unavailable", code: "unavailable" });

async function control(request: Request, operation: "cancel" | "uncancel"): Promise<Response> {
  const { userId, unauthorized } = await requireUserId();
  if (unauthorized) return unauthorized;
  if (!isSameOrigin(request)) return reply(403, { error: "Cross-site request refused", code: "cross_origin" });
  if (!isJson(request)) return reply(415, { error: "Send JSON", code: "unsupported_media_type" });
  const limit = checkRateLimit(userId, BILLING_MANAGEMENT_RATE_LIMIT);
  if (!limit.allowed) return rateLimitedResponse(limit);
  const { invalid } = await parseJsonBody(request, bodySchema);
  if (invalid) return invalid;
  const deployment = process.env.CODENAYA_DEPLOYMENT;
  if (!deployment || !["development", "preview", "staging", "production"].includes(deployment)) return unavailable();
  let config;
  try { config = readDodoConfig("next-management", deployment as DodoDeployment); } catch { return unavailable(); }
  const internalKey = process.env.CODENAYA_CONVEX_INTERNAL_KEY;
  if (!internalKey) return unavailable();
  const { getToken } = await auth();
  const token = await getToken({ template: "convex" });
  if (!token) return reply(401, { error: "Unauthorized" });
  const next = await fetchMutation(api.billingLifecycle.prepareControl, { internalKey, mode: config.environment, operation }, { token });
  if (next.kind === "refused") return next.code === "unavailable" ? unavailable()
    : reply(409, { error: "Subscription control refused", code: next.code });
  const result = await setDodoCancellation({ ...config, customerId: next.customerId }, {
    subscriptionId: next.subscriptionId, timing: operation === "cancel" ? "period_end" : "resume",
  });
  try {
    await fetchMutation(api.billingLifecycle.recordControlResult, {
      internalKey, subscriptionRef: next.subscriptionRef, revision: next.revision, outcome: result.kind,
    }, { token });
  } catch {
    // The existing claim and poll wakeup survive an expired session or lost record response.
    return reply(202, { status: "pending" });
  }
  return result.kind === "confirmed" ? reply(200, { status: "confirmed" }) : result.kind === "unknown"
    ? reply(202, { status: "pending" }) : reply(502, { error: "Subscription control failed", code: "provider_refused" });
}

export async function subscriptionControlRoute(request: Request, operation: "cancel" | "uncancel") {
  let response;
  try { response = await control(request, operation); } catch (error) {
    response = getAppError(error)?.code === "UNAUTHENTICATED" ? reply(401, { error: "Unauthorized" }) : unavailable();
  }
  response.headers.set("Cache-Control", "no-store");
  return response;
}
