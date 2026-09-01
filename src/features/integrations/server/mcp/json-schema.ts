/**
 * JSON Schema → Zod conversion for MCP tool input schemas.
 *
 * ## Why this is hand-written rather than a dependency
 *
 * AgentKit depends on `@dmitryrechkin/json-schema-to-zod`, which would be the
 * obvious choice. It cannot be used here: that package resolves its own nested
 * **Zod 3** (3.25.76) while this project — and therefore AgentKit's `createTool` —
 * uses **Zod 4** (4.3.6). The two have incompatible internals, so a schema built
 * by the converter is not something AgentKit can validate against. It is not just
 * a type-level mismatch that a cast would paper over; the objects genuinely differ.
 *
 * Rather than add a second converter dependency or pin Zod backwards, this handles
 * the subset of JSON Schema that MCP tools actually publish, using the project's
 * own Zod.
 *
 * ## Design bias: permissive, not strict
 *
 * Validation here is a convenience for the model, not a security boundary — the
 * real check happens on the remote server, which is authoritative about its own
 * arguments. So anything unrecognised becomes `z.unknown()` rather than an error.
 * Being too strict would reject a legitimate call the server would have accepted,
 * which is a worse failure than passing something through and letting the server
 * say no.
 */

import { z } from "zod";

interface JsonSchemaNode {
  type?: string | string[];
  properties?: Record<string, JsonSchemaNode>;
  required?: string[];
  items?: JsonSchemaNode | JsonSchemaNode[];
  enum?: unknown[];
  const?: unknown;
  description?: string;
  anyOf?: JsonSchemaNode[];
  oneOf?: JsonSchemaNode[];
  allOf?: JsonSchemaNode[];
  additionalProperties?: boolean | JsonSchemaNode;
  default?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Nesting ceiling.
 *
 * A hostile or malformed schema can be self-referential or absurdly deep; without
 * a bound, conversion would blow the stack and take the whole agent run with it.
 */
const MAX_DEPTH = 12;

function convertNode(node: JsonSchemaNode, depth: number): z.ZodTypeAny {
  if (depth > MAX_DEPTH) return z.unknown();

  // `const` is a single permitted value.
  if (node.const !== undefined) {
    return z.literal(node.const as never);
  }

  // `enum` of strings becomes a Zod enum, which gives the model a clear list.
  if (Array.isArray(node.enum) && node.enum.length > 0) {
    const values = node.enum;
    if (values.every((v) => typeof v === "string")) {
      return z.enum(values as [string, ...string[]]);
    }
    // Mixed-type enums have no clean Zod equivalent worth the complexity.
    return z.unknown();
  }

  // Unions. `allOf` is deliberately not intersected: for object schemas the
  // useful approximation is the first branch, and a true intersection of JSON
  // Schema semantics is far more machinery than this needs.
  const union = node.anyOf ?? node.oneOf;
  if (Array.isArray(union) && union.length > 0) {
    const branches = union.map((branch) => convertNode(branch, depth + 1));
    if (branches.length === 1) return branches[0];
    return z.union(branches as [z.ZodTypeAny, z.ZodTypeAny, ...z.ZodTypeAny[]]);
  }

  if (Array.isArray(node.allOf) && node.allOf.length > 0) {
    return convertNode(node.allOf[0], depth + 1);
  }

  // A type array such as ["string", "null"] is how nullability is usually
  // expressed.
  const types = Array.isArray(node.type) ? node.type : node.type ? [node.type] : [];
  const nullable = types.includes("null");
  const primary = types.find((t) => t !== "null");

  const base = ((): z.ZodTypeAny => {
    switch (primary) {
      case "string":
        return z.string();
      case "number":
        return z.number();
      case "integer":
        return z.number().int();
      case "boolean":
        return z.boolean();
      case "array": {
        const items = Array.isArray(node.items) ? node.items[0] : node.items;
        return z.array(items ? convertNode(items, depth + 1) : z.unknown());
      }
      case "object":
        return convertObject(node, depth);
      default:
        // No declared type. An object with properties is still clearly an object.
        if (node.properties) return convertObject(node, depth);
        return z.unknown();
    }
  })();

  return nullable ? base.nullable() : base;
}

function convertObject(node: JsonSchemaNode, depth: number): z.ZodTypeAny {
  const properties = node.properties;

  if (!properties || Object.keys(properties).length === 0) {
    // A parameterless tool. An empty object schema is correct and common.
    return z.object({});
  }

  const required = new Set(node.required ?? []);
  const shape: Record<string, z.ZodTypeAny> = {};

  for (const [key, child] of Object.entries(properties)) {
    let field = convertNode(child, depth + 1);

    // Descriptions are how the model learns what a field means, so they are
    // carried across rather than dropped.
    if (typeof child.description === "string" && child.description.length > 0) {
      field = field.describe(child.description);
    }

    shape[key] = required.has(key) ? field : field.optional();
  }

  return z.object(shape);
}

/**
 * Convert an MCP tool's `inputSchema` into a Zod schema.
 *
 * Always returns a usable schema. A tool whose schema cannot be understood is
 * exposed as taking no arguments rather than being dropped: the model can still
 * call it and learn from the response, which is more useful than the tool silently
 * not existing.
 */
export function mcpInputSchemaToZod(inputSchema: unknown): z.ZodTypeAny {
  if (!isRecord(inputSchema)) {
    return z.object({});
  }

  try {
    const converted = convertNode(inputSchema as JsonSchemaNode, 0);

    // AgentKit expects an object schema at the top level, since tool arguments are
    // always a named set. Anything else is coerced to an empty object.
    return converted instanceof z.ZodObject ? converted : z.object({});
  } catch {
    return z.object({});
  }
}
