import { expect, test, type Page } from "@playwright/test";

import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { EMPTY_CHAT_TITLE } from "./chat-fixtures";
import { hasClerkCredentials, signIn } from "./clerk-auth";
import { collectConsoleErrors } from "./console-errors";
import { userConvexClient } from "./convex-client";
import { STUB_MODEL, type StubChatRequest, startStubProvider, stubRole, systemPrompt } from "./stub-provider";

/**
 * A whole swarm run (ADR 0013) on a stubbed BYOK key: the orchestrator
 * delegates two pages, each worker writes its own file, and the orchestrator
 * checks the build and replies. Needs the Inngest dev server serving this app,
 * as in `byok-agent-run.spec.ts`.
 */

const PROMPT = "Build a pizzeria site with home and menu pages";
const TASKS = [
  { id: "home", title: "Home page", path: "src/pages/home.ts" },
  { id: "menu", title: "Menu page", path: "src/pages/menu.ts" },
];
const ORCHESTRATOR_REPLY = "The pizzeria site is ready.";
const AGENT_REPLY = "Listed the files.";

const DELEGATE = {
  name: "delegateTasks",
  arguments: {
    tasks: TASKS.map(({ id, title, path }) => ({ id, title, brief: `Build the ${title.toLowerCase()}.`, ownedPaths: [path] })),
  },
};

