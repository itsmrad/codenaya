import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => {
  const refs: { current: unknown }[] = [];
  let cursor = 0;
  const effects: (() => void)[] = [];
  return {
    refs, effects,
    render: () => { cursor = 0; effects.length = 0; },
    useRef: (current: unknown) => refs[cursor++] ?? (refs[cursor - 1] = { current }),
    create: vi.fn(), toast: vi.fn(), template: vi.fn(),
  };
});
vi.mock("react", async (importOriginal) => ({
  ...await importOriginal<typeof import("react")>(),
  useRef: harness.useRef,
  useState: (value: unknown) => [value, vi.fn()],
  useEffect: (effect: () => void) => harness.effects.push(effect),
}));
vi.mock("sonner", () => ({ toast: { error: harness.toast } }));
vi.mock("motion/react", () => ({ MotionConfig: "div", motion: { div: "div" } }));
vi.mock("@/lib/command-palette", () => ({ useCommandPalette: () => vi.fn() }));
vi.mock("@/lib/hooks/use-is-mac", () => ({ useIsMac: () => false }));
vi.mock("../hooks/use-projects", () => ({ useProjects: () => [] }));
vi.mock("../hooks/use-dashboard-tab", () => ({ useDashboardTab: () => ["projects", vi.fn()] }));
vi.mock("../hooks/use-create-project-from-prompt", () => ({
  useCreateProjectFromPrompt: () => ({ createProject: (...args: unknown[]) => harness.create(...args), isSubmitting: false }),
}));
vi.mock("@/features/templates/utils/pending-template", () => ({ takePendingTemplate: harness.template }));
vi.mock("@/features/showcase/components/community-rail", () => ({ CommunityRail: "div" }));
vi.mock("@/features/templates/components/starter-templates", () => ({ StarterTemplates: "div" }));
vi.mock("@/components/landing/grid-pattern", () => ({ GridPattern: "div" }));
vi.mock("@/components/landing/reveal", () => ({ Reveal: "div" }));
vi.mock("@/components/landing/section-header", () => ({ LabelBar: "div", SectionHeader: "div" }));
vi.mock("./first-run-checklist", () => ({ FirstRunChecklist: "div" }));
vi.mock("./import-github-dialog", () => ({ ImportGithubDialog: "div" }));
vi.mock("./new-project-dialog", () => ({ NewProjectDialog: "div" }));
vi.mock("./prompt-composer", () => ({ PromptComposer: "div" }));
vi.mock("./projects-grid", () => ({ ProjectsGrid: "div" }));
vi.mock("./recent-projects", () => ({ RecentProjects: "div" }));

import { ProjectsView } from "./projects-view";
import { peekPendingPrompt, savePendingPrompt } from "../utils/pending-prompt";

const render = () => {
  harness.render();
  ProjectsView({});
  return harness.effects[0];
};

describe("landing prompt resume effect", () => {
  afterEach(() => vi.unstubAllGlobals());
  beforeEach(() => {
    vi.clearAllMocks();
    harness.refs.length = 0;
    harness.template.mockReturnValue(null);
    const storage = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    });
  });

  it("survives Strict Mode replay and callback rerenders, then retries explicitly", async () => {
    savePendingPrompt("A portfolio site", "plan");
    harness.create.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const effect = render();
    effect();
    effect(); // Strict Mode effect replay uses the same refs.
    await vi.waitFor(() => expect(harness.toast).toHaveBeenCalledTimes(1));
    render()(); // A new callback identity must not automatically retry a failure.
    expect(harness.create).toHaveBeenCalledTimes(1);
    expect(peekPendingPrompt()).toBe("A portfolio site");
    const { action } = harness.toast.mock.calls[0][1];
    expect(action.label).toBe("Retry");
    action.onClick();
    action.onClick();
    await vi.waitFor(() => expect(peekPendingPrompt()).toBeNull());
    expect(harness.create).toHaveBeenCalledTimes(2);
    expect(harness.create).toHaveBeenLastCalledWith("A portfolio site", undefined, true, "plan");
    render()();
    expect(harness.create).toHaveBeenCalledTimes(2);
  });
});
