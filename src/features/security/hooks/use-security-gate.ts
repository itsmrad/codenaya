import { useState } from "react";
import ky from "ky";

import type { ScanFinding } from "../scan-project";
import type { Id } from "../../../../convex/_generated/dataModel";

export interface SecurityGateState {
  projectId: Id<"projects">;
  findings: ScanFinding[];
  /** The scan itself could not run. */
  failed: boolean;
  proceed: () => unknown;
}

/**
 * Scans the project before `proceed` runs (#300). A clean project proceeds
 * straight away; otherwise `pending` holds what the dialog shows.
 */
export function useSecurityGate(projectId: Id<"projects">) {
  const [checking, setChecking] = useState(false);
  const [pending, setPending] = useState<SecurityGateState | null>(null);

  const guard = async (proceed: () => unknown) => {
    setChecking(true);
    try {
      const { findings } = await ky
        .post("/api/projects/security-scan", { json: { projectId } })
        .json<{ findings: ScanFinding[] }>();
      if (findings.length === 0) {
        await proceed();
        return;
      }
      setPending({ projectId, findings, failed: false, proceed });
    } catch {
      // Advisory only: a broken scan should not trap the user's code, but they
      // have to say so explicitly.
      setPending({ projectId, findings: [], failed: true, proceed });
    } finally {
      setChecking(false);
    }
  };

  return { checking, guard, pending, dismiss: () => setPending(null) };
}
