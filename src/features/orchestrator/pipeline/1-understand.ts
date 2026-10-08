import { TaskComplexity } from "../types";

export interface UnderstoodTask {
  rawPrompt: string;
  normalizedGoal: string;
  estimatedComplexity: TaskComplexity;
  domain: string;
  scopeBoundaries: {
    inScope: string[];
    outOfScope: string[];
  };
}

/**
 * Phase 1: Understand
 * Analyzes the user's development request, extracts clear goals, scope boundaries, and estimated complexity.
 */
export function understandTask(rawPrompt: string): UnderstoodTask {
  const trimmed = rawPrompt.trim();
  const lower = trimmed.toLowerCase();

  // Estimate complexity based on intent signals
  let estimatedComplexity: TaskComplexity = "medium";

  const criticalKeywords = ["refactor architecture", "migrate", "security audit", "full-stack authentication", "database overhaul"];
  const highKeywords = ["new feature", "multi-page", "dashboard", "api integration", "state management", "flow"];
  const lowKeywords = ["fix typo", "update title", "color change", "add button", "readme", "comment"];

  if (criticalKeywords.some((k) => lower.includes(k))) {
    estimatedComplexity = "critical";
  } else if (highKeywords.some((k) => lower.includes(k))) {
    estimatedComplexity = "high";
  } else if (lowKeywords.some((k) => lower.includes(k))) {
    estimatedComplexity = "low";
  }

  // Detect domain using word boundaries so words like 'build' don't trigger 'ui'
  let domain = "web-frontend";
  if (
    /\b(backend|convex|api|database|sql|endpoint)\b/i.test(trimmed)
  ) {
    domain = "full-stack";
  } else if (
    /\b(ui|css|style|tailwind|theme|colors?|font)\b/i.test(trimmed)
  ) {
    domain = "ui-design";
  }

  return {
    rawPrompt: trimmed,
    normalizedGoal: trimmed,
    estimatedComplexity,
    domain,
    scopeBoundaries: {
      inScope: [
        "Minimal targeted changes addressing the requested user goal",
        "Adhering to existing repository architecture and conventions",
        "Validating structural integrity and test passing",
      ],
      outOfScope: [
        "Unrelated file modifications or cosmetic rewrites",
        "Introducing conflicting frameworks or duplicate utilities",
      ],
    },
  };
}
