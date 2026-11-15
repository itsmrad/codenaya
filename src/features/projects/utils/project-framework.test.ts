import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { readProjectFramework, writeProjectFramework } from "./project-framework";

beforeEach(() => {
  const storage = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
  });
});
afterEach(() => vi.unstubAllGlobals());

it("defaults to Auto and remembers every choice, including an old saved vite", () => {
  expect(readProjectFramework()).toBe("auto");
  writeProjectFramework("next");
  expect(readProjectFramework()).toBe("next");
  writeProjectFramework("tanstack-start");
  expect(readProjectFramework()).toBe("tanstack-start");
  writeProjectFramework("vite");
  expect(readProjectFramework()).toBe("vite");
  writeProjectFramework("auto");
  expect(readProjectFramework()).toBe("auto");
});

it("ignores invalid storage and tolerates blocked storage", () => {
  localStorage.setItem("codenaya:projectFramework", "unknown");
  expect(readProjectFramework()).toBe("auto");
  const blocked = () => { throw new Error("blocked"); };
  vi.stubGlobal("localStorage", { getItem: blocked, setItem: blocked });
  expect(readProjectFramework()).toBe("auto");
  expect(() => writeProjectFramework("next")).not.toThrow();
});
