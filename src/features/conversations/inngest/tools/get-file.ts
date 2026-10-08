import { convex } from "@/lib/convex-client";

import { api } from "../../../../../convex/_generated/api";
import { Id } from "../../../../../convex/_generated/dataModel";

/**
 * Looks up a file by an ID the agent supplied. Convex rejects a malformed or
 * wrong-table ID with an ArgumentValidationError; that is the agent's mistake,
 * not a transient failure, so it resolves to null like a missing file. Thrown
 * inside step.run it would make Inngest retry the step before the agent ever
 * sees it. A file from another project is also null (#209). Any other error
 * still throws so Inngest can retry it.
 */
export const getFileByAgentId = async (
  internalKey: string,
  projectId: Id<"projects">,
  fileId: string
) => {
  try {
    return await convex.query(api.system.getFileById, {
      internalKey,
      projectId,
      fileId: fileId as Id<"files">,
    });
  } catch (error) {
    if (error instanceof Error && error.message.includes("ArgumentValidationError")) {
      return null;
    }
    throw error;
  }
};
