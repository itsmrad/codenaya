/**
 * Open every secret of one project for injection, all or nothing.
 *
 * Replaces `resolveProjectEnv`'s omit-and-continue for the KMS path: if any
 * secret fails to open (KMS timeout or outage, unknown key, tampered row), the
 * whole manifest is refused and only the key names come back. A runtime never
 * boots with a partial secret set.
 *
 * Not wired yet; the activation stage switches sandbox boot to this.
 */

import { createEnvSealer, type EnvSealer } from "../crypto/env-sealer";
import type { EnvEntry } from "../../dotenv";
import type { EnvVarRecord } from "./resolve-env";

/** Bounded KMS fan-out per manifest. */
const KMS_CONCURRENCY = 4;

export type EnvManifest =
  | { ok: true; secretEntries: EnvEntry[] }
  | { ok: false; keys: string[] };

async function openRecord(
  projectId: string,
  record: EnvVarRecord & { projectId: string },
  sealer: EnvSealer,
): Promise<EnvEntry> {
  const { secretRef, kekProvider, kekKeyId, wrappedDek, ciphertext, iv, authTag } = record;
  if (record.projectId !== projectId) {
    throw new Error(`Env var "${record.key}" does not belong to the requested project.`);
  }
  if (!secretRef || !kekProvider || !kekKeyId || !wrappedDek || !ciphertext || !iv || !authTag) {
    throw new Error(`Env var "${record.key}" is missing envelope fields.`);
  }
  const value = await sealer.open(
    { kekProvider, kekKeyId, wrappedDek, ciphertext, iv, authTag },
    secretRef,
    // The destination is the row's own identity, never the envelope's.
    { projectId: record.projectId, envKey: record.key },
  );
  return { key: record.key, value };
}

/**
 * @param projectId the project the caller already verified ownership of.
 * @param records that project's `projectEnvVars` rows.
 */
export async function openEnvManifest(
  projectId: string,
  records: readonly (EnvVarRecord & { projectId: string })[],
  sealer: EnvSealer = createEnvSealer(),
): Promise<EnvManifest> {
  const secrets = records.filter((record) => record.visibility === "secret");
  try {
    const secretEntries: EnvEntry[] = [];
    for (let i = 0; i < secrets.length; i += KMS_CONCURRENCY) {
      const batch = secrets.slice(i, i + KMS_CONCURRENCY);
      secretEntries.push(
        ...(await Promise.all(batch.map((record) => openRecord(projectId, record, sealer)))),
      );
    }
    return { ok: true, secretEntries };
  } catch (error) {
    // Message only: crypto and KMS errors carry no values.
    console.error(
      "[env] secret manifest unavailable",
      error instanceof Error ? error.message : error,
    );
    return { ok: false, keys: secrets.map((record) => record.key) };
  }
}
