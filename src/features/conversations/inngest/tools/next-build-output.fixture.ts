/**
 * `next build` (15.5, webpack) failures as checkBuild's sandbox sees them:
 * progress on stdout, the failure on stderr, colour codes and absolute paths left in.
 */
const PROGRESS =
  "   \u001b[1m\u001b[38;2;173;127;168m▲ Next.js 15.5.4\u001b[39m\u001b[22m\n\n" +
  "   Creating an optimized production build ...\n";

export const NEXT_TYPE_ERROR = {
  stdout:
    PROGRESS +
    " \u001b[32m✓\u001b[39m Compiled successfully in 4.2s\n" +
    "   Linting and checking validity of types ...\n",
  stderr:
    "\u001b[31mFailed to compile.\u001b[39m\n\n" +
    "./src/app/page.tsx:12:3\n" +
    "Type error: Type 'number' is not assignable to type 'string'.\n\n" +
    "  10 | export default function Page() {\n" +
    "  11 |   return (\n" +
    "> 12 |     <Hero title={42} />\n" +
    "     |     ^\n" +
    "  13 |   );\n" +
    "  14 | }\n" +
    "Next.js build worker exited with code: 1 and signal: null\n",
};

export const NEXT_MODULE_NOT_FOUND = {
  stdout: PROGRESS,
  stderr:
    "\u001b[31mFailed to compile.\u001b[39m\n\n" +
    "./src/app/page.tsx:3:1\n" +
    "Module not found: Can't resolve '@/components/Hero'\n\n" +
    "  1 | import Link from \"next/link\";\n" +
    "  2 |\n" +
    "> 3 | import Hero from \"@/components/Hero\";\n" +
    "    | ^\n\n" +
    "https://nextjs.org/docs/messages/module-not-found\n\n\n" +
    "> Build failed because of webpack errors\n",
};

export const NEXT_PRERENDER_ERROR = {
  stdout:
    PROGRESS +
    " \u001b[32m✓\u001b[39m Compiled successfully in 3.1s\n" +
    "   Linting and checking validity of types ...\n" +
    "   Collecting page data ...\n" +
    "   Generating static pages (0/5) ...\n" +
    "   Generating static pages (5/5)\n",
  stderr:
    "Error occurred prerendering page \"/\". Read more: https://nextjs.org/docs/messages/prerender-error\n" +
    "Error: STRIPE_SECRET_KEY is not set\n" +
    "    at /home/user/app/.next/server/app/page.js:1:2345\n" +
    "    at Object.<anonymous> (/home/user/app/.next/server/app/page.js:1:3012) {\n" +
    "  digest: '2771937183'\n" +
    "}\n" +
    "Export encountered an error on /page: /, exiting the build.\n" +
    " \u001b[31m⨯\u001b[39m Next.js build worker exited with code: 1 and signal: null\n",
};

/**
 * `next build` 16.4.6 (Turbopack) failures, captured 2026-11-15 from the Next starter: a type
 * error now prints in tsc form on stdout, and compile errors are prefixed "Error: ".
 */
export const NEXT16_TYPE_ERROR = {
  stdout:
    "\u001b[1m\u001b[38;2;173;127;168m▲ Next.js 16.4.6\u001b[39m\u001b[22m (Turbopack)\n" +
    "\u001b[32m\u001b[1m✓\u001b[22m\u001b[39m Running next.config.ts took 25ms\n" +
    "\n" +
    "\u001b[37m\u001b[1m \u001b[22m\u001b[39m Creating an optimized production build ...\n" +
    "\u001b[32m\u001b[1m✓\u001b[22m\u001b[39m Compiled successfully in 2.8s\n" +
    "\u001b[37m\u001b[1m \u001b[22m\u001b[39m Running TypeScript ...\n" +
    "src/app/page.tsx(8,13): error TS2322: Type 'number' is not assignable to type 'string'.\n",
  stderr:
    "\u001b[31mFailed to type check.\n" +
    "\u001b[39m\n",
};

export const NEXT16_MODULE_NOT_FOUND = {
  stdout:
    "\u001b[1m\u001b[38;2;173;127;168m▲ Next.js 16.4.6\u001b[39m\u001b[22m (Turbopack)\n" +
    "\u001b[32m\u001b[1m✓\u001b[22m\u001b[39m Running next.config.ts took 24ms\n" +
    "\n" +
    "\u001b[37m\u001b[1m \u001b[22m\u001b[39m Creating an optimized production build ...\n",
  stderr:
    "\n" +
    "> Build error occurred\n" +
    "Error: Turbopack build failed with 1 error:\n" +
    "./src/app/page.tsx:3:1\n" +
    "\u001b[1m\u001b[31mError\u001b[39m: \u001b[1m\u001b[31mModule not found\u001b[39m\u001b[22m\u001b[1m: Can't resolve \u001b[32m'@/components/Hero'\u001b[39m\u001b[22m\n" +
    "  \u001b[90m1 |\u001b[0m \u001b[36mimport\u001b[0m \u001b[33mLink\u001b[0m \u001b[36mfrom\u001b[0m \u001b[32m\"next/link\"\u001b[0m;\n" +
    "  \u001b[90m2 |\u001b[0m\n" +
    "\u001b[31m\u001b[1m>\u001b[0m \u001b[90m3 |\u001b[0m \u001b[36mimport\u001b[0m \u001b[33mHero\u001b[0m \u001b[36mfrom\u001b[0m \u001b[32m\"@/components/Hero\"\u001b[0m;\n" +
    "  \u001b[90m  |\u001b[0m \u001b[31m\u001b[1m^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^\u001b[0m\n" +
    "  \u001b[90m4 |\u001b[0m\n" +
    "  \u001b[90m5 |\u001b[0m \u001b[36mexport\u001b[0m \u001b[36mdefault\u001b[0m \u001b[36mfunction\u001b[0m \u001b[33mHome\u001b[0m() {\n" +
    "  \u001b[90m6 |\u001b[0m   \u001b[36mreturn\u001b[0m <main><\u001b[33mHero\u001b[0m /><\u001b[33mLink\u001b[0m href=\u001b[32m\"/\"\u001b[0m>\u001b[33mHome\u001b[0m<\u001b[35m/Link></main\u001b[0m>;\n" +
    "\n" +
    "Import map: aliased to relative './src/components/Hero' inside of [project]/\n" +
    "\n" +
    "\n" +
    "https://nextjs.org/docs/messages/module-not-found\n" +
    "\n" +
    "\n" +
    "    at <unknown> (https://nextjs.org/docs/messages/module-not-found)\n",
};

