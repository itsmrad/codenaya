import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ list: vi.fn(), connect: vi.fn(), dev: vi.fn(), url: vi.fn() }));
vi.mock("./provider/fanout", () => ({ listAll: mocks.list }));
vi.mock("./provider/registry", () => ({ getConfiguredProviders: () => [], getProvider: () => ({ connect: mocks.connect }) }));
vi.mock("./dev-server", () => ({ findPreviewDevServer: mocks.dev, PREVIEW_PROXY_PORT: 4000, SHORT_CALL_MS: 10_000 }));
import { currentPreviewUrl } from "./current-preview-url";

beforeEach(() => {
  vi.resetAllMocks();
  mocks.list.mockResolvedValue([{ id: "live", provider: "e2b" }]);
  mocks.connect.mockResolvedValue({ previewUrl: mocks.url });
});

it("uses the editor's proxy URL for the owner's existing running preview", async () => {
  mocks.dev.mockResolvedValue({ port: 5173 });
  mocks.url.mockResolvedValue("https://4000-live.e2b.app");
  expect(await currentPreviewUrl("project", "owner")).toBe("https://4000-live.e2b.app");
  expect(mocks.list).toHaveBeenCalledWith([], { metadata: { userId: "owner", projectId: "project" }, requestTimeoutMs: 10_000 });
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
  expect(mocks.connect).not.toHaveBeenCalled();
});
