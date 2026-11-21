import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ query: vi.fn(), mutation: vi.fn(), kill: vi.fn() }));

vi.mock("@/lib/convex-client", () => ({ convex: { query: mocks.query, mutation: mocks.mutation } }));
vi.mock("./provider/registry", () => ({ getProvider: () => ({ kill: mocks.kill }) }));

import { killOutdatedPreviews, killRevokedRuntimes } from "./runtime-fence";

describe("killRevokedRuntimes", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("records a failed kill as revoke_failed, and the next sweep's kill removes it", async () => {
    mocks.query.mockResolvedValue([{ _id: "h1", sandboxId: "e2b:sbx_1" }]);
    mocks.kill.mockRejectedValueOnce(new Error("E2B unavailable"));

    expect(await killRevokedRuntimes("internal")).toEqual({ sandboxIds: ["e2b:sbx_1"], failed: 1 });
    expect(mocks.mutation).toHaveBeenLastCalledWith(expect.anything(), { internalKey: "internal", handleId: "h1", killed: false });

    mocks.kill.mockResolvedValueOnce(true);
    expect(await killRevokedRuntimes("internal")).toEqual({ sandboxIds: ["e2b:sbx_1"], failed: 0 });
    expect(mocks.kill).toHaveBeenLastCalledWith("sbx_1");
    expect(mocks.mutation).toHaveBeenLastCalledWith(expect.anything(), { internalKey: "internal", handleId: "h1", killed: true });
  });

  it("kills at most 5 sandboxes at a time", async () => {
    mocks.query.mockResolvedValue(Array.from({ length: 12 }, (_, i) => ({ _id: `h${i}`, sandboxId: `e2b:sbx_${i}` })));
    let inFlight = 0;
    let peak = 0;
    mocks.kill.mockImplementation(async () => {
      peak = Math.max(peak, ++inFlight);
      await new Promise((resolve) => setTimeout(resolve, 1));
      inFlight--;
      return true;
    });

    expect(await killRevokedRuntimes("internal")).toEqual(expect.objectContaining({ failed: 0 }));
    expect(mocks.kill).toHaveBeenCalledTimes(12);
    expect(peak).toBeLessThanOrEqual(5);
  });

  it("killOutdatedPreviews never throws; the sweep retries what it misses", async () => {
    mocks.query.mockRejectedValue(new Error("Convex unavailable"));

    await expect(killOutdatedPreviews("internal", "project_a" as never)).resolves.toBeUndefined();
  });

  it("counts a sandbox that is already gone as killed", async () => {
    mocks.query.mockResolvedValue([{ _id: "h1", sandboxId: "e2b:sbx_gone" }]);
    mocks.kill.mockResolvedValue(false);

    expect(await killRevokedRuntimes("internal")).toEqual({ sandboxIds: ["e2b:sbx_gone"], failed: 0 });
    expect(mocks.mutation).toHaveBeenCalledWith(expect.anything(), { internalKey: "internal", handleId: "h1", killed: true });
  });

  it("looks a client sandbox id up by its canonical form", async () => {
    mocks.query.mockResolvedValue([]);

    await killRevokedRuntimes("internal", { sandboxId: "sbx_1" });

    expect(mocks.query).toHaveBeenCalledWith(expect.anything(), { internalKey: "internal", projectId: undefined, sandboxId: "e2b:sbx_1" });
  });
});
