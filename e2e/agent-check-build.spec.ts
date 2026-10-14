import { expect, test, type Page } from "@playwright/test";
import { Sandbox } from "e2b";

import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { hasClerkCredentials, signIn } from "./clerk-auth";
import { collectConsoleErrors } from "./console-errors";
import { userConvexClient } from "./convex-client";
import { STUB_MODEL, type StubChatRequest, startStubProvider } from "./stub-provider";

/**
 * The agent's checkBuild step (#226). A stub provider (see `stub-provider.ts`)
 * plays the model, so this needs the Inngest dev server serving this app, as
 * in `byok-agent-run.spec.ts`.
 */

const STUB_REPLY = "**What was built:** a page.";

const calledCheckBuild = (request: StubChatRequest) =>
  JSON.stringify(request.messages).includes('"name":"checkBuild"');

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

  test("a run that ends without checking is routed back once and shows the failed check", async () => {
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
      // Answers the gate's note, and only that.
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

    // createFiles, the first reply, the routed-back turn's checkBuild, the
    // final reply: one extra turn, no more.
    const coding = stub.requests.slice(before).filter((request) => request.tools?.length);
    expect(coding).toHaveLength(4);
    expect(coding.filter(calledCheckBuild)).toHaveLength(1);
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
    await expect(page.getByText("Checking build")).toBeVisible({ timeout: 120_000 });
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
});
