/**
 * Random `adjective-animal-color` names for new projects (#80).
 *
 * Checked-in, curated lists instead of `unique-names-generator`'s full
 * dictionaries, which include offensive words ("sexual-shrimp-turquoise").
 * The name shows in the navbar, dashboard, command palette and as the root
 * folder, so every word here is neutral. 40 × 40 × 20 = 32,000 combinations.
 */

export const PROJECT_NAME_ADJECTIVES = [
  "able", "amber", "brave", "breezy", "bright", "calm", "clever", "cosmic",
  "crisp", "curious", "daring", "eager", "fancy", "gentle", "glad", "golden",
  "happy", "honest", "jolly", "kind", "lively", "lucky", "merry", "mighty",
  "nimble", "noble", "patient", "plucky", "proud", "quick", "quiet", "rapid",
  "shiny", "sleek", "smart", "steady", "sunny", "swift", "tidy", "witty",
] as const;

export const PROJECT_NAME_ANIMALS = [
  "badger", "beaver", "bison", "camel", "cheetah", "crane", "dolphin", "eagle",
  "falcon", "ferret", "finch", "fox", "gazelle", "gecko", "heron", "ibis",
  "jaguar", "koala", "lemur", "lion", "llama", "lynx", "marten", "moose",
  "narwhal", "otter", "owl", "panda", "parrot", "penguin", "puffin", "quail",
  "rabbit", "raven", "seal", "sparrow", "swan", "tiger", "walrus", "zebra",
] as const;

export const PROJECT_NAME_COLORS = [
  "amethyst", "aqua", "azure", "beige", "blue", "bronze", "coral", "cyan",
  "emerald", "green", "indigo", "ivory", "jade", "lavender", "lime", "olive",
  "orange", "silver", "teal", "violet",
] as const;

const pick = <T>(words: readonly T[]) => words[Math.floor(Math.random() * words.length)];

export const generateProjectName = () =>
  [pick(PROJECT_NAME_ADJECTIVES), pick(PROJECT_NAME_ANIMALS), pick(PROJECT_NAME_COLORS)].join("-");
