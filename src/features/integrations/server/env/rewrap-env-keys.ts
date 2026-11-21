/**
 * Online move of env-var DEK wraps to the current KMS key, and the verify pass.
 *
 * `rewrap` moves every secret row not yet on ENV_VARS_KMS_KEY_ARN (a legacy
 * local-KEK row, or a row on a previous ARN in the key set) to it: KMS Decrypt
 * under the row's own context, Encrypt under the current key with the same
 * context, then a compare-and-set write (convex/envKeyRewrap.ts). The value
 * is never decrypted; ciphertext, IV and tag are copied through untouched. A
 * save or delete that lands first wins. Rows of any recovery epoch are moved,
 * and their epoch is left as it is.
 *
 * `verify` unwraps every row's DEK under the current key and discards it,
 * without opening the value. A row on any other key is a failure.
 *
 * Both run a page at a time and report counts by the row's key id, plus the
 * row id and key id of each failure (nothing secret). Re-running is safe:
 * rows already on the current key are counted and left alone.
 */

import { convex } from "@/lib/convex-client";

import { api } from "../../../../../convex/_generated/api";
import { createEnvSealer, type EnvSealer } from "../crypto/env-sealer";

export const ENV_REWRAP_PAGE_SIZE = 50;
/** Bounded KMS fan-out, as for a manifest. */
const KMS_CONCURRENCY = 4;

export type EnvKeyPassMode = "rewrap" | "verify";
type Outcome = "moved" | "alreadyCurrent" | "skipped" | "verified" | "failed";
type Counts = Partial<Record<Outcome | "total", number>>;

export interface EnvKeyPassReport {
  /** Keyed by the row's key id as read (a KMS ARN or a legacy key id). */
  byKey: Record<string, Counts>;
  failures: { id: string; kekKeyId: string }[];
}

export interface EnvKeyPage extends EnvKeyPassReport {
  cursor: string;
  done: boolean;
}

export const emptyReport = (): EnvKeyPassReport => ({ byKey: {}, failures: [] });

/** Failures a merged report names; the counts stay complete. */
const MAX_REPORTED_FAILURES = 500;

/** Adds `page` into `total`. */
export function mergeReport(total: EnvKeyPassReport, page: EnvKeyPassReport) {
  for (const [keyId, counts] of Object.entries(page.byKey)) {
    const into = (total.byKey[keyId] ??= {});
    for (const [outcome, n] of Object.entries(counts) as [keyof Counts, number][]) {
      into[outcome] = (into[outcome] ?? 0) + n;
    }
  }
  total.failures.push(...page.failures.slice(0, MAX_REPORTED_FAILURES - total.failures.length));
}

export async function runEnvKeyPage(
  mode: EnvKeyPassMode,
  internalKey: string,
  cursor: string | null,
  { sealer = createEnvSealer(), pageSize = ENV_REWRAP_PAGE_SIZE }: { sealer?: EnvSealer; pageSize?: number } = {},
): Promise<EnvKeyPage> {
  const { page, isDone, continueCursor } = await convex.query(api.envKeyRewrap.listSecretEnvVarsPage, {
    internalKey,
    paginationOpts: { numItems: pageSize, cursor },
  });
  const report = emptyReport();

  const handle = async (row: (typeof page)[number]): Promise<Outcome> => {
    const { secretRef, kekProvider, kekKeyId, wrappedDek, ciphertext, iv, authTag } = row;
    if (!secretRef || !kekProvider || !kekKeyId || !wrappedDek || !ciphertext || !iv || !authTag) {
      throw new Error("missing envelope fields");
    }
    const sealed = { kekProvider, kekKeyId, wrappedDek, ciphertext, iv, authTag };
    // The destination is the row's own identity, never the envelope's.
    const destination = { projectId: row.projectId, envKey: row.key };
    if (mode === "verify") {
      await sealer.checkDek(sealed, destination);
      return "verified";
    }
    const { sealed: next, changed } = await sealer.rewrap(sealed, destination);
    if (!changed) return "alreadyCurrent";
    const written = await convex.mutation(api.envKeyRewrap.rewrapEnvVarDek, {
      internalKey,
      id: row._id,
      expected: { secretRef, kekProvider, kekKeyId, wrappedDek, updatedAt: row.updatedAt },
      next: { kekProvider: next.kekProvider, kekKeyId: next.kekKeyId, wrappedDek: next.wrappedDek },
    });
    // Not written: a save or delete changed the row since this page was read.
    return written ? "moved" : "skipped";
  };

  for (let i = 0; i < page.length; i += KMS_CONCURRENCY) {
    await Promise.all(
      page.slice(i, i + KMS_CONCURRENCY).map(async (row) => {
        const keyId = row.kekKeyId ?? "(none)";
        let outcome: Outcome;
        try {
          outcome = await handle(row);
        } catch (error) {
          outcome = "failed";
          report.failures.push({ id: row._id, kekKeyId: keyId });
          // The error class only, never its details.
          console.error(`[env] KMS ${mode} failed`, row._id, error instanceof Error ? error.name : "unknown error");
        }
        const counts = (report.byKey[keyId] ??= {});
        counts.total = (counts.total ?? 0) + 1;
        counts[outcome] = (counts[outcome] ?? 0) + 1;
      }),
    );
  }

  return { ...report, cursor: continueCursor, done: isDone };
}
