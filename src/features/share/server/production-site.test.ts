import { describe, expect, test, vi } from "vitest";
import { startProductionSite } from "./production-site";
import type { Sandbox } from "@/features/sandbox-preview/server/provider/types";

function sandbox() {
  return { run: vi.fn().mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" }), writeFiles: vi.fn().mockResolvedValue(undefined), start: vi.fn().mockResolvedValue({ pid: 1 }), previewUrl: vi.fn().mockResolvedValue("https://site.example") } as unknown as Sandbox;
}
const files = (dependencies: Record<string, string>) => [{ path: "package.json", data: JSON.stringify({ dependencies }) }, { path: "vite.config.ts", data: "export default {}" }];

describe("public builds", () => {
  test.each([
    [{ vite: "8" }, "vite build --sourcemap false", "vite preview"],
    [{ next: "16" }, "next build --webpack", "next start"],
    [{ "@tanstack/react-start": "1" }, "vite build --sourcemap false", "node /home/user/codenaya-start.mjs"],
  ] as const)("runs production commands for %j", async (dependencies, build, start) => {
    const box = sandbox();
    await startProductionSite(box, files(dependencies), { VITE_URL: "public" });
    expect(box.run).toHaveBeenCalledWith(expect.stringContaining(build), expect.anything());
    expect(box.start).toHaveBeenCalledWith(expect.stringContaining(start), expect.objectContaining({ envs: expect.objectContaining({ NODE_ENV: "production", VITE_URL: "public" }) }));
    expect(box.run).toHaveBeenCalledWith(expect.stringContaining("-name '*.map' -delete"), expect.anything());
    const commands = vi.mocked(box.run).mock.calls.map(([command]) => command).join("\n");
    expect(commands).not.toMatch(/npm run dev|vite dev|next dev/);
  });

  test("never starts a server after a failed build", async () => {
    const box = sandbox();
    vi.mocked(box.run).mockImplementation(async command => ({ exitCode: command.includes("vite build") ? 1 : 0, stdout: "", stderr: "" }));
    await expect(startProductionSite(box, files({ vite: "8" }), {})).rejects.toThrow("Build failed");
    expect(box.start).not.toHaveBeenCalled();
  });

  test("overrides an owner's Next browser sourcemap setting", async () => {
    const box = sandbox();
    await startProductionSite(box, [...files({ next: "16" }), { path: "next.config.ts", data: "export default { productionBrowserSourceMaps: true }" }], {});
    expect(box.writeFiles).toHaveBeenCalledWith(expect.arrayContaining([expect.objectContaining({ data: expect.stringContaining("productionBrowserSourceMaps: false") })]));
  });
});
