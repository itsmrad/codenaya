import { afterEach, describe, expect, it, vi } from "vitest";

import { dismissNoteProposal, isNoteProposalDismissed } from "./note-proposals";

afterEach(() => vi.unstubAllGlobals());

describe("note proposal dismissals", () => {
  it("persists each dismissal and isolates projects and messages", () => {
    const values = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    });
    expect(isNoteProposalDismissed("project-a", "message-a")).toBe(false);
    dismissNoteProposal("project-a", "message-a");
    dismissNoteProposal("project-a", "message-b");
    expect(isNoteProposalDismissed("project-a", "message-a")).toBe(true);
    expect(isNoteProposalDismissed("project-a", "message-b")).toBe(true);
    expect(isNoteProposalDismissed("project-b", "message-a")).toBe(false);
    expect(isNoteProposalDismissed("project-a", "message-c")).toBe(false);
  });

  it("tolerates unavailable storage", () => {
    const blocked = () => { throw new Error("blocked"); };
    vi.stubGlobal("localStorage", { getItem: blocked, setItem: blocked });
    expect(() => dismissNoteProposal("project-a", "message-a")).not.toThrow();
    expect(isNoteProposalDismissed("project-a", "message-a")).toBe(false);
  });
});
