import { convexErrorMessage, getAppError } from "@/lib/convex-error";
import type { Id } from "../../../convex/_generated/dataModel";

const DEBOUNCE_MS = 1500;

/** A tab's draft and its acknowledged server base; saves are always compare-and-save (#581). */
export class EditorSession {
  private base: string;
  private remote: string;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private inFlight = false;
  private savingContent: string | undefined;
  private listeners = new Set<() => void>();
  private snapshot: { content: string; dirty: boolean; conflict: boolean; saving: boolean; error: string | null };

  constructor(content: string, private write: (content: string, expectedContent: string) => Promise<unknown>) {
    this.base = this.remote = content;
    this.snapshot = { content, dirty: false, conflict: false, saving: false, error: null };
  }

  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  private publish() {
    this.snapshot = { ...this.snapshot, dirty: this.snapshot.content !== this.base, saving: this.inFlight };
    this.listeners.forEach((listener) => listener());
  }
  cancel() { clearTimeout(this.timer); this.timer = undefined; }
  private schedule() {
    this.cancel();
    if (!this.snapshot.conflict && this.snapshot.content !== this.base) {
      this.timer = setTimeout(() => { void this.save(); }, DEBOUNCE_MS);
    }
  }

  receive(content: string) {
    if (content === this.remote) return;
    this.remote = content;
    if (this.inFlight && content === this.savingContent) return;
    this.snapshot = { ...this.snapshot };
    if (content === this.snapshot.content) {
      // The server already holds the draft, e.g. a save that errored after it landed (#605).
      this.base = content;
      this.snapshot.conflict = false;
      this.snapshot.error = null;
      this.cancel();
    } else if (!this.snapshot.conflict && this.snapshot.content === this.base) {
      this.base = content;
      this.snapshot.content = content;
    } else {
      this.snapshot.conflict = true;
      this.cancel();
    }
    this.publish();
  }

  edit(content: string, previousContent = this.snapshot.content) {
    this.snapshot = { ...this.snapshot };
    // A subscription may arrive before the retained view applies its new document.
    this.snapshot.conflict ||= previousContent !== this.snapshot.content;
    this.snapshot.content = content;
    this.snapshot.error = null;
    this.publish();
    this.schedule();
  }

  save = async () => {
    this.cancel();
    if (this.inFlight || this.snapshot.conflict || this.snapshot.content === this.base) return;
    const content = this.snapshot.content;
    const expectedContent = this.base;
    this.inFlight = true;
    this.savingContent = content;
    this.publish();
    try {
      await this.write(content, expectedContent);
      this.snapshot = { ...this.snapshot };
      this.base = content;
      if (this.remote === expectedContent || this.remote === content) {
        this.remote = content;
        this.snapshot.conflict = false;
      } else if (this.snapshot.content === content || this.remote === this.snapshot.content) {
        // The server moved on to what the editor already shows, e.g. an agent echo of a newer draft (#605).
        this.base = this.remote;
        this.snapshot.content = this.remote;
        this.snapshot.conflict = false;
      } else {
        this.snapshot.conflict = true;
      }
      this.snapshot.error = null;
    } catch (error) {
      this.snapshot = { ...this.snapshot };
      if (this.remote !== expectedContent && (this.remote === content || this.remote === this.snapshot.content)) {
        // An echo shows the server already holds this content, so the error is moot (#605).
        this.base = this.remote;
        this.snapshot.error = null;
      } else {
        this.snapshot.conflict ||= getAppError(error)?.code === "CONFLICT";
        this.snapshot.error = convexErrorMessage(error, "Couldn't save your edits. Retry saving.");
      }
    } finally {
      this.inFlight = false;
      this.savingContent = undefined;
      this.publish();
    }
    if (!this.snapshot.error) this.schedule();
  };

  reload = () => {
    if (this.inFlight) return;
    this.cancel();
    this.base = this.remote;
    this.snapshot = { content: this.remote, dirty: false, conflict: false, saving: false, error: null };
    this.publish();
  };

  keepMine = () => {
    if (this.inFlight) return;
    this.base = this.remote;
    this.snapshot = { ...this.snapshot };
    this.snapshot.conflict = false;
    this.snapshot.error = null;
    this.publish();
    void this.save();
  };
}

const projectSessions = new Map<Id<"projects">, Map<Id<"files">, EditorSession>>();

/** A project's drafts outlive EditorView remounts and route changes until another project opens (#604, #618). */
export const getProjectSessions = (projectId: Id<"projects">) => {
  let sessions = projectSessions.get(projectId);
  if (!sessions) projectSessions.set(projectId, sessions = new Map());
  return sessions;
};

export const clearProjectSessions = (projectId: Id<"projects">) => { projectSessions.delete(projectId); };

/** Drops every retained draft and its pending autosave, e.g. on sign-out or a user switch. */
export const clearAllProjectSessions = () => {
  for (const sessions of projectSessions.values()) for (const session of sessions.values()) session.cancel();
  projectSessions.clear();
};

/** Keeps only this project's drafts, so memory holds one project at most. */
export const retainProjectSessions = (projectId: Id<"projects">) => {
  for (const id of projectSessions.keys()) if (id !== projectId) projectSessions.delete(id);
};

export const hasOpenConflict = (projectId: Id<"projects">) =>
  [...projectSessions.get(projectId)?.values() ?? []].some((session) => session.getSnapshot().conflict);
