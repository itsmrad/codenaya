/**
 * Vite 8.3.8 (Rolldown/Oxc) failures, captured from a real `vite build` and
 * `vite` dev server, colour codes left in, paths moved to the sandbox root,
 * stacks cut to two frames. Vite 6 projects still print the esbuild shapes.
 */
export const VITE8_BUILD_UNRESOLVED_IMPORT =
  "vite v8.3.8 building client environment for production...\n" +
  "transforming...\n" +
  "✓ 15 modules transformed.\n" +
  "✗ Build failed in 138ms\n" +
  "error during build:\n" +
  "Build failed with 1 error:\n" +
  "\n" +
  "\u001b[31m[UNRESOLVED_IMPORT] \u001b[0mCould not resolve './components/Missing' in src/App.tsx\n" +
  "   \u001b[38;5;246m╭\u001b[0m\u001b[38;5;246m─\u001b[0m\u001b[38;5;246m[\u001b[0m src/App.tsx:1:21 \u001b[38;5;246m]\u001b[0m\n" +
  "   \u001b[38;5;246m│\u001b[0m\n" +
  " \u001b[38;5;246m1 │\u001b[0m \u001b[38;5;249mi\u001b[0m\u001b[38;5;249mm\u001b[0m\u001b[38;5;249mp\u001b[0m\u001b[38;5;249mo\u001b[0m\u001b[38;5;249mr\u001b[0m\u001b[38;5;249mt\u001b[0m\u001b[38;5;249m \u001b[0m\u001b[38;5;249mM\u001b[0m\u001b[38;5;249mi\u001b[0m\u001b[38;5;249ms\u001b[0m\u001b[38;5;249ms\u001b[0m\u001b[38;5;249mi\u001b[0m\u001b[38;5;249mn\u001b[0m\u001b[38;5;249mg\u001b[0m\u001b[38;5;249m \u001b[0m\u001b[38;5;249mf\u001b[0m\u001b[38;5;249mr\u001b[0m\u001b[38;5;249mo\u001b[0m\u001b[38;5;249mm\u001b[0m\u001b[38;5;249m \u001b[0m\"./components/Missing\"\u001b[38;5;249m;\u001b[0m\n" +
  " \u001b[38;5;240m  │\u001b[0m                     ───────────┬──────────  \n" +
  " \u001b[38;5;240m  │\u001b[0m                                ╰──────────── Module not found.\n" +
  " \u001b[38;5;240m  │\u001b[0m \n" +
  " \u001b[38;5;240m  │\u001b[0m \u001b[38;5;115mHelp\u001b[0m: 'src/App.tsx' is imported by the following path:\n" +
  " \u001b[38;5;240m  │\u001b[0m         - src/App.tsx\n" +
  " \u001b[38;5;240m  │\u001b[0m         - src/main.tsx\n" +
  " \u001b[38;5;240m  │\u001b[0m         - index.html\n" +
  "\u001b[38;5;246m───╯\u001b[0m\n" +
  "\n" +
  "    at aggregateBindingErrorsIntoJsError (file:///home/user/app/node_modules/rolldown/dist/shared/error-CLo6EJKG.mjs:50:18)\n" +
  "    at unwrapBindingResult (file:///home/user/app/node_modules/rolldown/dist/shared/error-CLo6EJKG.mjs:20:128)\n";

export const VITE8_BUILD_SYNTAX_ERROR =
  "vite v8.3.8 building client environment for production...\n" +
  "transforming...\n" +
  "✓ 14 modules transformed.\n" +
  "✗ Build failed in 96ms\n" +
  "error during build:\n" +
  "Build failed with 1 error:\n" +
  "\n" +
  "\u001b[31m[builtin:vite-transform] \u001b[0mUnexpected token\n" +
  "   \u001b[38;5;246m╭\u001b[0m\u001b[38;5;246m─\u001b[0m\u001b[38;5;246m[\u001b[0m src/App.tsx:2:13 \u001b[38;5;246m]\u001b[0m\n" +
  "   \u001b[38;5;246m│\u001b[0m\n" +
  " \u001b[38;5;246m2 │\u001b[0m \u001b[38;5;249m \u001b[0m\u001b[38;5;249m \u001b[0m\u001b[38;5;249mc\u001b[0m\u001b[38;5;249mo\u001b[0m\u001b[38;5;249mn\u001b[0m\u001b[38;5;249ms\u001b[0m\u001b[38;5;249mt\u001b[0m\u001b[38;5;249m \u001b[0m\u001b[38;5;249mx\u001b[0m\u001b[38;5;249m \u001b[0m\u001b[38;5;249m=\u001b[0m\u001b[38;5;249m \u001b[0m;\n" +
  " \u001b[38;5;240m  │\u001b[0m             ┬  \n" +
  " \u001b[38;5;240m  │\u001b[0m             ╰── \n" +
  "\u001b[38;5;246m───╯\u001b[0m\n" +
  "\n" +
  "    at aggregateBindingErrorsIntoJsError (file:///home/user/app/node_modules/rolldown/dist/shared/error-CLo6EJKG.mjs:50:18)\n" +
  "    at unwrapBindingResult (file:///home/user/app/node_modules/rolldown/dist/shared/error-CLo6EJKG.mjs:20:128)\n";

