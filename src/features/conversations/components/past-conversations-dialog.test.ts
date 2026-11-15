import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";

import { useConversations } from "../hooks/use-conversations";
import { PastConversationsDialog } from "./past-conversations-dialog";

vi.mock("../hooks/use-conversations", () => ({ useConversations: vi.fn() }));

// Render the body in Node without the browser portal or command filtering.
vi.mock("@/components/ui/command", () => {
  const wrapper = ({ children }: { children: ReactNode }) => createElement("div", null, children);
  return {
    CommandDialog: wrapper,
    CommandInput: () => null,
    CommandList: wrapper,
    CommandEmpty: wrapper,
    CommandGroup: ({ children }: { children: ReactNode }) => createElement("section", null, children),
    CommandItem: wrapper,
  };
});

const render = (conversations: ReturnType<typeof useConversations>) => {
  vi.mocked(useConversations).mockReturnValue(conversations);
  return renderToStaticMarkup(createElement(PastConversationsDialog, {
    projectId: "project" as Parameters<typeof useConversations>[0],
    open: true, onOpenChange: () => {}, onSelect: () => {},
  }));
};

it("announces loading without mounting the empty state or group", () => {
  const html = render(undefined);
  expect(html).toMatch(/role="status"[^>]*>Loading conversations…</);
  expect(html).not.toContain("No conversations found.");
  expect(html).not.toContain("<section");
});

it("mounts the empty state after conversations resolve", () => {
  const html = render([]);
  expect(html).toContain("No conversations found.");
  expect(html).not.toContain("Loading conversations…");
});

it("renders resolved conversations and keeps the search empty state available", () => {
  const html = render([{
    _id: "conversation", _creationTime: 0, title: "Earlier conversation",
  }] as NonNullable<ReturnType<typeof useConversations>>);
  expect(html).toContain("<section");
  expect(html).toContain("Earlier conversation");
  expect(html).toContain("No conversations found.");
  expect(html).not.toContain("Loading conversations…");
});
