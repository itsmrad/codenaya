import { useEffect, useRef, useState } from "react";
import type { AppError } from "../utils/app-error";
import type { Framework } from "../utils/framework";
import {
  ESBUILD_RECOVERY_COOLDOWN_MS,
  MAX_ESBUILD_RECOVERIES,
  isEsbuildServiceFailure,
  nextEsbuildRecovery,
  type EsbuildRecoveryAttempts,
  type EsbuildRecoveryStatus,
} from "../utils/esbuild-recovery";

/** Infrastructure recovery never queues an AI repair or changes its timing (#776). */
export const useEsbuildRecovery = ({ sandboxId, framework, error, recover }: {
  sandboxId: string | null;
  framework: Framework | null;
  error: AppError | null;
  recover: () => Promise<EsbuildRecoveryStatus>;
}) => {
  const serviceFailed = sandboxId !== null && isEsbuildServiceFailure(error, framework);
  const [recovering, setRecovering] = useState(false);
  const attempts = useRef<{ sandboxId: string; state: EsbuildRecoveryAttempts } | null>(null);
  const waits = useRef({ sandboxId, count: 0 });
  useEffect(() => {
    if (waits.current.sandboxId !== sandboxId || !serviceFailed) waits.current = { sandboxId, count: 0 };
    if (!serviceFailed || !sandboxId) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    let retried = false;
    const attempt = async () => {
      if (cancelled) return;
      if (waits.current.count > 15) { setRecovering(false); return; }
      const previous = attempts.current?.sandboxId === sandboxId ? attempts.current.state : undefined;
      const next = nextEsbuildRecovery(previous, Date.now());
      if (!next) {
        setRecovering(false);
        // Inside the cooldown, try again once it ends; the attempt cap still stops this.
        if (previous && previous.attempts < MAX_ESBUILD_RECOVERIES) {
          timer = setTimeout(attempt, ESBUILD_RECOVERY_COOLDOWN_MS - (Date.now() - previous.lastAttemptAt));
        }
        return;
      }
      attempts.current = { sandboxId, state: next };
      setRecovering(true);
      try {
        const status = await recover();
        if (cancelled) return;
        // An install already in flight owns the server; no restart happened, so no attempt is spent.
        if (status === "busy") attempts.current = previous ? { sandboxId, state: previous } : null;
        if (status === "busy" && waits.current.count++ < 15) {
          timer = setTimeout(attempt, 2_000);
        } else {
          setRecovering(false);
        }
      } catch {
        if (cancelled) return;
        setRecovering(false);
        // One retry after the cooldown for a failed request; leaving the error cancels it.
        if (!retried && next.attempts < MAX_ESBUILD_RECOVERIES) {
          retried = true;
          timer = setTimeout(attempt, ESBUILD_RECOVERY_COOLDOWN_MS);
        }
      }
    };
    // Defer past React's effect setup/cleanup cycle; only a committed preview recovers.
    timer = setTimeout(attempt, 0);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [sandboxId, serviceFailed, recover]);
  return { serviceFailed, recovering: serviceFailed && recovering };
};
