// Native TypeScript on Node >=22.18; resolve this repo's extensionless imports.
import { registerHooks } from "node:module";

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
});
