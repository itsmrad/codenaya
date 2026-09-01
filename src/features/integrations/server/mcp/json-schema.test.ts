import { describe, expect, it } from "vitest";
import { z } from "zod";

import { mcpInputSchemaToZod } from "./json-schema";

/**
 * A bad conversion here silently breaks every tool call for a provider: AgentKit
 * validates arguments against this schema before dispatching, so an over-strict
 * result rejects calls the remote server would have accepted.
 *
 * The bias is therefore permissive. Validation is a convenience for the model; the
 * remote server is authoritative about its own arguments.
 */

describe("object schemas", () => {
  it("converts a typical MCP tool schema", () => {
    const schema = mcpInputSchemaToZod({
      type: "object",
      properties: {
        query: { type: "string", description: "The search query" },
        limit: { type: "integer" },
      },
      required: ["query"],
    });

    expect(schema.safeParse({ query: "hello" }).success).toBe(true);
    expect(schema.safeParse({ query: "hello", limit: 5 }).success).toBe(true);
    // `query` is required, so its absence must fail.
    expect(schema.safeParse({ limit: 5 }).success).toBe(false);
  });

  it("treats unlisted properties as optional", () => {
    const schema = mcpInputSchemaToZod({
      type: "object",
      properties: { a: { type: "string" }, b: { type: "string" } },
      required: ["a"],
    });

    expect(schema.safeParse({ a: "x" }).success).toBe(true);
  });

  it("produces an object schema for a parameterless tool", () => {
    for (const input of [
      { type: "object" },
      { type: "object", properties: {} },
    ]) {
      const schema = mcpInputSchemaToZod(input);
      expect(schema instanceof z.ZodObject).toBe(true);
      expect(schema.safeParse({}).success).toBe(true);
    }
  });

  it("infers object when properties are present without a type", () => {
    const schema = mcpInputSchemaToZod({
      properties: { name: { type: "string" } },
      required: ["name"],
    });

    expect(schema.safeParse({ name: "x" }).success).toBe(true);
    expect(schema.safeParse({}).success).toBe(false);
  });

  it("carries property descriptions through for the model", () => {
    const schema = mcpInputSchemaToZod({
      type: "object",
      properties: { q: { type: "string", description: "What to search for" } },
      required: ["q"],
    }) as z.ZodObject<{ q: z.ZodTypeAny }>;

    expect(schema.shape.q.description).toBe("What to search for");
  });

  it("handles nested objects", () => {
    const schema = mcpInputSchemaToZod({
      type: "object",
      properties: {
        filter: {
          type: "object",
          properties: { status: { type: "string" } },
          required: ["status"],
        },
      },
      required: ["filter"],
    });

    expect(schema.safeParse({ filter: { status: "open" } }).success).toBe(true);
    expect(schema.safeParse({ filter: {} }).success).toBe(false);
  });
});

describe("primitives", () => {
  const wrap = (property: Record<string, unknown>) =>
    mcpInputSchemaToZod({
      type: "object",
      properties: { v: property },
      required: ["v"],
    });

  it("converts string, number, boolean", () => {
    expect(wrap({ type: "string" }).safeParse({ v: "x" }).success).toBe(true);
    expect(wrap({ type: "string" }).safeParse({ v: 1 }).success).toBe(false);
    expect(wrap({ type: "number" }).safeParse({ v: 1.5 }).success).toBe(true);
    expect(wrap({ type: "boolean" }).safeParse({ v: true }).success).toBe(true);
  });

  it("enforces integer", () => {
    const schema = wrap({ type: "integer" });
    expect(schema.safeParse({ v: 3 }).success).toBe(true);
    expect(schema.safeParse({ v: 3.5 }).success).toBe(false);
  });

  it("converts arrays with typed items", () => {
    const schema = wrap({ type: "array", items: { type: "string" } });
    expect(schema.safeParse({ v: ["a", "b"] }).success).toBe(true);
    expect(schema.safeParse({ v: [1] }).success).toBe(false);
  });

  it("accepts an untyped array", () => {
    const schema = wrap({ type: "array" });
    expect(schema.safeParse({ v: [1, "a", null] }).success).toBe(true);
  });

  it("handles tuple-style items by using the first entry", () => {
    const schema = wrap({
      type: "array",
      items: [{ type: "string" }, { type: "number" }],
    });
    expect(schema.safeParse({ v: ["a"] }).success).toBe(true);
  });
});

