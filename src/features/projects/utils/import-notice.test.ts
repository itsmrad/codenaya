import { expect, it } from "vitest";
import { missingEnvVarsMessage } from "./import-notice";

it("uses singular and plural copy", () => {
  expect(missingEnvVarsMessage(1)).toBe("Detected 1 missing environment variable in the imported project.");
  expect(missingEnvVarsMessage(2)).toBe("Detected 2 missing environment variables in the imported project.");
});
