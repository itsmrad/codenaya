import { expect, test, type Page } from "@playwright/test";

import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { hasClerkCredentials, signIn } from "./clerk-auth";
import { collectConsoleErrors } from "./console-errors";
import { userConvexClient } from "./convex-client";
import { STUB_MODEL, startStubProvider, type StubChatRequest } from "./stub-provider";

/**
 * Plan mode (#120): with Plan on, the agent replies with a checklist and the
 * project is left alone; "Build this plan" then runs a build that writes files.
 *
 * The runs are real (Inngest + a local OpenAI-compatible stub on a BYOK key, as
 * in `byok-agent-run.spec.ts`), so this needs the Inngest dev server serving
 * this app. The stub tells the runs apart by their tools: a plan run is
 * offered no `createFiles`.
 */

const PLAN_ITEM = "Add a todo list page";
const PLAN = `A simple todo app.\n\n### Steps\n- [ ] ${PLAN_ITEM}\n- [ ] Keep todos in local state`;
const BUILD_REPLY = "Built the todo app";
const ADDED_FILE = "todo-app.tsx";
const WRITE_TOOLS = ["createFiles", "updateFile", "deleteFiles", "renameFile", "createFolder"];

const toolsOf = (request: StubChatRequest) =>
  (request.tools ?? []).map((tool) => tool.function.name);
const isBuild = (request: StubChatRequest) => toolsOf(request).includes("createFiles");

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
      reply: (request) => (isBuild(request) ? BUILD_REPLY : PLAN),
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
    await expect(page.getByText("What do you want to build?")).toBeVisible();

    const trigger = page.getByRole("combobox", { name: "Agent model" });
    await trigger.click();
    await page
      .getByRole("group", { name: new RegExp(label) })
      .getByRole("option", { name: STUB_MODEL })
      .click();
    await expect(trigger).toHaveText(STUB_MODEL);

    const planToggle = page.getByRole("button", { name: "Plan", exact: true });
    await planToggle.click();
    await expect(planToggle).toHaveAttribute("aria-pressed", "true");

    const input = page.getByPlaceholder("Describe a change or ask a question…");
    await input.fill("todo app");
    await input.press("Enter");

    // The plan renders as a checklist, and nothing was written.
    await expect(page.getByText(PLAN_ITEM)).toBeVisible({ timeout: 120_000 });
    await expect(page.getByRole("checkbox").first()).toBeVisible();
    const build = page.getByRole("button", { name: "Build this plan" });
    await expect(build).toBeVisible();
    await test.info().attach("plan-reply", {
      body: await page.screenshot(),
      contentType: "image/png",
    });
    expect(await fileNames()).toEqual([]);
    const planRequest = stub.requests.find((request) => request.tools?.length)!;
    expect(toolsOf(planRequest)).toContain("listFiles");
    for (const tool of WRITE_TOOLS) expect(toolsOf(planRequest)).not.toContain(tool);

    // Building sends the plan as a build message, which writes files.
    await build.click();
    await expect(page.getByText(BUILD_REPLY)).toBeVisible({ timeout: 120_000 });
    await expect.poll(fileNames, { timeout: 30_000 }).toContain(ADDED_FILE);
    await expect(planToggle).toHaveAttribute("aria-pressed", "false");
    expect(JSON.stringify(stub.requests.find(isBuild)?.messages)).toContain(PLAN_ITEM);
    await test.info().attach("build-reply", {
      body: await page.screenshot(),
      contentType: "image/png",
    });

    expect(errors.filter((error) => !error.includes("webcontainer-api.io"))).toEqual([]);
  });
});
