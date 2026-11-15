import { expect, test, type Page } from "@playwright/test";
import { Sandbox } from "e2b";

import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { EMPTY_CHAT_TITLE } from "./chat-fixtures";
import { hasClerkCredentials, signIn } from "./clerk-auth";
import { collectConsoleErrors } from "./console-errors";
import { userConvexClient } from "./convex-client";
import { hasPreviewFixtureEnv, killProjectSandboxes, seedNextApp, seedPreviewProject } from "./preview-fixtures";
import { STUB_MODEL, type StubChatRequest, startStubProvider } from "./stub-provider";

/**
 * The agent's checkBuild step (#226). A stub provider (see `stub-provider.ts`)
 * plays the model, so this needs the Inngest dev server serving this app, as
 * in `byok-agent-run.spec.ts`.
 */

const STUB_REPLY = "Built the page.";

const calledCheckBuild = (request: StubChatRequest) =>
  JSON.stringify(request.messages).includes('"name":"checkBuild"');

/** checkBuild calls in a request's history; the last request's history is the whole run. */
const checkBuildCalls = (request: StubChatRequest) =>
  request.messages
    .flatMap((message) => (message as { tool_calls?: Array<{ function: { name: string } }> }).tool_calls ?? [])
    .filter((call) => call.function.name === "checkBuild").length;

