import { beforeEach, describe, expect, it, vi } from "vitest";

import { HTTPError } from "ky";

import { createWithPromptBody, useCreateProjectFromPrompt } from "./use-create-project-from-prompt";

const model = { modelId: "x-ai/grok-4.7" };

describe("createWithPromptBody", () => {
  it("sends the picked mode", () => {
    expect(createWithPromptBody("A kanban board", model, undefined, false, "swarm")).toMatchObject({
      prompt: "A kanban board",
      model,
      mode: "swarm",
    });
    expect(createWithPromptBody("A blog", model, undefined, true, "plan")).toMatchObject({ mode: "plan", fromLanding: true });
  });

  it("omits the mode for build, as the chat composer does", () => {
    expect(createWithPromptBody("A blog", model, undefined, false, "build")).not.toHaveProperty("mode");
    expect(createWithPromptBody("A blog", model)).not.toHaveProperty("mode");
  });
});

// Hook callbacks can be exercised in Node without mounting the dashboard.
vi.mock("react", async (importOriginal) => ({
  ...await importOriginal<typeof import("react")>(),
  useCallback: (callback: unknown) => callback,
  useRef: (current: unknown) => ({ current }),
  useState: (value: unknown) => [value, vi.fn()],
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: mocks.push }) }));
vi.mock("@/features/conversations/hooks/use-agent-model", () => ({ useAgentModel: () => [model] }));
vi.mock("./use-projects", () => ({ useUpdateProjectInstructions: () => vi.fn() }));
vi.mock("@/features/conversations/components/setup-questions-dialog", () => ({ askSetupQuestions: () => mocks.ask() }));
vi.mock("@/features/conversations/setup-questions", () => ({
  shouldAskSetupQuestions: () => true,
  withSetupAnswers: (text: string) => text,
  withSetupDecisions: () => undefined,
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("ky", async (importOriginal) => ({
  ...await importOriginal<typeof import("ky")>(),
  default: { post: (...args: unknown[]) => mocks.post(...args) },
}));

const mocks = vi.hoisted(() => ({ ask: vi.fn(), post: vi.fn(), push: vi.fn() }));

describe("createProject failure contract and submission lock", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.ask.mockResolvedValue(null);
    mocks.post.mockReturnValue({ json: async () => ({ projectId: "project-1" }) });
  });

  it("blocks concurrent calls before setup answers and during creation", async () => {
    let answer!: (value: null) => void;
    let finish!: (value: { projectId: string }) => void;
    mocks.ask.mockImplementation(() => new Promise((resolve) => { answer = resolve; }));
    mocks.post.mockReturnValue({ json: () => new Promise((resolve) => { finish = resolve; }) });
    const { createProject } = useCreateProjectFromPrompt();
    const first = createProject("A blog");
    expect(await createProject("A blog")).toBe(false);
    expect(mocks.ask).toHaveBeenCalledTimes(1);
    answer(null);
    await Promise.resolve();
    expect(await createProject("A blog")).toBe(false);
    expect(mocks.post).toHaveBeenCalledTimes(1);
    finish({ projectId: "project-1" });
    expect(await first).toBe(true);
    expect(mocks.push).toHaveBeenCalledTimes(1);
  });

  it("returns false on request failure and permits a successful retry", async () => {
    mocks.post.mockReturnValueOnce({ json: async () => { throw new Error("offline"); } });
    const { createProject } = useCreateProjectFromPrompt();
    expect(await createProject("A blog")).toBe(false);
    expect(mocks.push).not.toHaveBeenCalled();
    expect(await createProject("A blog")).toBe(true);
    expect(mocks.post).toHaveBeenCalledTimes(2);
  });

  it("returns false on setup cancellation and permits retry", async () => {
    mocks.ask.mockResolvedValueOnce(undefined);
    const { createProject } = useCreateProjectFromPrompt();
    expect(await createProject("A blog")).toBe(false);
    expect(mocks.post).not.toHaveBeenCalled();
    expect(await createProject("A blog")).toBe(true);
  });

  it("counts dispatch failure with an existing project as success", async () => {
    const error = new HTTPError(
      new Response(JSON.stringify({ code: "dispatch_failed", projectId: "project-1" }), { status: 502 }),
      new Request("https://example.test"),
      {} as never,
    );
    mocks.post.mockReturnValueOnce({ json: async () => { throw error; } });
    const { createProject } = useCreateProjectFromPrompt();
    expect(await createProject("A blog")).toBe(true);
    expect(mocks.push).toHaveBeenCalledWith("/projects/project-1");
  });
});
