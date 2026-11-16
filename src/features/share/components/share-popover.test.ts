import { beforeEach, expect, test, vi } from "vitest";
import type { ReactElement } from "react";
import type { Id } from "../../../../convex/_generated/dataModel";
import { SharePopover } from "./share-popover";

const mocks = vi.hoisted(() => ({ mutation: vi.fn(), fetch: vi.fn(), states: [] as unknown[], cursor: 0,
  project: { shareToken: undefined as string | undefined, shareEnabled: true, shareMode: "snapshot", shareKeepLiveMinutes: 0 } }));
vi.mock("react", async original => ({ ...await original<typeof import("react")>(),
  useState: (initial: unknown) => {
    const index = mocks.cursor++;
    if (!(index in mocks.states)) mocks.states[index] = initial;
    return [mocks.states[index], (value: unknown) => { mocks.states[index] = value; }];
  },
}));
vi.mock("convex/react", () => ({ useMutation: () => mocks.mutation }));
vi.mock("@/features/projects/hooks/use-projects", () => ({ useProject: () => mocks.project }));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

type Element = ReactElement<Record<string, unknown>>;
function elements(node: unknown): Element[] {
  if (!node || typeof node !== "object" || !("props" in node)) return [];
  const element = node as Element;
  return [element, ...[element.props.children].flat().flatMap(elements)];
}
function render() {
  mocks.cursor = 0;
  return elements(SharePopover({ projectId: "project" as Id<"projects"> }));
}

beforeEach(() => {
  mocks.project.shareToken = undefined; mocks.project.shareEnabled = true;
  mocks.states = []; mocks.mutation.mockReset(); mocks.fetch.mockReset();
  mocks.fetch.mockResolvedValue({ ok: true, json: async () => ({ status: "saved" }) });
  vi.stubGlobal("fetch", mocks.fetch);
  vi.stubGlobal("window", { location: { origin: "https://codenaya.tech" } });
});

test.each([undefined, "a".repeat(32)])("options stay local until Generate/Update (existing token: %s)", async token => {
  mocks.project.shareToken = token;
  const selects = render().filter(element => typeof element.props.onValueChange === "function");
  (selects[0].props.onValueChange as (value: string) => void)("latest");
  (selects[1].props.onValueChange as (value: string) => void)("30");
  expect(mocks.mutation).not.toHaveBeenCalled();
  expect(mocks.fetch).not.toHaveBeenCalled();
  const button = render().find(element => element.props.children === (token ? "Update link" : "Generate link"))!;
  await (button.props.onClick as () => Promise<void>)();
  expect(mocks.fetch).toHaveBeenCalledTimes(1);
  expect(JSON.parse(mocks.fetch.mock.calls[0][1].body)).toMatchObject({ mode: "latest", minutes: 30 });
  expect(mocks.mutation).not.toHaveBeenCalled();
});


test("first Generate is enabled without a toggle; disabled existing links can reuse their slug", async () => {
  let tree = render();
  expect(tree.filter(element => typeof element.props.onCheckedChange === "function")).toHaveLength(0);
  const generate = tree.find(element => element.props.children === "Generate link")!;
  expect(generate.props.disabled).toBe(false);
  await (generate.props.onClick as () => Promise<void>)();
  expect(mocks.fetch).toHaveBeenCalledTimes(1);

  mocks.project.shareToken = "a".repeat(32);
  mocks.project.shareEnabled = false;
  tree = render();
  const toggle = tree.find(element => typeof element.props.onCheckedChange === "function")!;
  expect(toggle.props.checked).toBe(false);
  await (toggle.props.onCheckedChange as (on: boolean) => Promise<void>)(true);
  expect(mocks.fetch).toHaveBeenCalledTimes(2);
  expect(mocks.mutation).not.toHaveBeenCalled();
});

test("turning off an existing link is one explicit mutation", async () => {
  mocks.project.shareToken = "a".repeat(32);
  const toggle = render().find(element => typeof element.props.onCheckedChange === "function")!;
  expect(toggle.props.checked).toBe(true);
  await (toggle.props.onCheckedChange as (on: boolean) => Promise<void>)(false);
  expect(mocks.mutation).toHaveBeenCalledTimes(1);
  expect(mocks.fetch).not.toHaveBeenCalled();
});
