import { Sandbox, type SandboxOpts } from "e2b";

/**
 * Sandbox setup shared by the preview route and the agent's checkBuild tool,
 * so both run a project in the same image, at the same path.
 */

/**
 * The base image ships Node 20.9, too old for Vite 7 (#178). E2B_TEMPLATE
 * points at the Node 22 template built by `npm run e2b:template`.
 */
export const SANDBOX_TEMPLATE = process.env.E2B_TEMPLATE?.trim() || "base";

/** Where project files are written inside the sandbox. */
export const WORK_DIR = "/home/user/app";

export type ProjectFile = { path: string; content: string };

export const createProjectSandbox = (
  opts: Pick<SandboxOpts, "apiKey" | "timeoutMs" | "metadata" | "network">,
) => Sandbox.create(SANDBOX_TEMPLATE, opts);

export const writeProjectFiles = async (sandbox: Sandbox, files: ProjectFile[]) => {
  await sandbox.files.makeDir(WORK_DIR);
  for (const file of files) {
    await sandbox.files.write(`${WORK_DIR}/${file.path}`, file.content);
  }
};
