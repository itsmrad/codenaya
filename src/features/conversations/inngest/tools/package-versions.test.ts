import { describe, expect, it } from "vitest";

import { KNOWN_GOOD_VERSIONS } from "../known-good-versions";
import { checkPackageVersions } from "./package-versions";

const pkg = (deps: Record<string, string>, devDeps: Record<string, string> = {}) =>
  JSON.stringify({ name: "app", dependencies: deps, devDependencies: devDeps }, null, 2);

describe("checkPackageVersions", () => {
  it("rewrites unpinned known packages to the manifest range and names each change", () => {
    const { content, note } = checkPackageVersions(
      "package.json",
      pkg({ "react-router": "latest", "lucide-react": "*", zod: "", "left-pad": "latest" }, { vite: "next" }),
    );
    const written = JSON.parse(content);

    expect(written.dependencies).toEqual({
      "react-router": KNOWN_GOOD_VERSIONS["react-router"],
      "lucide-react": KNOWN_GOOD_VERSIONS["lucide-react"],
      zod: KNOWN_GOOD_VERSIONS.zod,
      "left-pad": "latest",
    });
    expect(written.devDependencies.vite).toBe(KNOWN_GOOD_VERSIONS.vite);
    expect(note).toContain(`react-router "latest" → "${KNOWN_GOOD_VERSIONS["react-router"]}"`);
    expect(note).toContain(`lucide-react "*" → "${KNOWN_GOOD_VERSIONS["lucide-react"]}"`);
    expect(note).toContain(`zod "" → "${KNOWN_GOOD_VERSIONS.zod}"`);
    expect(note).toContain(`vite "next" → "${KNOWN_GOOD_VERSIONS.vite}"`);
    expect(note).not.toContain("left-pad");
  });

  it("rewrites a newer major than the manifest's, since nobody has checked it runs", () => {
    const { content, note } = checkPackageVersions(
      "package.json",
      pkg({ "react-router": "^8.0.0" }, { vite: "^7.1.0" }),
    );
    const written = JSON.parse(content);

    expect(written.dependencies["react-router"]).toBe(KNOWN_GOOD_VERSIONS["react-router"]);
    expect(written.devDependencies.vite).toBe(KNOWN_GOOD_VERSIONS.vite);
    expect(note).toContain(`react-router "^8.0.0" → "${KNOWN_GOOD_VERSIONS["react-router"]}"`);
    expect(note).toContain(`vite "^7.1.0" → "${KNOWN_GOOD_VERSIONS.vite}"`);
    expect(note).not.toContain("Version check");
  });

  it("warns on an older major but keeps it, since existing projects may be on it", () => {
    const original = pkg(
      { react: "^18.3.1", "lucide-react": "^0.468.0", "react-dom": "^18 || ^19" },
      { tailwindcss: "^3.4.0" },
    );
    const { content, note } = checkPackageVersions("package.json", original);

    expect(content).toBe(original);
    expect(note).toContain('react "^18.3.1"');
    expect(note).toContain('lucide-react "^0.468.0"');
    expect(note).toContain('tailwindcss "^3.4.0"');
    expect(note).toContain("are not the known-good major");
    expect(note).not.toContain("react-dom");
    expect(note).not.toContain("Pinned");
    expect(checkPackageVersions("package.json", pkg({ react: "^18.3.1" })).note).toContain(
      "is not the known-good major",
    );
  });

  it("leaves matching majors, protocols, other files and invalid JSON alone", () => {
    const original = pkg(
      { react: "^19.0.0", typescript: "~5.9.2", zod: "workspace:*", vite: "npm:rolldown-vite@7" },
      { "@types/node": "github:types/node" },
    );
    expect(checkPackageVersions("package.json", original)).toEqual({ content: original, note: "" });
    expect(checkPackageVersions("other.json", pkg({ zod: "latest" })).note).toBe("");
    expect(checkPackageVersions("package.json", "{ nope")).toEqual({ content: "{ nope", note: "" });
    expect(checkPackageVersions("package.json", pkg({ constructor: "latest" })).note).toBe("");
  });
});
