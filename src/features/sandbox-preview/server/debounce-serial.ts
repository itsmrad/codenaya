/** A package.json sync waits this long for more edits before re-installing. */
export const REINSTALL_DEBOUNCE_MS = 2000;

/**
 * Runs `task` `delayMs` after the last `schedule()` and never twice at once: a
 * call that lands while the task runs queues exactly one more run after it.
 * `task` must handle its own errors.
 */
export const debounceSerial = (task: () => Promise<void>, delayMs: number) => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let current: Promise<void> | undefined;
  let pending = false;
  const idleWaiters: Array<() => void> = [];
  const wakeIdle = () => {
    if (timer !== undefined || current) return;
    for (const resolve of idleWaiters.splice(0)) resolve();
  };

  const schedule = () => {
    clearTimeout(timer);
    timer = setTimeout(run, delayMs);
  };

  const cancel = () => {
    clearTimeout(timer);
    timer = undefined;
    wakeIdle();
  };

  const run = async () => {
    timer = undefined;
    if (current) {
      pending = true;
      return;
    }
    current = (async () => {
      try {
        await task();
      } finally {
        current = undefined;
        if (pending) {
          pending = false;
          schedule();
        }
        wakeIdle();
      }
    })();
    await current;
  };

  /**
   * Runs a scheduled task now and resolves once nothing is scheduled or
   * running. `onDrained` runs in the same tick the queue is found empty, so
   * nothing can be scheduled between the two.
   */
  const flush = async (onDrained?: () => void) => {
    while (timer !== undefined || current) {
      if (current) {
        await current;
      } else {
        clearTimeout(timer);
        await run();
      }
    }
    onDrained?.();
  };

  /** Resolves once nothing is scheduled or running, without running early. */
  const idle = () =>
    new Promise<void>((resolve) => {
      idleWaiters.push(resolve);
      wakeIdle();
    });

  return { schedule, cancel, flush, idle };
};
