/**
 * `vite build && tsc --noEmit` failures for a TanStack Start project as checkBuild's sandbox sees them.
 * Modelled on Vite 7's output and tsc's, not captured from a real run: the client and server
 * builds each print their progress and asset table, Vite's failure goes to stderr, tsc's to stdout.
 */
const CLIENT_BUILD =
  "\u001b[36mvite v7.1.5 \u001b[32mbuilding client environment for production...\u001b[39m\n" +
  "transforming...\n" +
  "\u001b[32m✓\u001b[39m 214 modules transformed.\n" +
  "rendering chunks...\n" +
  "computing gzip size...\n" +
  "dist/client/assets/main-Bx3k9Qd1.js   231.07 kB │ gzip: 74.12 kB\n" +
  "\u001b[32m✓ built in 2.31s\u001b[39m\n";

const SERVER_BUILD =
  "\u001b[36mvite v7.1.5 \u001b[32mbuilding SSR bundle for production...\u001b[39m\n" +
  "transforming...\n" +
  "\u001b[32m✓\u001b[39m 96 modules transformed.\n" +
  "rendering chunks...\n" +
  "dist/server/assets/router-Cq8vL2aa.js   18.44 kB\n" +
  "\u001b[32m✓ built in 1.02s\u001b[39m\n";

/** The build passed and generated src/routeTree.gen.ts; tsc then fails. */
export const START_TYPE_ERROR = {
  stdout:
    CLIENT_BUILD +
    SERVER_BUILD +
    "/home/user/app/src/routes/index.tsx(12,17): error TS2322: Type 'number' is not assignable to type 'string'.\n",
  stderr: "",
};

/** `vite build` itself fails: the client build stops, so no server build runs. */
export const START_BUILD_ERROR = {
  stdout:
    "\u001b[36mvite v7.1.5 \u001b[32mbuilding client environment for production...\u001b[39m\n" +
    "transforming...\n",
  stderr:
    "\u001b[31m✗\u001b[39m Build failed in 412ms\n" +
    "\u001b[31merror during build:\u001b[39m\n" +
    '[vite]: Rollup failed to resolve import "@/components/Hero" from "/home/user/app/src/routes/index.tsx".\n' +
    "This is most likely unintended because it can break your application at runtime.\n",
};
