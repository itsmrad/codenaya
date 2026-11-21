import { auth, currentUser } from "@clerk/nextjs/server";
import { fetchMutation } from "convex/nextjs";
import { z } from "zod";

import { api } from "../../../../../convex/_generated/api";
import { createDodoCheckout, createDodoCustomer } from "@/features/billing/server/dodo-checkout";
import { type DodoNextConfig, parseDeployment, readDodoConfig } from "@/features/billing/server/dodo-config";
import { getAppError } from "@/lib/convex-error";
import { parseJsonBody } from "@/lib/parse-json-body";
import { BILLING_CHECKOUT_RATE_LIMIT, checkRateLimit, rateLimitedResponse } from "@/lib/rate-limit";
import { isJson, isSameOrigin } from "@/lib/request-guards";

// Worst case: Clerk, four Convex calls and two 15 s Dodo creates. A kill between a create and its
// record would leave work for support, so the budget is explicit, not the platform default.
export const maxDuration = 60;

const requestSchema = z.object({ sku: z.enum(["pro_monthly", "top_up"]) }).strict();

/** One customer create, then one checkout create: at most two Convex decisions per request. */
const MAX_PREPARE_STEPS = 2;
const LOG = "[billingCheckout]";

const reply = (status: number, body: Record<string, string>) => Response.json(body, { status });
const notFound = () => reply(404, { error: "Not found" });
const unavailable = () => reply(503, { error: "Billing is unavailable", code: "billing_unavailable" });
const failed = (code: string) => reply(502, { error: "Checkout could not be started", code });

/** Disabled → null (404, even without a deployment); enabled but misconfigured → "unavailable". */
function checkoutConfig(): DodoNextConfig | null | "unavailable" {
  if (process.env.CODENAYA_BILLING_ENABLED !== "true") return null;
  const deployment = parseDeployment(process.env.CODENAYA_DEPLOYMENT);
  if (!deployment) {
    console.error(`${LOG} not configured: CODENAYA_DEPLOYMENT is missing or invalid.`);
    return "unavailable";
  }
  try {
    return readDodoConfig("next", deployment);
  } catch (error) {
    // Config errors name the variable only, never its value.
    console.error(`${LOG} not configured:`, error instanceof Error ? error.message : "unknown error");
    return "unavailable";
  }
}

/** The signed-in user's primary email and a display name, read server-side only. */
async function customerIdentity(): Promise<{ email: string; name: string } | null> {
  const user = await currentUser();
  const email = user?.primaryEmailAddress?.emailAddress;
  if (!user || !email) return null;
  return { email, name: user.fullName?.trim() || user.username || email.split("@")[0] };
}

