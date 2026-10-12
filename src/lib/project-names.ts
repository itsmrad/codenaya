/**
 * Curated safe word lists for auto-generated project names.
 * Replaces uncurated dictionary libraries to ensure all generated names are clean,
 * appropriate, and non-offensive.
 * Format: <adjective>-<animal>-<color>
 */

export const SAFE_ADJECTIVES = [
  "bright", "calm", "clever", "cool", "crisp", "daring", "eager", "fast",
  "fresh", "gentle", "glad", "grand", "happy", "keen", "kind", "lively",
  "merry", "neat", "nimble", "noble", "peaceful", "proud", "quick", "quiet",
  "radiant", "sharp", "shining", "silent", "sleek", "smart", "smooth", "snappy",
  "speedy", "steady", "stellar", "strong", "subtle", "sunny", "swift", "tidy",
  "trusty", "valiant", "vibrant", "warm", "wise", "witty", "worthy", "zen",
  "azure", "cosmic", "digital", "golden", "lucid", "modern", "mystic", "prime"
];

export const SAFE_ANIMALS = [
  "antelope", "badger", "beaver", "bison", "cheetah", "crane", "dolphin", "dove",
  "eagle", "falcon", "ferret", "finch", "fox", "gazelle", "gecko", "giraffe",
  "hare", "hawk", "hedgehog", "heron", "ibex", "jaguar", "koala", "lark",
  "lemur", "leopard", "lynx", "marten", "mole", "mongoose", "otter", "owl",
  "panda", "panther", "pelican", "penguin", "plover", "puma", "quail", "rabbit",
  "raven", "robin", "seal", "sparrow", "starling", "swift", "tiger", "toucan"
];

export const SAFE_COLORS = [
  "amber", "aqua", "azure", "beige", "bronze", "cerulean", "cobalt", "copper",
  "coral", "crimson", "cyan", "emerald", "gold", "gray", "green", "indigo",
  "ivory", "jade", "lavender", "lemon", "lime", "magenta", "maroon", "mint",
  "navy", "olive", "onyx", "orange", "peach", "pearl", "pink", "plum",
  "purple", "ruby", "rust", "saffron", "sapphire", "scarlet", "silver", "slate",
  "teal", "topaz", "turquoise", "violet", "amber", "bronze", "emerald", "jade"
];

/**
 * Generates a clean, human-friendly random project name in the format:
 * `<adjective>-<animal>-<color>`
 */
export function generateProjectName(): string {
  const adj = SAFE_ADJECTIVES[Math.floor(Math.random() * SAFE_ADJECTIVES.length)];
  const animal = SAFE_ANIMALS[Math.floor(Math.random() * SAFE_ANIMALS.length)];
  const color = SAFE_COLORS[Math.floor(Math.random() * SAFE_COLORS.length)];
  return `${adj}-${animal}-${color}`;
}
