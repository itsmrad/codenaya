import { convex } from "@/lib/convex-client";
import { resolveProjectEnv } from "@/features/integrations/server/env/resolve-env";
import { buildFlatFileList } from "@/features/sandbox-preview/utils/file-tree";
import { getInstructionsExportFile } from "@/features/projects/instructions";

import { api } from "../../../../convex/_generated/api";
import type { Id } from "../../../../convex/_generated/dataModel";
import { scanProject, type ScanEnvVar } from "../scan-project";

/**
 * Scans a project's saved files and env vars (#300). Server-side because the
 * stored secret values it looks for are decrypted here and must not reach the
 * browser; only the findings, which hold no values, are returned. The
 * `AGENTS.md` that exports generate from the project instructions is scanned
 * like any exported file, so pasted credentials are caught before they leave.
 */
export async function scanStoredProject(
  internalKey: string,
  projectId: Id<"projects">,
) {
  const [files, env, project] = await Promise.all([
    convex.query(api.system.getProjectFilesWithUrls, { internalKey, projectId }),
    storedScanEnv(internalKey, projectId),
    convex.query(api.system.getProjectById, { internalKey, projectId }),
  ]);
  const flatFiles = buildFlatFileList(files);
  const instructionsFile = getInstructionsExportFile(
    project?.instructions,
    flatFiles.map((file) => file.path),
  );
  return scanProject(instructionsFile ? [...flatFiles, instructionsFile] : flatFiles, env);
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
