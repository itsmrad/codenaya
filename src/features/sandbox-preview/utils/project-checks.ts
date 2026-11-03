// Generated from lucide-react@1.66.0 (the Vite starter), including type exports.
// Regenerate: node scripts/generate-lucide-exports.mjs 1.66.0
import lucideExports from "./lucide-exports.v1.json";
import ts from "typescript";
import {
  localCandidates, RESOLVE_SUFFIXES, stripComments, undeclaredPackages, unresolvedImports,
} from "./missing-references";

export type CheckFile = { path: string; content: string };
export type Finding = { checkId: string; message: string };
const ICON_FILE = /\.(?:[jt]sx?|[cm][jt]s|mdx)$/;
const ICONS = new Set(lucideExports);
const CANONICAL_ICONS = [...ICONS].filter((name) => /^[A-Z]/.test(name) && !/^(Lucide)|Icon$/.test(name));
const rangeMajor = (range: unknown) => typeof range === "string"
  ? range.match(/^[~^]?(\d+)(?:\.(?:\d+|x|\*)){0,2}(?:-[\w.-]+)?$/)?.[1] : undefined;
export const supportsIconCatalog = (range: unknown) => rangeMajor(range) === "1";
const parseSource = (file: CheckFile) => {
  const source = ts.createSourceFile(file.path, file.content, ts.ScriptTarget.Latest, true, file.path.endsWith(".mdx") ? ts.ScriptKind.TSX : undefined);
  const diagnostics = (source as ts.SourceFile & { parseDiagnostics?: readonly ts.Diagnostic[] }).parseDiagnostics;
  return diagnostics?.length ? undefined : source;
};
const exportedNames = (source: ts.SourceFile): Set<string> | undefined => {
  if (/module\.exports|exports\./.test(source.text)) return undefined;
  const names = new Set<string>();
  for (const statement of source.statements) {
    if (ts.isExportAssignment(statement)) {
      if (statement.isExportEquals) return undefined;
      names.add("default");
    } else if (ts.isExportDeclaration(statement)) {
      if (!statement.exportClause || !ts.isNamedExports(statement.exportClause)) return undefined;
      for (const entry of statement.exportClause.elements) names.add(entry.name.text);
    } else if (ts.canHaveModifiers(statement) && ts.getModifiers(statement)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) {
      if (ts.getModifiers(statement)?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword)) {
        names.add("default");
      } else if (ts.isVariableStatement(statement)) {
        for (const declaration of statement.declarationList.declarations) {
          if (!ts.isIdentifier(declaration.name)) return undefined;
          names.add(declaration.name.text);
        }
      } else if ("name" in statement && statement.name && ts.isIdentifier(statement.name as ts.Node)) {
        names.add((statement.name as ts.Identifier).text);
      } else {
        return undefined;
      }
    }
  }
  return names;
};
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

