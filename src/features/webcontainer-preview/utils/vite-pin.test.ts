import { describe, expect, it } from "vitest";

import { WEBCONTAINER_VITE_PINS, pinViteForWebContainer } from "./vite-pin";

const pkg = (devDependencies: Record<string, string>) =>
  JSON.stringify({ name: "app", dependencies: { react: "19.3.1" }, devDependencies });

describe("pinViteForWebContainer", () => {
  it("pins vite 8 and plugin-react to the WebContainer versions", () => {
    const out = pinViteForWebContainer(pkg({ vite: "8.3.8", "@vitejs/plugin-react": "6.3.0", typescript: "5.9.3" }));
    expect(JSON.parse(out!)).toEqual({
      name: "app",
      dependencies: { react: "19.3.1" },
      devDependencies: { ...WEBCONTAINER_VITE_PINS, typescript: "5.9.3" },
    });
  });

  it("reads ranges and the dependencies section too", () => {
    const out = pinViteForWebContainer(JSON.stringify({ dependencies: { vite: "^8.3.0" } }));
    expect(JSON.parse(out!)).toEqual({ dependencies: { vite: WEBCONTAINER_VITE_PINS.vite } });
  });

  it.each(["^6.0.0", "7.1.0"])("leaves vite %s untouched", (vite) => {
    expect(pinViteForWebContainer(pkg({ vite, "@vitejs/plugin-react": "^4.3.4" }))).toBeNull();
  });

  it("leaves a project without vite untouched", () => {
    expect(pinViteForWebContainer(JSON.stringify({ dependencies: { next: "15.5.0" } }))).toBeNull();
  });

  it("leaves malformed JSON untouched", () => {
    expect(pinViteForWebContainer("{ not json")).toBeNull();
    expect(pinViteForWebContainer("null")).toBeNull();
  });
});
