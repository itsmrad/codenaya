import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { debounceSerial } from "./debounce-serial";

describe("debounceSerial", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("runs once after a burst of calls settles", async () => {
    const task = vi.fn().mockResolvedValue(undefined);
    const { schedule } = debounceSerial(task, 2000);

    schedule();
    await vi.advanceTimersByTimeAsync(1500);
    schedule();
    await vi.advanceTimersByTimeAsync(1500);
    expect(task).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(500);
    expect(task).toHaveBeenCalledTimes(1);
  });

  it("queues one more run for calls made while the task runs", async () => {
    let finish = () => {};
    const task = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const { schedule } = debounceSerial(task, 100);

    schedule();
    await vi.advanceTimersByTimeAsync(100);
    expect(task).toHaveBeenCalledTimes(1);

    schedule();
    await vi.advanceTimersByTimeAsync(100);
    schedule();
    await vi.advanceTimersByTimeAsync(100);
    expect(task).toHaveBeenCalledTimes(1);

    finish();
    await vi.advanceTimersByTimeAsync(100);
    expect(task).toHaveBeenCalledTimes(2);
  });

  it("drops a scheduled run on cancel", async () => {
    const task = vi.fn().mockResolvedValue(undefined);
    const { schedule, cancel } = debounceSerial(task, 100);

    schedule();
    cancel();
    await vi.advanceTimersByTimeAsync(500);
    expect(task).not.toHaveBeenCalled();
  });
  it("runs a scheduled task on flush without waiting for the delay (#492)", async () => {
    const task = vi.fn().mockResolvedValue(undefined);
    const { schedule, flush } = debounceSerial(task, 2000);

    schedule();
    await flush();
    expect(task).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(5000);
    expect(task).toHaveBeenCalledTimes(1);
  });

  it("on flush, waits for the running task and the run queued behind it", async () => {
    let finish = () => {};
    const task = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const { schedule, flush } = debounceSerial(task, 100);

    schedule();
    await vi.advanceTimersByTimeAsync(100);
    schedule();

    let flushed = false;
    const flushing = flush().then(() => {
      flushed = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(flushed).toBe(false);

    finish();
    await vi.advanceTimersByTimeAsync(0);
    expect(task).toHaveBeenCalledTimes(2);
    expect(flushed).toBe(false);

    finish();
    await flushing;
    expect(flushed).toBe(true);
  });

  it("resolves flush at once when nothing is scheduled", async () => {
    const task = vi.fn().mockResolvedValue(undefined);
    const { flush } = debounceSerial(task, 100);

    await flush();
    expect(task).not.toHaveBeenCalled();
  });
});
