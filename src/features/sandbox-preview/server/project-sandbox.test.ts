import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_INSTALL_COMMAND, MAX_LIVE_SANDBOXES, atLiveSandboxCap, killProjectPreviews } from "./project-sandbox";
import { listAll } from "./provider/fanout";
import type { ListedSandbox, ProviderId, SandboxProvider } from "./provider/types";

vi.mock("e2b", () => ({ Sandbox: {} }));
vi.mock("./provider/fanout", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./provider/fanout")>();
  return { ...actual, listAll: vi.fn(actual.listAll) };
});

/** Runs the install command in bash against a fake `npm` that exits with `codes` in turn. */
const installWith = (...codes: number[]) => {
  const dir = mkdtempSync(join(tmpdir(), "install-"));
  writeFileSync(join(dir, "codes"), codes.join("\n"));
  writeFileSync(
    join(dir, "npm"),
    `#!/bin/bash\necho "$*" >> "${dir}/calls"\nn=$(wc -l < "${dir}/calls")\nexit $(sed -n "\${n}p" "${dir}/codes")\n`,
  );
  chmodSync(join(dir, "npm"), 0o755);
  let exitCode = 0;
  try {
    execFileSync("bash", ["-c", DEFAULT_INSTALL_COMMAND], { env: { ...process.env, PATH: `${dir}:${process.env.PATH}` } });
  } catch (error) {
    exitCode = (error as { status: number }).status;
  }
  return { exitCode, calls: readFileSync(join(dir, "calls"), "utf8").trim().split("\n") };
};

describe("DEFAULT_INSTALL_COMMAND", () => {
  it("installs from the cache once when that works", () => {
    expect(installWith(0)).toEqual({ exitCode: 0, calls: ["install --prefer-offline --no-audit --no-fund"] });
  });

  it("retries once online when the cached install fails (stale packument: ETARGET)", () => {
    expect(installWith(1, 0)).toEqual({
      exitCode: 0,
      calls: ["install --prefer-offline --no-audit --no-fund", "install --no-audit --no-fund"],
    });
  });

  it("fails with the online attempt's exit code when both fail", () => {
    expect(installWith(1, 7).exitCode).toBe(7);
  });
});

describe("sandbox template", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it.each([undefined, "", "   "])("defaults to Node 22 when E2B_TEMPLATE is %j", async (value) => {
    vi.stubEnv("E2B_TEMPLATE", value);
    const { SANDBOX_TEMPLATE } = await import("./project-sandbox");

    expect(SANDBOX_TEMPLATE).toBe("codenaya-node22");
    await import("./project-sandbox");
    expect(console.warn).toHaveBeenCalledTimes(1);
    expect(console.warn).toHaveBeenCalledWith(
      "[project-sandbox] E2B_TEMPLATE unset; using codenaya-node22. Build it with npm run e2b:template",
    );
  });

  it("uses the configured template, trimmed, without warning", async () => {
    vi.stubEnv("E2B_TEMPLATE", " custom-node22 ");
    const { SANDBOX_TEMPLATE } = await import("./project-sandbox");

    expect(SANDBOX_TEMPLATE).toBe("custom-node22");
    expect(console.warn).not.toHaveBeenCalled();
  });

  it("matches the build script's default template name", async () => {
    vi.stubEnv("E2B_TEMPLATE", undefined);
    const { SANDBOX_TEMPLATE } = await import("./project-sandbox");
    const buildScript = readFileSync("e2b/build-template.mts", "utf8");

    expect(buildScript).toContain(
      `const TEMPLATE_NAME = process.env.E2B_TEMPLATE?.trim() || "${SANDBOX_TEMPLATE}";`,
    );
  });
});

describe("previews across providers", () => {
  const listed = (...ids: string[]): ListedSandbox[] => ids.map((id) => ({ id, metadata: {}, endAt: new Date(0) }));
  const fakeProvider = (id: string, running: ListedSandbox[]) =>
    ({ id: id as ProviderId, list: vi.fn(async () => running), kill: vi.fn(async () => true) }) as unknown as SandboxProvider;

  it("caps a user at MAX_LIVE_SANDBOXES in total, not per provider", async () => {
    expect(MAX_LIVE_SANDBOXES).toBe(3);
    const a = fakeProvider("e2b", listed("a1", "a2"));
    const b = fakeProvider("other", listed("b1"));

    expect(await atLiveSandboxCap([a, b], "u1")).toBe(true);
    expect(await atLiveSandboxCap([a, fakeProvider("other", [])], "u1")).toBe(false);
    expect(a.list).toHaveBeenCalledWith({ metadata: { userId: "u1" }, limit: MAX_LIVE_SANDBOXES });
  });

  it("kills the project's previews on every provider, each through its own provider", async () => {
    const a = fakeProvider("e2b", listed("a1"));
    const b = fakeProvider("other", listed("b1", "b2"));

    expect(await killProjectPreviews([a, b], "u1", "p1")).toEqual(["e2b:a1", "other:b1", "other:b2"]);
    expect(a.kill).toHaveBeenCalledWith("a1");
    expect(b.kill).toHaveBeenCalledTimes(2);
    expect(a.kill).not.toHaveBeenCalledWith("b1");
  });

  it("skips a listed sandbox whose provider was not given, instead of throwing", async () => {
    const a = fakeProvider("e2b", []);
    vi.mocked(listAll).mockResolvedValueOnce([
      { id: "a1", metadata: {}, endAt: new Date(0), provider: "e2b" },
      { id: "x1", metadata: {}, endAt: new Date(0), provider: "gone" as ProviderId },
    ]);

    expect(await killProjectPreviews([a], "u1", "p1")).toEqual(["e2b:a1"]);
    expect(a.kill).toHaveBeenCalledTimes(1);
    expect(a.kill).toHaveBeenCalledWith("a1");
  });
});
