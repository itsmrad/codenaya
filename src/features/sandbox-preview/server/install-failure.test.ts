import { describe, expect, it } from "vitest";

import { installFailure } from "./install-failure";

describe("installFailure (#497)", () => {
  const SECRET = "sk_live_synthetic_0123456789";
  const command = "npm install";

  it("ends in the failed-install line and redacts injected secrets", () => {
    const failure = installFailure(
      {
        exitCode: 1,
        stdout: `postinstall: API_KEY=${SECRET}\n`,
        stderr: "npm error code ERESOLVE\n",
      },
      command,
      [SECRET],
    );

    expect(failure.exitCode).toBe(1);
    expect(failure.output).not.toContain(SECRET);
    expect(failure.output).toContain("API_KEY=[redacted]");
    expect(failure.output).toContain("npm error code ERESOLVE");
    expect(failure.output.trimEnd().split("\n").at(-1)).toBe(
      "Error: npm install failed with exit code 1",
    );
  });

  it("redacts before the tail is cut, so no part of a secret is left", () => {
    // Sized so the 4096-character cut falls 10 characters into the secret.
    const exitLine = "\nError: npm install failed with exit code 1";
    const padding = "x".repeat(4096 - (SECRET.length - 10) - exitLine.length);
    const unredacted = `${SECRET}${padding}${exitLine}`.slice(-4096);
    expect(unredacted.startsWith(SECRET.slice(10))).toBe(true);

    const failure = installFailure(
      { exitCode: 1, stdout: `${SECRET}${padding}`, stderr: "" },
      command,
      [SECRET],
    );

    expect(failure.output).not.toContain(SECRET.slice(10));
    expect(failure.output.length).toBeLessThanOrEqual(4097);
  });

  it("keeps only the last lines", () => {
    const stdout = Array.from({ length: 100 }, (_, i) => `line ${i}`).join("\n");
    const lines = installFailure({ exitCode: 1, stdout, stderr: "" }, command, []).output
      .trimEnd()
      .split("\n");

    expect(lines).toHaveLength(40);
    expect(lines[0]).toBe("line 61");
  });

  it("sends no output or command when the secrets couldn't be loaded", () => {
    const failure = installFailure(
      { exitCode: 1, stdout: SECRET, stderr: SECRET },
      `${command} --token=${SECRET}`,
      null,
    );

    expect(failure.output).toBe("Error: The install failed with exit code 1\n");
  });
});
