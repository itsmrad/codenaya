import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";

import type { Checkpoint } from "../hooks/use-checkpoints";
import { CheckpointHistoryDialog } from "./checkpoint-dialogs";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("../hooks/use-checkpoints", () => ({ useForkFromCheckpoint: () => vi.fn() }));

// Render the body in Node without Radix's browser portal.
vi.mock("@/components/ui/dialog", () => {
  const wrapper = ({ children }: { children: ReactNode }) => createElement("div", null, children);
  return { Dialog: wrapper, DialogContent: wrapper, DialogHeader: wrapper, DialogTitle: wrapper, DialogDescription: wrapper };
});

const render = (checkpoints?: Checkpoint[]) => renderToStaticMarkup(createElement(CheckpointHistoryDialog, {
  checkpoints, open: true, onOpenChange: () => {}, onRestore: () => {}, disabled: false,
}));

it("announces loading instead of an empty list while history is unresolved", () => {
  const html = render();
  expect(html).toMatch(/role="status"[^>]*>Loading version history…</);
  expect(html).not.toContain("No checkpoints yet.");
  expect(html).not.toContain("<ul");
});

it("shows the empty state only after history resolves", () => {
  const html = render([]);
  expect(html).toContain("No checkpoints yet.");
  expect(html).not.toContain("Loading version history…");
});

it("shows resolved checkpoints without the loading or empty state", () => {
  const html = render([{
    _id: "checkpoint" as Checkpoint["_id"], _creationTime: 0,
    label: "Before edit", fileCount: 1,
  } as Checkpoint]);
  expect(html).toContain("<ul");
  expect(html).toContain("Before edit");
  expect(html).toContain("1 file");
  expect(html).toContain("Fork from here");
  expect(html).not.toContain("Loading version history…");
  expect(html).not.toContain("No checkpoints yet.");
});
