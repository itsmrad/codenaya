import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ list: vi.fn(), inspect: vi.fn(), dev: vi.fn(), url: vi.fn() }));
vi.mock("./provider/fanout", () => ({ listAll: mocks.list }));
vi.mock("./provider/registry", () => ({
  fanoutHealth: () => ({ primary: "e2b", cooldown: "cooldown" }),
  getConfiguredProviders: () => [],
  getProvider: () => ({ inspect: mocks.inspect }),
}));
vi.mock("./dev-server", () => ({ findPreviewDevServer: mocks.dev, PREVIEW_PROXY_PORT: 4000, SHORT_CALL_MS: 10_000 }));
import { currentPreviewUrl, PreviewLookupRateLimitError } from "./current-preview-url";
import { resetRateLimits } from "@/lib/rate-limit";
import { SandboxNotFoundError } from "./provider/types";

beforeEach(() => {
  vi.resetAllMocks();
  resetRateLimits();
  mocks.list.mockResolvedValue([{ id: "live", provider: "e2b" }]);
  mocks.inspect.mockResolvedValue({ previewUrl: mocks.url });
});

it("uses the editor's proxy URL for the owner's existing running preview", async () => {
  mocks.dev.mockResolvedValue({ port: 5173 });
  mocks.url.mockResolvedValue("https://4000-live.e2b.app");
  expect(await currentPreviewUrl("project", "owner")).toBe("https://4000-live.e2b.app");
  expect(mocks.list).toHaveBeenCalledWith(
    [],
    { metadata: { userId: "owner", projectId: "project" }, limit: 2, requestTimeoutMs: 10_000 },
    { primary: "e2b", cooldown: "cooldown", skip: "failing" },
  );
  expect(mocks.url).toHaveBeenCalledWith(4000);
});

it("shows the empty state when there is no dev server", async () => {
  mocks.dev.mockResolvedValue(null);
  expect(await currentPreviewUrl("project", "owner")).toBeNull();
  expect(mocks.url).not.toHaveBeenCalled();
});

it("shows the empty state after the preview expires", async () => {
  mocks.list.mockResolvedValue([]);
  expect(await currentPreviewUrl("project", "owner")).toBeNull();
  expect(mocks.inspect).not.toHaveBeenCalled();
});

it("does not resume a sandbox that was paused or expired after listing", async () => {
  mocks.inspect.mockRejectedValue(new SandboxNotFoundError("Not running"));
  expect(await currentPreviewUrl("project", "owner")).toBeNull();
  expect(mocks.dev).not.toHaveBeenCalled();
});

it("bounds provider lookups per verified user across projects and both page/API callers", async () => {
  mocks.list.mockResolvedValue([]);
  await Promise.all(Array.from({ length: 30 }, (_, index) => currentPreviewUrl(`project-${index}`, "owner")));
  await expect(currentPreviewUrl("any-project", "owner")).rejects.toBeInstanceOf(PreviewLookupRateLimitError);
  expect(mocks.list).toHaveBeenCalledTimes(30);
  await currentPreviewUrl("project", "other-owner");
  expect(mocks.list).toHaveBeenCalledTimes(31);
});

it("treats a fallback provider's failing inspect as no preview; the primary's still throws", async () => {
  const error = new Error("provider down");
  mocks.inspect.mockRejectedValue(error);
  mocks.list.mockResolvedValue([{ id: "elsewhere", provider: "test-fallback" }]);
  expect(await currentPreviewUrl("project", "owner")).toBeNull();
  mocks.list.mockResolvedValue([{ id: "live", provider: "e2b" }]);
  await expect(currentPreviewUrl("project", "owner")).rejects.toBe(error);
});
