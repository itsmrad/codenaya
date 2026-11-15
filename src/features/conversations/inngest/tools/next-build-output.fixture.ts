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
