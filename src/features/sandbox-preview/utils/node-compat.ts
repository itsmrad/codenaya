/**
 * Vite 7 calls `crypto.hash`, which needs Node ^20.19 || >=22.12. On an older
 * Node it crashes at startup with a stack trace that doesn't name the cause,
 * so the sandbox checks before installing anything (#178).
 */

const parseNode = (version: string) => {
  const match = version.trim().match(/^v?(\d+)\.(\d+)/);
  return match ? { major: Number(match[1]), minor: Number(match[2]) } : null;
};

const supportsVite7 = ({ major, minor }: { major: number; minor: number }) =>
  (major === 20 && minor >= 19) || (major === 22 && minor >= 12) || major > 22;

/** The Vite major a package.json asks for, or null when it doesn't use Vite. */
const viteMajor = (packageJson: string): number | null => {
  let pkg: { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
  try {
    pkg = JSON.parse(packageJson);
  } catch {
    return null;
  }
  const range = pkg.devDependencies?.vite ?? pkg.dependencies?.vite;
  if (typeof range !== "string") return null;
  const digits = range.match(/\d+/);
  // "latest", "*" and similar resolve to the newest major.
  return digits ? Number(digits[0]) : Number.POSITIVE_INFINITY;
};

/**
 * Explains why `nodeVersion` (as printed by `node --version`) can't run the
 * project, or returns null when it can (or when we can't tell).
 */
export const nodeIncompatibility = (
  nodeVersion: string,
  packageJson: string | undefined,
): string | null => {
  const node = parseNode(nodeVersion);
  const vite = packageJson ? viteMajor(packageJson) : null;
  if (!node || vite === null || vite < 7 || supportsVite7(node)) return null;

  return (
    `This project uses Vite ${Number.isFinite(vite) ? vite : "7+"}, which needs ` +
    `Node 20.19+ or 22.12+, but the cloud sandbox has Node ${nodeVersion.trim()}. ` +
    `Ask the agent to switch to Vite 6 (with @vitejs/plugin-react 4), or set ` +
    `E2B_TEMPLATE to a Node 22 template (npm run e2b:template).`
  );
};
