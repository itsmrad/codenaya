import { convex } from "@/lib/convex-client";
import { resolveProjectEnv } from "@/features/integrations/server/env/resolve-env";
import { buildFlatFileList } from "@/features/sandbox-preview/utils/file-tree";

import { api } from "../../../../convex/_generated/api";
import type { Id } from "../../../../convex/_generated/dataModel";
import { scanProject, type ScanEnvVar } from "../scan-project";

/**
 * Scans a project's saved files and env vars (#300). Server-side because the
 * stored secret values it looks for are decrypted here and must not reach the
 * browser; only the findings, which hold no values, are returned.
 */
export async function scanStoredProject(
  internalKey: string,
  projectId: Id<"projects">,
) {
  const [files, env] = await Promise.all([
    convex.query(api.system.getProjectFilesWithUrls, { internalKey, projectId }),
    storedScanEnv(internalKey, projectId),
  ]);
  return scanProject(buildFlatFileList(files), env);
}

/** The project's env vars as `scanProject` takes them, decrypted. */
export async function storedScanEnv(
  internalKey: string,
  projectId: Id<"projects">,
): Promise<ScanEnvVar[]> {
  const records = await convex.query(api.system.getEnvVarsForSandbox, { internalKey, projectId });

  // A variable that cannot be decrypted is only missing from the stored-secret
  // check; the rest of the scan still runs.
  const { publicEntries, secretEntries } = await resolveProjectEnv(records);

  return [
    ...publicEntries.map((entry) => ({ ...entry, visibility: "public" as const })),
    ...secretEntries.map((entry) => ({ ...entry, visibility: "secret" as const })),
  ];
}
