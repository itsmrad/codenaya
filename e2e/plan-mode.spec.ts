import { expect, test, type Page } from "@playwright/test";

import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { EMPTY_CHAT_TITLE } from "./chat-fixtures";
import { hasClerkCredentials, signIn } from "./clerk-auth";
import { collectConsoleErrors } from "./console-errors";
import { userConvexClient } from "./convex-client";
import { STUB_MODEL, startStubProvider, type StubChatRequest } from "./stub-provider";

/**
 * Ask / Plan mode (#120, #311): with it on, the agent replies with a checklist
 * and the project is left alone; "Build this plan" then runs a build that
 * writes files. A question gets a plain answer, with nothing to build. The
 * plan can be edited before it is built (#527).
 *
 * The runs are real (Inngest + a local OpenAI-compatible stub on a BYOK key, as
 * in `byok-agent-run.spec.ts`), so this needs the Inngest dev server serving
 * this app. The stub tells the runs apart by their tools: a plan run is
 * offered no `createFiles`.
 */

const PLAN_ITEM = "Add a todo list page";
const PLAN = `A simple todo app.\n\n### Steps\n- [ ] ${PLAN_ITEM}\n- [ ] Keep todos in local state`;
const BUILD_REPLY = "Built the todo app";
const CHIP = "Save the todos in local storage";
// Follow-up chips (#256): the block is stored apart and never shown.
const BUILD_REPLY_WITH_CHIPS = `- ${BUILD_REPLY}\n\n<suggestions>\n${CHIP}\nAdd a footer\n</suggestions>`;
const ADDED_FILE = "todo-app.tsx";
const QUESTION = "what does useAuth do?";
const ANSWER = "useAuth returns the signed-in user";
const WRITE_TOOLS = ["writeFiles", "createFiles", "updateFile", "deleteFiles", "renameFile", "createFolder"];

const toolsOf = (request: StubChatRequest) =>
  (request.tools ?? []).map((tool) => tool.function.name);
const isBuild = (request: StubChatRequest) => toolsOf(request).includes("createFiles");
// The latest user message only: later runs carry the question in their history.
const isQuestion = (request: StubChatRequest) =>
  JSON.stringify(request.messages.filter((m) => m.role === "user").at(-1)?.content).includes(QUESTION);
const EDITED_ITEM = "Add a footer with a contact link";

