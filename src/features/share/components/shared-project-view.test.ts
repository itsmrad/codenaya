import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { ReactElement } from "react";
import { SharedProjectView } from "./shared-project-view";

const mocks = vi.hoisted(() => ({
  fetch: vi.fn(), states: [] as unknown[], cursor: 0,
  effect: undefined as (() => (() => void) | undefined) | undefined,
}));
vi.mock("react", async original => ({ ...await original<typeof import("react")>(),
  useState: (initial: unknown) => {
    const index = mocks.cursor++;
    if (!(index in mocks.states)) mocks.states[index] = initial;
    return [mocks.states[index], (value: unknown) => { mocks.states[index] = value; }];
  },
  useCallback: (callback: unknown) => callback,
  useEffect: (effect: () => (() => void) | undefined) => { mocks.effect = effect; },
}));
vi.mock("convex/react", () => ({ useQuery: () => ({ name: "Site" }), useMutation: () => vi.fn() }));
vi.mock("@/features/showcase/hooks/use-remix", () => ({ useRemix: () => ({ remix: vi.fn(), isRemixing: false }) }));

function text(node: unknown): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(text).join("");
  if (node && typeof node === "object" && "props" in node) {
    return text((node as ReactElement<{ children?: unknown }>).props.children);
  }
  return "";
}
function render() {
  mocks.cursor = 0;
  return SharedProjectView({ token: "a".repeat(32), initial: { name: "Site" } });
}

beforeEach(() => {
  mocks.states = []; mocks.fetch.mockReset();
  vi.stubGlobal("fetch", mocks.fetch);
});
afterEach(() => vi.unstubAllGlobals());

test.each([
  [429, "17", "Too many requests, try again in 17 seconds.", "rate_limited"],
  [429, null, "Too many requests, try again in a minute.", "rate_limited"],
  [429, "invalid", "Too many requests, try again in a minute.", "rate_limited"],
  [200, null, "Busy, try again shortly.", "busy"],
] as const)("HTTP %s with Retry-After %s renders the correct state", async (status, retryAfter, message, expectedState) => {
  mocks.fetch.mockResolvedValue(new Response(JSON.stringify({ status: "busy" }), {
    status, headers: retryAfter ? { "Retry-After": retryAfter } : {},
  }));
  render();
  const cleanup = mocks.effect!();
  try {
    await vi.waitFor(() => expect(mocks.states[0]).toMatchObject({ status: expectedState }));
    const output = text(render());
    expect(output).toContain(message);
    if (status === 429) expect(output).not.toContain("Busy");
  } finally { cleanup?.(); }
});