/** The worker's own task section of its system prompt (see `swarm-worker.ts`). */
const ownedPath = (request: StubChatRequest) =>
  systemPrompt(request).match(/## Your task: .+\nOwned paths: (.+)/)?.[1] ?? "";

const calledCheckBuild = (request: StubChatRequest) =>
  JSON.stringify(request.messages).includes('"name":"checkBuild"');

test.describe.serial("agent swarm run", () => {
  test.skip(!hasClerkCredentials(), "Needs CLERK_SECRET_KEY and NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY");

  const apiKey = `sk-e2e-swarm-${Date.now()}-wxyz`;
  const label = `Swarm ${Date.now()}`;
  let stub: Awaited<ReturnType<typeof startStubProvider>>;
  let page: Page;
  let keyId: Id<"aiProviderKeys"> | undefined;
  let projectId: Id<"projects"> | undefined;
  /** Set by the cancel test: workers' model calls wait on it. */
  let workerGate: Promise<void> | undefined;

  test.beforeAll(async ({ browser }) => {
    stub = await startStubProvider(apiKey, {
      toolCall: (request) => {
        const role = stubRole(request);
        if (role === "orchestrator") return DELEGATE;
        if (role === "worker") {
          const path = ownedPath(request);
          return { name: "writeFiles", arguments: { files: [{ path, content: `export const page = "${path}";\n` }] } };
        }
        return { name: "listFiles", arguments: {} };
      },
      // The orchestrator checks the build once after delegating; the rest reply.
      followUp: (request) =>
        stubRole(request) === "orchestrator" && !calledCheckBuild(request) ? { name: "checkBuild", arguments: {} } : undefined,
      reply: (request) => {
        const role = stubRole(request);
        return role === "worker" ? `Wrote ${ownedPath(request)}.` : role === "orchestrator" ? ORCHESTRATOR_REPLY : AGENT_REPLY;
      },
      hold: (request) => (stubRole(request) === "worker" ? workerGate : undefined),
    });
    page = await browser.newPage();
    await signIn(page);
    projectId = await (await userConvexClient(page)).mutation(api.projects.create, { name: `e2e-swarm-${Date.now()}` });

    const response = await page.request.post("/api/ai-providers", {
      data: { provider: "custom", apiKey, label, baseUrl: stub.baseUrl, modelIds: [STUB_MODEL] },
    });
    expect(response.status()).toBe(200);
    keyId = (await response.json()).keyId;
  });

  test.afterAll(async () => {
    const user = page && (await userConvexClient(page));
    if (keyId) await user.mutation(api.aiProviders.remove, { keyId }).catch(() => {});
    if (projectId) await user.mutation(api.projects.remove, { id: projectId }).catch(() => {});
    await page?.close();
    stub?.server.close();
  });

  /** Opens a new conversation, picks the stub model and Swarm, and sends the prompt; resolves to the send's body. */
  const sendSwarm = async () => {
    await page.goto(`/projects/${projectId}?engine=webcontainer`);
    // The dev-tools badge covers the composer's bottom-left corner.
    await page.addStyleTag({ content: "nextjs-portal { display: none !important; }" });
    await page.getByRole("button", { name: "New conversation" }).click();
    await expect(page.getByText(EMPTY_CHAT_TITLE)).toBeVisible();

    const trigger = page.getByRole("combobox", { name: "Agent model" });
    await trigger.click();
    await page.getByRole("group", { name: new RegExp(label) }).getByRole("option", { name: STUB_MODEL }).click();
    await expect(trigger).toHaveText(STUB_MODEL);
    const modes = page.getByRole("radiogroup", { name: "Message mode" });
    await modes.getByRole("radio", { name: "Swarm" }).click();
    await expect(modes.getByRole("radio", { name: "Swarm" })).toBeChecked();

    const sent = page.waitForRequest((request) => request.url().endsWith("/api/messages") && request.method() === "POST");
    const input = page.getByPlaceholder("Describe a change or ask a question…");
    await input.fill(PROMPT);
    await input.press("Enter");
    return (await sent).postDataJSON() as { conversationId: string; model: unknown; mode: string };
  };

  const board = () => page.getByRole("region", { name: "Swarm board" }).last();
  const row = (name: string) => board().getByRole("button", { name });

  test("the orchestrator delegates two pages and both workers finish with their files", async () => {
    test.setTimeout(240_000);
    const errors = collectConsoleErrors(page);
    expect((await sendSwarm()).mode).toBe("swarm");

    await expect(page.getByText(ORCHESTRATOR_REPLY)).toBeVisible({ timeout: 180_000 });
    await expect(row("Orchestrator: Coordinate the build, Done")).toBeVisible();
    for (const { title, path } of TASKS) {
      const worker = row(`Worker: ${title}, Done`);
      await expect(worker).toBeVisible();
      await expect(worker).toContainText(path);
    }
    await expect(board().getByText(/^Swarm · 2 workers · \d+:\d\d · 2 done$/)).toBeVisible();

    // Both files landed in the one file tree.
    await page.getByRole("button", { name: "src", exact: true }).click();
    await page.getByRole("button", { name: "pages", exact: true }).click();
    for (const { path } of TASKS) {
      await expect(page.getByText(path.split("/").at(-1)!, { exact: true })).toBeVisible();
    }
    expect(errors.filter((error) => !error.includes("webcontainer-api.io"))).toEqual([]);
  });

  test("a new message cancels a running swarm", async () => {
    test.setTimeout(240_000);
    let release!: () => void;
    workerGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      const { conversationId, model } = await sendSwarm();
      for (const { title } of TASKS) {
        await expect(row(`Worker: ${title}, Running`)).toBeVisible({ timeout: 120_000 });
      }

      // The composer is disabled mid-run, so this posts the next message the way it sends one.
      const next = `swarm e2e follow-up ${Date.now()}`;
      const response = await page.request.post("/api/messages", { data: { conversationId, message: next, model } });
      expect(response.ok()).toBe(true);

      await expect(row("Orchestrator: Coordinate the build, Cancelled")).toBeVisible({ timeout: 60_000 });
      for (const { title } of TASKS) {
        await expect(row(`Worker: ${title}, Cancelled`)).toBeVisible();
      }
      // The new message runs as a normal build.
      await expect(page.getByText(AGENT_REPLY)).toBeVisible({ timeout: 120_000 });
    } finally {
      workerGate = undefined;
      release();
    }
  });

  // ponytail: the kill switch (`SWARM_ENABLED`) is a Convex env var the e2e run can't flip; unit tests cover it.
  test.skip("the Swarm toggle is hidden when SWARM_ENABLED is off", () => {});
});
