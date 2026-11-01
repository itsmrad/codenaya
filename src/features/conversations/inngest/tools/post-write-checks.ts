import { buildPathIndex } from "@/features/conversations/agent-steps";
import { projectChecks, projectCheckNote, rewriteIcons, type Finding } from "@/features/sandbox-preview/utils/project-checks";
import { convex } from "@/lib/convex-client";
import { api } from "../../../../../convex/_generated/api";
import type { Id } from "../../../../../convex/_generated/dataModel";

/** Bound registry metadata even when a package has thousands of historical releases. */
const boundedJson = async (response: Response) => {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("empty registry response");
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.length;
      if (bytes > 512_000) throw new Error("registry response too large");
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } finally {
    await reader.cancel();
  }
};

/** One cache per agent run, shared by all write tools. Public npm only, never credentials. */
export const createRegistryCheck = () => {
  const cache = new Map<string, Promise<Finding[]>>();
  let active = 0;
  return async (packages: string[]): Promise<Finding[]> => {
    const valid = [...new Set(packages)].filter((name) => name.length <= 214 && /^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i.test(name));
    const names = valid.slice(0, 4);
    // Four concurrent packages maximum; the whole batch shares a two-second deadline.
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2_000);
    try {
      return (await Promise.all(names.map((name) => {
        let pending = cache.get(name);
        if (!pending && active >= 4) return Promise.resolve([{ checkId: "registry", message: `${name}: registry busy; not checked.` }]);
        if (!pending && cache.size >= 100) return Promise.resolve([{ checkId: "registry", message: "Registry run limit reached; remaining packages not checked." }]);
        if (!pending) {
          active++;
          pending = (async (): Promise<Finding[]> => {
            try {
              const response = await fetch(`https://registry.npmjs.org/${encodeURIComponent(name)}`, { signal: controller.signal });
              if (response.status === 404) {
                await response.body?.cancel();
                return [{ checkId: "registry", message: `${name}: package does not exist on npm.` }];
              }
              if (!response.ok) {
                await response.body?.cancel();
                throw new Error("registry unavailable");
              }
              const metadata = await boundedJson(response);
              const downloads = await fetch(`https://api.npmjs.org/downloads/point/last-week/${encodeURIComponent(name)}`, { signal: controller.signal }).then(boundedJson);
              const fresh = Date.now() - Date.parse(metadata.time?.created) < 30 * 86_400_000;
              const small = typeof downloads.downloads === "number" && downloads.downloads < 1000;
              return fresh || small ? [{ checkId: "registry", message: `${name}: review this dependency (${fresh ? "created within 30 days" : "fewer than 1k weekly downloads"}).` }] : [];
            } catch {
              return [{ checkId: "registry", message: `${name}: registry unreachable or response too large; existence/reputation not checked.` }];
            } finally {
              active--;
            }
          })();
          if (cache.size < 100) cache.set(name, pending);
        }
        return pending;
      }))).flat().concat(valid.length > 4 ? [{ checkId: "registry", message: "Registry batch limit: only the first four undeclared packages checked." }] : []);
    } finally {
      clearTimeout(timeout);
    }
  };
};
export type RegistryCheck = ReturnType<typeof createRegistryCheck>;

/** Separate from the version-manifest hook (#331); all failures are advisory after saving. */
export const postWriteNote = async (
  internalKey: string,
  projectId: Id<"projects">,
  touchedIds: string[],
  registry: RegistryCheck,
  rewrites: string[] = [],
) => {
  if (!touchedIds.length) return "";
  try {
    const rows = await convex.query(api.system.getProjectFilesWithUrls, { internalKey, projectId });
    const pathOf = buildPathIndex(rows);
    const paths = new Set<string>();
    const touched = new Set<string>();
    const files = [];
    for (const row of rows) {
      const path = row.type === "file" ? pathOf(row._id) : undefined;
      if (!path) continue;
      paths.add(path);
      if (touchedIds.includes(row._id)) touched.add(path);
      if (typeof row.content === "string") files.push({ path, content: row.content });
    }
    const findings = projectChecks(files, paths, touched);
    const packages = findings.filter((f) => f.checkId === "package").map((f) => f.message.split(" (")[0]);
    findings.push(...await registry(packages));
    findings.unshift(...rewrites.map((message) => ({ checkId: "icon-rewrite", message })));
    return projectCheckNote(findings);
  } catch {
    return projectCheckNote([
      ...rewrites.map((message) => ({ checkId: "icon-rewrite", message })),
      { checkId: "unavailable", message: "Project checks unavailable; write succeeded. Use checkBuild before finishing." },
    ]);
  }
};

export { rewriteIcons };
