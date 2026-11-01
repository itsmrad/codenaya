import * as lucide from "lucide-react";
import ts from "typescript";
import {
  localCandidates, RESOLVE_SUFFIXES, stripComments, undeclaredPackages, unresolvedImports,
} from "./missing-references";

export type CheckFile = { path: string; content: string };
export type Finding = { checkId: string; message: string };
const ICONS = new Set(Object.keys(lucide));
const CANONICAL_ICONS = [...ICONS].filter((name) => /^[A-Z]/.test(name) && !/^(Lucide)|Icon$/.test(name));
const NAMED_IMPORT = /\bimport\s+(?:type\s+)?(?:[\w$]+\s*,\s*)?\{([^}]+)\}\s*from\s*["']([^"'\n]+)["']/g;
const names = (list: string) => list.split(",").map((part) => part.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0]).filter(Boolean);
const resolve = (from: string, specifier: string, paths: Set<string>) =>
  localCandidates(from, specifier)?.flatMap((candidate) => RESOLVE_SUFFIXES.map((suffix) => candidate + suffix)).find((path) => paths.has(path));

/** Only a unique one-character typo is safe enough to change without asking. */
const oneEdit = (a: string, b: string) => {
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0, j = 0, edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i++; j++; continue; }
    if (++edits > 1) return false;
    if (a.length >= b.length) i++;
    if (b.length >= a.length) j++;
  }
  return edits + (a.length - i) + (b.length - j) === 1;
};

export const rewriteIcons = (content: string) => {
  const rewrites: string[] = [];
  if (content.length > 100_000) return { content, rewrites };
  try {
    const source = ts.createSourceFile("icons.tsx", content, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const replacements: { start: number; end: number; text: string }[] = [];
    for (const statement of source.statements) {
      if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier) ||
          statement.moduleSpecifier.text !== "lucide-react") continue;
      const bindings = statement.importClause?.namedBindings;
      if (!bindings || !ts.isNamedImports(bindings)) continue;
      for (const specifier of bindings.elements) {
        const wanted = (specifier.propertyName ?? specifier.name).text;
        if (replacements.length >= 20 || ICONS.has(wanted) || wanted.length < 5) continue;
        const closest = CANONICAL_ICONS.filter((name) => oneEdit(name, wanted));
        if (closest.length !== 1) continue;
        const text = `${closest[0]} as ${specifier.name.text}`;
        rewrites.push(`${wanted} → ${text}`);
        replacements.push({ start: specifier.getStart(source), end: specifier.end, text });
      }
    }
    let rewritten = content;
    for (const replacement of replacements.reverse()) {
      rewritten = rewritten.slice(0, replacement.start) + replacement.text + rewritten.slice(replacement.end);
    }
    return { content: rewritten, rewrites };
  } catch {
    // Best-effort repair must never prevent saving the original content.
    return { content, rewrites: [] };
  }
};

