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

it("defaults to Vite and remembers either framework", () => {
  expect(readProjectFramework()).toBe("vite");
  writeProjectFramework("next");
  expect(readProjectFramework()).toBe("next");
  writeProjectFramework("vite");
  expect(readProjectFramework()).toBe("vite");
});

it("ignores invalid storage and tolerates blocked storage", () => {
  localStorage.setItem("codenaya:projectFramework", "unknown");
  expect(readProjectFramework()).toBe("vite");
  const blocked = () => { throw new Error("blocked"); };
  vi.stubGlobal("localStorage", { getItem: blocked, setItem: blocked });
  expect(readProjectFramework()).toBe("vite");
  expect(() => writeProjectFramework("next")).not.toThrow();
});
