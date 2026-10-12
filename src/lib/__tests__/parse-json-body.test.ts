import { describe, expect, it } from "vitest";
import { z } from "zod";
import { parseJsonBody } from "../parse-json-body";

describe("parseJsonBody", () => {
  const schema = z.object({
    name: z.string().min(1),
    count: z.number().int().positive(),
  });

  it("successfully parses valid JSON matching schema", async () => {
    const req = new Request("http://localhost/api/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "codenaya", count: 42 }),
    });

    const result = await parseJsonBody(req, schema);
    expect(result.success).toBe(true);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toEqual({ name: "codenaya", count: 42 });
      expect(result.response).toBeUndefined();
    }
  });

  it("returns 400 Bad Request for malformed JSON string", async () => {
    const req = new Request("http://localhost/api/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{ invalid json: 123",
    });

    const result = await parseJsonBody(req, schema);
    expect(result.success).toBe(false);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(400);
      const json = await result.response.json();
      expect(json.error).toBe("Invalid JSON in request body");
    }
  });

  it("returns 400 Bad Request with field details when schema validation fails", async () => {
    const req = new Request("http://localhost/api/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "", count: -5 }),
    });

    const result = await parseJsonBody(req, schema);
    expect(result.success).toBe(false);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(400);
      const json = await result.response.json();
      expect(json.error).toBe("Invalid request payload");
      expect(json.details).toHaveProperty("name");
      expect(json.details).toHaveProperty("count");
    }
  });

  it("returns 400 Bad Request for non-object JSON when schema expects object", async () => {
    const req = new Request("http://localhost/api/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(["item1", "item2"]),
    });

    const result = await parseJsonBody(req, schema);
    expect(result.success).toBe(false);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(400);
    }
  });
});
