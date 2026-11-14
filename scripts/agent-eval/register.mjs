// Run the harness's TypeScript (and the app/e2e modules it reuses) on Node.
// Native type stripping keeps `import { Doc }` from .d.ts-only Convex codegen,
// so transpile with the repo's TypeScript, which elides type-only imports.
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath } from "node:url";
import ts from "typescript";

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      if (error.code !== "ERR_MODULE_NOT_FOUND" || !specifier.startsWith(".")) throw error;
      try { return nextResolve(`${specifier}.js`, context); }
      catch { return nextResolve(`${specifier}.ts`, context); }
    }
  },
  load(url, context, nextLoad) {
    if (!url.endsWith(".ts") || url.includes("/node_modules/")) return nextLoad(url, context);
    const { outputText } = ts.transpileModule(readFileSync(fileURLToPath(url), "utf8"), {
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
      fileName: fileURLToPath(url),
    });
    return { format: "module", source: outputText, shortCircuit: true };
  },
});
