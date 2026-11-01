import { describe, expect, it } from "vitest";

import { chatStarters } from "./chat-starters";

const prompts = (project: Parameters<typeof chatStarters>[0]) =>
  chatStarters(project).suggestions.map((suggestion) => suggestion.prompt);

describe("chatStarters", () => {
  it("keeps the build-from-scratch starters for an empty project", () => {
    const starters = chatStarters({ name: "Blank", imported: false, hasFiles: false });
    expect(starters.title).toBe("What do you want to build?");
    expect(starters.suggestions).toHaveLength(4);
    expect(starters.suggestions[0].prompt).toMatch(/landing page/);
  });

  it("offers codebase starters for an imported project, even before its files load", () => {
    const starters = chatStarters({ name: "my-repo", imported: true, hasFiles: false });
    expect(starters.title).toBe("Continue building my-repo");
    expect(prompts({ name: "my-repo", imported: true, hasFiles: false })).toEqual([
      "Explain this codebase",
      "Find and fix bugs",
      "Add a README",
    ]);
  });

  it("offers edit starters for a project that has files", () => {
    expect(chatStarters({ name: "Shop (copy)", imported: false, hasFiles: true }).title).toBe(
      "Continue building Shop (copy)",
    );
    expect(prompts({ name: "Shop (copy)", imported: false, hasFiles: true })).toEqual([
      "Improve the mobile layout",
      "Add dark mode",
      "Find and fix bugs",
    ]);
  });
});
