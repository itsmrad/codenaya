import type { Sandbox } from "e2b";

import { createStreamRedactor } from "@/features/integrations/server/env/stream-redactor";
import {
  resolveProjectEnv,
  secretValuesFrom,
} from "@/features/integrations/server/env/resolve-env";
import { convex } from "@/lib/convex-client";

import { api } from "../../../../convex/_generated/api";
import type { Id } from "../../../../convex/_generated/dataModel";

/** What PATCH /api/sandbox/[sandboxId] reports for a failed reinstall (#497). */
export interface InstallFailure {
  exitCode: number;
  /** A redacted tail of the install output, ending in the failed-install line. */
  output: string;
}

const OUTPUT_TAIL_LINES = 40;
const OUTPUT_TAIL_CHARS = 4096;

/**
 * The failure to send the browser. `secrets` null means they couldn't be
 * loaded, so no output goes out: only the exit line, without the command.
 */
export const installFailure = (
  result: { exitCode: number; stdout: string; stderr: string },
  command: string,
  secrets: readonly string[] | null,
): InstallFailure => {
  if (secrets === null) {
    return {
      exitCode: result.exitCode,
      output: `Error: The install failed with exit code ${result.exitCode}\n`,
    };
  }
  // The same line the boot stream prints, which detectBuildError reads (#491).
  const text = `${result.stdout}\n${result.stderr}\nError: ${command} failed with exit code ${result.exitCode}`;
  // Redacted whole before the cut, so a cut can't leave part of a secret behind.
  const redactor = createStreamRedactor(secrets);
  const redacted = redactor.push(text) + redactor.flush();
  const tail = redacted
    .split("\n")
    .filter((line) => line.trim())
    .slice(-OUTPUT_TAIL_LINES)
    .join("\n")
    .slice(-OUTPUT_TAIL_CHARS);
  return { exitCode: result.exitCode, output: `${tail}\n` };
};

/**
 * The secret values the boot injected into this sandbox, for the redactor.
 * The project comes from the sandbox's own metadata, set by the boot after its
 * ownership check. Null when they can't be loaded.
 */
export const sandboxSecretValues = async (sandbox: Sandbox): Promise<string[] | null> => {
  try {
    const projectId = (await sandbox.getInfo()).metadata?.projectId;
    // The boot injects variables only for a project.
    if (!projectId) return [];
    const internalKey = process.env.CODENAYA_CONVEX_INTERNAL_KEY;
    if (!internalKey) return null;
    const records = await convex.query(api.system.getEnvVarsForSandbox, {
      internalKey,
      projectId: projectId as Id<"projects">,
    });
    return secretValuesFrom(await resolveProjectEnv(records));
  } catch (error) {
    console.error("[sandbox] secret resolution for install output failed", error);
    return null;
  }
};