export const NEXT16_SYNTAX_ERROR = {
  stdout:
    "\u001b[1m\u001b[38;2;173;127;168m▲ Next.js 16.4.6\u001b[39m\u001b[22m (Turbopack)\n" +
    "\u001b[32m\u001b[1m✓\u001b[22m\u001b[39m Running next.config.ts took 25ms\n" +
    "\n" +
    "\u001b[37m\u001b[1m \u001b[22m\u001b[39m Creating an optimized production build ...\n",
  stderr:
    "\n" +
    "> Build error occurred\n" +
    "Error: Turbopack build failed with 1 error:\n" +
    "./src/app/page.tsx:6:3\n" +
    "\u001b[1m\u001b[31mError\u001b[39m: Expected ',', got ';'\u001b[22m\n" +
    "  \u001b[90m4 |\u001b[0m       <h1>\u001b[33mApp\u001b[0m</h1>\n" +
    "  \u001b[90m5 |\u001b[0m     </main>\n" +
    "\u001b[31m\u001b[1m>\u001b[0m \u001b[90m6 |\u001b[0m   ;\n" +
    "  \u001b[90m  |\u001b[0m   \u001b[31m\u001b[1m^\u001b[0m\n" +
    "  \u001b[90m7 |\u001b[0m }\n" +
    "  \u001b[90m8 |\u001b[0m\n" +
    "\n" +
    "Parsing ecmascript source code failed\n" +
    "\n" +
    "\n" +
    "    at \u001b[3mignore-listed frames\u001b[23m\n",
};

export const NEXT16_PRERENDER_ERROR = {
  stdout:
    "\u001b[1m\u001b[38;2;173;127;168m▲ Next.js 16.4.6\u001b[39m\u001b[22m (Turbopack)\n" +
    "\u001b[32m\u001b[1m✓\u001b[22m\u001b[39m Running next.config.ts took 24ms\n" +
    "\n" +
    "\u001b[37m\u001b[1m \u001b[22m\u001b[39m Creating an optimized production build ...\n" +
    "\u001b[32m\u001b[1m✓\u001b[22m\u001b[39m Compiled successfully in 2.2s\n" +
    "\u001b[37m\u001b[1m \u001b[22m\u001b[39m Running TypeScript ...\n" +
    "\u001b[37m\u001b[1m \u001b[22m\u001b[39m Finished TypeScript in 2.0s ...\n" +
    "\u001b[37m\u001b[1m \u001b[22m\u001b[39m Collecting page data using 4 workers ...\n" +
    "\u001b[37m\u001b[1m \u001b[22m\u001b[39m Generating static pages using 4 workers (0/3) ...\n",
  stderr:
    "Error occurred prerendering page \"/\". Read more: https://nextjs.org/docs/messages/prerender-error\n" +
    "Error: STRIPE_SECRET_KEY is not set\n" +
    "    at <unknown> (src/app/page.tsx:2:45)\n" +
    "  \u001b[90m1 |\u001b[0m \u001b[36mexport\u001b[0m \u001b[36mdefault\u001b[0m \u001b[36mfunction\u001b[0m \u001b[33mHome\u001b[0m() {\n" +
    "\u001b[31m\u001b[1m>\u001b[0m \u001b[90m2 |\u001b[0m   \u001b[36mif\u001b[0m (!process.env.\u001b[33mSTRIPE_SECRET_KEY\u001b[0m) \u001b[36mthrow\u001b[0m \u001b[36mnew\u001b[0m \u001b[33mError\u001b[0m(\u001b[32m\"STRIPE_SECRET_KEY is not set\"\u001b[0m);\n" +
    "  \u001b[90m  |\u001b[0m                                             \u001b[31m\u001b[1m^\u001b[0m\n" +
    "  \u001b[90m3 |\u001b[0m   \u001b[36mreturn\u001b[0m <main>ok</main>;\n" +
    "  \u001b[90m4 |\u001b[0m }\n" +
    "  \u001b[90m5 |\u001b[0m {\n" +
    "  digest: \u001b[32m'2835453256'\u001b[39m\n" +
    "}\n" +
    "Export encountered an error on /page: /, exiting the build.\n" +
    "\u001b[31m\u001b[1m⨯\u001b[22m\u001b[39m Next.js build worker exited with code: 1 and signal: null\n",
};