export const VITE8_BUILD_JSX_ERROR =
  "vite v8.3.8 building client environment for production...\n" +
  "transforming...\n" +
  "✓ 14 modules transformed.\n" +
  "✗ Build failed in 93ms\n" +
  "error during build:\n" +
  "Build failed with 1 error:\n" +
  "\n" +
  "\u001b[31m[builtin:vite-transform] \u001b[0mExpected corresponding JSX closing tag for 'h1'.\n" +
  "   \u001b[38;5;246m╭\u001b[0m\u001b[38;5;246m─\u001b[0m\u001b[38;5;246m[\u001b[0m src/App.tsx:2:21 \u001b[38;5;246m]\u001b[0m\n" +
  "   \u001b[38;5;246m│\u001b[0m\n" +
  " \u001b[38;5;246m2 │\u001b[0m \u001b[38;5;249m \u001b[0m\u001b[38;5;249m \u001b[0m\u001b[38;5;249mr\u001b[0m\u001b[38;5;249me\u001b[0m\u001b[38;5;249mt\u001b[0m\u001b[38;5;249mu\u001b[0m\u001b[38;5;249mr\u001b[0m\u001b[38;5;249mn\u001b[0m\u001b[38;5;249m \u001b[0m\u001b[38;5;249m<\u001b[0mh1\u001b[38;5;249m>\u001b[0m\u001b[38;5;249mH\u001b[0m\u001b[38;5;249me\u001b[0m\u001b[38;5;249ml\u001b[0m\u001b[38;5;249ml\u001b[0m\u001b[38;5;249mo\u001b[0m\u001b[38;5;249m<\u001b[0m\u001b[38;5;249m/\u001b[0mh2\u001b[38;5;249m>\u001b[0m\u001b[38;5;249m;\u001b[0m\n" +
  " \u001b[38;5;240m  │\u001b[0m           ─┬        ─┬  \n" +
  " \u001b[38;5;240m  │\u001b[0m            ╰──────────── Opened here\n" +
  " \u001b[38;5;240m  │\u001b[0m                      │  \n" +
  " \u001b[38;5;240m  │\u001b[0m                      ╰── Expected `</h1>`\n" +
  "\u001b[38;5;246m───╯\u001b[0m\n" +
  "\n" +
  "    at aggregateBindingErrorsIntoJsError (file:///home/user/app/node_modules/rolldown/dist/shared/error-CLo6EJKG.mjs:50:18)\n" +
  "    at unwrapBindingResult (file:///home/user/app/node_modules/rolldown/dist/shared/error-CLo6EJKG.mjs:20:128)\n";

export const VITE8_DEV_SYNTAX_ERROR =
  "5:34:14 PM [vite] Internal server error: Transform failed with 1 error:\n" +
  "\n" +
  "\u001b[31m[PARSE_ERROR] \u001b[0mUnexpected token\n" +
  "   \u001b[38;5;246m╭\u001b[0m\u001b[38;5;246m─\u001b[0m\u001b[38;5;246m[\u001b[0m src/App.tsx:2:13 \u001b[38;5;246m]\u001b[0m\n" +
  "   \u001b[38;5;246m│\u001b[0m\n" +
  " \u001b[38;5;246m2 │\u001b[0m \u001b[38;5;249m \u001b[0m\u001b[38;5;249m \u001b[0m\u001b[38;5;249mc\u001b[0m\u001b[38;5;249mo\u001b[0m\u001b[38;5;249mn\u001b[0m\u001b[38;5;249ms\u001b[0m\u001b[38;5;249mt\u001b[0m\u001b[38;5;249m \u001b[0m\u001b[38;5;249mx\u001b[0m\u001b[38;5;249m \u001b[0m\u001b[38;5;249m=\u001b[0m\u001b[38;5;249m \u001b[0m;\n" +
  " \u001b[38;5;240m  │\u001b[0m             ┬  \n" +
  " \u001b[38;5;240m  │\u001b[0m             ╰── \n" +
  "\u001b[38;5;246m───╯\u001b[0m\n" +
  "\n" +
  "  Plugin: vite:oxc\n" +
  "  File: /home/user/app/src/App.tsx\n" +
  "      at transformWithOxc (file:///home/user/app/node_modules/vite/dist/node/chunks/node.js:7673:19)\n" +
  "      at TransformPluginContext.transform (file:///home/user/app/node_modules/vite/dist/node/chunks/node.js:7747:26)\n";

export const VITE8_DEV_UNRESOLVED_IMPORT =
  "5:34:12 PM [vite] Internal server error: Failed to resolve import \"./components/Missing\" from \"src/App.tsx\". Does the file exist?\n" +
  "  Plugin: vite:import-analysis\n" +
  "  File: /home/user/app/src/App.tsx:1:20\n" +
  "  1  |  import Missing from \"./components/Missing\";\n" +
  "     |                       ^\n" +
  "  2  |  var _jsxFileName = \"/tmp/claude-1000/-home-ubuntu--t3-worktrees-codenaya-feat-vite-8-starter/cdbb047b-a4b7-44e5-b407-...\n" +
  "  3  |  import { jsxDEV as _jsxDEV } from \"react/jsx-dev-runtime\";\n" +
  "      at TransformPluginContext._formatLog (file:///home/user/app/node_modules/vite/dist/node/chunks/node.js:8865:39)\n" +
  "      at TransformPluginContext.error (file:///home/user/app/node_modules/vite/dist/node/chunks/node.js:8862:14)\n";
