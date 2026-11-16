import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { readProjectFramework } from "./project-framework";

beforeEach(() => {
  const storage = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
  });
});
afterEach(() => vi.unstubAllGlobals());

it("defaults to Auto and reads legacy choices for template handoffs", () => {
  expect(readProjectFramework()).toBe("auto");
  localStorage.setItem("codenaya:projectFramework", "next");
  expect(readProjectFramework()).toBe("next");
  localStorage.setItem("codenaya:projectFramework", "tanstack-start");
  expect(readProjectFramework()).toBe("tanstack-start");
  localStorage.setItem("codenaya:projectFramework", "vite");
  expect(readProjectFramework()).toBe("vite");
  localStorage.setItem("codenaya:projectFramework", "auto");
  expect(readProjectFramework()).toBe("auto");
});

it("ignores invalid storage and tolerates blocked storage", () => {
  localStorage.setItem("codenaya:projectFramework", "unknown");
  expect(readProjectFramework()).toBe("auto");
  const blocked = () => { throw new Error("blocked"); };
  vi.stubGlobal("localStorage", { getItem: blocked, setItem: blocked });
  expect(readProjectFramework()).toBe("auto");
});
