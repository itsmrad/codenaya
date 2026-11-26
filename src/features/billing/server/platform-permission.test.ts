import { expect, it, vi } from "vitest";
import { api } from "../../../../convex/_generated/api";
const mutation = vi.hoisted(() => vi.fn());
vi.mock("@/lib/convex-client", () => ({ convex: { mutation } }));
import { readPlatformPermission } from "./platform-permission";
it("uses the authoritative mutation without passing a client clock", async () => {
  const view = { plan: "pro", creditsLeft: 3400 };
  mutation.mockResolvedValueOnce(view);
  expect(await readPlatformPermission({ internalKey: "ik", userId: "owner" })).toBe(view);
  expect(mutation).toHaveBeenCalledWith(api.billingEntitlement.getForServer, { internalKey: "ik", userId: "owner" });
});
it("propagates outages rather than manufacturing permission", async () => {
  mutation.mockRejectedValueOnce(new Error("Policy unavailable"));
  await expect(readPlatformPermission({ internalKey: "ik", userId: "owner" })).rejects.toThrow("Policy unavailable");
});
