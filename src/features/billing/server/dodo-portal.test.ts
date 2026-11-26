import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDodoPortal, DODO_PORTAL_HOSTS } from "./dodo-subscription";
import { DODO_READ_TIMEOUT_MS, MAX_PROVIDER_BODY_BYTES } from "./dodo-reads";
import type { DodoManagementConfig } from "./dodo-config";
const config: DodoManagementConfig = { environment: "test_mode", apiKey: "dummy-canary",
  businessId: "bus_dummy", proProductId: "pro_dummy" };
const link = "https://portal.test.invalid/session/dummy-canary";
beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  expect(console.log).not.toHaveBeenCalled();
  expect(console.warn).not.toHaveBeenCalled();
  expect(console.error).not.toHaveBeenCalled();
  DODO_PORTAL_HOSTS.test_mode = [];
  DODO_PORTAL_HOSTS.live_mode = [];
  vi.restoreAllMocks(); vi.useRealTimers();
});
it("ships both modes empty and refuses before any provider call", async () => {
  expect(DODO_PORTAL_HOSTS).toEqual({ test_mode: [], live_mode: [] });
  const fetchImpl = vi.fn<typeof fetch>();
  for (const environment of ["test_mode", "live_mode"] as const) {
    expect(await createDodoPortal({ ...config, environment }, "cus_alice", fetchImpl)).toBeNull();
  }
  expect(fetchImpl).not.toHaveBeenCalled();
});
it.each(["test_mode", "live_mode"] as const)("posts owned customer with explicit email disabled in %s", async environment => {
  // Synthetic hosts only. Real session hosts and merchant actions are unverified.
  DODO_PORTAL_HOSTS[environment] = ["portal.test.invalid"];
  const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ link }));
  expect(await createDodoPortal({ ...config, environment }, "cus_alice", fetchImpl)).toEqual({ url: link });
  expect(fetchImpl).toHaveBeenCalledTimes(1);
  expect(fetchImpl).toHaveBeenCalledWith(`https://${environment === "test_mode" ? "test" : "live"}.dodopayments.com/customers/cus_alice/customer-portal/session?send_email=false`, {
    method: "POST", redirect: "manual", signal: expect.any(AbortSignal),
    headers: { Authorization: "Bearer dummy-canary", Accept: "application/json" },
  });
});
it.each([
  "http://portal.test.invalid/s", "https://portal.test.invalid.evil.invalid/s",
  "https://evil.invalid/s", "https://portal.test.invalid:444/s", "https://user:pass@portal.test.invalid/s",
  "https://portal.test.invalid./s", "/session", "garbage", "javascript:alert(1)", ` ${link}`,
])("withholds unsafe link %s", async url => {
  DODO_PORTAL_HOSTS.test_mode = ["portal.test.invalid"];
  expect(await createDodoPortal(config, "cus_alice", vi.fn().mockResolvedValue(Response.json({ link: url })))).toBeNull();
});
it("does not borrow the other mode's hosts or permit unsafe customer paths", async () => {
  DODO_PORTAL_HOSTS.live_mode = ["portal.test.invalid"];
  const fetchImpl = vi.fn<typeof fetch>();
  expect(await createDodoPortal(config, "cus_alice", fetchImpl)).toBeNull();
  DODO_PORTAL_HOSTS.test_mode = ["portal.test.invalid"];
  for (const id of ["../cus_bob", "", "cus_a?send_email=true", "cus_a/b"]) {
    expect(await createDodoPortal(config, id, fetchImpl)).toBeNull();
  }
  expect(fetchImpl).not.toHaveBeenCalled();
});
it("refuses foreign returned host even if approved in the other mode", async () => {
  DODO_PORTAL_HOSTS.test_mode = ["portal.test.invalid"];
  DODO_PORTAL_HOSTS.live_mode = ["portal.live.invalid"];
  expect(await createDodoPortal(config, "cus_alice", vi.fn().mockResolvedValue(Response.json({ link: "https://portal.live.invalid/s" })))).toBeNull();
});
it.each([301, 302, 307, 308, 400, 500])("refuses %s without retrying or following redirects", async status => {
  DODO_PORTAL_HOSTS.test_mode = ["portal.test.invalid"];
  const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status, headers: { Location: link } }));
  expect(await createDodoPortal(config, "cus_alice", fetchImpl)).toBeNull();
  expect(fetchImpl).toHaveBeenCalledTimes(1);
});
it.each([{}, { link: 5 }, null, [], { url: link }])("refuses malformed response %j", async body => {
  DODO_PORTAL_HOSTS.test_mode = ["portal.test.invalid"];
  expect(await createDodoPortal(config, "cus_alice", vi.fn().mockResolvedValue(Response.json(body)))).toBeNull();
});
it("bounds streamed bytes, malformed JSON and provider exceptions", async () => {
  DODO_PORTAL_HOSTS.test_mode = ["portal.test.invalid"];
  for (const response of [new Response("{bad"), new Response("x".repeat(MAX_PROVIDER_BODY_BYTES + 1))]) {
    expect(await createDodoPortal(config, "cus_alice", vi.fn().mockResolvedValue(response))).toBeNull();
  }
  expect(await createDodoPortal(config, "cus_alice", vi.fn().mockRejectedValue(new Error(link + config.apiKey)))).toBeNull();
});
it("aborts the request when the declared response is too large", async () => {
  DODO_PORTAL_HOSTS.test_mode = ["portal.test.invalid"];
  const response = new Response("{}", { headers: { "content-length": String(MAX_PROVIDER_BODY_BYTES + 1) } });
  const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(response);

  expect(await createDodoPortal(config, "cus_alice", fetchImpl)).toBeNull();
  expect(fetchImpl.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
  expect(response.bodyUsed).toBe(false);
});
it("aborts on timeout with a sanitized failure", async () => {
  vi.useFakeTimers();
  DODO_PORTAL_HOSTS.test_mode = ["portal.test.invalid"];
  const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => new Promise((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(new Error(link)), { once: true });
  }));
  const result = createDodoPortal(config, "cus_alice", fetchImpl);
  await vi.advanceTimersByTimeAsync(DODO_READ_TIMEOUT_MS);
  expect(await result).toBeNull();
  expect(fetchImpl).toHaveBeenCalledTimes(1);
});
