import { useEffect, useRef, useState } from "react";
import type { AppError } from "../utils/app-error";
import {
  isEsbuildServiceFailure,
  nextEsbuildRecovery,
  type EsbuildRecoveryAttempts,
  type EsbuildRecoveryStatus,
} from "../utils/esbuild-recovery";

/** Infrastructure recovery never queues an AI repair or changes its timing (#776). */
export const useEsbuildRecovery = ({ sandboxId, error, recover }: {
  sandboxId: string | null;
  error: AppError | null;
  recover: () => Promise<EsbuildRecoveryStatus>;
}) => {
  const serviceFailed = sandboxId !== null && isEsbuildServiceFailure(error);
  const [recovering, setRecovering] = useState(false);
  const attempts = useRef<{ sandboxId: string; state: EsbuildRecoveryAttempts } | null>(null);
  useEffect(() => {
    if (!serviceFailed || !sandboxId) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    let waits = 0;
    const attempt = async () => {
      if (cancelled) return;
      const previous = attempts.current?.sandboxId === sandboxId ? attempts.current.state : undefined;
      const next = nextEsbuildRecovery(previous, Date.now());
      if (!next) { setRecovering(false); return; }
      attempts.current = { sandboxId, state: next };
      setRecovering(true);
      try {
        const status = await recover();
        if (cancelled) return;
        if (status === "busy" && waits++ < 15) {
          // An install already in flight owns the server; wait without spending an attempt.
          attempts.current = previous ? { sandboxId, state: previous } : null;
          timer = setTimeout(attempt, 2_000);
        } else {
          setRecovering(false);
        }
      } catch {
        if (!cancelled) setRecovering(false);
      }
    };
    // Defer past React's effect setup/cleanup cycle; only a committed preview recovers.
    timer = setTimeout(attempt, 0);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [sandboxId, serviceFailed, recover]);
  return { serviceFailed, recovering: serviceFailed && recovering };
};
