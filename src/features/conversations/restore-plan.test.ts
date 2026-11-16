import { expect, it } from "vitest";

import { restorePlan } from "./restore-plan";

it("flips the comparison: files added since the checkpoint are removed, deleted ones come back", () => {
  expect(
    restorePlan([
      { path: "new.ts", status: "added" },
      { path: "App.tsx", status: "modified" },
      { path: "old.ts", status: "deleted" },
      { path: "other.ts", status: "added" },
    ]),
  ).toEqual({ removed: ["new.ts", "other.ts"], changed: ["App.tsx"], recreated: ["old.ts"] });
});

it("is empty when nothing differs", () => {
  expect(restorePlan([])).toEqual({ removed: [], changed: [], recreated: [] });
});