test.describe.serial("plan mode", () => {
  test.skip(
    !hasClerkCredentials(),
    "Needs CLERK_SECRET_KEY and NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY",
  );

  const apiKey = `sk-e2e-plan-${Date.now()}-wxyz`;
  const label = `Plan run ${Date.now()}`;
  let stub: Awaited<ReturnType<typeof startStubProvider>>;
  let page: Page;
  let keyId: Id<"aiProviderKeys">;
  let projectId: Id<"projects">;

  const fileNames = async () =>
    (await (await userConvexClient(page)).query(api.files.getFiles, { projectId }))
      .map((file) => file.name);

  test.beforeAll(async ({ browser }) => {
    stub = await startStubProvider(apiKey, {
      reply: (request) => (isQuestion(request) ? ANSWER : isBuild(request) ? BUILD_REPLY_WITH_CHIPS : PLAN),
      toolCall: (request) =>
        isBuild(request)
          ? {
              name: "createFiles",
              arguments: { parentId: "", files: [{ name: ADDED_FILE, content: "export {};\n" }] },
            }
          : { name: "listFiles", arguments: {} },
    });
    page = await browser.newPage();
    await signIn(page);
    projectId = await (await userConvexClient(page)).mutation(api.projects.create, {
      name: `e2e-plan-mode-${Date.now()}`,
    });

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

  test("plans without writing files, then builds the plan", async () => {
    test.setTimeout(240_000);
    const errors = collectConsoleErrors(page);

    await page.goto(`/projects/${projectId}?engine=webcontainer`);
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

    const planToggle = page.getByRole("radio", { name: "Ask / Plan", exact: true });
    await planToggle.click();
    await expect(planToggle).toBeChecked();

    const input = page.getByPlaceholder("Describe a change or ask a question…");
    await input.fill("todo app");
    await input.press("Enter");

    // The plan renders as a checklist, and nothing was written.
    await expect(page.getByText(PLAN_ITEM)).toBeVisible({ timeout: 120_000 });
    // One checkbox per step, no bullet (#263). The boxes are aria-hidden, so
    // they are found by selector rather than by role.
    const step = page.locator(".task-list-item", { hasText: PLAN_ITEM });
    await expect(step.locator('input[type="checkbox"]')).toBeVisible();
    await expect(step.locator("xpath=..")).toHaveCSS("list-style-type", "none");
    const build = page.getByRole("button", { name: "Build this plan" });
    await expect(build).toBeVisible();
    await test.info().attach("plan-reply", {
      body: await page.screenshot(),
      contentType: "image/png",
    });
    expect(await fileNames()).toEqual([]);
    const planRequest = stub.requests.find((request) => request.tools?.length)!;
    expect(toolsOf(planRequest)).toContain("listFiles");
    expect(toolsOf(planRequest)).toContain("searchFiles");
    for (const tool of WRITE_TOOLS) expect(toolsOf(planRequest)).not.toContain(tool);

    // Building sends the plan as a build message, which writes files.
    await build.click();
    await expect(page.getByText(BUILD_REPLY)).toBeVisible({ timeout: 120_000 });
    await expect.poll(fileNames, { timeout: 30_000 }).toContain(ADDED_FILE);
    await expect(planToggle).not.toBeChecked();
    expect(JSON.stringify(stub.requests.find(isBuild)?.messages)).toContain(PLAN_ITEM);

    // The build reply ends with chips; one fills the composer without sending.
    const chip = page.getByRole("button", { name: CHIP });
    await expect(chip).toBeVisible();
    await expect(page.getByRole("button", { name: "Add a footer" })).toBeVisible();
    await expect(page.getByText("<suggestions>")).toHaveCount(0);
    const requestsBefore = stub.requests.length;
    await chip.click();
    const composer = page.getByPlaceholder("Describe a change or ask a question…");
    await expect(composer).toHaveValue(CHIP);
    await expect(composer).toBeFocused();
    expect(stub.requests.length).toBe(requestsBefore);
    await composer.fill("");
    await test.info().attach("build-reply", {
      body: await page.screenshot(),
      contentType: "image/png",
    });

    expect(errors.filter((error) => !error.includes("webcontainer-api.io"))).toEqual([]);
  });

  test("answers a question with nothing to build", async () => {
    test.setTimeout(180_000);
    const filesBefore = await fileNames();
    const toggle = page.getByRole("radio", { name: "Ask / Plan", exact: true });
    await toggle.click();
    await expect(toggle).toBeChecked();

    const input = page.getByPlaceholder("Describe a change or ask a question…");
    await input.fill(QUESTION);
    await input.press("Enter");

    await expect(page.getByText(ANSWER)).toBeVisible({ timeout: 120_000 });
    await expect(page.getByRole("button", { name: "Build this plan" })).toHaveCount(0);
    // Chips are only under the latest reply, and never under a plan-mode one.
    await expect(page.getByRole("button", { name: CHIP })).toHaveCount(0);
    await test.info().attach("answer-reply", {
      body: await page.screenshot(),
      contentType: "image/png",
    });
    const askRequest = stub.requests.find((request) => isQuestion(request) && request.tools?.length)!;
    for (const tool of WRITE_TOOLS) expect(toolsOf(askRequest)).not.toContain(tool);
    expect(await fileNames()).toEqual(filesBefore);
  });

  test("edits the plan before building it, on a phone-width panel", async () => {
    test.setTimeout(240_000);
    await page.setViewportSize({ width: 375, height: 740 });
    // Phones show the chat as a tab. The IDE reopens on the view saved on the
    // desktop, where the chat is a side panel (the editor), so pick Chat.
    const chatTab = page.getByRole("tablist", { name: "Workspace views" }).getByRole("tab", { name: "Chat" });
    await chatTab.click();
    await expect(chatTab).toHaveAttribute("aria-selected", "true");
    const input = page.getByPlaceholder("Describe a change or ask a question…");
    await input.fill("todo app with a footer");
    await input.press("Enter");
    const build = page.getByRole("button", { name: "Build this plan" });
    await expect(build).toBeVisible({ timeout: 120_000 });

    // Cancel leaves the plan as it was.
    const edit = page.getByRole("button", { name: "Edit plan" });
    await edit.click();
    const editor = page.getByRole("textbox", { name: "Edit plan" });
    await expect(editor).toHaveValue(PLAN);
    await editor.fill("thrown away");
    await page.getByRole("group", { name: "Plan editor" }).getByRole("button", { name: "Cancel" }).click();
    await expect(editor).toHaveCount(0);
    await expect(edit).toBeFocused();
    await expect(page.locator(".task-list-item", { hasText: PLAN_ITEM }).last()).toBeVisible();

    // An empty plan cannot be built.
    await edit.click();
    await editor.fill("  ");
    const buildEdited = page.getByRole("button", { name: "Build edited plan" });
    await expect(buildEdited).toBeDisabled();

    await editor.fill(`${PLAN}\n- [ ] ${EDITED_ITEM}`);
    await expect(buildEdited).toBeInViewport();
    await test.info().attach("plan-editor-375", {
      body: await page.screenshot(),
      contentType: "image/png",
    });
    const before = stub.requests.length;
    await buildEdited.click();

    // The edited plan is the user's message, and the build gets it.
    await expect(page.getByText(EDITED_ITEM)).toBeVisible();
    await expect(page.getByText(BUILD_REPLY).last()).toBeVisible({ timeout: 120_000 });
    const editedBuild = stub.requests.slice(before).find(isBuild);
    expect(JSON.stringify(editedBuild?.messages)).toContain(EDITED_ITEM);
  });
});
