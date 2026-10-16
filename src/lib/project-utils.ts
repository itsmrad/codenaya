import {
  adjectives,
  animals,
  uniqueNamesGenerator,
} from "unique-names-generator";

/**
 * Derives a human-friendly project title from a user's initial prompt.
 * Examples:
 * - "pomodoro" -> "Pomodoro App"
 * - "Build me a modern SaaS website for an AI-powered productivity platform" -> "SaaS Productivity Platform"
 * - "Create a personal portfolio website" -> "Personal Portfolio Website"
 * - "An e-commerce store with Stripe checkout" -> "E-commerce Store"
 */
export function generateProjectNameFromPrompt(prompt: string): string {
  const trimmed = prompt.trim();
  if (!trimmed) {
    return uniqueNamesGenerator({
      dictionaries: [adjectives, animals],
      separator: "-",
      length: 2,
    });
  }

  // Remove common prompt prefixes
  let cleaned = trimmed
    .replace(/^(can\s+you\s+)?(please\s+)?(build|create|make|design|generate|develop|code)\s+(me\s+)?(a|an|the)?\s+/i, "")
    .replace(/^(i\s+want\s+(to\s+)?(build|create|make|have)\s+(a|an|the)?\s+)/i, "")
    .replace(/^(a|an|the)\s+/i, "")
    .trim();

  // Find the earliest stop word / preposition boundary
  const stopWords = [" with ", " using ", " for ", " that ", " which ", " where ", " and ", " having ", " including ", " in "];
  let earliestIdx = -1;
  for (const stop of stopWords) {
    const idx = cleaned.toLowerCase().indexOf(stop);
    if (idx > 3 && (earliestIdx === -1 || idx < earliestIdx)) {
      earliestIdx = idx;
    }
  }

  if (earliestIdx !== -1) {
    cleaned = cleaned.substring(0, earliestIdx).trim();
  }

  // Strip punctuation
  cleaned = cleaned.replace(/[.,/#!$%^&*;:{}=\-_`~()?"']/g, " ").replace(/\s+/g, " ").trim();

  const words = cleaned.split(" ").filter(Boolean);
  if (words.length === 0) {
    return uniqueNamesGenerator({
      dictionaries: [adjectives, animals],
      separator: "-",
      length: 2,
    });
  }

  // Take between 1 and 4 words
  const selectedWords = words.slice(0, 4);

  // Pop any trailing prepositions or conjunctions
  const trailingStopWords = new Set(["for", "with", "and", "or", "in", "to", "at", "by", "on", "of", "the", "a", "an"]);
  while (selectedWords.length > 1 && trailingStopWords.has(selectedWords[selectedWords.length - 1].toLowerCase())) {
    selectedWords.pop();
  }

  // Title case each word
  let title = selectedWords
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(" ");

  // If single word, append "App" or "Project" unless already suffixed
  if (selectedWords.length === 1 && !/app|site|tool|bot|game|hub|io/i.test(title)) {
    title = `${title} App`;
  }

  // Ensure reasonable length
  if (title.length > 40) {
    title = title.substring(0, 40).trim();
  }

  return title || "Codenaya Project";
}
