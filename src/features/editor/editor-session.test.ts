import { afterEach, expect, test, vi } from "vitest";
import { ConvexError } from "convex/values";

import type { Id } from "../../../convex/_generated/dataModel";
import { clearProjectSessions, EditorSession, getProjectSessions, hasOpenConflict, retainProjectSessions } from "./editor-session";

afterEach(() => vi.useRealTimers());

test("dirty local edits survive an external update and autosave stops at a visible conflict (#581)", async () => {
  vi.useFakeTimers();
  const write = vi.fn().mockResolvedValue(null);
  const session = new EditorSession("old heading", write);
  session.edit("old heading plus manual edit");
  session.receive("new agent heading");
  await vi.runAllTimersAsync();
  await session.save();

  expect(session.getSnapshot()).toMatchObject({ content: "old heading plus manual edit", conflict: true, dirty: true });
  expect(write).not.toHaveBeenCalled();
});

test("typing during a save and its subscription echo queues one serial save against the acknowledged content", async () => {
  vi.useFakeTimers();
  const first = Promise.withResolvers<null>();
  const write = vi.fn().mockReturnValueOnce(first.promise).mockResolvedValue(null);
  const session = new EditorSession("old", write);
  session.edit("first edit");
  const saving = session.save();
  session.edit("second edit");
  session.receive("first edit");
  await vi.advanceTimersByTimeAsync(1500);
  expect(write).toHaveBeenCalledTimes(1);
  expect(session.getSnapshot()).toMatchObject({ content: "second edit", conflict: false, saving: true });
  first.resolve(null);
  await saving;
  await vi.advanceTimersByTimeAsync(1500);
  expect(write.mock.calls).toEqual([["first edit", "old"], ["second edit", "first edit"]]);
  expect(session.getSnapshot()).toMatchObject({ content: "second edit", dirty: false });
});

test("a racing server rejection retains the draft and cannot be retried by debounce or unload", async () => {
  vi.useFakeTimers();
  const write = vi.fn().mockRejectedValue(new ConvexError({ code: "CONFLICT", message: "Changed elsewhere" }));
  const session = new EditorSession("old", write);
  session.edit("my edits");
  await vi.advanceTimersByTimeAsync(1500);
  session.receive("agent edits");
  session.edit("more of my edits");
  await vi.runAllTimersAsync();
  await session.save();
  expect(write).toHaveBeenCalledTimes(1);
  expect(session.getSnapshot()).toMatchObject({ content: "more of my edits", dirty: true, conflict: true });
});

test("reload discards only the local draft without saving; keeping mine still uses a guarded save", async () => {
  const write = vi.fn().mockResolvedValue(null);
  const session = new EditorSession("old", write);
  session.edit("my edits");
  session.receive("agent edits");
  session.reload();
  expect(session.getSnapshot()).toMatchObject({ content: "agent edits", dirty: false, conflict: false });
  expect(write).not.toHaveBeenCalled();
  session.edit("my next edits");
  session.receive("next agent edits");
  session.keepMine();
  await vi.waitFor(() => expect(session.getSnapshot().saving).toBe(false));
  expect(write.mock.calls).toEqual([["my next edits", "next agent edits"]]);
});

test("an external write after our save but before acknowledgement updates a clean draft", async () => {
  const pending = Promise.withResolvers<null>();
  const session = new EditorSession("old", () => pending.promise);
  session.edit("manual");
  const saving = session.save();
  session.receive("manual");
  session.receive("later agent edit");
  pending.resolve(null);
  await saving;
  expect(session.getSnapshot()).toMatchObject({ content: "later agent edit", dirty: false, conflict: false });
});

test("new local edits survive an external write while an earlier save completes", async () => {
  const pending = Promise.withResolvers<null>();
  const session = new EditorSession("old", () => pending.promise);
  session.edit("manual");
  const saving = session.save();
  session.edit("more manual");
  session.receive("later agent edit");
  pending.resolve(null);
  await saving;
  expect(session.getSnapshot()).toMatchObject({ content: "more manual", dirty: true, conflict: true });
});

