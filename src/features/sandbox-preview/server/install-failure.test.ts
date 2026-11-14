import { describe, expect, it } from "vitest";

import { installFailure } from "./install-failure";

describe("installFailure (#497)", () => {
  const SECRET = "sk_live_synthetic_0123456789";

  it("keeps only the exit code and npm's last error code, never the output", () => {
    const failure = installFailure({
      exitCode: 1,
      stdout: `postinstall: API_KEY=${SECRET}\nnpm warn code EOLD\n`,
      stderr: `npm error code E404\nnpm error ${SECRET}\nnpm ERR! code ERESOLVE\n`,
    });

    expect(failure).toEqual({ exitCode: 1, code: "ERESOLVE" });
    expect(JSON.stringify(failure)).not.toContain(SECRET);
  });

  it("has no code when nothing matches the strict pattern", () => {
    for (const stderr of [
      "",
      "Error: something broke\n",
      `npm error code ${SECRET}\n`,
      "npm error code e404\n",
    ]) {
      expect(installFailure({ exitCode: 2, stdout: "", stderr })).toEqual({ exitCode: 2 });
    }
  });
});
