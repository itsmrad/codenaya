/**
 * Runs `task` `delayMs` after the last `schedule()` and never twice at once: a
 * call that lands while the task runs queues exactly one more run after it.
 * `task` must handle its own errors.
 */
export const debounceSerial = (task: () => Promise<void>, delayMs: number) => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let current: Promise<void> | undefined;
  let pending = false;

  const schedule = () => {
    clearTimeout(timer);
    timer = setTimeout(run, delayMs);
  };

  const cancel = () => {
    clearTimeout(timer);
    timer = undefined;
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
      }
    })();
    await current;
  };

  /** Runs a scheduled task now and resolves once nothing is scheduled or running. */
  const flush = async () => {
    while (timer !== undefined || current) {
      if (current) {
        await current;
      } else {
        clearTimeout(timer);
        await run();
      }
    }
  };

  return { schedule, cancel, flush };
};
