import { useState } from "react";
import ky from "ky";

import type { ScanFinding } from "../scan-project";
import type { Id } from "../../../../convex/_generated/dataModel";

export interface SecurityGateState {
  projectId: Id<"projects">;
  findings: ScanFinding[];
  /** The scan itself could not run. */
  failed: boolean;
  /** `acknowledged` is true when the user chose "Continue anyway". */
  proceed: (acknowledged: boolean) => unknown;
}

/**
 * Scans the project before `proceed` runs (#300). A clean project proceeds
 * straight away; otherwise `pending` holds what the dialog shows.
 */
export function useSecurityGate(projectId: Id<"projects">) {
  const [checking, setChecking] = useState(false);
  const [pending, setPending] = useState<SecurityGateState | null>(null);

  const guard = async (proceed: (acknowledged: boolean) => unknown) => {
    setChecking(true);
    try {
      const { findings } = await ky
        .post("/api/projects/security-scan", { json: { projectId } })
        .json<{ findings: ScanFinding[] }>();
      if (findings.length === 0) {
        await proceed(false);
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

  /** Asks before `proceed` when a check couldn't run, e.g. publish's server scan. */
  const confirmUnchecked = (proceed: (acknowledged: boolean) => unknown) =>
    setPending({ projectId, findings: [], failed: true, proceed });

  return { checking, guard, confirmUnchecked, pending, dismiss: () => setPending(null) };
}
