import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";

import { expect, test, type Page } from "@playwright/test";

import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { hasClerkCredentials, signIn } from "./clerk-auth";
import { collectConsoleErrors } from "./console-errors";
import { userConvexClient } from "./convex-client";

/**
 * Agent runs on the user's own key (BYOK), end to end.
 *
 * A local OpenAI-compatible stub stands in for the provider, registered as a
 * custom key (`next dev` allows a localhost endpoint). Inference goes through
 * Inngest's `step.ai.infer`, so this needs the Inngest dev server serving this
 * app (`INNGEST_DEV` / `INNGEST_BASE_URL` pointing at it).
 */

const projectId = process.env.E2E_PROJECT_ID;
const STUB_MODEL = "stub-model";
const STUB_TITLE = "Stub chat title";
const STUB_REPLY = "Hello from your own key";

interface ChatRequest {
  model: string;
  tools?: unknown[];
  messages: Array<{ role: string }>;
}

const readJson = async (request: IncomingMessage) => {
  let body = "";
  for await (const chunk of request) body += chunk;
  return JSON.parse(body || "{}") as ChatRequest;
};

/**
 * Accepts one key until `reject()` is called. The coding agent first gets a
 * `listFiles` call (so the run block has a step to show), then a text reply;
 * the title agent (no tools) gets a fixed title.
 */
const startStubProvider = async (apiKey: string) => {
  let rejecting = false;
  const models: string[] = [];

  const server = createServer(async (request, response) => {
    const send = (status: number, body: unknown) => {
      response.writeHead(status, { "Content-Type": "application/json" });
      response.end(JSON.stringify(body));
    };

    if (rejecting || request.headers.authorization !== `Bearer ${apiKey}`) {
      return send(401, {
        error: { message: "Incorrect API key provided", code: "invalid_api_key" },
      });
    }
    if (request.method === "GET") {
      return send(200, { data: [{ id: STUB_MODEL }] });
    }

    const body = await readJson(request);
    models.push(body.model);
    const message = !body.tools?.length
      ? { role: "assistant", content: STUB_TITLE }
      : body.messages.some((m) => m.role === "tool")
        ? { role: "assistant", content: STUB_REPLY }
        : {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: `call_${Date.now()}`,
                type: "function",
                function: { name: "listFiles", arguments: "{}" },
              },
            ],
          };
    send(200, {
      id: "chatcmpl-stub",
      object: "chat.completion",
      model: body.model,
      choices: [
        {
          index: 0,
          message,
          finish_reason: message.content ? "stop" : "tool_calls",
        },
      ],
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    server,
    baseUrl: `http://127.0.0.1:${port}/v1`,
    models,
    reject: () => {
      rejecting = true;
    },
  };
};

test.describe.serial("agent runs on the user's own key", () => {
  test.skip(
    !hasClerkCredentials() || !projectId,
    "Needs CLERK_SECRET_KEY, NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY and E2E_PROJECT_ID (a project owned by the e2e user)",
  );

  const apiKey = `sk-e2e-byok-run-${Date.now()}-wxyz`;
  const label = `BYOK run ${Date.now()}`;
  let stub: Awaited<ReturnType<typeof startStubProvider>>;
  let page: Page;
  let keyId: Id<"aiProviderKeys">;

  const keyStatus = async () =>
    (await (await userConvexClient(page)).query(api.aiProviders.list, {})).find(
      (key) => key._id === keyId,
    )?.status;

  const openNewChat = async () => {
    await page.goto(`/projects/${projectId}?engine=webcontainer`);
    // The dev-tools badge covers the composer's bottom-left corner.
    await page.addStyleTag({ content: "nextjs-portal { display: none !important; }" });
    await page.getByRole("button", { name: "New conversation" }).click();
    await expect(page.getByText("What do you want to build?")).toBeVisible();
  };

  const sendPrompt = async (text: string) => {
    const input = page.getByPlaceholder("Describe a change or ask a question…");
    await input.fill(text);
    await input.press("Enter");
    await expect(page.getByText(text)).toBeVisible();
  };

  test.beforeAll(async ({ browser }) => {
    stub = await startStubProvider(apiKey);
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
    if (keyId) {
      await (await userConvexClient(page))
        .mutation(api.aiProviders.remove, { keyId })
        .catch(() => {});
    }
    await page?.close();
    stub?.server.close();
  });

  test("the switcher lists the key and a run uses it", async () => {
    test.setTimeout(180_000);
    const errors = collectConsoleErrors(page);
    await openNewChat();

    const trigger = page.getByRole("combobox", { name: "Agent model" });
    await trigger.click();
    await expect(page.getByRole("group", { name: "Codenaya" })).toBeVisible();
    const keyGroup = page.getByRole("group", { name: new RegExp(label) });
    await expect(keyGroup).toBeVisible();
    await keyGroup.getByRole("option", { name: STUB_MODEL }).click();
    await expect(trigger).toHaveText(STUB_MODEL);

    await sendPrompt(`byok e2e ${Date.now()}: list the files`);

    await expect(page.getByText(STUB_REPLY)).toBeVisible({ timeout: 120_000 });
    await expect(page.getByText(STUB_TITLE).first()).toBeVisible({ timeout: 30_000 });
    // The run block names the provider and model.
    await expect(page.getByText(new RegExp(`${label} · ${STUB_MODEL}`))).toBeVisible();
    expect(stub.models.length).toBeGreaterThan(0);
    expect(new Set(stub.models)).toEqual(new Set([STUB_MODEL]));

    expect(errors.filter((error) => !error.includes("webcontainer-api.io"))).toEqual([]);
  });

  test("a key the provider rejects ends the run with a link to settings", async () => {
    test.setTimeout(180_000);
    stub.reject();
    const calls = stub.models.length;
    await openNewChat();
    await expect(page.getByRole("combobox", { name: "Agent model" })).toHaveText(STUB_MODEL);

    await sendPrompt(`byok e2e rejected ${Date.now()}`);

    const link = page.getByRole("link", { name: "Settings → AI providers" }).last();
    await expect(link).toBeVisible({ timeout: 60_000 });
    await expect(link).toHaveAttribute("href", "/settings/ai-providers");
    await expect(page.getByRole("button", { name: "Stop" })).toHaveCount(0);
    // Marked invalid, and nothing fell back to the platform key.
    await expect.poll(keyStatus).toBe("invalid");
    expect(stub.models.length).toBe(calls);
  });

  test("an invalid key fails the next run straight away", async () => {
    test.setTimeout(120_000);
    await openNewChat();
    await sendPrompt(`byok e2e invalid ${Date.now()}`);

    const link = page.getByRole("link", { name: "Settings → AI providers" }).last();
    await expect(link).toBeVisible({ timeout: 60_000 });
    await expect(page.getByRole("button", { name: "Stop" })).toHaveCount(0);
  });
});
