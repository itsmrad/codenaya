import { describe, it, expect } from "vitest";
import {
  generateProjectName,
  SAFE_ADJECTIVES,
  SAFE_ANIMALS,
  SAFE_COLORS,
} from "../project-names";

describe("Curated Safe Project Names (Issue #80)", () => {
  const blocklist = [
    "sexual",
    "sexy",
    "nude",
    "kill",
    "dead",
    "murder",
    "hate",
    "bloody",
    "violent",
    "racist",
    "slave",
    "drug",
    "drunk",
  ];

  it("ensures all curated words are lowercase alphabetic", () => {
    const allWords = [...SAFE_ADJECTIVES, ...SAFE_ANIMALS, ...SAFE_COLORS];
    expect(allWords.length).toBeGreaterThan(50);

    for (const word of allWords) {
      expect(word).toMatch(/^[a-z]+$/);
    }
  });

  it("ensures no curated word matches inappropriate blocklist terms", () => {
    const allWords = [...SAFE_ADJECTIVES, ...SAFE_ANIMALS, ...SAFE_COLORS];

    for (const word of allWords) {
      for (const blocked of blocklist) {
        expect(word).not.toContain(blocked);
      }
    }
  });

  it("generates names in adjective-animal-color format", () => {
    for (let i = 0; i < 20; i++) {
      const name = generateProjectName();
      const parts = name.split("-");
      expect(parts).toHaveLength(3);
      expect(SAFE_ADJECTIVES).toContain(parts[0]);
      expect(SAFE_ANIMALS).toContain(parts[1]);
      expect(SAFE_COLORS).toContain(parts[2]);
    }
  });
});