async function startCheckout(request: Request): Promise<Response> {
  const { userId, getToken } = await auth();
  if (!userId) return reply(401, { error: "Unauthorized" });
  if (!isSameOrigin(request)) return reply(403, { error: "Cross-site request refused", code: "cross_origin" });
  if (!isJson(request)) return reply(415, { error: "Send JSON", code: "unsupported_media_type" });
  const limit = checkRateLimit(userId, BILLING_CHECKOUT_RATE_LIMIT);
  if (!limit.allowed) return rateLimitedResponse(limit);

  const config = checkoutConfig();
  if (config === "unavailable") return unavailable();
  if (!config) return notFound();

  const { data, invalid } = await parseJsonBody(request, requestSchema);
  if (invalid) return invalid;
  const { sku } = data;
  const productId = sku === "pro_monthly" ? config.proProductId
    : config.topUpsEnabled ? config.topUpProductId : null;
  if (!productId) return notFound();

  const token = await getToken({ template: "convex" });
  if (!token) return reply(401, { error: "Unauthorized" });
  const internalKey = process.env.CODENAYA_CONVEX_INTERNAL_KEY;
  if (!internalKey) {
    console.error(`${LOG} not configured: CODENAYA_CONVEX_INTERNAL_KEY is missing.`);
    return unavailable();
  }
  const call = { token };

  for (let step = 0; step < MAX_PREPARE_STEPS; step++) {
    let next;
    try {
      next = await fetchMutation(api.billingCheckout.prepareCheckout,
        { internalKey, mode: config.environment, sku, productId }, call);
    } catch (error) {
      const code = getAppError(error)?.code;
      if (code === "UNAUTHENTICATED") return reply(401, { error: "Unauthorized" });
      if (code === "FORBIDDEN") return reply(403, { error: "Billing is on hold", code: "billing_on_hold" });
      console.error(`${LOG} prepare failed`, code ?? "unknown");
      return failed("checkout_unavailable");
    }

    switch (next.kind) {
      case "resume":
        return reply(200, { url: next.checkoutUrl });
      case "pending":
        return reply(409, { error: "A checkout is already in progress", code: "checkout_pending" });
      case "refused":
        return next.code === "unavailable"
          ? unavailable()
          : reply(409, { error: "Checkout is not available for this account", code: next.code });
      case "create_customer": {
        const { customerRef, leaseId } = next;
        // Before anything reaches Dodo, a failure is a definite "not created": release the lease
        // so the owner is not left `unknown` (support-only) by a Clerk outage or a missing email.
        const releaseLease = () => fetchMutation(api.billingCheckout.recordCustomerResult,
          { internalKey, customerRef, leaseId, result: { kind: "not_created" } }, call);
        let identity;
        try {
          identity = await customerIdentity();
        } catch {
          console.error(`${LOG} customer identity unavailable`, customerRef);
          await releaseLease().catch(() => undefined);
          return failed("checkout_unavailable");
        }
        if (!identity) {
          try {
            await releaseLease();
          } catch {
            return failed("checkout_unavailable");
          }
          return reply(409, { error: "Add a primary email address to buy", code: "email_required" });
        }
        const created = await createDodoCustomer(config, identity);
        const result = created.kind === "created"
          ? { kind: "created" as const, customerId: created.value.customerId }
          : { kind: created.kind };
        try {
          await fetchMutation(api.billingCheckout.recordCustomerResult,
            { internalKey, customerRef, leaseId, result }, call);
        } catch (error) {
          // Never followed by another create: Convex's stale-lease rule makes this recoverable.
          console.error(`${LOG} customer result not recorded`, customerRef, getAppError(error)?.code ?? "unknown");
          return failed("checkout_unknown");
        }
        console.info(`${LOG} customer create`, customerRef, created.kind);
        if (created.kind !== "created") return failed("checkout_unavailable");
        continue;
      }
      case "create_checkout": {
        const { purchaseRef, intentId } = next;
        // Convex hands back the owner's bound customer id; the browser never names one.
        const created = await createDodoCheckout(config, { customerId: next.customerId, productId, intentId, sku });
        const result = created.kind === "created"
          ? { kind: "created" as const, sessionId: created.value.sessionId, checkoutUrl: created.value.checkoutUrl }
          : { kind: created.kind };
        try {
          await fetchMutation(api.billingCheckout.recordCheckoutResult, { internalKey, purchaseRef, result }, call);
        } catch (error) {
          console.error(`${LOG} checkout result not recorded`, purchaseRef, getAppError(error)?.code ?? "unknown");
          return failed("checkout_unknown");
        }
        console.info(`${LOG} checkout create`, purchaseRef, created.kind);
        if (created.kind === "unknown") return failed("checkout_unknown");
        if (created.kind === "not_created") return failed("checkout_failed");
        return created.value.checkoutUrl
          ? reply(200, { url: created.value.checkoutUrl })
          : failed("checkout_unavailable");
      }
    }
  }
  return failed("checkout_unavailable");
}

/** Starts (or resumes) the signed-in user's Dodo checkout for `{ sku }`; answers `{ url }`. */
export async function POST(request: Request) {
  let response: Response;
  try {
    response = await startCheckout(request);
  } catch {
    // Unexpected (Clerk, token): fixed text only, never the error.
    console.error(`${LOG} unexpected failure`);
    response = reply(500, { error: "Checkout could not be started" });
  }
  response.headers.set("Cache-Control", "no-store");
  return response;
}
