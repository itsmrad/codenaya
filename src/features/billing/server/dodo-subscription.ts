import { readBoundedBody } from "./bounded-body";
import type { DodoEnvironment, DodoManagementConfig, DodoReconcilerConfig } from "./dodo-config";
import { DODO_READ_TIMEOUT_MS, MAX_PROVIDER_BODY_BYTES } from "./dodo-reads";

// customerId is the owned binding from prepareControl, never browser input.
export type DodoSubscriptionConfig = DodoReconcilerConfig & { customerId: string; controlWriteUntil?: number };
type Result = { kind: "confirmed"; cancelAtNextBillingDate: boolean; status: string } |
  { kind: "unknown" } | { kind: "refused" };
const BASE = { test_mode: "https://test.dodopayments.com", live_mode: "https://live.dodopayments.com" };
const ID = /^[A-Za-z0-9_-]{1,128}$/;

/** One write, no retries; both before and after it, check the subscription's bound owner. */
export async function setDodoCancellation(
  config: DodoSubscriptionConfig,
  input: { subscriptionId: string; timing: "period_end" | "resume" | "immediate" },
  fetchImpl: typeof fetch = fetch,
): Promise<Result> {
  if (!ID.test(input.subscriptionId) || !ID.test(config.customerId)) return { kind: "refused" };
  const remaining = () => config.controlWriteUntil === undefined ? DODO_READ_TIMEOUT_MS : config.controlWriteUntil - Date.now();
  if (!(remaining() > 0)) return { kind: "refused" };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.min(DODO_READ_TIMEOUT_MS, remaining()));
  let wrote = false;
  async function request(path: string, body?: object) {
    const response = await fetchImpl(`${BASE[config.environment]}${path}`, {
      method: body ? "PATCH" : "GET", redirect: "manual", signal: controller.signal,
      headers: { Authorization: `Bearer ${config.apiKey}`, "Content-Type": "application/json", Accept: "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return response;
  }
  async function json(response: Response): Promise<Record<string, unknown>> {
    if (!response.ok) throw new Error("Provider read unavailable");
    const bytes = await readBoundedBody(response, MAX_PROVIDER_BODY_BYTES);
    if (!bytes) throw new Error("Provider read unavailable");
    const body: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("Provider read unavailable");
    return body as Record<string, unknown>;
  }
  async function owned() {
    const customer = await json(await request(`/customers/${config.customerId}`));
    const sub = await json(await request(`/subscriptions/${input.subscriptionId}`));
    const owner = sub.customer as { customer_id?: unknown } | null;
    return customer.customer_id === config.customerId && customer.business_id === config.businessId &&
      sub.subscription_id === input.subscriptionId && owner?.customer_id === config.customerId &&
      sub.product_id === config.proProductId && typeof sub.cancel_at_next_billing_date === "boolean" &&
      typeof sub.status === "string" ? sub : null;
  }
  try {
    const before = await owned();
    if (!before || (input.timing === "resume" && before.status !== "active")) return { kind: "refused" };
    if (controller.signal.aborted || !(remaining() > 0)) return { kind: "refused" };
    wrote = true;
    const response = await request(`/subscriptions/${input.subscriptionId}`, input.timing === "immediate"
      ? { status: "cancelled" } : { cancel_at_next_billing_date: input.timing === "period_end" });
    await response.body?.cancel();
    if (!response.ok) return { kind: [400, 401, 403, 404, 422].includes(response.status) ? "refused" : "unknown" };
    const after = await owned();
    if (!after) return { kind: "unknown" };
    const matches = input.timing === "immediate" ? after.status === "cancelled"
      : after.cancel_at_next_billing_date === (input.timing === "period_end");
    return matches ? { kind: "confirmed", cancelAtNextBillingDate: after.cancel_at_next_billing_date as boolean,
      status: after.status as string } : { kind: "unknown" };
  } catch {
    // No write before ownership verification; after dispatch the outcome is ambiguous.
    return { kind: wrote ? "unknown" : "refused" };
  } finally {
    clearTimeout(timer);
  }
}

// Empty until stage 13 proves each mode's session host AND permitted merchant actions.
export const DODO_PORTAL_HOSTS: Record<DodoEnvironment, readonly string[]> = {
  test_mode: [], live_mode: [],
};

/** Implements the pinned 2.63.0 portal contract; never log or persist the session link. */
export async function createDodoPortal(
  config: DodoManagementConfig, customerId: string, fetchImpl: typeof fetch = fetch,
): Promise<{ url: string } | null> {
  const hosts = DODO_PORTAL_HOSTS[config.environment];
  if (!hosts?.length || !ID.test(customerId)) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DODO_READ_TIMEOUT_MS);
  try {
    const response = await fetchImpl(`${BASE[config.environment]}/customers/${customerId}/customer-portal/session?send_email=false`, {
      method: "POST", redirect: "manual", signal: controller.signal,
      headers: { Authorization: `Bearer ${config.apiKey}`, Accept: "application/json" },
    });
    if (!response.ok) { await response.body?.cancel(); return null; }
    const bytes = await readBoundedBody(response, MAX_PROVIDER_BODY_BYTES);
    if (!bytes) return null;
    const body: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (!body || typeof body !== "object" || !("link" in body) || typeof body.link !== "string") return null;
    const url = new URL(body.link);
    if (url.protocol !== "https:" || url.username || url.password || url.port ||
      !hosts.includes(url.hostname) || body.link !== body.link.trim()) return null;
    return { url: url.href };
  } catch {
    // Provider errors may contain credentials or the bearer session URL.
    return null;
  } finally {
    controller.abort();
    clearTimeout(timer);
  }
}
