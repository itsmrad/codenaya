import { Children, isValidElement, type ReactElement, type ReactNode } from "react";
import type { ComposerMode } from "@/features/conversations/components/plan-mode-toggle";
import type { ProjectFramework } from "../utils/project-framework";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => {
  const refs: { current: unknown }[] = [];
  let cursor = 0;
  const effects: Array<() => void | (() => void)> = [];
  return {
    refs, effects,
    states: [] as unknown[],
    cleanups: [] as (() => void)[],
    render: () => { cursor = 0; effects.length = 0; },
    useRef: (current: unknown) => refs[cursor++] ?? (refs[cursor - 1] = { current }),
    create: vi.fn(), toast: vi.fn(), dismiss: vi.fn(), template: vi.fn(), peekTemplate: vi.fn(),
  };
});
vi.mock("react", async (importOriginal) => ({
  ...await importOriginal<typeof import("react")>(),
  useRef: harness.useRef,
  useState: (value: unknown) => {
    const index = harness.useRef(harness.states.length).current as number;
    if (!(index in harness.states)) harness.states[index] = value;
    return [harness.states[index], (next: unknown) => { harness.states[index] = next; }];
  },
  useSyncExternalStore: (subscribe: (listener: () => void) => () => void, getSnapshot: () => unknown) => {
    harness.cleanups.push(subscribe(() => {}));
    return getSnapshot();
  },
  useEffect: (effect: () => void | (() => void)) => harness.effects.push(effect),
}));
vi.mock("sonner", () => ({ toast: { error: harness.toast, dismiss: harness.dismiss } }));
vi.mock("motion/react", () => ({ MotionConfig: "div", motion: { div: "div" } }));
vi.mock("@/lib/command-palette", () => ({ useCommandPalette: () => vi.fn() }));
vi.mock("@/lib/hooks/use-is-mac", () => ({ useIsMac: () => false }));
vi.mock("../hooks/use-projects", () => ({ useProjects: () => [] }));
vi.mock("../hooks/use-dashboard-tab", () => ({ useDashboardTab: () => ["projects", vi.fn()] }));
vi.mock("../hooks/use-create-project-from-prompt", () => ({
  useCreateProjectFromPrompt: () => ({ createProject: (...args: unknown[]) => harness.create(...args), isSubmitting: false }),
}));
vi.mock("@/features/templates/utils/pending-template", () => ({ takePendingTemplate: harness.template, peekPendingTemplate: harness.peekTemplate }));
vi.mock("@/features/showcase/components/community-rail", () => ({ CommunityRail: "div" }));
vi.mock("@/features/templates/components/starter-templates", () => ({ StarterTemplates: "div" }));
vi.mock("@/components/landing/grid-pattern", () => ({ GridPattern: "div" }));
vi.mock("@/components/landing/reveal", () => ({ Reveal: "div" }));
vi.mock("@/components/landing/section-header", () => ({ LabelBar: "div", SectionHeader: "div" }));
vi.mock("./first-run-checklist", () => ({ FirstRunChecklist: "div" }));
vi.mock("./import-github-dialog", () => ({ ImportGithubDialog: "div" }));
vi.mock("./new-project-dialog", () => ({ NewProjectDialog: "div" }));
vi.mock("./prompt-composer", () => ({ PromptComposer: "prompt-composer" }));
vi.mock("./projects-grid", () => ({ ProjectsGrid: "div" }));
vi.mock("./recent-projects", () => ({ RecentProjects: "div" }));

import { PENDING_RETRY_TOAST_ID, getProjectHandoff, resetProjectHandoff } from "../utils/project-handoff";
import { ProjectsView } from "./projects-view";
import { PENDING_PROMPT_KEY, clearPendingPrompt, peekPendingPrompt, savePendingPrompt } from "../utils/pending-prompt";

type ComposerProps = {
  onSubmit: (prompt: string, mode: ComposerMode, framework?: ProjectFramework) => Promise<boolean>;
  initialPrompt?: string;
  initialMode?: ComposerMode;
  initialFramework?: ProjectFramework;
};
const findComposer = (node: ReactNode): ReactElement<{ children?: ReactNode }> | null => {
  if (!isValidElement<{ children?: ReactNode }>(node)) return null;
  if (node.type === "prompt-composer") return node;
  for (const child of Children.toArray(node.props.children)) {
    const found = findComposer(child);
    if (found) return found;
  }
  return null;
};
const composer = (node: ReactNode): ComposerProps | null => {
  const found = findComposer(node);
  return found ? (found.props as unknown as ComposerProps) : null;
};

const render = () => {
  harness.render();
  ProjectsView({});
  return harness.effects[0];
};

