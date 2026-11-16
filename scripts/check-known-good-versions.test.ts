import { describe, expect, it } from "vitest";
import { minVersion } from "semver";

import { KNOWN_GOOD_VERSIONS } from "../src/features/conversations/inngest/known-good-versions";
import { checkKnownGoodVersions } from "./check-known-good-versions.mjs";

const metadata = Object.fromEntries(Object.entries(KNOWN_GOOD_VERSIONS).map(
  ([name, range]) => [`${name}@${range}`, { version: minVersion(range)!.version }],
));
const packageCount = Object.keys(metadata).length;

describe("checkKnownGoodVersions", () => {
  it("checks every manifest entry offline and accepts single and array responses", () => {
    const seen: string[] = [];
    const result = checkKnownGoodVersions((spec: string) => {
      seen.push(spec);
      return seen.length % 2 ? metadata[spec].version : [metadata[spec]];
    });
    expect(seen).toEqual(Object.keys(metadata));
    expect(result.failures).toEqual([]);
    expect(result.summary).toContain(`${packageCount}/${packageCount} ranges resolved; 0 failures`);
  });

  it("reports unresolved, empty, malformed and out-of-range results and continues", () => {
    const broken = [undefined, [], {}, { version: "999.0.0" }];
    let calls = 0;
    const result = checkKnownGoodVersions((spec: string) => {
      calls++;
      if (calls === 1) throw new Error("registry unavailable");
      return calls <= 5 ? broken[calls - 2] : metadata[spec];
    });
    expect(calls).toBe(packageCount);
    expect(result.failures).toHaveLength(5);
    expect(result.summary).toContain(`${packageCount - 5}/${packageCount} ranges resolved`);
  });

  it("checks the highest matching version for incompatible React peers and Node engines", () => {
    const result = checkKnownGoodVersions((spec: string) => {
      if (spec.startsWith("react@")) {
        return { version: "19.2.0", peerDependencies: { react: "^18" } };
      }
      if (!spec.startsWith("react-dom@")) return metadata[spec];
      return [
        { version: "19.2.0", peerDependencies: { react: "^18 || ^19" }, engines: { node: ">=20" } },
        { version: "19.2.1", peerDependencies: { react: "^18" } },
        { version: "19.2.2", engines: { node: ">=22.22" } },
        { version: "19.2.3", engines: { node: ">=22.22" } },
      ];
    });
    expect(result.failures).toHaveLength(2);
    expect(result.failures.join("\n")).toContain('"react":"^18"');
    expect(result.failures.join("\n")).toContain('"node":">=22.22"');
  });

  it("skips the remaining entries once the time budget is spent", () => {
    let calls = 0;
    const result = checkKnownGoodVersions(() => { calls++; return {}; }, 0);
    expect(calls).toBe(0);
    expect(result.failures).toHaveLength(packageCount);
    expect(result.failures[0]).toContain("skipped, time budget spent");
  });

  it("ignores historical incompatible releases when the latest matching release works", () => {
    const result = checkKnownGoodVersions((spec: string) => spec.startsWith("react-dom@") ? [
      { version: "19.2.9", peerDependencies: { react: "^19" } },
      { version: "19.2.0", peerDependencies: { react: "^18" } },
    ] : metadata[spec]);
    expect(result.failures).toEqual([]);
  });
});
