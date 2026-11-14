import { z } from "zod";

/**
 * Some models (Haiku 5.5) send an array or object argument as a JSON string.
 * This decodes such a string before `schema` validates it. Any other value,
 * invalid JSON included, reaches `schema` unchanged and fails with its usual
 * error. Use it only in a handler's own schema: AgentKit sends `parameters`
 * to the model as JSON schema and never validates against it.
 */
export const jsonArg = <T extends z.ZodType>(schema: T) =>
  z.preprocess((value) => {
    if (typeof value !== "string") return value;
    try {
      const parsed: unknown = JSON.parse(value);
      return typeof parsed === "object" && parsed !== null ? parsed : value;
    } catch {
      return value;
    }
  }, schema);