// Activity hides a route without unmounting: listeners go, effect cleanups run, refs survive.
const hide = async () => {
  const cleanup = harness.effects[1]();
  if (typeof cleanup === "function") cleanup();
  harness.cleanups.splice(0).forEach((cleanup) => cleanup());
  await Promise.resolve();
};

describe("landing prompt resume effect", () => {
  afterEach(() => {
    harness.cleanups.splice(0).forEach((cleanup) => cleanup());
    vi.unstubAllGlobals();
  });
  beforeEach(() => {
    vi.clearAllMocks();
    harness.create.mockReset(); // clearAllMocks keeps implementations, which leaked between tests.
    resetProjectHandoff(); // The store is module state: start every test from idle with no attempt.
    // Without a window the store skips its storage-derived snapshot, which the browser always has.
    vi.stubGlobal("window", {});
    harness.refs.length = 0;
    harness.states.length = 0;
    harness.template.mockReturnValue(null);
    harness.peekTemplate.mockReturnValue(null);
    const storage = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    });
  });

  it.each(["build", "plan", "swarm"] as const)("restores %s and framework after failure", async (mode) => {
    savePendingPrompt("A portfolio site", mode === "build" ? undefined : mode, "next");
    harness.create.mockResolvedValue(false);
    harness.render();
    expect(ProjectsView({}).type).toBe("main");
    harness.effects[0]();
    await vi.waitFor(() => expect(getProjectHandoff().phase).toBe("idle"));
    harness.render();
    const props = composer(ProjectsView({}));
    expect(props).toMatchObject({ initialPrompt: "A portfolio site", initialMode: mode === "build" ? undefined : mode, initialFramework: "next" });
    expect(harness.create).toHaveBeenCalledWith("A portfolio site", undefined, true, mode === "build" ? undefined : mode, "next");
    harness.create.mockResolvedValueOnce(true);
    expect(await props!.onSubmit("A portfolio site", mode, "next")).toBe(true);
    expect(harness.create).toHaveBeenLastCalledWith("A portfolio site", undefined, true, mode === "build" ? undefined : mode, "next");
    expect(getProjectHandoff().phase).toBe("navigating");
    expect(peekPendingPrompt()).toBeNull();
  });

  it.each([true, false])("a failed composer submit and concurrent Retry cannot strand the screen (retry first: %s)", async (retryFirst) => {
    savePendingPrompt("A portfolio site", "plan", "next");
    harness.create.mockResolvedValueOnce(false);
    render()();
    await vi.waitFor(() => expect(harness.toast).toHaveBeenCalledTimes(1));
    harness.render();
    const props = composer(ProjectsView({}))!;
    let finish!: (created: boolean) => void;
    harness.create.mockImplementationOnce(() => new Promise<boolean>((resolve) => { finish = resolve; }));
    const retry = harness.toast.mock.calls[0][1].action.onClick;
    if (retryFirst) retry();
    const submitted = props.onSubmit("A portfolio site", "plan", "next");
    if (!retryFirst) retry();
    await vi.waitFor(() => expect(harness.create).toHaveBeenCalledTimes(2));
    expect(getProjectHandoff().phase).toBe("creating");
    finish(false);
    expect(await submitted).toBe(false);
    expect(getProjectHandoff().phase).toBe("idle");
    harness.render();
    expect(composer(ProjectsView({}))).toMatchObject({ initialPrompt: "A portfolio site", initialMode: "plan", initialFramework: "next" });
  });

  it("a remount observes the in-flight failure and returns to the prefilled dashboard", async () => {
    savePendingPrompt("A portfolio site", "plan", "next");
    let finish!: (created: boolean) => void;
    harness.create.mockImplementationOnce(() => new Promise<boolean>((resolve) => { finish = resolve; }));
    render()();
    await vi.waitFor(() => expect(harness.create).toHaveBeenCalledTimes(1));
    harness.cleanups.splice(0).forEach((cleanup) => cleanup());
    harness.refs.length = 0;
    harness.states.length = 0;
    harness.render();
    expect(ProjectsView({}).type).toBe("main");
    harness.effects[0]();
    finish(false);
    await vi.waitFor(() => expect(getProjectHandoff().phase).toBe("idle"));
    harness.render();
    expect(composer(ProjectsView({}))).toMatchObject({ initialPrompt: "A portfolio site", initialMode: "plan", initialFramework: "next" });
    expect(harness.create).toHaveBeenCalledTimes(1);
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
    expect(harness.create).toHaveBeenLastCalledWith("A portfolio site", undefined, true, "plan", undefined);
    render()();
    expect(harness.create).toHaveBeenCalledTimes(2);
  });

  it("resumes a landing Next.js draft with its chosen framework", async () => {
    savePendingPrompt("A blog", undefined, "next");
    harness.create.mockResolvedValue(true);
    render()();
    await vi.waitFor(() => expect(harness.create).toHaveBeenCalledWith("A blog", undefined, true, undefined, "next"));
  });

  it("renders the dashboard at once when no handoff is pending", () => {
    harness.render();
    expect(composer(ProjectsView({}))).not.toBeNull();
  });

  it("shows the dashboard again after a hide and reshow that follows a successful handoff", async () => {
    savePendingPrompt("A blog");
    harness.create.mockResolvedValue(true);
    render()();
    await vi.waitFor(() => expect(getProjectHandoff().phase).toBe("navigating"));
    await hide();
    harness.render();
    expect(composer(ProjectsView({}))).not.toBeNull();
    harness.effects[0]();
    expect(getProjectHandoff().phase).toBe("idle");
    expect(harness.create).toHaveBeenCalledTimes(1);
  });

  it("keeps an in-flight handoff across a hide and reshow, without a second create", async () => {
    savePendingPrompt("A blog");
    let finish!: (created: boolean) => void;
    harness.create.mockImplementationOnce(() => new Promise<boolean>((resolve) => { finish = resolve; }));
    render()();
    await vi.waitFor(() => expect(harness.create).toHaveBeenCalledTimes(1));
    await hide();
    harness.render();
    expect(ProjectsView({}).type).toBe("main");
    harness.effects[0]();
    expect(harness.create).toHaveBeenCalledTimes(1);
    finish(true);
    await vi.waitFor(() => expect(getProjectHandoff().phase).toBe("navigating"));
    expect(harness.create).toHaveBeenCalledTimes(1);
  });

  it("does not auto-retry a failed draft when the dashboard is reshown", async () => {
    savePendingPrompt("A blog", "plan");
    harness.create.mockResolvedValue(false);
    render()();
    await vi.waitFor(() => expect(harness.toast).toHaveBeenCalledTimes(1));
    await hide();
    harness.render();
    expect(composer(ProjectsView({}))).toMatchObject({ initialPrompt: "A blog", initialMode: "plan" });
    harness.effects[0]();
    expect(harness.create).toHaveBeenCalledTimes(1);
  });

  it("remounts the composer, and drops its toast, when the user changes", async () => {
    savePendingPrompt("A's prompt", "plan");
    harness.create.mockResolvedValue(false);
    render()();
    await vi.waitFor(() => expect(harness.toast).toHaveBeenCalledTimes(1));
    harness.render();
    const before = findComposer(ProjectsView({}));
    expect(composer(ProjectsView({}))).toMatchObject({ initialPrompt: "A's prompt", initialMode: "plan" });
    clearPendingPrompt(); // As the user-change hook does, with the reset.
    resetProjectHandoff();
    expect(harness.dismiss).toHaveBeenCalledWith(PENDING_RETRY_TOAST_ID);
    harness.render();
    const after = findComposer(ProjectsView({}));
    expect(before).not.toBeNull();
    expect(after).not.toBeNull();
    expect(after?.key).not.toBe(before?.key);
    expect(composer(ProjectsView({}))?.initialPrompt).toBeUndefined();
    expect(composer(ProjectsView({}))?.initialMode).toBeUndefined();
  });

  it("keeps the template id when a failed template start is retried from the composer", async () => {
    harness.template.mockReturnValue({ id: "blog", prompt: "A blog" });
    harness.peekTemplate.mockReturnValue({ id: "blog", prompt: "A blog" });
    harness.create.mockResolvedValueOnce(false).mockResolvedValue(true);
    render()();
    await vi.waitFor(() => expect(getProjectHandoff().phase).toBe("idle"));
    harness.render();
    const props = composer(ProjectsView({}))!;
    expect(props.initialPrompt).toBe("A blog");
    await props.onSubmit("A blog", "build");
    expect(harness.create).toHaveBeenLastCalledWith("A blog", "blog", false, "build", undefined);
  });

  it("drops a stale draft when a template wins, so no second project is created", async () => {
    savePendingPrompt("A portfolio site");
    harness.template.mockReturnValue({ id: "blog", prompt: "A blog" });
    render()();
    await vi.waitFor(() => expect(harness.create).toHaveBeenCalledExactlyOnceWith("A blog", "blog", true, undefined, undefined));
    expect(localStorage.getItem(PENDING_PROMPT_KEY)).toBeNull();
    expect(peekPendingPrompt()).toBeNull();
    await vi.waitFor(() => expect(getProjectHandoff().phase).toBe("idle"));
  });

  it("shows no Retry toast once a refusal has dropped the draft", async () => {
    savePendingPrompt("A portfolio site");
    harness.create.mockImplementationOnce(async () => {
      localStorage.removeItem(PENDING_PROMPT_KEY); // As a credential refusal does.
      return false;
    });
    render()();
    await vi.waitFor(() => expect(harness.create).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(harness.toast).not.toHaveBeenCalled();
  });
});
