import { readFile } from "node:fs/promises";

import { expect, test, type Page } from "@playwright/test";
import { ConvexHttpClient } from "convex/browser";
import JSZip from "jszip";

import { api } from "../convex/_generated/api";
import { hasClerkCredentials, signIn } from "./clerk-auth";
import { collectConsoleErrors } from "./console-errors";
import { userConvexClient } from "./convex-client";

const PROJECT_NAME = "e2e-download-zip";
const internalKey = process.env.CODENAYA_CONVEX_INTERNAL_KEY;
const convexUrl = process.env.NEXT_PUBLIC_CONVEX_URL;

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff]);

/**
 * Reuses (or creates) the e2e user's fixture project and replaces its files
 * with a known tree: nested text files, an empty folder and a binary file.
 */
const seedProject = async (page: Page) => {
  const user = await userConvexClient(page);
  const existing = (await user.query(api.projects.get, {})).find(
    (project) => project.name === PROJECT_NAME,
  );
  const projectId =
    existing?._id ?? (await user.mutation(api.projects.create, { name: PROJECT_NAME }));

  const system = new ConvexHttpClient(convexUrl!);
  const key = internalKey!;
  await system.mutation(api.system.cleanup, { internalKey: key, projectId });

  await system.mutation(api.system.createFile, {
    internalKey: key,
    projectId,
    name: "README.md",
    content: "# Download ZIP e2e",
  });
  const src = await system.mutation(api.system.createFolder, {
    internalKey: key,
    projectId,
    name: "src",
  });
  const components = await system.mutation(api.system.createFolder, {
    internalKey: key,
    projectId,
    name: "components",
    parentId: src,
  });
  await system.mutation(api.system.createFile, {
    internalKey: key,
    projectId,
    name: "button.tsx",
    content: "export const Button = () => null;",
    parentId: components,
  });
  await system.mutation(api.system.createFolder, {
    internalKey: key,
    projectId,
    name: "empty",
  });

  const uploadUrl = await system.mutation(api.system.generateUploadUrl, { internalKey: key });
  const upload = await fetch(uploadUrl, {
    method: "POST",
    headers: { "Content-Type": "image/png" },
    body: PNG_BYTES,
  });
  const { storageId } = await upload.json();
  await system.mutation(api.system.createBinaryFile, {
    internalKey: key,
    projectId,
    name: "logo.png",
    storageId,
    parentId: src,
  });

  return projectId;
};

test.describe("download project as ZIP", () => {
  test.skip(
    !hasClerkCredentials() || !internalKey || !convexUrl,
    "Needs CLERK_SECRET_KEY, NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY, NEXT_PUBLIC_CONVEX_URL and CODENAYA_CONVEX_INTERNAL_KEY",
  );

  test("downloads the project files with their folder structure", async ({ page }) => {
    test.setTimeout(180_000);
    const errors = collectConsoleErrors(page);

    await signIn(page);
    const projectId = await seedProject(page);

    await page.goto(`/projects/${projectId}?engine=webcontainer`);
    await page.getByRole("button", { name: "Export", exact: true }).click();

    const [download] = await Promise.all([
      page.waitForEvent("download"),
      page.getByRole("button", { name: "Download ZIP" }).click(),
    ]);
    expect(download.suggestedFilename()).toBe(`${PROJECT_NAME}.zip`);

    const zip = await JSZip.loadAsync(await readFile(await download.path()));
    expect(Object.keys(zip.files).sort()).toEqual([
      "README.md",
      "empty/",
      "src/",
      "src/components/",
      "src/components/button.tsx",
      "src/logo.png",
    ]);
    expect(await zip.file("src/components/button.tsx")!.async("string")).toBe(
      "export const Button = () => null;",
    );
    expect(await zip.file("src/logo.png")!.async("uint8array")).toEqual(PNG_BYTES);

    // The WebContainer preview iframe serves the generated app, not ours.
    expect(errors.filter((error) => !error.includes("webcontainer-api.io"))).toEqual([]);
  });
});
