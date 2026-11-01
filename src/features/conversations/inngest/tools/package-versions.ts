import { KNOWN_GOOD_VERSIONS } from "../known-good-versions";

const DEPENDENCY_FIELDS = ["dependencies", "devDependencies"] as const;

/** The major each `||` alternative starts with, plus hyphen-range endpoints. */
const majors = (range: string) =>
  [...range.matchAll(/(?:^|\|\||\s+-)\s*[\^~>=<v\s]*(\d+)/g)].map((match) => Number(match[1]));

/**
 * Checks a package.json the agent wrote against the known-good manifest (#331).
 * A listed package with no version (`latest`, `*`, `""`, another dist-tag) is
 * rewritten to the manifest range, since npm would resolve it to today's
 * newest major. So is a newer major than the manifest's: nobody has checked it
 * runs (react-router 8 needs Node >=22.22, Vite 7 crashes the sandbox). An
 * older major is only reported: an existing project may be on Tailwind v3 or
 * React 18 on purpose.
 */
export const checkPackageVersions = (
  fileName: string,
  content: string,
): { content: string; note: string } => {
  if (fileName !== "package.json") return { content, note: "" };
  let pkg: Record<string, unknown>;
  try {
    pkg = JSON.parse(content);
  } catch {
    return { content, note: "" };
  }
  if (!pkg || typeof pkg !== "object") return { content, note: "" };

  const pinned: string[] = [];
  const warned: string[] = [];
  for (const field of DEPENDENCY_FIELDS) {
    const deps = pkg[field];
    if (!deps || typeof deps !== "object") continue;
    for (const [name, range] of Object.entries(deps as Record<string, unknown>)) {
      if (!Object.hasOwn(KNOWN_GOOD_VERSIONS, name) || typeof range !== "string") continue;
      const known: string = KNOWN_GOOD_VERSIONS[name as keyof typeof KNOWN_GOOD_VERSIONS];
      // Protocols (workspace:, npm:, file:, git URLs) aren't registry ranges.
      if (/[:/]/.test(range)) continue;
      const knownMajor = majors(known)[0];
      const rangeMajors = majors(range);
      const unbounded = range.split("||").some((alternative) =>
        alternative.trim().startsWith(">") && !alternative.includes("<"),
      );
      if (rangeMajors.length === 0 || Math.max(...rangeMajors) > knownMajor || unbounded) {
        (deps as Record<string, string>)[name] = known;
        pinned.push(`${name} "${range}" → "${known}"`);
      } else if (!rangeMajors.includes(knownMajor)) {
        warned.push(`${name} "${range}" (known-good: "${known}")`);
      }
    }
  }

  let note = "";
  if (pinned.length > 0) {
    note += `\nPinned to the starter's known-good versions in package.json: ${pinned.join(", ")}.`;
  }
  if (warned.length > 0) {
    note += `\nVersion check: ${warned.join(", ")} ${warned.length > 1 ? "are" : "is"} not the known-good major. Use the known-good range unless this project is already on that major.`;
  }
  return {
    content: pinned.length > 0 ? `${JSON.stringify(pkg, null, 2)}\n` : content,
    note,
  };
};
