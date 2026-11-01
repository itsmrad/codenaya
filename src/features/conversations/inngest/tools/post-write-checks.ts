import { buildPathIndex } from "@/features/conversations/agent-steps";
import { projectChecks, projectCheckNote, rewriteIcons, type Finding } from "@/features/sandbox-preview/utils/project-checks";
import { convex } from "@/lib/convex-client";
import { api } from "../../../../../convex/_generated/api";
import type { Id } from "../../../../../convex/_generated/dataModel";

/** Bound the small downloads response too; no package metadata is downloaded. */
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

/** Shared within one Inngest invocation; replayed steps retain their saved results. */
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
            let exists = false;
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
              exists = true;
              // Status alone decides existence; never download a full packument.
              await response.body?.cancel();
              const downloadsResponse = await fetch(`https://api.npmjs.org/downloads/point/last-week/${encodeURIComponent(name)}`, { signal: controller.signal });
              if (!downloadsResponse.ok) {
                await downloadsResponse.body?.cancel();
                return [{ checkId: "registry", message: `${name}: exists on npm; download reputation not checked.` }];
              }
              const downloads = await boundedJson(downloadsResponse);
              const small = typeof downloads.downloads === "number" && downloads.downloads < 1000;
              return small ? [{ checkId: "registry", message: `${name}: review this dependency (fewer than 1k weekly downloads).` }] : [];
            } catch {
              return [{ checkId: "registry", message: exists ? `${name}: exists on npm; download reputation not checked (registry unreachable or response too large).` : `${name}: registry unreachable; existence/reputation not checked.` }];
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

/** Read the project range before any repair; a batch's new manifest takes precedence. */
export const getIconRewriter = async (
  internalKey: string,
  projectId: Id<"projects">,
  pending: { path: string; content: string }[] = [],
) => {
  let range: unknown;
  try {
    let manifest = pending.find((file) => file.path === "package.json")?.content;
    if (manifest === undefined) {
      const rows = await convex.query(api.system.getProjectFilesWithUrls, { internalKey, projectId });
      manifest = rows.find((row) => row.type === "file" && !row.parentId && row.name === "package.json")?.content;
    }
    const pkg = JSON.parse(manifest ?? "{}");
    range = pkg?.dependencies?.["lucide-react"] ?? pkg?.devDependencies?.["lucide-react"];
  } catch {
    // Unknown ranges skip repairs, including a failed best-effort manifest read.
  }
  return (content: string) => rewriteIcons(content, range);
};

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
      if (typeof row.content === "string" && row.content.length <= 100_000) files.push({ path, content: row.content });
    }
    const findings = projectChecks(files, paths, touched);
    const packages = findings.filter((f) => f.checkId === "package").map((f) => f.message.split(" (")[0]);
    findings.push(...await registry(packages));
    findings.unshift(...rewrites.map((message) => ({ checkId: "icon-rewrite", message })));
    return projectCheckNote(findings);
  } catch {
    // No formatting or further diagnostics here: the write has already committed.
    return "\nProject checks (content saved):\n- [unavailable] Project checks unavailable; write succeeded. Use checkBuild before finishing.";
  }
};
