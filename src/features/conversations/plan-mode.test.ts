import { describe, expect, it } from "vitest";

import { diagnoseStuckMessage, isPlanReply } from "./plan-mode";

describe("diagnoseStuckMessage", () => {
  it("names the loop, the error with its known cause, and the file", () => {
    const message = diagnoseStuckMessage(
      {
        reason: "repeated-error",
        error: `Error: Build failed: [vite] Failed to resolve import "./hooks" from "src/App.tsx".`,
      },
      "src/App.tsx",
    );
    expect(message).toContain("the same error came back 3 times");
    expect(message).toContain('Failed to resolve import "./hooks"');
    expect(message).toContain("Likely cause (unresolved-import)");
    expect(message).toContain("File: src/App.tsx");
  });

  it("leaves out what the run did not record", () => {
    expect(diagnoseStuckMessage({ reason: "repeated-write" })).toBe(
      "The last run got stuck: the same file was rewritten 4 times without fixing it.\n\n" +
        "Find the root cause before changing anything, and plan a different approach.",
    );
  });
});

describe("isPlanReply", () => {
  it("is a plan with a plan section and a checklist", () => {
    expect(isPlanReply("A todo app.\n\n### Steps\n- [ ] Add a todo list page")).toBe(true);
    expect(isPlanReply("## Components\n* [ ] TodoList")).toBe(true);
  });

  it("is an answer without them", () => {
    expect(isPlanReply("`useAuth` reads the Clerk session in `src/hooks/use-auth.ts`.")).toBe(false);
    expect(isPlanReply("### Steps it takes\n1. Reads the session")).toBe(false);
    expect(isPlanReply("- [ ] a checklist with no plan section")).toBe(false);
  });
});
