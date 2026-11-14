import { expect, test } from "@playwright/test";

import { EMPTY_CHAT_TITLE } from "./chat-fixtures";
import { hasClerkCredentials, signIn } from "./clerk-auth";

const projectId = process.env.E2E_PROJECT_ID;

test.describe("sending a chat message", () => {
  test.skip(
    !hasClerkCredentials() || !projectId,
    "Needs CLERK_SECRET_KEY, NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY and E2E_PROJECT_ID (a project owned by the e2e user)",
  );

  test("shows the message at once, sends it once, and keeps it if the send fails", async ({ page }) => {
    test.setTimeout(120_000);

    await signIn(page);
    await page.goto(`/projects/${projectId}?engine=webcontainer`);
    // The dev-tools badge covers the composer's bottom-left corner.
    await page.addStyleTag({ content: "nextjs-portal { display: none !important; }" });
    await page.getByRole("button", { name: "New conversation" }).click();
    await expect(page.getByText(EMPTY_CHAT_TITLE)).toBeVisible();

    // The send request stays open until the test answers it.
    let requests = 0;
    let respond!: (status: number) => void;
    await page.route("**/api/messages", async (route) => {
      requests += 1;
      const status = await new Promise<number>((resolve) => (respond = resolve));
      await route.fulfill({ status, json: { error: "Internal error" } });
    });

    const composer = page.getByPlaceholder("Describe a change or ask a question…");
    const send = page.getByRole("button", { name: "Send" });
    const prompt = `e2e instant send ${Date.now()}`;
    // getByText also matches the composer's text.
    const bubble = page.getByText(prompt).and(page.locator(":not(textarea)"));
    await composer.fill(prompt);
    await composer.press("Enter");

    // Before the server answers: the bubble shows and the composer clears.
    await expect(bubble).toBeVisible();
    await expect(composer).toHaveValue("");
    await expect(send).toBeDisabled();
    await expect.poll(() => requests).toBe(1);

    // Another Enter while the first send is in flight sends nothing.
    await composer.fill("a second message");
    await composer.press("Enter");
    await expect(composer).toHaveValue("a second message");
    expect(requests).toBe(1);
    await composer.fill("");

    // A failed send shows an error and gives the text back.
    respond(500);
    await expect(page.getByText("Message failed to send")).toBeVisible();
    await expect(composer).toHaveValue(prompt);
    await expect(bubble).toBeHidden();
    expect(requests).toBe(1);
  });
});
