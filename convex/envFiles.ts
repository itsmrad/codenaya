/** Example files meant to be committed and shared (the convention `security/scan-project.ts` also uses). */
const SHAREABLE_ENV_FILE = /^\.env\.(?:example|sample)$/;

/**
 * Whether a file name is a dotenv file that may hold secrets: `.env`,
 * `.env.*` and `*.env`, plus `.envrc` (direnv scripts export secrets too).
 * `.env.example` and `.env.sample` stay shareable. Case-insensitive, by name
 * only, so it applies at any depth. Used to keep them out of share links (#260).
 */
export const isSecretEnvFile = (name: string) => {
  const lower = name.toLowerCase();
  if (SHAREABLE_ENV_FILE.test(lower)) return false;
  return lower === ".envrc" || lower === ".env" || lower.startsWith(".env.") || lower.endsWith(".env");
};
