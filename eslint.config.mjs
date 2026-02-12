import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";
import importPlugin from "eslint-plugin-import";

const eslintConfig = defineConfig([
	...nextVitals,
	...nextTs,
	// Override default ignores of eslint-config-next.
	{
		plugins: {
			import: importPlugin,
		},
		settings: {
			"import/resolver": {
				typescript: {
					project: "./tsconfig.json",
				},
			},
		},
	},
	globalIgnores([
		// Default ignores of eslint-config-next:
		".next/**",
		"out/**",
		"build/**",
		"next-env.d.ts",
	]),
]);

export default eslintConfig;
