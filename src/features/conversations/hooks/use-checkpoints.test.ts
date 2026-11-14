import { describe, expect, it, vi } from "vitest";

import { undoAction } from "./use-checkpoints";

describe("undoAction (#259)", () => {
  it("undoes once however often Undo is clicked", () => {
    const undo = vi.fn();
    const action = undoAction(undo);

    action.onClick();
    action.onClick();

    expect(action.label).toBe("Undo");
    expect(undo).toHaveBeenCalledTimes(1);
  });
});