describe("enums and constants", () => {
  const wrap = (property: Record<string, unknown>) =>
    mcpInputSchemaToZod({
      type: "object",
      properties: { v: property },
      required: ["v"],
    });

  it("converts a string enum", () => {
    const schema = wrap({ enum: ["asc", "desc"] });
    expect(schema.safeParse({ v: "asc" }).success).toBe(true);
    expect(schema.safeParse({ v: "sideways" }).success).toBe(false);
  });

  it("accepts anything for a mixed-type enum", () => {
    // No clean Zod equivalent, and rejecting would block a legitimate call.
    const schema = wrap({ enum: ["a", 1, true] });
    expect(schema.safeParse({ v: "a" }).success).toBe(true);
    expect(schema.safeParse({ v: 1 }).success).toBe(true);
  });

  it("converts const to a literal", () => {
    const schema = wrap({ const: "fixed" });
    expect(schema.safeParse({ v: "fixed" }).success).toBe(true);
    expect(schema.safeParse({ v: "other" }).success).toBe(false);
  });
});

describe("nullability and unions", () => {
  const wrap = (property: Record<string, unknown>) =>
    mcpInputSchemaToZod({
      type: "object",
      properties: { v: property },
      required: ["v"],
    });

  it("supports a nullable type array", () => {
    const schema = wrap({ type: ["string", "null"] });
    expect(schema.safeParse({ v: "x" }).success).toBe(true);
    expect(schema.safeParse({ v: null }).success).toBe(true);
    expect(schema.safeParse({ v: 5 }).success).toBe(false);
  });

  it("supports anyOf", () => {
    const schema = wrap({ anyOf: [{ type: "string" }, { type: "number" }] });
    expect(schema.safeParse({ v: "x" }).success).toBe(true);
    expect(schema.safeParse({ v: 5 }).success).toBe(true);
    expect(schema.safeParse({ v: true }).success).toBe(false);
  });

  it("supports oneOf", () => {
    const schema = wrap({ oneOf: [{ type: "string" }, { type: "boolean" }] });
    expect(schema.safeParse({ v: false }).success).toBe(true);
  });

  it("unwraps a single-branch union", () => {
    const schema = wrap({ anyOf: [{ type: "string" }] });
    expect(schema.safeParse({ v: "x" }).success).toBe(true);
    expect(schema.safeParse({ v: 1 }).success).toBe(false);
  });

  it("approximates allOf with its first branch", () => {
    const schema = wrap({ allOf: [{ type: "string" }] });
    expect(schema.safeParse({ v: "x" }).success).toBe(true);
  });
});

describe("degrades safely rather than throwing", () => {
  it("returns an object schema for non-object input", () => {
    for (const input of [null, undefined, "string", 42, [], true]) {
      const schema = mcpInputSchemaToZod(input);
      expect(schema instanceof z.ZodObject).toBe(true);
      expect(schema.safeParse({}).success).toBe(true);
    }
  });

  it("coerces a non-object top level to an empty object", () => {
    // Tool arguments are always a named set, so a bare string schema at the top
    // level cannot be used as-is.
    const schema = mcpInputSchemaToZod({ type: "string" });
    expect(schema instanceof z.ZodObject).toBe(true);
  });

  it("accepts anything for an unrecognised type", () => {
    const schema = mcpInputSchemaToZod({
      type: "object",
      properties: { v: { type: "some-future-type" } },
      required: ["v"],
    });
    expect(schema.safeParse({ v: "anything" }).success).toBe(true);
    expect(schema.safeParse({ v: { nested: true } }).success).toBe(true);
  });

  it("survives a deeply nested schema without blowing the stack", () => {
    // A malformed or hostile schema could otherwise take down the whole agent run.
    let node: Record<string, unknown> = { type: "string" };
    for (let i = 0; i < 60; i++) {
      node = { type: "object", properties: { child: node }, required: ["child"] };
    }

    expect(() => mcpInputSchemaToZod(node)).not.toThrow();
    expect(mcpInputSchemaToZod(node) instanceof z.ZodObject).toBe(true);
  });

  it("handles a self-referential structure without hanging", () => {
    const node: Record<string, unknown> = { type: "object" };
    node.properties = { self: node };

    expect(() => mcpInputSchemaToZod(node)).not.toThrow();
  });
});

describe("real MCP tool schemas", () => {
  it("converts a Supabase execute_sql shape", () => {
    const schema = mcpInputSchemaToZod({
      type: "object",
      properties: {
        project_id: { type: "string" },
        query: { type: "string", description: "The SQL query to execute" },
      },
      required: ["project_id", "query"],
      additionalProperties: false,
      $schema: "http://json-schema.org/draft-07/schema#",
    });

    expect(
      schema.safeParse({ project_id: "abc", query: "select 1" }).success,
    ).toBe(true);
    expect(schema.safeParse({ query: "select 1" }).success).toBe(false);
  });

  it("converts a Neon repeated-category shape", () => {
    const schema = mcpInputSchemaToZod({
      type: "object",
      properties: {
        projectId: { type: "string" },
        categories: { type: "array", items: { type: "string" } },
        readonly: { type: "boolean" },
      },
      required: ["projectId"],
    });

    expect(
      schema.safeParse({
        projectId: "p1",
        categories: ["querying", "schema"],
        readonly: true,
      }).success,
    ).toBe(true);
  });
});
