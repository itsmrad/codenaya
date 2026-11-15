/** `next dev` 16.4.6 (Turbopack) terminal output, captured 2026-11-15 with colour codes. */

export const NEXT16_DEV_MODULE_NOT_FOUND =
  "\u001b[31m\u001b[1m⨯\u001b[22m\u001b[39m ./src/app/page.tsx:3:1\n" +
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
  "https://nextjs.org/docs/messages/module-not-found\n";

export const NEXT16_DEV_RENDER_ERROR =
  "\u001b[31m\u001b[1m⨯\u001b[22m\u001b[39m Error: STRIPE_SECRET_KEY is not set\n" +
  "    at Home (src/app/page.tsx:2:45)\n" +
  "  \u001b[90m1 |\u001b[0m \u001b[36mexport\u001b[0m \u001b[36mdefault\u001b[0m \u001b[36mfunction\u001b[0m \u001b[33mHome\u001b[0m() {\n" +
  "\u001b[31m\u001b[1m>\u001b[0m \u001b[90m2 |\u001b[0m   \u001b[36mif\u001b[0m (!process.env.\u001b[33mSTRIPE_SECRET_KEY\u001b[0m) \u001b[36mthrow\u001b[0m \u001b[36mnew\u001b[0m \u001b[33mError\u001b[0m(\u001b[32m\"STRIPE_SECRET_KEY is not set\"\u001b[0m);\n" +
  "  \u001b[90m  |\u001b[0m                                             \u001b[31m\u001b[1m^\u001b[0m\n" +
  "  \u001b[90m3 |\u001b[0m   \u001b[36mreturn\u001b[0m <main>ok</main>;\n" +
  "  \u001b[90m4 |\u001b[0m }\n";

export const NEXT16_DEV_SYNTAX_ERROR =
  "\u001b[31m\u001b[1m⨯\u001b[22m\u001b[39m ./src/app/page.tsx:6:3\n" +
  "\u001b[1m\u001b[31mError\u001b[39m: Expected ',', got ';'\u001b[22m\n" +
  "  \u001b[90m4 |\u001b[0m       <h1>\u001b[33mApp\u001b[0m</h1>\n" +
  "  \u001b[90m5 |\u001b[0m     </main>\n" +
  "\u001b[31m\u001b[1m>\u001b[0m \u001b[90m6 |\u001b[0m   ;\n" +
  "  \u001b[90m  |\u001b[0m   \u001b[31m\u001b[1m^\u001b[0m\n" +
  "  \u001b[90m7 |\u001b[0m }\n" +
  "  \u001b[90m8 |\u001b[0m\n" +
  "\n" +
  "Parsing ecmascript source code failed\n";

export const NEXT16_DEV_COMPILED =
  "\u001b[32m\u001b[1m✓\u001b[22m\u001b[39m Compiled in 84ms\n";
