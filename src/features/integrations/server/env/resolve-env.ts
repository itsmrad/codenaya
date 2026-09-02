/**
 * Open a project's environment variables for injection into a sandbox.
 *
 * Server-side only. The returned values are plaintext secrets.
 *
 * ## The two-audience problem
 *
 * The same variable set feeds two very different destinations:
 *
 * - **E2B** runs server-side. `sandbox.files.write` and `commands.run` never touch
 *   the browser, so secrets are safe there.
 * - **WebContainer** boots *in the page*. Anything given to it is readable by the
 *   end user in devtools, and by anyone they share a preview link with.
 *
 * So this module returns the two sets separately rather than one list with a flag.
 * A caller that wants public values cannot accidentally receive secret ones,
 * because they are not in the value it was handed.
 */

import { getSecretSealer, secretContext } from "../crypto";
import type { EnvEntry } from "../../dotenv";

/** The subset of a `projectEnvVars` document this module needs. */
export interface EnvVarRecord {
  _id: string;
  key: string;
  visibility: "public" | "secret";
  plainValue?: string;
  secretRef?: string;
  kekProvider?: string;
  kekKeyId?: string;
  wrappedDek?: string;
  ciphertext?: string;
  iv?: string;
  authTag?: string;
}

export interface ResolvedEnv {
  /** Safe for any destination, including the browser. */
  publicEntries: EnvEntry[];
  /** Server-side destinations only. */
  secretEntries: EnvEntry[];
  /** Keys that could not be opened, for a warning. Never values. */
  failedKeys: string[];
}

/**
 * Decrypt what needs decrypting and partition by visibility.
 *
 * A variable that cannot be opened is reported by key and omitted, rather than
 * failing the whole boot. One corrupt row should not stop a preview from starting —
 * the app may not even use that variable.
 */
export async function resolveProjectEnv(
  records: readonly EnvVarRecord[],
): Promise<ResolvedEnv> {
  const sealer = getSecretSealer();

  const publicEntries: EnvEntry[] = [];
  const secretEntries: EnvEntry[] = [];
  const failedKeys: string[] = [];

  for (const record of records) {
    if (record.visibility === "public") {
      // A public row with no value is meaningless but harmless; skip rather than
      // emit an empty assignment the app might read as intentional.
      if (record.plainValue !== undefined) {
        publicEntries.push({ key: record.key, value: record.plainValue });
      }
      continue;
    }

    const {
      secretRef,
      kekProvider,
      kekKeyId,
      wrappedDek,
      ciphertext,
      iv,
      authTag,
    } = record;

    if (
      !secretRef ||
      !kekProvider ||
      !kekKeyId ||
      !wrappedDek ||
      !ciphertext ||
      !iv ||
      !authTag
    ) {
      // A secret row missing envelope fields is a schema-level inconsistency, not
      // something a retry fixes.
      failedKeys.push(record.key);
      continue;
    }

    try {
      const value = await sealer.open(
        { kekProvider, kekKeyId, wrappedDek, ciphertext, iv, authTag },
        secretContext("projectEnvVars", secretRef, "value"),
      );
      secretEntries.push({ key: record.key, value });
    } catch (error) {
      // Logged with the key only. The failure detail is operator information
      // (wrong KEK, tampered row) and is already logged by the crypto layer.
      console.error(
        `[env] could not decrypt "${record.key}" for sandbox injection`,
        error instanceof Error ? error.message : error,
      );
      failedKeys.push(record.key);
    }
  }

  return { publicEntries, secretEntries, failedKeys };
}

/**
 * Every secret value, for redacting the sandbox output stream.
 *
 * The install and dev-server logs are piped to the browser terminal. A framework
 * that echoes its configuration on boot — or a stack trace containing a connection
 * string — would otherwise deliver secrets straight to the client that is watching.
 */
export function secretValuesFrom(resolved: ResolvedEnv): string[] {
  return resolved.secretEntries.map((entry) => entry.value);
}
