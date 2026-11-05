import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { AgentStep } from "@/features/conversations/agent-steps";
import { PreviewBuilding } from "./preview-building";

const write = (id: string, tool: string, targets: string[], status: AgentStep["status"] = "done"): AgentStep => ({
  id,
  kind: "tool",
  tool,
  targets,
  status,
  startedAt: 0,
});

const render = (steps: AgentStep[]) => renderToStaticMarkup(createElement(PreviewBuilding, { steps }));

// #478: the building screen shows real progress, with a calm animation.
describe("PreviewBuilding", () => {
  it("shows placeholders, not the seeded starter, before the agent writes anything", () => {
    const html = render([write("r", "readFiles", ["package.json"])]);
    expect(html).toContain('aria-label="Files written so far"');
    expect(html).not.toContain("package.json");
    expect(html).toContain('data-slot="skeleton"');
  });

  it("lists the files the run wrote, newest first", () => {
    const html = render([
      write("a", "writeFiles", ["src/App.tsx", "src/lib/auth.ts"]),
      write("b", "updateFile", ["src/index.css"]),
    ]);
    const order = ["src/index.css", "src/lib/auth.ts", "src/App.tsx"].map((path) => html.indexOf(`title="${path}"`));
    expect(order.every((index) => index >= 0)).toBe(true);
    expect([...order].sort((x, y) => x - y)).toEqual(order);
  });

  it("collapses past eight files into +N more", () => {
    const paths = Array.from({ length: 11 }, (_, index) => `src/f${index}.ts`);
    expect(render([write("a", "writeFiles", paths)])).toContain("+3 more");
  });

  it("breathes and orbits instead of pinging, and stops for reduced motion", () => {
    const html = render([]);
    expect(html).not.toContain("animate-ping");
    expect(html).toContain("animate-build-glow");
    expect(html).toContain("animate-[spin_2.8s_linear_infinite]");
    expect(html.match(/motion-reduce:hidden/g)).toHaveLength(2);
  });
});
