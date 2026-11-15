import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_INSTALL_COMMAND } from "./project-sandbox";

vi.mock("e2b", () => ({ Sandbox: {} }));

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
