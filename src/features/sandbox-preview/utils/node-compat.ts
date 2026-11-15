/**
 * Vite 7+ (the starter is on Vite 8) calls `crypto.hash`, which needs Node
 * ^20.19 || >=22.12. On an older Node it crashes at startup with a stack trace
 * that doesn't name the cause, so the sandbox checks before installing anything (#178).
 * TanStack Start needs Node >=22.12 whatever its Vite range says.
 */

const parseNode = (version: string) => {
  const match = version.trim().match(/^v?(\d+)\.(\d+)/);
  return match ? { major: Number(match[1]), minor: Number(match[2]) } : null;
};

type NodeVersion = { major: number; minor: number };
type PackageJson = { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };

const atLeast22_12 = ({ major, minor }: NodeVersion) => (major === 22 && minor >= 12) || major > 22;
const supportsVite7 = (node: NodeVersion) => (node.major === 20 && node.minor >= 19) || atLeast22_12(node);

const parsePackageJson = (packageJson: string): PackageJson | null => {
  try {
    return JSON.parse(packageJson);
  } catch {
    return null;
  }
};

/** The Vite major a package.json asks for, or null when it doesn't use Vite. */
const viteMajor = (pkg: PackageJson): number | null => {
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
  const pkg = packageJson ? parsePackageJson(packageJson) : null;
  if (!node || !pkg) return null;
  const sandbox = `but the cloud sandbox has Node ${nodeVersion.trim()}`;
  const template =
    "set E2B_TEMPLATE to a Node 22 template (default: codenaya-node22; build or rebuild with npm run e2b:template)";

  // No older Start release to fall back to: it needs the newer Node.
  if ((pkg.dependencies?.["@tanstack/react-start"] ?? pkg.devDependencies?.["@tanstack/react-start"]) && !atLeast22_12(node)) {
    return `This project uses TanStack Start, which needs Node 22.12+, ${sandbox}. To fix it, ${template}.`;
  }

  const vite = viteMajor(pkg);
  if (vite === null || vite < 7 || supportsVite7(node)) return null;
  return (
    `This project uses Vite ${Number.isFinite(vite) ? vite : "7+"}, which needs ` +
    `Node 20.19+ or 22.12+, ${sandbox}. ` +
    `Set E2B_TEMPLATE to the Node 22 template (npm run e2b:template), or ask ` +
    `the agent to move this project to Vite 6 (with @vitejs/plugin-react 4).`
  );
};
