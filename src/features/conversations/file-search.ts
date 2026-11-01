import { RE2JS } from "re2js";

export const MAX_SEARCH_RESULTS = 200;
export const SEARCH_BYTE_BUDGET = 4 * 1024 * 1024;
export const SEARCH_TRUNCATED = "Search truncated. Narrow pathGlob or the pattern and search again.";

/** Only *, ** and ? are special; RE2 keeps even adversarial globs linear. */
export const compilePathGlob = (glob: string) => {
  let pattern = "^";
  for (let i = 0; i < glob.length; i++) {
    const char = glob[i];
    if (char === "*" && glob[i + 1] === "*") {
      i++;
      if (glob[i + 1] === "/") {
        i++;
        pattern += "(?:.*/)?";
      } else pattern += ".*";
    } else if (char === "*") pattern += "[^/]*";
    else if (char === "?") pattern += "[^/]";
    else pattern += char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  return RE2JS.compile(`${pattern}$`);
};

export const compileSearch = (pattern: string, isRegex = false) => {
  if (!pattern.length || pattern.length > 500) {
    throw new Error("Use a non-empty pattern of at most 500 characters.");
  }
  if (!isRegex) return (line: string) => line.includes(pattern);
  try {
    const regex = RE2JS.compile(pattern);
    return (line: string) => regex.matcher(line).find();
  } catch {
    throw new Error("Invalid regex. Use RE2 syntax (no backreferences or lookarounds), or set isRegex to false for literal search.");
  }
};
