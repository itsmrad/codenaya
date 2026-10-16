import { describe, it, expect } from "vitest";
import { generateProjectNameFromPrompt } from "../project-utils";

describe("generateProjectNameFromPrompt", () => {
  it("generates Pomodoro App from 'pomodoro'", () => {
    expect(generateProjectNameFromPrompt("pomodoro")).toBe("Pomodoro App");
  });

  it("handles 'Build me a modern SaaS website for an AI-powered productivity platform'", () => {
    const name = generateProjectNameFromPrompt("Build me a modern SaaS website for an AI-powered productivity platform");
    expect(name).toBe("Modern Saas Website");
  });

  it("handles 'Create an e-commerce store with Stripe'", () => {
    const name = generateProjectNameFromPrompt("Create an e-commerce store with Stripe");
    expect(name).toBe("E Commerce Store");
  });

  it("falls back gracefully on empty string", () => {
    const name = generateProjectNameFromPrompt("");
    expect(name).toBeDefined();
    expect(typeof name).toBe("string");
    expect(name.length).toBeGreaterThan(0);
  });
});