/** Pure bounded checks. Conservative regexes skip uncertain barrel/CommonJS exports. */
export const projectChecks = (
  input: CheckFile[],
  paths = new Set(input.map((file) => file.path)),
  touched?: Set<string>,
): Finding[] => {
  if (input.length > 500 || input.some((f) => f.content.length > 100_000) ||
      input.reduce((sum, f) => sum + f.content.length, 0) > 2_000_000) {
    return [{ checkId: "limit", message: "Project checks not checked: snapshot exceeds 500 files, 100 KB/file or 2 MB total; use checkBuild." }];
  }
  try {
    const files = input.map((file) => ({ ...file, content: stripComments(file.content) }));
    const byPath = new Map(files.map((f) => [f.path, f]));
    const affected = files.filter((file) => !touched || touched.has("package.json") || touched.has(file.path) ||
      [...file.content.matchAll(/\b(?:from\s*|import\s*\(?\s*)["']([^"'\n]+)["']/g)].some(([, specifier]) => touched.has(resolve(file.path, specifier, paths) ?? "")));
    const pkg = JSON.parse(byPath.get("package.json")?.content ?? "{}");
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    const next = Boolean(deps.next);
    const findings: Finding[] = [];
    const add = (checkId: string, message: string) => { if (findings.length < 40) findings.push({ checkId, message: message.slice(0, 500) }); };
    for (const message of undeclaredPackages([...files.filter((f) => f.path.endsWith("package.json")), ...affected.filter((f) => !f.path.endsWith("package.json"))])) add("package", message);
    if (!next) for (const message of unresolvedImports(affected, paths)) add("import", message);
    if (next) add("framework", "Local imports and Tailwind drift not checked for Next.js projects.");
    const major = String(deps.tailwindcss ?? "").match(/^[~^]?(3|4)(?:\.|$)/)?.[1];
    for (const file of affected) {
      if (/\.[cm]?[jt]sx?$/.test(file.path)) for (const [, list, specifier] of file.content.matchAll(NAMED_IMPORT)) {
        for (const name of names(list)) {
          if (specifier === "lucide-react" && !ICONS.has(name)) add("icon", `${file.path}: lucide-react has no export "${name}" in the installed codenaya version.`);
          if (next) continue;
          const target = byPath.get(resolve(file.path, specifier, paths) ?? "");
          if (!target || /export\s*\*|module\.exports|exports\./.test(target.content) || !/\.[cm]?[jt]sx?$/.test(target.path)) continue;
          const exports = new Set([...target.content.matchAll(/\bexport\s+(?:declare\s+)?(?:async\s+)?(?:const|let|var|function|class|type|interface|enum)\s+(\w+)/g)].map((m) => m[1]));
          for (const [, block] of target.content.matchAll(/\bexport\s+(?:type\s+)?\{([^}]+)\}/g)) {
            for (const part of block.split(",")) exports.add(part.trim().replace(/^type\s+/, "").split(/\s+as\s+/).at(-1)!);
          }
          // Destructuring/multi-declarations aren't safely covered by the simple scan.
          if (/export\s+(?:const|let|var)\s*[{[]|export\s+(?:const|let|var)[^;\n]*,/.test(target.content)) continue;
          if (!exports.has(name)) add("export", `${file.path} imports { ${name} } from ${specifier} (no such export in ${target.path}).`);
        }
      }
      if (!next && /\.[cm]?[jt]sx?$/.test(file.path)) for (const [, specifier] of file.content.matchAll(/\bimport\s+[\w$]+(?:\s*,[^;]*?)?\s+from\s*["']([^"'\n]+)["']/g)) {
        const target = byPath.get(resolve(file.path, specifier, paths) ?? "");
        if (target && /\.[cm]?[jt]sx?$/.test(target.path) &&
            !/export\s*\*|module\.exports|exports\.|export\s+default|export\s*\{[^}]*\bdefault\b/.test(target.content)) {
          add("export", `${file.path}: ${specifier} has no default export.`);
        }
      }
      if (next || !major) continue;
      if (major === "4") {
        if (/(?:^|\/)tailwind\.config\.[cm]?[jt]s$/.test(file.path)) add("tailwind", `${file.path}: Tailwind v4 uses CSS configuration; migrate to @theme or load legacy config explicitly with @config.`);
        if (/\.css$/.test(file.path) && /@tailwind\s+(base|components|utilities)\b/.test(file.content)) add("tailwind", `${file.path}: replace v3 @tailwind directives with @import "tailwindcss" for v4.`);
        if (file.content.includes("tailwindcss-animate")) add("tailwind", `${file.path}: Tailwind v4: replace tailwindcss-animate with tw-animate-css, or load the legacy plugin with @plugin.`);
      } else if ((/\.css$/.test(file.path) && /@import\s+["']tailwindcss["']|@(theme|plugin|custom-variant)\b/.test(file.content)) || file.content.includes("@tailwindcss/vite")) {
        add("tailwind", `${file.path}: Tailwind v3 uses @tailwind base/components/utilities, tailwind.config plugins/theme and PostCSS; remove v4 directives and @tailwindcss/vite.`);
      }
    }
    return findings;
  } catch {
    return [{ checkId: "unavailable", message: "Project checks not checked: invalid package.json or unsupported snapshot." }];
  }
};

export const projectCheckNote = (findings: Finding[]) => findings.length
  ? `\nProject checks (content saved; fix findings before finishing):\n- ${findings.slice(0, 60).map((f) => `[${f.checkId}] ${f.message.slice(0, 500)}`).concat(findings.length > 60 ? ["More findings omitted; fix these and check again."] : []).join("\n- ")}` : "";