test("network failures preserve the draft, surface an error, and permit an explicit retry", async () => {
  const write = vi.fn().mockRejectedValueOnce(new Error("network")).mockResolvedValue(null);
  const session = new EditorSession("old", write);
  session.edit("manual");
  await session.save();
  expect(session.getSnapshot()).toMatchObject({ content: "manual", dirty: true, conflict: false, error: expect.any(String) });
  await session.save();
  expect(session.getSnapshot()).toMatchObject({ content: "manual", dirty: false, error: null });
});

test("an edit from the old displayed document cannot borrow a newly received server base", async () => {
  vi.useFakeTimers();
  const write = vi.fn().mockResolvedValue(null);
  const session = new EditorSession("old heading", write);
  session.receive("new agent heading");
  // React has received the new file, but the retained view has not applied it yet.
  session.edit("old heading plus manual edit", "old heading");
  await vi.runAllTimersAsync();
  expect(session.getSnapshot()).toMatchObject({ content: "old heading plus manual edit", dirty: true, conflict: true });
  expect(write).not.toHaveBeenCalled();
});

test("published snapshots stay immutable for React subscribers", () => {
  const session = new EditorSession("old", vi.fn());
  const before = session.getSnapshot();
  session.edit("local");
  expect(before).toMatchObject({ content: "old", dirty: false });
  session.reload();
});

test("an unresolved conflict still retains the local document if it is undone to the old base", () => {
  const session = new EditorSession("old", vi.fn());
  session.edit("local");
  session.receive("agent");
  session.edit("old");
  session.receive("next agent");
  expect(session.getSnapshot()).toMatchObject({ content: "old", conflict: true });
  session.reload();
});

test("each project keeps its own sessions until another project opens, and reports open conflicts (#604, #618)", () => {
  const a = "projectA" as Id<"projects">;
  const b = "projectB" as Id<"projects">;
  const session = new EditorSession("base", vi.fn());
  getProjectSessions(a).set("file" as Id<"files">, session);

  expect(getProjectSessions(a).get("file" as Id<"files">)).toBe(session);
  expect(getProjectSessions(b).size).toBe(0);
  expect(hasOpenConflict(a)).toBe(false);

  session.edit("mine");
  session.receive("theirs");
  expect(hasOpenConflict(a)).toBe(true);
  expect(hasOpenConflict(b)).toBe(false);

  retainProjectSessions(a);
  expect(getProjectSessions(a).get("file" as Id<"files">)).toBe(session);
  retainProjectSessions(b);
  expect(getProjectSessions(a).size).toBe(0);
  expect(hasOpenConflict(a)).toBe(false);
  clearProjectSessions(a);
  clearProjectSessions(b);
});

test("an echo equal to the draft after a non-conflict save error is not a conflict (#605)", async () => {
  vi.useFakeTimers();
  const write = vi.fn().mockRejectedValue(new Error("network down"));
  const session = new EditorSession("old", write);
  session.edit("mine");
  await session.save();
  expect(session.getSnapshot()).toMatchObject({ conflict: false, error: expect.any(String) });

  // The write landed on the server before the client saw the error.
  session.receive("mine");
  expect(session.getSnapshot()).toMatchObject({ content: "mine", dirty: false, conflict: false, error: null });
  await vi.runAllTimersAsync();
  expect(write).toHaveBeenCalledTimes(1);

  // A later different echo with no local edits is simply followed.
  session.receive("agent");
  expect(session.getSnapshot()).toMatchObject({ content: "agent", conflict: false });
});

test("an echo that matches an already conflicted draft resolves the conflict (#605)", () => {
  const session = new EditorSession("old", vi.fn());
  session.edit("mine");
  session.receive("theirs");
  expect(session.getSnapshot().conflict).toBe(true);
  session.receive("mine");
  expect(session.getSnapshot()).toMatchObject({ content: "mine", dirty: false, conflict: false });
});
