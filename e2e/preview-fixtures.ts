import type { Page } from "@playwright/test";
import { ConvexHttpClient } from "convex/browser";

import { api } from "../convex/_generated/api";
import { userConvexClient } from "./convex-client";

export const hasPreviewFixtureEnv = () =>
  Boolean(process.env.CODENAYA_CONVEX_INTERNAL_KEY && process.env.NEXT_PUBLIC_CONVEX_URL);

/** Reuses (or creates) the e2e user's fixture project; the preview needs a file to boot. */
export const seedPreviewProject = async (page: Page, name: string) => {
  const internalKey = process.env.CODENAYA_CONVEX_INTERNAL_KEY!;
  const user = await userConvexClient(page);
  const existing = (await user.query(api.projects.get, {})).find(
    (project) => project.name === name,
  );
  const projectId = existing?._id ?? (await user.mutation(api.projects.create, { name }));

  const system = new ConvexHttpClient(process.env.NEXT_PUBLIC_CONVEX_URL!);
  await system.mutation(api.system.cleanup, { internalKey, projectId });
  await system.mutation(api.system.createFile, {
    internalKey,
    projectId,
    name: "index.html",
    content: "<h1>Hello</h1>\n",
  });

  return projectId;
};
