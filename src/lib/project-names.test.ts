import { describe, expect, it } from "vitest";

import {
  PROJECT_NAME_ADJECTIVES,
  PROJECT_NAME_ANIMALS,
  PROJECT_NAME_COLORS,
  generateProjectName,
} from "./project-names";

// Not exhaustive: a tripwire so an edit to the lists gets a second look.
const BLOCKLIST = [
  "sex", "sexual", "nude", "naked", "kill", "dead", "death", "murder", "blood",
  "drunk", "drug", "stupid", "dumb", "ugly", "fat", "racist", "nazi", "hate",
  "evil", "crazy", "insane", "idiot", "damn", "hell", "slut", "whore", "bitch",
  "bastard", "retard", "gay", "terror", "bomb", "gun", "suicide",
];

const ALL_WORDS = [...PROJECT_NAME_ADJECTIVES, ...PROJECT_NAME_ANIMALS, ...PROJECT_NAME_COLORS];

describe("project names", () => {
  it("uses only lowercase alphabetic words", () => {
    for (const word of ALL_WORDS) {
      expect(word).toMatch(/^[a-z]+$/);
    }
  });

  it("contains no blocklisted words", () => {
    for (const word of ALL_WORDS) {
      expect(BLOCKLIST.some((bad) => word.includes(bad)), word).toBe(false);
    }
  });

  it("generates adjective-animal-color names from the curated lists", () => {
    for (let i = 0; i < 50; i++) {
      const [adjective, animal, color, ...rest] = generateProjectName().split("-");
      expect(rest).toEqual([]);
      expect(PROJECT_NAME_ADJECTIVES).toContain(adjective);
      expect(PROJECT_NAME_ANIMALS).toContain(animal);
      expect(PROJECT_NAME_COLORS).toContain(color);
    }
  });
});
