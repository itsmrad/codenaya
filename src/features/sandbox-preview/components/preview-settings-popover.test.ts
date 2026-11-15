import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { PreviewSettingsPopover } from "./preview-settings-popover";
import type { Doc, Id } from "../../../../convex/_generated/dataModel";

vi.mock("@/features/projects/hooks/use-projects", () => ({ useUpdateProjectSettings: () => vi.fn() }));
vi.mock("@/components/ui/popover", () => ({
  Popover: ({ children }: { children: ReactNode }) => children,
  PopoverTrigger: ({ children }: { children: ReactNode }) => children,
  PopoverContent: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@tanstack/react-form", () => ({
  useForm: ({ defaultValues }: { defaultValues: Record<string, string> }) => ({
    Field: ({ name, children }: { name: string; children: (field: unknown) => ReactNode }) => children({
      name, state: { value: defaultValues[name] }, handleBlur: vi.fn(), handleChange: vi.fn(),
    }),
    Subscribe: ({ children }: { children: (state: boolean[]) => ReactNode }) => children([true, false]),
  }),
}));

const file = (name: string, content: string) => ({ _id: name, name, type: "file", content } as Doc<"files">);
const render = (files: Doc<"files">[], devCommand?: string) => renderToStaticMarkup(createElement(PreviewSettingsPopover, {
  projectId: "project" as Id<"projects">, files, initialValues: { devCommand },
}));

describe("preview command hints", () => {
  it("detects imported Next.js without a config from its dependency", () => {
    const html = render([file("package.json", '{"dependencies":{"next":"15.5.0"}}')]);
    expect(html).toContain('placeholder="npm run dev -- -H 0.0.0.0"');
    expect(html).toContain("Next.js detected");
    expect(html).toContain('value=""');
  });

  it("detects Vite and preserves a manual override", () => {
    const html = render([file("package.json", "{}"), file("vite.config.ts", "")], "npm run custom");
    expect(html).toContain('placeholder="npm run dev -- --host 0.0.0.0"');
    expect(html).toContain('value="npm run custom"');
    expect(html).toContain("Vite detected");
  });

  it("still uses config detection during an invalid package.json edit", () => {
    expect(render([file("package.json", "{"), file("next.config.ts", "")])).toContain('placeholder="npm run dev -- -H 0.0.0.0"');
  });

  it("keeps a generic hint before files load or for an unknown framework", () => {
    expect(render([])).toContain('placeholder="npm run dev"');
    expect(render([file("package.json", "{}")])).toContain('placeholder="npm run dev"');
  });
});
