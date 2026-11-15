import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { DEFAULT_INSTALL_COMMAND } from "./project-sandbox";

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