test.describe.serial("agent checkBuild", () => {
  test.skip(
    !hasClerkCredentials(),
    "Needs CLERK_SECRET_KEY and NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY",
  );

  const apiKey = `sk-e2e-check-build-${Date.now()}-wxyz`;
  const label = `Check build ${Date.now()}`;
  let stub: Awaited<ReturnType<typeof startStubProvider>>;
  let page: Page;
  let keyId: Id<"aiProviderKeys"> | undefined;
  let projectId: Id<"projects"> | undefined;
  /** Picks the stub's tool calls; each test sets its own script. */
  let script: {
    toolCall: { name: string; arguments: Record<string, unknown> };
    followUp: (request: StubChatRequest) => { name: string; arguments: Record<string, unknown> } | undefined;
  };

  test.beforeAll(async ({ browser }) => {
    stub = await startStubProvider(apiKey, {
      reply: STUB_REPLY,
      toolCall: () => script.toolCall,
      followUp: (request) => script.followUp(request),
    });
    page = await browser.newPage();
    await signIn(page);

    const response = await page.request.post("/api/ai-providers", {
      data: {
        provider: "custom",
        apiKey,
        label,
        baseUrl: stub.baseUrl,
        modelIds: [STUB_MODEL],
      },
    });
    expect(response.status()).toBe(200);
    keyId = (await response.json()).keyId;
  });

  test.afterAll(async () => {
    const user = page && (await userConvexClient(page));
    if (keyId) {
      await user.mutation(api.aiProviders.remove, { keyId }).catch(() => {});
    }
    if (projectId) {
      await user.mutation(api.projects.remove, { id: projectId }).catch(() => {});
    }
    await page?.close();
    stub?.server.close();
  });

  /**
   * The warm Next preview's project, whose sandbox afterEach frees.
   * Earlier tests share `page` from beforeAll, so this stays unset for them.
   */
  let seeded: string | undefined;
  test.afterEach(async () => {
    if (!seeded) return;
    // Closed first, so the preview can't boot a replacement for the killed sandbox.
    await page.close();
    await killProjectSandboxes(seeded);
    seeded = undefined;
  });

  /** Runs one prompt in a fresh project on the stub model and opens its run block. */
  const runAgent = async (prompt: string) => {
    const user = await userConvexClient(page);
    if (projectId) {
      await user.mutation(api.projects.remove, { id: projectId }).catch(() => {});
    }
    projectId = await user.mutation(api.projects.create, {
      name: `e2e-check-build-${Date.now()}`,
    });

    await page.goto(`/projects/${projectId}?engine=webcontainer`);
    await sendPrompt(prompt);
  };

  /** Opens a new conversation on the stub model and sends `prompt`. */
  const sendPrompt = async (prompt: string) => {
    // The dev-tools badge covers the composer's bottom-left corner.
    await page.addStyleTag({ content: "nextjs-portal { display: none !important; }" });
    await page.getByRole("button", { name: "New conversation" }).click();
    await expect(page.getByText(EMPTY_CHAT_TITLE)).toBeVisible();

    const trigger = page.getByRole("combobox", { name: "Agent model" });
    await trigger.click();
    await page
      .getByRole("group", { name: new RegExp(label) })
      .getByRole("option", { name: STUB_MODEL })
      .click();
    await expect(trigger).toHaveText(STUB_MODEL);

    const input = page.getByPlaceholder("Describe a change or ask a question…");
    await input.fill(prompt);
    await input.press("Enter");
  };

  const openRunBlock = async () => {
    // A finished run block collapses itself shortly after the run ends; a
    // click before that would close it instead of opening it.
    const runBlock = page.getByRole("button", { name: /Worked/ }).last();
    await expect(runBlock).toHaveAttribute("aria-expanded", "false");
    await runBlock.click();
    await expect(runBlock).toHaveAttribute("aria-expanded", "true");
  };

  test("a run that ends without checking is routed back, shows the failed check, and says the build still fails", async () => {
    test.setTimeout(180_000);
    const errors = collectConsoleErrors(page);
    script = {
      toolCall: {
        name: "createFiles",
        arguments: {
          parentId: "",
          files: [{ name: "main.ts", content: 'import { start } from "./missing";\nstart();\n' }],
        },
      },
      // Answers the gate's first note, and not the fix notes after it.
      followUp: (request) => {
        const last = request.messages.at(-1);
        return last?.role === "user" && String(last.content).includes("Run checkBuild")
          ? { name: "checkBuild", arguments: {} }
          : undefined;
      },
    };
    const before = stub.requests.length;

    await runAgent("Add an entry point");
    await expect(page.getByText(STUB_REPLY)).toBeVisible({ timeout: 120_000 });
    await openRunBlock();
    await test.info().attach("run-block", { body: await page.screenshot(), contentType: "image/png" });

    await expect(page.getByText("Checked build")).toBeVisible();
    await expect(page.getByText(/Static checks failed/)).toBeVisible();
    await expect(page.getByText(/The build still has errors after the fix attempts/)).toBeVisible();

    // createFiles, the first reply, the routed-back turn's checkBuild, then a
    // reply to it and to each fix note: three forced turns, no more.
    const coding = stub.requests.slice(before).filter((request) => request.tools?.length);
    expect(coding).toHaveLength(6);
    // One check: the stub answers only the first note, not the fix notes.
    expect(checkBuildCalls(coding.at(-1)!)).toBe(1);
    expect(errors.filter((error) => !error.includes("webcontainer-api.io"))).toEqual([]);
  });

  test("a scaffolded Vite app builds in a real sandbox, which is killed afterwards", async () => {
    test.skip(!process.env.E2B_API_KEY, "Needs E2B_API_KEY (boots a real sandbox)");
    test.setTimeout(420_000);
    script = {
      toolCall: { name: "scaffoldViteApp", arguments: {} },
      followUp: (request) =>
        calledCheckBuild(request) ? undefined : { name: "checkBuild", arguments: {} },
    };

    await runAgent("Start a Vite app");
    // The first-build panel repeats the live label as "Checking build…".
    await expect(page.getByText("Checking build", { exact: true })).toBeVisible({ timeout: 120_000 });
    const started = Date.now();
    await expect(page.getByText(STUB_REPLY)).toBeVisible({ timeout: 300_000 });
    test.info().annotations.push({
      type: "check-build-ms",
      description: String(Date.now() - started),
    });
    await openRunBlock();
    await test.info().attach("run-block", { body: await page.screenshot(), contentType: "image/png" });
    await expect(page.getByText("Build verified")).toBeVisible();

    const running = await Sandbox.list({
      apiKey: process.env.E2B_API_KEY,
      query: { metadata: { projectId: projectId!, purpose: "check-build" } },
    }).nextItems();
    expect(running).toEqual([]);
  });

  test("a Next.js checkBuild leaves the live preview serving", async () => {
    test.skip(
      !process.env.E2B_API_KEY || !hasPreviewFixtureEnv(),
      "Needs E2B_API_KEY and the Convex fixture env (boots a real preview sandbox)",
    );
    test.setTimeout(600_000);
    script = { toolCall: { name: "checkBuild", arguments: {} }, followUp: () => undefined };

    const user = await userConvexClient(page);
    if (projectId) await user.mutation(api.projects.remove, { id: projectId }).catch(() => {});
    // No project variables, so only the framework keeps checkBuild out of this preview's sandbox.
    projectId = await seedPreviewProject(page, "e2e-check-build-next-warm");
    seeded = projectId;
    await seedNextApp(projectId, {
      pageSource: "export default function Page() { return <h1>Next preview before checkBuild</h1>; }\n",
    });
    await page.goto(`/projects/${projectId}`);
    await page.getByRole("tab", { name: "Preview" }).click();
    const preview = page.frameLocator('iframe[title="Preview"]');
    await expect(preview.getByRole("heading", { name: "Next preview before checkBuild" })).toBeVisible({
      timeout: 240_000,
    });
    const previewUrl = new URL("/", page.frame({ url: /e2b\.app/ })!.url()).href;

    await sendPrompt("Check the build");
    await expect(page.getByText(STUB_REPLY)).toBeVisible({ timeout: 300_000 });
    await openRunBlock();
    await expect(page.getByText("Build verified")).toBeVisible();

    // A `next build` beside `next dev` got the dev server OOM-killed, and the proxy answered 502.
    await expect
      .poll(async () => (await page.request.get(previewUrl)).status(), { timeout: 90_000, intervals: [2_000] })
      .toBe(200);
  });
});
