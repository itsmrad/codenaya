import { detectFramework } from "@/features/sandbox-preview/utils/framework";
import type { Sandbox } from "@/features/sandbox-preview/server/provider/types";
import { offlineFirstInstall, WORK_DIR } from "@/features/sandbox-preview/server/project-sandbox";

import { START_SERVER } from "./start-server";

type File = { path: string; data: string | ArrayBuffer };

/** Fixed commands only: owner dev/install commands never run on the public path. */
export async function startProductionSite(sandbox: Sandbox, files: File[], envs: Record<string, string>) {
  const pkgFile = files.find(file => file.path === "package.json");
  if (!pkgFile || typeof pkgFile.data !== "string") throw new Error("Missing package.json");
  const pkg = JSON.parse(pkgFile.data);
  const framework = detectFramework(files.map(file => file.path), pkg);
  if (!framework) throw new Error("Unsupported framework");
  await sandbox.run(`mkdir -p ${WORK_DIR}`);
  await sandbox.writeFiles(files.map(file => ({ ...file, path: `${WORK_DIR}/${file.path}` })));
  const options = { cwd: WORK_DIR, envs: { ...envs, NODE_ENV: "production", NODE_OPTIONS: "--max-old-space-size=640", GENERATE_SOURCEMAP: "false" }, timeoutMs: 240_000 };
  // Install dev dependencies needed by build, then run only a production entrypoint.
  const install = await sandbox.run(offlineFirstInstall("--no-audit --no-fund --include=dev"), options);
  if (install.exitCode) throw new Error("Install failed");
  if (framework === "next") {
    const config = files.find(file => /^next\.config\.[cm]?[jt]s$/.test(file.path));
    const original = config ? `codenaya-original.${config.path.split(".").pop()}` : null;
    if (config && original) await sandbox.writeFiles([{ path: `${WORK_DIR}/${original}`, data: config.data }]);
    if (config) await sandbox.run(`rm -- ${config.path}`, options);
    await sandbox.writeFiles([{ path: `${WORK_DIR}/next.config.${config?.path.endsWith("ts") ? "ts" : "mjs"}`, data:
      `// @ts-nocheck\n${original ? `import original from "./${original}";` : "const original = {};"}
export default async (phase, context) => {
  const config = typeof original === "function" ? await original(phase, context) : await original;
  return { ...config, productionBrowserSourceMaps: false, experimental: { ...config.experimental, serverSourceMaps: false } };
};` }]);
  }
  const build = await sandbox.run(framework === "next" ? "./node_modules/.bin/next build --webpack" : "./node_modules/.bin/vite build --sourcemap false", options);
  if (build.exitCode) throw new Error("Build failed");
  // Even a project config that opts into maps cannot expose them on the public server.
  const clean = await sandbox.run("find dist .next .output public -type f -name '*.map' -delete 2>/dev/null; test -d dist -o -d .next -o -d .output", options);
  if (clean.exitCode) throw new Error("Map cleanup failed");
  if (framework === "tanstack-start") await sandbox.writeFiles([{ path: "/home/user/codenaya-start.mjs", data: START_SERVER }]);
  const command = framework === "next" ? "./node_modules/.bin/next start --hostname 0.0.0.0 --port 3000" :
    framework === "tanstack-start" ? "if test -f .output/server/index.mjs; then PORT=3000 HOST=0.0.0.0 node .output/server/index.mjs; else node /home/user/codenaya-start.mjs; fi" :
      "./node_modules/.bin/vite preview --host 0.0.0.0 --port 3000 --strictPort";
  await sandbox.start(command, { cwd: WORK_DIR, envs: options.envs });
  const ready = await sandbox.run("for i in $(seq 1 60); do curl -fsS -o /dev/null http://127.0.0.1:3000 && exit 0; sleep 1; done; exit 1", { timeoutMs: 70_000 });
  if (ready.exitCode) throw new Error("Site did not start");
  return sandbox.previewUrl(3000);
}
