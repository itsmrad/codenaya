import { describe, expect, it, vi } from "vitest";
import { setDodoCancellation } from "./dodo-subscription";

const config = { environment: "test_mode" as const, businessId: "bus_dummy", apiKey: "dummy-canary", proProductId: "pro_dummy", customerId: "cus_dummy" };
const customer = { customer_id: config.customerId, business_id: config.businessId };
const subscription = { subscription_id: "sub_dummy", customer: { customer_id: config.customerId }, product_id: config.proProductId,
  status: "active", cancel_at_next_billing_date: false };
const ok = (value: object) => Response.json(value);
function mock(over: object = {}, status = 200) {
  return vi.fn<typeof fetch>()
    .mockResolvedValueOnce(ok(customer)).mockResolvedValueOnce(ok(subscription))
    .mockResolvedValueOnce(new Response(null, { status }))
    .mockResolvedValueOnce(ok(customer)).mockResolvedValueOnce(ok({ ...subscription, cancel_at_next_billing_date: true, ...over }));
}
describe("cancellation adapter", () => {
  it.each(["period_end", "resume", "immediate"] as const)("confirms %s only after fresh reads", async timing => {
    const fn = mock({ cancel_at_next_billing_date: timing === "period_end", status: timing === "immediate" ? "cancelled" : "active" });
    expect(await setDodoCancellation(config, { subscriptionId: "sub_dummy", timing }, fn)).toMatchObject({ kind: "confirmed" });
    expect(fn).toHaveBeenCalledTimes(5);
    expect(JSON.parse(fn.mock.calls[2][1]!.body as string)).toEqual(timing === "immediate" ? { status: "cancelled" }
      : { cancel_at_next_billing_date: timing === "period_end" });
    for (const [url, init] of fn.mock.calls) {
      expect(url).toMatch(/^https:\/\/test.dodopayments.com\//);
      expect(init?.redirect).toBe("manual");
      expect(init?.signal).toBeInstanceOf(AbortSignal);
    }
  });
  it.each([
    { subscription_id: "sub_foreign" }, { customer: { customer_id: "cus_foreign" } },
    { product_id: "pro_foreign" }, { cancel_at_next_billing_date: undefined },
  ])("does not confirm foreign or malformed subscription %j", async over => {
    expect(await setDodoCancellation(config, { subscriptionId: "sub_dummy", timing: "period_end" }, mock(over))).toEqual({ kind: "unknown" });
  });
  it("checks business before dispatch and after write", async () => {
    for (const after of [false, true]) {
      const fn = mock();
      if (after) fn.mockReset().mockResolvedValueOnce(ok(customer)).mockResolvedValueOnce(ok(subscription))
        .mockResolvedValueOnce(new Response(null)).mockResolvedValueOnce(ok({ ...customer, business_id: "foreign" }));
      else fn.mockReset().mockResolvedValue(ok({ ...customer, business_id: "foreign" }));
      expect(await setDodoCancellation(config, { subscriptionId: "sub_dummy", timing: "period_end" }, fn))
        .toEqual({ kind: after ? "unknown" : "refused" });
      if (!after) expect(fn.mock.calls.some(([, init]) => init?.method === "PATCH")).toBe(false);
    }
  });
  it.each([302, 408, 409, 429, 500])("keeps HTTP %s ambiguous without retry", async status => {
    const fn = mock({}, status);
    expect(await setDodoCancellation(config, { subscriptionId: "sub_dummy", timing: "period_end" }, fn)).toEqual({ kind: "unknown" });
    expect(fn).toHaveBeenCalledTimes(3);
  });
  it.each([400, 401, 403, 404, 422])("definite refusal %s", async status => {
    expect(await setDodoCancellation(config, { subscriptionId: "sub_dummy", timing: "period_end" }, mock({}, status))).toEqual({ kind: "refused" });
  });
  it("lost write response is unknown and never retried", async () => {
    const fn = vi.fn<typeof fetch>().mockResolvedValueOnce(ok(customer)).mockResolvedValueOnce(ok(subscription)).mockRejectedValueOnce(new DOMException("dummy", "AbortError"));
    expect(await setDodoCancellation(config, { subscriptionId: "sub_dummy", timing: "period_end" }, fn)).toEqual({ kind: "unknown" });
    expect(fn).toHaveBeenCalledTimes(3);
  });
  it("refuses malformed ids without fetching", async () => {
    const fn = vi.fn<typeof fetch>();
    expect(await setDodoCancellation(config, { subscriptionId: "../foreign", timing: "resume" }, fn)).toEqual({ kind: "refused" });
    expect(fn).not.toHaveBeenCalled();
  });
  it("live mode uses only the live endpoint", async () => {
    const fn = mock();
    await setDodoCancellation({ ...config, environment: "live_mode" }, { subscriptionId: "sub_dummy", timing: "period_end" }, fn);
    expect(fn.mock.calls.every(([url]) => String(url).startsWith("https://live.dodopayments.com/"))).toBe(true);
  });
});