export const rewriteIcons = (content: string, lucideRange: unknown, path: string) => {
  const rewrites: string[] = [];
  if (!ICON_FILE.test(path) || !supportsIconCatalog(lucideRange) || content.length > 100_000) return { content, rewrites };
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
        const text = `${specifier.isTypeOnly ? "type " : ""}${closest[0]} as ${specifier.name.text}`;
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

/** Bounded advisory checks; oversized files and uncertain export targets are skipped. */
export const projectChecks = (
  input: CheckFile[],
  paths = new Set(input.map((file) => file.path)),
  touched?: Set<string>,
  { references = true } = {},
): Finding[] => {
  try {
    let bytes = 0;
    const files = [...input.filter((f) => f.path === "package.json"), ...input.filter((f) => f.path !== "package.json")]
      .filter((file) => {
        if (file.content.length > 100_000 || bytes + file.content.length > 2_000_000) return false;
        bytes += file.content.length;
        return true;
      }).slice(0, 500);
    const byPath = new Map(files.map((f) => [f.path, f]));
    const sources = new Map<string, ts.SourceFile | undefined>();
    const sourceOf = (file: CheckFile) => {
      if (!sources.has(file.path)) sources.set(file.path, parseSource(file));
      return sources.get(file.path);
    };
    const affected = files.filter((file) => !touched || touched.has("package.json") || touched.has(file.path) ||
      [...stripComments(file.content).matchAll(/\b(?:from\s*|import\s*\(?\s*)["']([^"'\n]+)["']/g)]
        .some(([, specifier]) => touched.has(resolve(file.path, specifier, paths) ?? "")));
    let deps: Record<string, unknown> = {};
    try {
      const pkg = JSON.parse(stripComments(byPath.get("package.json")?.content ?? "{}"));
      deps = { ...pkg?.dependencies, ...pkg?.devDependencies };
    } catch { /* Other checks still work without a valid manifest. */ }
    const next = Boolean(deps.next);
    const findings: Finding[] = [];
    const add = (checkId: string, message: string) => { if (findings.length < 40) findings.push({ checkId, message: message.slice(0, 500) }); };
    if (references) {
      for (const message of undeclaredPackages([...files.filter((f) => f.path.endsWith("package.json")), ...affected.filter((f) => !f.path.endsWith("package.json"))], paths)) add("package", message);
      if (!next) for (const message of unresolvedImports(affected, paths)) add("import", message);
    }
    const major = rangeMajor(deps.tailwindcss);
    const css = files.filter((f) => /\.css$/.test(f.path)).map((f) => stripComments(f.content));
    const legacyConfig = css.some((text) => /@config\s+["'][^"']+["']/.test(text));
    const legacyAnimate = css.some((text) => /@plugin\s+["']tailwindcss-animate["']/.test(text));
    for (const file of affected) {
      const source = ICON_FILE.test(file.path) ? sourceOf(file) : undefined;
      if (source) for (const statement of source.statements) {
        if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
        const specifier = statement.moduleSpecifier.text;
        const bindings = statement.importClause?.namedBindings;
        const imports = bindings && ts.isNamedImports(bindings)
          ? bindings.elements.map((entry) => (entry.propertyName ?? entry.name).text) : [];
        if (specifier === "lucide-react" && supportsIconCatalog(deps["lucide-react"])) {
          for (const name of imports) if (!ICONS.has(name)) add("icon", `${file.path}: lucide-react v1 has no export "${name}".`);
        }
        if (next) continue;
        const target = byPath.get(resolve(file.path, specifier, paths) ?? "");
        if (!target || !/\.[cm]?[jt]sx?$/.test(target.path)) continue;
        const targetSource = sourceOf(target);
        const exports = targetSource && exportedNames(targetSource);
        if (!exports) continue;
        for (const name of imports) if (!exports.has(name)) add("export", `${file.path} imports { ${name} } from ${specifier} (no such export in ${target.path}).`);
        if (statement.importClause?.name && !exports.has("default")) add("export", `${file.path}: ${specifier} has no default export.`);
      }
      if (next || !major) continue;
      const content = stripComments(file.content);
      if (major === "4") {
        if (!legacyConfig && /(?:^|\/)tailwind\.config\.[cm]?[jt]s$/.test(file.path)) add("tailwind", `${file.path}: Tailwind v4 uses CSS configuration; migrate to @theme or load legacy config explicitly with @config.`);
        if (/\.css$/.test(file.path) && /@tailwind\s+(base|components|utilities)\b/.test(content)) add("tailwind", `${file.path}: replace v3 @tailwind directives with @import "tailwindcss" for v4.`);
        if (!legacyAnimate && content.includes("tailwindcss-animate")) add("tailwind", `${file.path}: Tailwind v4: replace tailwindcss-animate with tw-animate-css, or load the legacy plugin with @plugin.`);
      } else if (major === "3" && ((/\.css$/.test(file.path) && /@import\s+["']tailwindcss["']|@(theme|plugin|custom-variant)\b/.test(content)) || content.includes("@tailwindcss/vite"))) {
        add("tailwind", `${file.path}: Tailwind v3 uses @tailwind base/components/utilities, tailwind.config plugins/theme and PostCSS; remove v4 directives and @tailwindcss/vite.`);
      }
    }
    return findings;
  } catch {
    return [];
  }
};

export const projectCheckNote = (findings: Finding[]) => findings.length
  ? `\nProject checks (content saved; fix findings before finishing):\n- ${findings.slice(0, 60).map((f) => `[${f.checkId}] ${f.message.slice(0, 500)}`).concat(findings.length > 60 ? ["More findings omitted; fix these and check again."] : []).join("\n- ")}` : "";
